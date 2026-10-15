import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { LeadImportBatch, LeadImportContext, LeadImportOptions, LeadImportPreview, LeadImportResult, LeadImportReview, LeadImportUpload } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { closed, invalid, parseLeadCsv } from './lead-import-csv.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !UUID.test(v)) invalid(); }
function human(c: LeadImportContext): void {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
  for (const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) uuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function version(input: Record<string, unknown>): void { if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1 || (input.expectedVersion as number) > 999999999) invalid(); }
function dbError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'IMPORT_FORBIDDEN', detail: 'Live scoped human authority and an active review are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
  if (['40001','23505','55P03'].includes(code ?? '')) throw new ConflictException({ code: code === '23505' ? 'IDEMPOTENCY_KEY_REUSED' : 'IMPORT_CONFLICT', detail: 'Refresh the batch version and review. Identical retries retain their original key.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'IMPORT_TIMEOUT', detail: 'No success is assumed. Refresh metadata or retry the unchanged request with its original key.' });
  if (['22023','22P02','22P05','23514','22021','22003'].includes(code ?? '')) invalid();
  throw e;
}
@Injectable()
export class LeadImportService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async upload(c: LeadImportContext, input: LeadImportUpload): Promise<LeadImportResult> {
    human(c); const parsed = parseLeadCsv(input); uuid(input.pipelineStageId);
    return this.mutate(c,'upload',null,{...input,...parsed});
  }
  open(c: LeadImportContext,id: string,input: {expectedVersion: number}): Promise<LeadImportResult<LeadImportReview>> {
    human(c); uuid(id); closed(input,['expectedVersion']); version(input); return this.mutate(c,'open',id,input);
  }
  decide(c: LeadImportContext,id: string,input: {expectedVersion: number; reviewToken: string; decisions: {index: number;choice: 'IMPORT'|'SKIP'}[]}): Promise<LeadImportResult> {
    human(c); uuid(id); closed(input,['expectedVersion','reviewToken','decisions']); version(input); uuid(input.reviewToken);
    if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length>1000 || new Set(input.decisions.map(d=>d?.index)).size!==input.decisions.length) invalid();
    for (const d of input.decisions) { closed(d,['index','choice']); if (!Number.isInteger(d.index) || (d.index as number)<1 || (d.index as number)>1000 || !['IMPORT','SKIP'].includes(d.choice as string)) invalid(); }
    return this.mutate(c,'decide',id,input);
  }
  finalize(c: LeadImportContext,id: string,input: {expectedVersion: number;reviewToken: string;selectedIndices: number[]}): Promise<LeadImportResult> {
    human(c); uuid(id); closed(input,['expectedVersion','reviewToken','selectedIndices']); version(input); uuid(input.reviewToken);
    if (!Array.isArray(input.selectedIndices) || input.selectedIndices.length>1000 || new Set(input.selectedIndices).size!==input.selectedIndices.length || input.selectedIndices.some(x=>!Number.isInteger(x)||x<1||x>1000)) invalid();
    return this.mutate(c,'finalize',id,input);
  }
  async read(c: LeadImportContext,kind: 'LIST'|'BATCH'|'OPTIONS'|'REVIEW_ROWS',id: string|null=null,token: string|null=null): Promise<LeadImportBatch|LeadImportBatch[]|LeadImportOptions|LeadImportPreview> {
    human(c); if (!['LIST','BATCH','OPTIONS','REVIEW_ROWS'].includes(kind) || (['LIST','OPTIONS'].includes(kind) !== (id===null))) invalid();
    if (id!==null) uuid(id); if (kind==='REVIEW_ROWS') uuid(token); else if(token!==null) invalid();
    try { return await this.database.withTenantTransaction(c,async client=>{
      await this.source(client,c);
      return (await client.query('SELECT hon.read_lead_import($1,$2,$3::uuid,$4::uuid) data',[c.externalSubject,kind,id,token])).rows[0]!.data;
    }); } catch(e) { return dbError(e); }
  }
  private async source(client: import('pg').PoolClient,c: LeadImportContext): Promise<void> {
    await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
    await client.query("SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '5s'");
  }
  private async mutate<T=LeadImportBatch>(c: LeadImportContext,operation: string,id: string|null,input: object): Promise<LeadImportResult<T>> {
    if (!c.idempotencyKey || c.idempotencyKey.length>200 || c.idempotencyKey.trim()!==c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    try { return await this.database.withTenantTransaction(c,async client=>{
      await this.source(client,c);
      return (await client.query('SELECT hon.mutate_lead_import($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data',[c.externalSubject,operation,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId])).rows[0]!.data;
    }); } catch(e) { return dbError(e); }
  }
}
