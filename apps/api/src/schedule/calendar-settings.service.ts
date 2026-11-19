import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import {
  SHARE_CALENDAR_PUBLIC_ID, validateCalendarBlockOutInput, validateCalendarBlockOutsQuery, validateCalendarShareSettingsInput, validateCalendarVersionInput,
  validateShareCalendarInput, verifyCalendarBlockOutReceipt, verifyCalendarBlockOutRemoveReceipt, verifyCalendarBlockOuts, verifyCalendarSettings,
  verifyCalendarShareSettingsReceipt, verifyPublicShareCalendar, verifyShareCalendarDeleteReceipt, verifyShareCalendarReceipt,
  type CalendarBlockOuts, type CalendarSettings, type PublicShareCalendar,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0583 error codes; every unknown database failure is unavailable, never success.
const SETTINGS_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  CLASS_SERIES_FORBIDDEN: code => new ForbiddenException({ code }),
  CLASS_SESSIONS_READ_FORBIDDEN: code => new ForbiddenException({ code }),
  PROGRAM_NOT_FOUND: code => new NotFoundException({ code, detail: 'The program is not available in this school.' }),
  CALENDAR_SETTINGS_NOT_FOUND: code => new NotFoundException({ code, detail: 'That block-out or calendar is not available in this school.' }),
  CALENDAR_SETTINGS_LIMIT: code => new ConflictException({ code, detail: 'This school already has the most block-outs or shared calendars allowed.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This setting has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = SETTINGS_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '54000'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CALENDAR_SETTINGS_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CALENDAR_SETTINGS_UNAVAILABLE' });
}

/**
 * 0583 calendar settings. Each staff call runs one protected definer function that re-proves the direct human subject and the
 * live school-scoped permission; the runtime has no privilege on the tables. The public read takes the link id alone.
 */
@Injectable()
export class CalendarSettingsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext): Promise<CalendarSettings> {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', false);
    return this.readOne(context, 'SELECT hon.read_calendar_settings($1) AS data', [context.externalSubject], verifyCalendarSettings, 'CLASS_SERIES_FORBIDDEN');
  }

  async blockOuts(context: MembershipLifecycleContext, value: unknown): Promise<CalendarBlockOuts> {
    this.assertHumanContext(context, 'CLASS_SESSIONS_READ_FORBIDDEN', false);
    const query = this.validated(() => validateCalendarBlockOutsQuery(value));
    return this.readOne(context, 'SELECT hon.read_school_calendar_block_outs($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(query)],
      data => verifyCalendarBlockOuts(data, query), 'CLASS_SESSIONS_READ_FORBIDDEN');
  }

  async saveSettings(context: MembershipLifecycleContext, value: unknown) {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    const input = this.validated(() => validateCalendarShareSettingsInput(value));
    return this.write(context, 'SELECT hon.save_calendar_share_settings($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyCalendarShareSettingsReceipt(data, input));
  }

  async addBlockOut(context: MembershipLifecycleContext, value: unknown) {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    const input = this.validated(() => validateCalendarBlockOutInput(value));
    return this.write(context, 'SELECT hon.save_calendar_block_out($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyCalendarBlockOutReceipt(data, input));
  }

  async removeBlockOut(context: MembershipLifecycleContext, blockOutId: string, value: unknown) {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    if (!UUID.test(blockOutId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateCalendarVersionInput(value));
    return this.write(context, 'SELECT hon.remove_calendar_block_out($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, blockOutId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyCalendarBlockOutRemoveReceipt(data, { blockOutId, input }));
  }

  async saveShareCalendar(context: MembershipLifecycleContext, shareCalendarId: string | null, value: unknown) {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    if (shareCalendarId !== null && !UUID.test(shareCalendarId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateShareCalendarInput(value, shareCalendarId !== null));
    return this.write(context, 'SELECT hon.save_share_calendar($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, shareCalendarId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyShareCalendarReceipt(data, { shareCalendarId, input }));
  }

  async deleteShareCalendar(context: MembershipLifecycleContext, shareCalendarId: string, value: unknown) {
    this.assertHumanContext(context, 'CLASS_SERIES_FORBIDDEN', true);
    if (!UUID.test(shareCalendarId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const input = this.validated(() => validateCalendarVersionInput(value));
    return this.write(context, 'SELECT hon.delete_share_calendar($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, shareCalendarId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyShareCalendarDeleteReceipt(data, { shareCalendarId, input }));
  }

  /** The public read: null when the link is unknown, switched off, deleted or its school is not live. */
  async published(publicId: string): Promise<PublicShareCalendar | null> {
    if (typeof publicId !== 'string' || !SHARE_CALENDAR_PUBLIC_ID.test(publicId)) return null;
    try {
      const data = await this.database.runPublicEventCall('SELECT hon.read_public_share_calendar($1) AS data', [publicId]);
      return data === null ? null : verifyPublicShareCalendar(data, publicId);
    } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }

  private async readOne<R>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => R, forbidden: string): Promise<R> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified calendar settings.');
        return verify(result.rows[0]!.data);
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
          throw new Error('Unverified calendar settings receipt.');
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Calendar settings accept only direct human commands.' });
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
