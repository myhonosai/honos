import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  validateBookParentClassSessionInput, validateCancelParentClassBookingInput, verifyParentClassBookingChoices, verifyParentClassBookingReceipt,
  type ParentClassBookingChoices, type ParentClassBookingReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  PARENT_CLASS_BOOKING_FORBIDDEN: code => new ForbiddenException({ code }),
  PARENT_CLASS_BOOKING_CHILD_NOT_FOUND: code => new NotFoundException({ code, detail: 'That child is not in your family at this school.' }),
  PARENT_CLASS_BOOKING_NOT_OFFERED: code => new ConflictException({ code, detail: 'This class cannot be booked from the parent app right now.' }),
  PARENT_CLASS_BOOKING_ALREADY_BOOKED: code => new ConflictException({ code, detail: 'Your child is already booked into this class.' }),
  PARENT_CLASS_BOOKING_FULL: code => new ConflictException({ code, detail: 'This class is full.' }),
  PARENT_CLASS_BOOKING_NOT_FOUND: code => new NotFoundException({ code, detail: 'The booking is not available.' }),
  PARENT_CLASS_BOOKING_NOT_CANCELLABLE: code => new ConflictException({ code, detail: 'This booking can no longer be cancelled from the parent app.' }),
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
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PARENT_CLASS_BOOKING_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_CLASS_BOOKING_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'PARENT_CLASS_BOOKING_UNAVAILABLE', detail: 'No verified class booking result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}

/** 0329 parent class booking: the parent's one live family grant decides the tenant; no school, family or child selector is trusted. */
@Injectable()
export class ParentClassBookingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (scopes.length !== 1) throw new ForbiddenException({ code: 'PARENT_CLASS_BOOKING_FORBIDDEN' });
    return scopes[0]!;
  }
  private context(scope: ResolvedParentFamilyScope) {
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId };
  }

  async choices(subject: string): Promise<ParentClassBookingChoices> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_CLASS_BOOKING_FORBIDDEN' });
    try {
      const scope = await this.scope(subject);
      return await this.database.withTenantReadOnlyTransaction(this.context(scope), async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verifyParentClassBookingChoices(await this.one(client, 'SELECT hon.read_parent_class_booking_choices($1) AS data', [subject]));
      });
    } catch (error) { return translate(error); }
  }

  async book(subject: string, value: unknown, key: unknown): Promise<{ receipt: ParentClassBookingReceipt; replayed: boolean }> {
    let input;
    try { input = validateBookParentClassSessionInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(subject, key, 'SELECT hon.book_parent_class_session($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyParentClassBookingReceipt(data, input));
  }

  async cancel(subject: string, bookingId: string, value: unknown, key: unknown): Promise<{ receipt: ParentClassBookingReceipt; replayed: boolean }> {
    let input;
    try {
      const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (Object.keys(body).join() !== 'expectedVersion') throw new Error('shape');
      input = validateCancelParentClassBookingInput({ bookingId, expectedVersion: body.expectedVersion });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(subject, key, 'SELECT hon.cancel_parent_class_booking($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifyParentClassBookingReceipt(data, { bookingId: input.bookingId }));
  }

  private async write<I>(subject: string, key: unknown, statement: string, input: I, verify: (data: unknown) => ParentClassBookingReceipt) {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_CLASS_BOOKING_FORBIDDEN' });
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
          throw new Error('Unverified parent class booking receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified parent class booking read.');
    return result.rows[0]!.data;
  }
}
