import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  validateBookParentSchoolBookingTypeInput, validateBookParentSchoolEventSlotInput, validateCancelParentSchoolBookingInput, verifyParentSchoolBookingReceipt,
  verifyParentSchoolBookings, type ParentSchoolBookingReceipt, type ParentSchoolBookings,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  PARENT_CLASS_BOOKING_FORBIDDEN: () => new ForbiddenException({ code: 'PARENT_SCHOOL_BOOKING_FORBIDDEN' }),
  PARENT_SCHOOL_BOOKING_NO_CONTACT: code => new UnprocessableEntityException({ code, detail: 'Your account has no email the school can use for this booking.' }),
  PARENT_SCHOOL_BOOKING_NOT_OFFERED: code => new ConflictException({ code, detail: 'This time cannot be booked from the parent app right now.' }),
  PARENT_SCHOOL_BOOKING_ALREADY_BOOKED: code => new ConflictException({ code, detail: 'Your family already has a booking here.' }),
  PARENT_SCHOOL_BOOKING_FULL: code => new ConflictException({ code, detail: 'This time is full.' }),
  PARENT_SCHOOL_BOOKING_NOT_FOUND: code => new NotFoundException({ code, detail: 'The booking is not available.' }),
  PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE: code => new ConflictException({ code, detail: 'This booking can no longer be cancelled from the parent app.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PARENT_SCHOOL_BOOKING_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_SCHOOL_BOOKING_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'PARENT_SCHOOL_BOOKING_UNAVAILABLE', detail: 'No verified booking result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}

/** 0461 parent school bookings: the parent's one live family grant decides the tenant; no school, family, name or contact is taken from the request. */
@Injectable()
export class ParentSchoolBookingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (scopes.length !== 1) throw new ForbiddenException({ code: 'PARENT_SCHOOL_BOOKING_FORBIDDEN' });
    return scopes[0]!;
  }
  private context(scope: ResolvedParentFamilyScope) {
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId };
  }

  async choices(subject: string): Promise<ParentSchoolBookings> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_SCHOOL_BOOKING_FORBIDDEN' });
    try {
      const scope = await this.scope(subject);
      return await this.database.withTenantReadOnlyTransaction(this.context(scope), async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verifyParentSchoolBookings(await this.one(client, 'SELECT hon.read_parent_school_bookings($1) AS data', [subject]));
      });
    } catch (error) { return translate(error); }
  }

  async bookEventSlot(subject: string, value: unknown, key: unknown): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
    let input;
    try { input = validateBookParentSchoolEventSlotInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(subject, key, 'SELECT hon.book_parent_school_event_slot($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyParentSchoolBookingReceipt(data, { kind: 'EVENT' }));
  }

  async bookBookingType(subject: string, value: unknown, key: unknown): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
    let input;
    try { input = validateBookParentSchoolBookingTypeInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(subject, key, 'SELECT hon.book_parent_school_booking_type($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyParentSchoolBookingReceipt(data, { kind: 'BOOKING_TYPE' }));
  }

  async cancel(subject: string, bookingId: string, value: unknown, key: unknown): Promise<{ receipt: ParentSchoolBookingReceipt; replayed: boolean }> {
    let input;
    try {
      const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (Object.keys(body).join() !== 'expectedVersion') throw new Error('shape');
      input = validateCancelParentSchoolBookingInput({ bookingId, expectedVersion: body.expectedVersion });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(subject, key, 'SELECT hon.cancel_parent_school_booking($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyParentSchoolBookingReceipt(data, { bookingId: input.bookingId }));
  }

  private async write<I>(subject: string, key: unknown, statement: string, input: I, verify: (data: unknown) => ParentSchoolBookingReceipt) {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_SCHOOL_BOOKING_FORBIDDEN' });
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    try {
      const scope = await this.scope(subject);
      const context = this.context(scope);
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, [subject, JSON.stringify(input), key, context.requestId, context.requestId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified parent school booking receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified parent school booking read.');
    return result.rows[0]!.data;
  }
}
