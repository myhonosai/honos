import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HUMAN_WORK_UUID, HUMAN_WORK_STATUSES, validateHumanWork, type HumanWorkContext, type HumanWorkInput, type HumanWorkTransition, type HumanWorkOperation, type HumanWorkQueue, type HumanWorkRecord, type HumanWorkStatus } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function workUuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !HUMAN_WORK_UUID.test(v)) invalid(); }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use closed bounded human work fields and current version.' }); }
function human(c: HumanWorkContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) workUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'WORK_FORBIDDEN', detail: 'Current exact human school authority and eligible known staff assignment are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'WORK_UNAVAILABLE', detail: 'Human work is unavailable in your current school scope.' });
  if (['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'WORK_CONFLICT', detail: 'Refresh current state, assignment and version. Retain the key for an unchanged uncertain request.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'WORK_TIMEOUT', detail: 'No success assumed. Retry unchanged with the retained key.' });
  if (['22023','22P02','22007','22008','23514','23503','22003'].includes(code ?? '')) invalid();
  throw e;
}
@Injectable()
export class WorkItemService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: HumanWorkContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return (await client.query<{ data: T }>(sql,args)).rows[0]!.data;
    }); } catch(e) { return boundaryError(e); }
  }
  list(c: HumanWorkContext, queue: 'mine' | 'team' = 'mine', status: HumanWorkStatus | 'ACTIVE' | 'ALL' = 'ACTIVE', after: string | null = null): Promise<HumanWorkQueue> {
    if (!['mine','team'].includes(queue) || ![...HUMAN_WORK_STATUSES,'ACTIVE','ALL'].includes(status)) invalid();
    if (after !== null) workUuid(after);
    return this.boundary(c,'SELECT hon.read_human_work($1,NULL,$2,$3,$4::uuid,NULL) data',[c.externalSubject,queue,status,after]);
  }
  read(c: HumanWorkContext, id: string, beforeVersion: number | null = null): Promise<HumanWorkRecord> {
    workUuid(id);
    if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 2 || beforeVersion > 999999999)) invalid();
    return this.boundary(c,"SELECT hon.read_human_work($1,$2::uuid,'mine','ALL',NULL,$3::integer) data",[c.externalSubject,id,beforeVersion]);
  }
  mutate(c: HumanWorkContext, op: HumanWorkOperation, id: string | null, input: HumanWorkInput | HumanWorkTransition): Promise<{ workItem: HumanWorkRecord; replayed: boolean }> {
    human(c); if (id !== null) workUuid(id);
    try { validateHumanWork(op,input); } catch { invalid(); }
    if ((op === 'CREATE') !== (id === null)) invalid();
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c,'SELECT hon.mutate_human_work($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data',[c.externalSubject,op,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId]);
  }
}
