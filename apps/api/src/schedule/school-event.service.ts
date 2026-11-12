import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import {
  isPublicEventId, normalizeEventBookingCode, validatePublicEventBookingInput, validateSaveSchoolEventInput, validateSetSchoolEventBookingStatusInput,
  validateSetSchoolEventStatusInput, verifyPublicEventBookingOutcome, verifyPublicEventCancelOutcome, verifyPublicSchoolEvent, verifySchoolEventBookingReceipt,
  verifySchoolEventDetail, verifySchoolEventReceipt, verifySchoolEvents,
  type PublicEventBookingOutcome, type PublicEventCancelResult, type PublicSchoolEvent, type SchoolEventBookingReceipt, type SchoolEventDetail,
  type SchoolEventReceipt, type SchoolEvents,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0261 error codes; every unknown database failure is unavailable, never success.
const EVENT_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  CLASS_SERIES_FORBIDDEN: () => new ForbiddenException({ code: 'SCHOOL_EVENT_FORBIDDEN' }),
  SCHOOL_EVENT_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_EVENT_NOT_FOUND: code => new NotFoundException({ code, detail: 'The event is not available in this school.' }),
  SCHOOL_EVENT_BOOKING_NOT_FOUND: code => new NotFoundException({ code, detail: 'The booking is not available in this school.' }),
  SCHOOL_EVENT_DATE_OUT_OF_RANGE: code => new UnprocessableEntityException({ code, detail: 'Events can be set from today up to 365 days ahead.' }),
  SCHOOL_EVENT_NO_SLOTS: code => new UnprocessableEntityException({ code, detail: 'This event has no time slots left to book.' }),
  SCHOOL_EVENT_SCHEDULE_LOCKED: code => new ConflictException({ code, detail: 'The date and times are fixed once the event is published.' }),
  SCHOOL_EVENT_SPOTS_BELOW_BOOKED: code => new ConflictException({ code, detail: 'Spots per slot cannot go below the most-booked slot.' }),
  SCHOOL_EVENT_CANCELLED: code => new ConflictException({ code, detail: 'This event was cancelled.' }),
  SCHOOL_EVENT_STATUS_INVALID: code => new ConflictException({ code, detail: 'The event cannot move to that status.' }),
  SCHOOL_EVENT_BOOKING_STATUS_INVALID: code => new ConflictException({ code, detail: 'The booking cannot move to that status.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = EVENT_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_EVENT_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_EVENT_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_EVENT_UNAVAILABLE' });
}

/**
 * B-SCH-3 (0261): school events with bookable time slots. Staff calls run one protected definer function that re-proves
 * the direct human subject and live schedule.session.manage; public calls run the fixed public functions as the restricted
 * runtime, which hold the publish, entitlement, capacity, one-per-family and rate rules. No message, charge, lead or AI.
 */
@Injectable()
export class SchoolEventService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext): Promise<SchoolEvents> {
    this.assertHumanContext(context, false);
    return this.read(context, async client => verifySchoolEvents(await this.one(client, 'SELECT hon.read_school_events($1) AS data', [context.externalSubject])));
  }

  async detail(context: MembershipLifecycleContext, eventId: string): Promise<SchoolEventDetail> {
    this.assertHumanContext(context, false);
    if (!UUID.test(eventId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, async client => verifySchoolEventDetail(await this.one(client, 'SELECT hon.read_school_event($1,$2::uuid) AS data', [context.externalSubject, eventId]), eventId));
  }

  async save(context: MembershipLifecycleContext, eventId: string | null, value: unknown): Promise<{ receipt: SchoolEventReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    if (eventId !== null && !UUID.test(eventId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateSaveSchoolEventInput(value));
    if ((eventId === null) !== (input.expectedVersion === 0)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.write(context, 'SELECT hon.save_school_event($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, eventId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolEventReceipt(data, eventId ? { eventId } : {}));
  }

  async setStatus(context: MembershipLifecycleContext, eventId: string, value: unknown): Promise<{ receipt: SchoolEventReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    if (!UUID.test(eventId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateSetSchoolEventStatusInput(value));
    return this.write(context, 'SELECT hon.set_school_event_status($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, eventId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolEventReceipt(data, { eventId }));
  }

  async setBookingStatus(context: MembershipLifecycleContext, bookingId: string, value: unknown): Promise<{ receipt: SchoolEventBookingReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    if (!UUID.test(bookingId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateSetSchoolEventBookingStatusInput(value));
    return this.write(context, 'SELECT hon.set_school_event_booking_status($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, bookingId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolEventBookingReceipt(data, { bookingId }));
  }

  /** Public read: null when the link is unknown, a draft, or the school has no live access. */
  async published(publicId: string): Promise<PublicSchoolEvent | null> {
    if (!isPublicEventId(publicId)) return null;
    try {
      const data = await this.database.runPublicEventCall('SELECT hon.read_public_school_event($1) AS data', [publicId]);
      return data === null ? null : verifyPublicSchoolEvent(data, publicId);
    } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }

  async book(publicId: string, value: unknown, key: unknown): Promise<PublicEventBookingOutcome> {
    if (!isPublicEventId(publicId) || typeof key !== 'string' || !PUBLIC_KEY.test(key)) return { result: 'INVALID' };
    let input;
    try { input = validatePublicEventBookingInput(value); } catch { return { result: 'INVALID' }; }
    try {
      return verifyPublicEventBookingOutcome(await this.database.runPublicEventCall('SELECT hon.book_public_school_event($1,$2::jsonb,$3) AS data', [publicId, JSON.stringify(input), key]));
    } catch { return { result: 'UNAVAILABLE' }; } // Never propagate PostgreSQL detail, contact or booking state.
  }

  async cancel(publicId: string, value: unknown): Promise<PublicEventCancelResult> {
    if (!isPublicEventId(publicId) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'code') return 'INVALID';
    let code: string;
    try { code = normalizeEventBookingCode((value as { code: unknown }).code); } catch { return 'INVALID'; }
    try {
      return verifyPublicEventCancelOutcome(await this.database.runPublicEventCall('SELECT hon.cancel_public_school_event_booking($1,$2::jsonb) AS data', [publicId, JSON.stringify({ code })]));
    } catch { return 'UNAVAILABLE'; }
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified school event read.');
    return result.rows[0]!.data;
  }

  private async read<T>(context: MembershipLifecycleContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error); }
  }

  private async write<R>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => R): Promise<{ receipt: R; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school event receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'School events accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_EVENT_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
