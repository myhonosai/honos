import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FOLLOW_UP_UUID, validateFollowUp, type FollowUpContext, type FollowUpInput, type FollowUpTransition, type FollowUpOperation, type FollowUpQueue, type FollowUpRecord, type FollowUpStatus } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function followUpUuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !FOLLOW_UP_UUID.test(v)) invalid(); }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed bounded follow-up contract and current version.' }); }
function human(c: FollowUpContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) followUpUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'FOLLOW_UP_FORBIDDEN', detail: 'Current exact human school authority and eligible known staff assignment are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'FOLLOW_UP_UNAVAILABLE' });
  if (['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'FOLLOW_UP_CONFLICT', detail: 'Refresh current assignment and version. Retain the key for unchanged uncertain requests.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'FOLLOW_UP_TIMEOUT', detail: 'No success assumed. Retry unchanged with the retained key.' });
  if (['22023','22P02','22007','22008','23514','23503','22003'].includes(code ?? '')) invalid();
  throw e;
}
@Injectable()
export class FollowUpService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: FollowUpContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
    }); } catch (e) { return boundaryError(e); }
  }
  list(c: FollowUpContext, queue: 'mine' | 'team' = 'mine', status: FollowUpStatus | 'ALL' = 'OPEN', after: string | null = null): Promise<FollowUpQueue> {
    if (!['mine','team'].includes(queue) || !['OPEN','COMPLETED','CANCELLED','ALL'].includes(status)) invalid();
    if (after !== null) followUpUuid(after);
    return this.boundary(c, 'SELECT hon.read_follow_ups($1,NULL,$2,$3,$4::uuid) data', [c.externalSubject, queue, status, after]);
  }
  read(c: FollowUpContext, id: string): Promise<FollowUpRecord> {
    followUpUuid(id); return this.boundary(c, "SELECT hon.read_follow_ups($1,$2::uuid,'mine','ALL',NULL) data", [c.externalSubject, id]);
  }
  mutate(c: FollowUpContext, op: FollowUpOperation, id: string | null, input: FollowUpInput | FollowUpTransition): Promise<{ followUp: FollowUpRecord; replayed: boolean }> {
    human(c); if (id !== null) followUpUuid(id);
    try { validateFollowUp(op, input); } catch { invalid(); }
    if ((op === 'CREATE') !== (id === null)) invalid();
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_follow_up($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data', [c.externalSubject, op, id, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
}
