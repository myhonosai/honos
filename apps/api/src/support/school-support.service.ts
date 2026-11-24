import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateSupportMessageInput, validateSupportSubmitInput, verifySupportRequest, verifySupportRequestList, type SupportRequest, type SupportRequestList,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type SchoolSupportContext = MembershipLifecycleContext;

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, [string[], (code: string) => HttpException]> = {
  SUPPORT_INVALID: [['22023'], code => new BadRequestException({ code, detail: 'Choose a topic and write a subject (3 to 200 characters) and a message (up to 4,000).' })],
  SUPPORT_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Support request permission at this school is required.' })],
  SUPPORT_BUSY: [['55P03'], code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' })],
  IDEMPOTENCY_KEY_REUSED: [['23505'], code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' })],
  SUPPORT_RATE_LIMITED: [['54000'], code => new HttpException({ code, detail: 'This school reached today\'s support limit. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS)],
  SUPPORT_REQUEST_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SUPPORT_REQUEST_CLOSED: [['23514'], code => new ConflictException({ code, detail: 'This request is closed. Ask a new question instead.' })],
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known[0].includes(sqlState)) throw known[1](message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SUPPORT_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'SUPPORT_INVALID' });
  throw new ServiceUnavailableException({ code: 'SUPPORT_UNAVAILABLE', detail: 'Nothing is assumed sent. Reload, or retry the unchanged request with the same key.' });
}
function receipt(data: Record<string, unknown> | undefined, rows: number): { request: SupportRequest; replayed: boolean } {
  if (rows !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified support receipt.');
  return { request: verifySupportRequest(data.record), replayed: data.replayed };
}

/**
 * School support requests (0335). Each call runs one protected definer function that re-proves the direct human subject
 * and live support.request at the session school. A request becomes an OPEN HQ support case for that exact school.
 * Deliberately no active-entitlement requirement (owner decision D3): a school may contact support before access starts.
 */
@Injectable()
export class SchoolSupportService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: SchoolSupportContext): Promise<SupportRequestList> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verifySupportRequestList((await client.query<{ data: unknown }>('SELECT hon.read_school_support_requests($1) AS data', [context.externalSubject])).rows[0]?.data);
      });
    } catch (error) { return translate(error); }
  }

  async submit(context: SchoolSupportContext, value: unknown): Promise<{ request: SupportRequest; replayed: boolean }> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSupportSubmitInput(value); } catch { throw new BadRequestException({ code: 'SUPPORT_INVALID' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: Record<string, unknown> }>('SELECT hon.submit_school_support_request($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        return receipt(r.rows[0]?.data, r.rows.length);
      });
    } catch (error) { return translate(error); }
  }

  async message(context: SchoolSupportContext, requestId: string, value: unknown): Promise<{ request: SupportRequest; replayed: boolean }> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSupportMessageInput(value); } catch { throw new BadRequestException({ code: 'SUPPORT_INVALID' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const r = await client.query<{ data: Record<string, unknown> }>('SELECT hon.add_school_support_message($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, requestId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const result = receipt(r.rows[0]?.data, r.rows.length);
        if (result.request.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('Unverified support receipt.');
        return result;
      });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: SchoolSupportContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SUPPORT_FORBIDDEN' });
  }
}
