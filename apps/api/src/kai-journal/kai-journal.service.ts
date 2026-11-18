import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isKaiJournalRange, validateSaveKaiJournalEntryInput, verifyKaiJournalRead, verifyKaiJournalReceipt, verifyKaiTeamJournalRead, type KaiJournalRead, type KaiJournalReceipt, type KaiTeamJournalRead } from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0497 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  KAI_JOURNAL_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  KAI_JOURNAL_ENTRY_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  KAI_JOURNAL_ENTRY_REMOVED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'A removed entry cannot change. Add a new entry instead.' }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The entry has changed. Reload the journal and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'KAI_JOURNAL_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'KAI_JOURNAL_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'KAI_JOURNAL_UNAVAILABLE' });
}

/**
 * 0497: the Kai teaching journal (KJ1). Each read and save is one protected definer call that re-proves the direct human
 * subject, teaching.journal.use and Complete access. An instructor reads and changes only their own entries, and reads, never
 * changes, the entries other instructors at the same school chose to share. No AI runs here.
 */
@Injectable()
export class KaiJournalService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext, from: string, to: string): Promise<KaiJournalRead> {
    this.assertHumanContext(context, false);
    if (!isKaiJournalRange(from, to)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_kai_journal($1,$2::date,$3::date) AS data', [context.externalSubject, from, to]);
        if (result.rows.length !== 1) throw new Error('Unverified Kai journal read.');
        return verifyKaiJournalRead(result.rows[0]!.data, { from, to });
      });
    } catch (error) { return translate(error); }
  }

  /** Entries other instructors at this school shared with the teaching team (read-only, display names only). */
  async readTeam(context: MembershipLifecycleContext, from: string, to: string): Promise<KaiTeamJournalRead> {
    this.assertHumanContext(context, false);
    if (!isKaiJournalRange(from, to)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_kai_team_journal($1,$2::date,$3::date) AS data', [context.externalSubject, from, to]);
        if (result.rows.length !== 1) throw new Error('Unverified Kai team journal read.');
        return verifyKaiTeamJournalRead(result.rows[0]!.data, { from, to });
      });
    } catch (error) { return translate(error); }
  }

  async save(context: MembershipLifecycleContext, value: unknown): Promise<KaiJournalReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSaveKaiJournalEntryInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.save_kai_journal_entry($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified Kai journal receipt.');
        // A save (or its exact replay, which carries the same expected version) produces the next version of the same entry.
        return verifyKaiJournalReceipt(result.rows[0]!.data, input);
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The teaching journal accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'KAI_JOURNAL_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
