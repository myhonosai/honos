import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import {
  validateCalendarCardsQuery, validateCreateCalendarCardInput, validateMoveCalendarCardInput, verifyCalendarCards, verifyCreateCalendarCardReceipt,
  verifyMoveCalendarCardReceipt, type CalendarCards, type CreateCalendarCardReceipt, type MoveCalendarCardReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0567 error codes; every unknown database failure is unavailable, never success.
const CARD_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  CLASS_SERIES_FORBIDDEN: code => new ForbiddenException({ code }),
  CLASS_SESSIONS_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  PROGRAM_NOT_FOUND: code => new NotFoundException({ code, detail: 'The program is not available in this school.' }),
  INSTRUCTOR_NOT_FOUND: code => new NotFoundException({ code, detail: 'The instructor is not available in this school.' }),
  CALENDAR_CARD_NOT_FOUND: code => new NotFoundException({ code, detail: 'The class is not available in this school.' }),
  CALENDAR_CARD_NOT_IN_FUTURE: code => new BadRequestException({ code, detail: 'The class must start in the future.' }),
  CALENDAR_CARD_LOCKED: code => new ConflictException({ code, detail: 'This class has started, ended, been cancelled or has attendance, so it cannot be moved.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The class has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translate(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = CARD_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CALENDAR_CARD_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CALENDAR_CARDS_UNAVAILABLE' });
}

/**
 * 0567 calendar cards. Each call runs one protected definer function that re-proves the direct human subject and the live
 * school-scoped permission; the runtime has no privilege on the tables and no UPDATE on class sessions. Moving a class never
 * contacts the families booked into it.
 */
@Injectable()
export class CalendarCardsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext, value: unknown): Promise<CalendarCards> {
    this.assertHumanContext(context, 'CLASS_SESSIONS_READ_FORBIDDEN', false);
    const query = this.validated(() => validateCalendarCardsQuery(value));
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_calendar_cards($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(query)]);
        if (result.rows.length !== 1) throw new Error('Unverified calendar cards.');
        return verifyCalendarCards(result.rows[0]!.data, query);
      });
    } catch (error) { return translate(error, 'CLASS_SESSIONS_READ_FORBIDDEN'); }
  }

  async create(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: CreateCalendarCardReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    const input = this.validated(() => validateCreateCalendarCardInput(value));
    return this.write(context, 'SELECT hon.create_calendar_card($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], verifyCreateCalendarCardReceipt);
  }

  async move(context: MembershipLifecycleContext, sessionId: string, value: unknown): Promise<{ receipt: MoveCalendarCardReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    if (!UUID.test(sessionId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateMoveCalendarCardInput(value));
    return this.write(context, 'SELECT hon.move_calendar_card($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, sessionId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyMoveCalendarCardReceipt(data, { sessionId, input }));
  }

  private async write<R>(context: MembershipLifecycleContext, statement: string, values: unknown[],
    verify: (data: unknown) => R): Promise<{ receipt: R; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified calendar card receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error, 'CLASS_SERIES_FORBIDDEN'); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Calendar cards accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: forbidden });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
