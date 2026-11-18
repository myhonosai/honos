import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  isStaffShiftWeekStart, validateSaveTimeEntry, validateTimeClockPunch, validateTimesheetDecision, verifyMyTimeClock, verifyTimeEntryReceipt,
  verifyTimesheetDecisionReceipt, verifyTimesheetWeek, type MyTimeClock, type TimeEntryReceipt, type TimesheetDecisionReceipt, type TimesheetWeek,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const stale = 'Your time clock changed. Reload and try again.';
// Exact 0478 + 0495 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  STAFF_TIME_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  STAFF_MEMBER_UNAVAILABLE: { states: ['42501'], make: code => new ForbiddenException({ code, detail: 'This person is not current staff at this school.' }) },
  TIMESHEET_SELF_APPROVAL: { states: ['42501'], make: code => new ForbiddenException({ code, detail: 'You cannot approve your own week. Ask the owner or another manager.' }) },
  TIME_ENTRY_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  TIME_CLOCK_STATE_CHANGED: { states: ['55000'], make: code => new ConflictException({ code, detail: stale }) },
  TIME_ENTRY_TOO_LONG: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This entry is over 24 hours. Ask a manager to fix it.' }) },
  TIMESHEET_APPROVED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This week is approved. A manager must reopen it first.' }) },
  TIMESHEET_HAS_OPEN_ENTRY: { states: ['55000'], make: code => new ConflictException({ code, detail: 'Someone is still clocked in this week.' }) },
  TIME_ENTRY_OVERLAP: { states: ['23P01'], make: code => new ConflictException({ code, detail: 'This overlaps another entry for this person.' }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'This changed. Reload and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'STAFF_TIME_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'STAFF_TIME_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'STAFF_TIME_UNAVAILABLE' });
}
function unverified(): never { throw new Error('Unverified staff time answer.'); }

/**
 * 0478: the staff time clock and timesheets. Each read and command is one protected definer call that re-proves the direct
 * human subject and the live permission. Punch times come from the database clock; the device clock is never sent.
 */
@Injectable()
export class StaffTimeService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async myClock(context: MembershipLifecycleContext): Promise<MyTimeClock> {
    this.assertHumanContext(context, false);
    return this.read(context, 'SELECT hon.read_my_time_clock($1) AS data', [context.externalSubject], verifyMyTimeClock);
  }

  async timesheet(context: MembershipLifecycleContext, weekStart: string): Promise<TimesheetWeek> {
    this.assertHumanContext(context, false);
    if (!isStaffShiftWeekStart(weekStart)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, 'SELECT hon.read_staff_timesheet_week($1,$2::date) AS data', [context.externalSubject, weekStart],
      value => verifyTimesheetWeek(value, { weekStart }));
  }

  async punch(context: MembershipLifecycleContext, value: unknown): Promise<TimeEntryReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateTimeClockPunch(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, 'staff_time_clock_punch', input, data => {
      const receipt = verifyTimeEntryReceipt(data, { version: input.expectedVersion + 1, closed: input.action === 'CLOCK_OUT' });
      if (receipt.entry.origin !== 'CLOCK' && input.action === 'CLOCK_IN') unverified();
      return receipt;
    });
  }

  async saveEntry(context: MembershipLifecycleContext, value: unknown): Promise<TimeEntryReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSaveTimeEntry(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, 'save_staff_time_entry', input, data =>
      verifyTimeEntryReceipt(data, { version: input.expectedVersion + 1, closed: true, entryId: input.entryId, staffPrincipalId: input.staffPrincipalId }));
  }

  async decide(context: MembershipLifecycleContext, value: unknown): Promise<TimesheetDecisionReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateTimesheetDecision(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, 'set_staff_timesheet_week', input, data => verifyTimesheetDecisionReceipt(data, input));
  }

  private async read<T>(context: MembershipLifecycleContext, sql: string, params: unknown[], verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(sql, params);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private async write<T>(context: MembershipLifecycleContext, fn: 'staff_time_clock_punch' | 'save_staff_time_entry' | 'set_staff_timesheet_week', input: object, verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(`SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The time clock accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'STAFF_TIME_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
