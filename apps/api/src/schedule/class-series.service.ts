import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import {
  validateCreateClassSeriesInput, validateEndClassSeriesInput, validateFillClassSeriesInput, validateReviseClassSeriesInput, validateSetClassSeriesOngoingInput,
  validateTimetableQuery, validateTopUpClassSeriesInput, verifyClassSeriesReceipt, verifyClassSeriesTopUpReceipt, verifySchoolClassSeries, verifyWeeklyTimetable,
  type ClassSeriesReceipt, type ClassSeriesTopUpReceipt, type SchoolClassSeries, type WeeklyTimetable,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0239 error codes; every unknown database failure is unavailable, never success.
const SERIES_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  CLASS_SERIES_FORBIDDEN: code => new ForbiddenException({ code }),
  CLASS_SESSIONS_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  CLASS_SERIES_NOT_FOUND: code => new NotFoundException({ code, detail: 'The class series is not available in this school.' }),
  PROGRAM_NOT_FOUND: code => new NotFoundException({ code, detail: 'The program is not available in this school.' }),
  CLASS_SERIES_ENDED: code => new ConflictException({ code, detail: 'This class series has ended.' }),
  CLASS_SERIES_FILL_TOO_FAR: code => new UnprocessableEntityException({ code, detail: 'Sessions can be created from today up to 12 weeks ahead.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The class series has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translate(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = SERIES_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CLASS_SERIES_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CLASS_SERIES_UNAVAILABLE' });
}

/**
 * B-SCH-1 (0239): weekly class series in school time and the weekly timetable. Each call runs one protected definer function
 * that re-proves the direct human subject and the live school-scoped permission; the runtime has no privilege on the series
 * tables and no UPDATE on class sessions. Sessions are created only by an explicit staff fill, an ongoing switch or the
 * page's top-up of ongoing series (0251); nothing here runs on a timer, contacts anyone, or charges.
 */
@Injectable()
export class ClassSeriesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext): Promise<SchoolClassSeries> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', false);
    return this.read(context, 'CLASS_SERIES_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_school_class_series($1) AS data', [context.externalSubject]);
      if (result.rows.length !== 1) throw new Error('Unverified class series.');
      return verifySchoolClassSeries(result.rows[0]!.data);
    });
  }

  async timetable(context: MembershipLifecycleContext, value: unknown): Promise<WeeklyTimetable> {
    this.assertHumanContext(context, 'CLASS_SESSIONS_READ_FORBIDDEN', false);
    const query = this.validated(() => validateTimetableQuery(value));
    return this.read(context, 'CLASS_SESSIONS_READ_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_school_weekly_timetable($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(query)]);
      if (result.rows.length !== 1) throw new Error('Unverified timetable.');
      return verifyWeeklyTimetable(result.rows[0]!.data, query);
    });
  }

  async create(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ClassSeriesReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    const input = this.validated(() => validateCreateClassSeriesInput(value));
    return this.write(context, 'SELECT hon.create_class_series($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], data => verifyClassSeriesReceipt(data, {}));
  }

  async revise(context: MembershipLifecycleContext, seriesId: string, value: unknown) { return this.seriesCommand(context, 'revise_class_series', seriesId, () => validateReviseClassSeriesInput(value)); }
  async end(context: MembershipLifecycleContext, seriesId: string, value: unknown) { return this.seriesCommand(context, 'end_class_series', seriesId, () => validateEndClassSeriesInput(value)); }
  async fill(context: MembershipLifecycleContext, seriesId: string, value: unknown) { return this.seriesCommand(context, 'fill_class_series', seriesId, () => validateFillClassSeriesInput(value)); }
  async setOngoing(context: MembershipLifecycleContext, seriesId: string, value: unknown) { return this.seriesCommand(context, 'set_class_series_ongoing', seriesId, () => validateSetClassSeriesOngoingInput(value)); }

  async topUp(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ClassSeriesTopUpReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    const input = this.validated(() => validateTopUpClassSeriesInput(value));
    return this.write(context, 'SELECT hon.top_up_class_series($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], verifyClassSeriesTopUpReceipt);
  }

  private async seriesCommand(context: MembershipLifecycleContext, fn: 'revise_class_series' | 'end_class_series' | 'fill_class_series' | 'set_class_series_ongoing', seriesId: string,
    validate: () => unknown): Promise<{ receipt: ClassSeriesReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    if (!UUID.test(seriesId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(validate);
    return this.write(context, `SELECT hon.${fn}($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data`,
      [context.externalSubject, seriesId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyClassSeriesReceipt(data, { seriesId }));
  }

  private async read<T>(context: MembershipLifecycleContext, forbidden: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translate(error, forbidden); }
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
          throw new Error('Unverified class series receipt.');
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Class series accept only direct human commands.' });
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
