import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AcknowledgeDocumentInput, CreateDocumentTemplateInput, CreateDocumentVersionInput, DocumentAcknowledgementEvidence, DocumentActionCode, DocumentCommandContext, DocumentMutationResult, DocumentPublicationRecord, DocumentTemplateRecord, DocumentVersionRecord, PublishDocumentInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only the closed bounded internal document contract is accepted.' }); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function text(value: unknown, max: number, multiline = false): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) invalid(); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid(); }
function version(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999999999) invalid(); }
function human(c: DocumentCommandContext): void {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId || !['STAFF','PARENT'].includes(c.audienceMode)) throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Direct verified human UI sessions only; no AI, Action Engine, automation, integration or delegation.' });
  for (const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) uuid(id);
  text(c.externalSubject,200);
}
function error(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'Live scoped human document authority is required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', detail: 'This document or evidence is unavailable in your scope.' });
  if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT', detail: 'Refresh the document: stale, superseded or already acknowledged content cannot be changed.' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The key was used for a different command.' });
  if (code === '55P03') throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'An identical command is in progress.' });
  if (['22023','22P02','23514','22021'].includes(code ?? '')) invalid();
  throw e;
}
@Injectable()
export class DocumentService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  create(c: DocumentCommandContext, input: CreateDocumentTemplateInput): Promise<DocumentMutationResult<DocumentTemplateRecord>> {
    human(c); object(input,['title','content','audience','familyId']); text(input.title,200); text(input.content,100000,true);
    if (c.audienceMode !== 'STAFF') throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    if (input.audience === 'PARENT') uuid(input.familyId); else if (input.audience !== 'STAFF' || 'familyId' in input) invalid();
    return this.mutate(c,'document.template.create',null,input);
  }
  version(c: DocumentCommandContext, id: string, input: CreateDocumentVersionInput): Promise<DocumentMutationResult<DocumentTemplateRecord>> {
    human(c); uuid(id); object(input,['expectedVersion','title','content']); version(input.expectedVersion); text(input.title,200); text(input.content,100000,true);
    return this.mutate(c,'document.template.version',id,input);
  }
  publish(c: DocumentCommandContext, id: string, input: PublishDocumentInput): Promise<DocumentMutationResult<DocumentTemplateRecord>> {
    human(c); uuid(id); object(input,['expectedVersion','versionId']); version(input.expectedVersion); uuid(input.versionId);
    return this.mutate(c,'document.publish',id,input);
  }
  acknowledge(c: DocumentCommandContext, publicationId: string, input: AcknowledgeDocumentInput): Promise<DocumentMutationResult<DocumentAcknowledgementEvidence>> {
    human(c); uuid(publicationId); object(input,['contentHash','choice','attestationText']);
    if (typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash) || input.choice !== 'ACKNOWLEDGE') invalid();
    if ('attestationText' in input) text(input.attestationText,500);
    return this.mutate(c,'document.acknowledge',publicationId,input);
  }
  async read(c: DocumentCommandContext, kind: 'TEMPLATE' | 'VERSION' | 'PUBLICATION' | 'LIST' | 'EVIDENCE', id: string | null, limit = 50): Promise<DocumentTemplateRecord | DocumentVersionRecord | DocumentPublicationRecord | DocumentPublicationRecord[] | DocumentAcknowledgementEvidence> {
    human(c); if (id !== null) uuid(id); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (kind === 'LIST') !== (id === null)) invalid();
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
      return (await client.query('SELECT hon.read_documents($1,$2,$3,$4::uuid,$5) AS data',[c.externalSubject,c.audienceMode,kind,id,limit])).rows[0]!.data;
    }); } catch(e) { return error(e); }
  }
  private async mutate<T extends DocumentTemplateRecord | DocumentAcknowledgementEvidence>(c: DocumentCommandContext, action: DocumentActionCode, id: string | null, input: object): Promise<DocumentMutationResult<T>> {
    if (!c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A bounded Idempotency-Key is required.' });
    if (c.audienceMode === 'PARENT' && action !== 'document.acknowledge') throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
      return (await client.query('SELECT hon.mutate_document($1,$2,$3,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) AS data',[c.externalSubject,c.audienceMode,action,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId])).rows[0]!.data;
    }); } catch(e) { return error(e); }
  }
}
