import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validatePersonMembershipStartInput, verifyPersonMembershipStartOptions, verifyPersonMembershipStartReceipt, PERSON_MEMBERSHIP_START_BLOCKERS,
  type PersonMembershipStartOptions, type PersonMembershipStartReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_BLOCKERS = new Set<string>(PERSON_MEMBERSHIP_START_BLOCKERS);

/** The database's blocker list (its HINT) as known codes only; anything else becomes an empty list. */
function blockers(hint: unknown): string[] {
  try {
    const parsed: unknown = typeof hint === 'string' ? JSON.parse(hint) : null;
    return Array.isArray(parsed) && parsed.length <= KNOWN_BLOCKERS.size && parsed.every(x => typeof x === 'string' && KNOWN_BLOCKERS.has(x)) ? parsed as string[] : [];
  } catch { return []; }
}

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PERSON_MEMBERSHIP_FORBIDDEN' });
  if (sqlState === 'P0002' && message === 'PERSON_MEMBERSHIP_NOT_FOUND') throw new NotFoundException({ code: 'PERSON_MEMBERSHIP_NOT_FOUND' });
  if (sqlState === '55000' && message === 'PERSON_MEMBERSHIP_BLOCKED') {
    throw new ConflictException({ code: 'PERSON_MEMBERSHIP_BLOCKED', blockers: blockers((error as { hint?: unknown }).hint) });
  }
  if (sqlState === '40001' && message === 'MEMBERSHIP_PLAN_VERSION_STALE') throw new ConflictException({ code: 'MEMBERSHIP_PLAN_VERSION_STALE', detail: 'This plan changed. Pick it again.' });
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  if (['40001', '40P01', '55P03', '23505', '23P01'].includes(sqlState)) throw new ConflictException({ code: 'PERSON_MEMBERSHIP_CONFLICT' });
  if (['22023', '22P02', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'PERSON_MEMBERSHIP_UNAVAILABLE' });
}

/**
 * M-B (0624): what the card needs to start a membership, and the start itself. Each call re-proves the direct human subject
 * and live billing.membership.create in the database; the start repeats the exact plan version the staff member saw.
 */
@Injectable()
export class PersonMembershipStartService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async options(context: MembershipLifecycleContext, personId: string): Promise<PersonMembershipStartOptions> {
    const subject = this.subject(context);
    if (!UUID.test(personId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verifyPersonMembershipStartOptions(await this.one(client, 'SELECT hon.read_person_membership_start($1,$2::jsonb) AS data', [subject, JSON.stringify({ personId })]), personId);
      });
    } catch (error) { return translate(error); }
  }

  async start(context: MembershipLifecycleContext, personId: string, body: unknown): Promise<{ receipt: PersonMembershipStartReceipt; replayed: boolean }> {
    const subject = this.subject(context);
    let input;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'personId')) throw new Error('shape');
      input = validatePersonMembershipStartInput({ ...(body as Record<string, unknown>), personId });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const data = await this.one(client, 'SELECT hon.start_person_membership($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [subject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join() !== 'receipt,replayed'
          || typeof (data as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified membership start.');
        const d = data as { receipt: unknown; replayed: boolean };
        return { receipt: verifyPersonMembershipStartReceipt(d.receipt, input), replayed: d.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified membership start.');
    return result.rows[0]!.data;
  }

  private subject(context: MembershipLifecycleContext): string {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Starting a membership is for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'PERSON_MEMBERSHIP_FORBIDDEN' });
    return subject;
  }
}
