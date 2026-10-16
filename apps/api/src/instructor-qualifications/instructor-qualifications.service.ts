import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateCreateInstructorQualification, validateInstructorQualificationUuid, validateRecordInstructorQualificationEvidence,
  validateRetireInstructorQualification, validateReviewInstructorQualificationEvidence,
  type CreateInstructorQualificationInput, type InstructorQualificationAccess, type InstructorQualificationContext,
  type InstructorQualificationDefinition, type InstructorQualificationEvidence, type RecordInstructorQualificationEvidenceInput,
  type RetireInstructorQualificationInput, type ReviewInstructorQualificationEvidenceInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use exact known staff/course-program/qualification UUIDs, bounded internal evidence, and the current expected version.' }); }
function directHuman(context: InstructorQualificationContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'Only a direct human staff workbench command is accepted.' });
  for (const id of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) validateInstructorQualificationUuid(id);
  if (typeof context.externalSubject !== 'string' || context.externalSubject.length < 1 || context.externalSubject.length > 200) invalid();
}
function key(context: InstructorQualificationContext): void {
  if (typeof context.idempotencyKey !== 'string' || context.idempotencyKey.length < 1 || context.idempotencyKey.length > 200 || context.idempotencyKey.trim() !== context.idempotencyKey || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) invalid();
}
function db(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'INSTRUCTOR_QUALIFICATION_FORBIDDEN', detail: 'Current direct-human school scope, exact permission, active entitlement, and known active staff record are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE', detail: 'That known staff, course-program, qualification, or evidence identifier is unavailable in the current school.' });
  if (['40001', '40P01', '55P03', '23505', '23514'].includes(code ?? '')) throw new ConflictException({ code: 'INSTRUCTOR_QUALIFICATION_CONFLICT', detail: 'The current record, lifecycle, expected version, or retry key changed. Refresh, then retry unchanged only with the retained key.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'INSTRUCTOR_QUALIFICATION_TIMEOUT', detail: 'No result is assumed. Retry the unchanged command with its original key.' });
  if (['22023', '22P02', '22007', '22008', '22003'].includes(code ?? '')) invalid();
  throw new ServiceUnavailableException({ code: 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE', detail: 'No verified instructor qualification result is available.' });
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }
const uuid = (v: unknown) => { try { validateInstructorQualificationUuid(v); return true; } catch { return false; } };
function version(v: unknown, zero = false): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= (zero ? 0 : 1) && v <= 999_999_999; }
function parseDefinition(value: unknown): InstructorQualificationDefinition {
  if (!exact(value, ['id','code','title','kind','courseProgramId','version','status','humanRecordedOnly','qualificationOnly'])) throw new Error('Unsafe qualification response.');
  const x = value as Record<string, unknown>;
  if (!uuid(x.id) || typeof x.code !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(x.code) || typeof x.title !== 'string' || !x.title || x.title.length > 120 || !['QUALIFICATION','CERTIFICATION'].includes(String(x.kind)) || !(x.courseProgramId === null || uuid(x.courseProgramId)) || !version(x.version) || !['ACTIVE','RETIRED'].includes(String(x.status)) || x.humanRecordedOnly !== true || x.qualificationOnly !== true) throw new Error('Unsafe qualification response.');
  return x as unknown as InstructorQualificationDefinition;
}
function parseEvidence(value: unknown, staffId: string): InstructorQualificationEvidence {
  const keys = ['id','staffPrincipalId','qualificationId','qualificationVersion','courseProgramId','kind','attainedOn','expiresOn','evidenceRecordedAt','evidenceRecorded','reviewVersion','reviewStatus','reviewedAt','expiredOnRead','humanRecordedOnly','qualificationOnly','notEligibility'];
  if (!exact(value, keys)) throw new Error('Unsafe redacted evidence response.'); const x = value as Record<string, unknown>;
  if (!uuid(x.id) || x.staffPrincipalId !== staffId || !uuid(x.qualificationId) || !version(x.qualificationVersion) || !(x.courseProgramId === null || uuid(x.courseProgramId)) || !['QUALIFICATION','CERTIFICATION'].includes(String(x.kind)) || typeof x.attainedOn !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(x.attainedOn) || !(x.expiresOn === null || typeof x.expiresOn === 'string') || typeof x.evidenceRecordedAt !== 'string' || typeof x.reviewedAt !== 'string' || !Number.isFinite(Date.parse(x.evidenceRecordedAt)) || !Number.isFinite(Date.parse(x.reviewedAt)) || x.evidenceRecorded !== true || !version(x.reviewVersion) || !['RECORDED','REVIEWED','RETIRED'].includes(String(x.reviewStatus)) || typeof x.expiredOnRead !== 'boolean' || x.humanRecordedOnly !== true || x.qualificationOnly !== true || x.notEligibility !== true) throw new Error('Unsafe redacted evidence response.');
  return x as unknown as InstructorQualificationEvidence;
}
function parseAccess(value: unknown): InstructorQualificationAccess {
  if (!exact(value, ['canRead','canManage','humanRecordedOnly','qualificationOnly'])) throw new Error('Unsafe qualification access response.'); const x=value as Record<string, unknown>;
  if (x.canRead !== true || typeof x.canManage !== 'boolean' || x.humanRecordedOnly !== true || x.qualificationOnly !== true) throw new Error('Unsafe qualification access response.');
  return x as unknown as InstructorQualificationAccess;
}

@Injectable()
export class InstructorQualificationsService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(context: InstructorQualificationContext, sql: string, args: unknown[], writing = false): Promise<T> {
    directHuman(context);
    try {
      const work = async (client: import('pg').PoolClient): Promise<T> => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
        await client.query(writing ? "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'" : "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
        const result = await client.query<{ data: T }>(sql, args); if (!result.rows[0]) throw new Error('Empty instructor qualification boundary response.'); return result.rows[0].data;
      };
      return writing
        ? await this.database.withTenantTransaction(context, work)
        : await this.database.withTenantReadOnlyTransaction(context, work);
    } catch (error) { return db(error); }
  }
  async access(context: InstructorQualificationContext): Promise<InstructorQualificationAccess> {
    const raw = await this.boundary<unknown>(context, "SELECT hon.read_instructor_qualification($1,'ACCESS',NULL,NULL) data", [context.externalSubject]); return parseAccess(raw);
  }
  async qualification(context: InstructorQualificationContext, qualificationId: string): Promise<InstructorQualificationDefinition> {
    validateInstructorQualificationUuid(qualificationId); const raw = await this.boundary<unknown>(context, "SELECT hon.read_instructor_qualification($1,'QUALIFICATION',NULL,$2::uuid) data", [context.externalSubject, qualificationId]); return parseDefinition(raw);
  }
  async evidence(context: InstructorQualificationContext, staffPrincipalId: string, evidenceId: string): Promise<InstructorQualificationEvidence> {
    validateInstructorQualificationUuid(staffPrincipalId); validateInstructorQualificationUuid(evidenceId); const raw = await this.boundary<unknown>(context, "SELECT hon.read_instructor_qualification($1,'EVIDENCE',$2::uuid,$3::uuid) data", [context.externalSubject, staffPrincipalId, evidenceId]); return parseEvidence(raw, staffPrincipalId);
  }
  private async mutate(context: InstructorQualificationContext, action: string, staffPrincipalId: string | null, entityId: string | null, input: object): Promise<{ record: unknown; replayed: boolean }> {
    key(context); if (staffPrincipalId !== null) validateInstructorQualificationUuid(staffPrincipalId); if (entityId !== null) validateInstructorQualificationUuid(entityId);
    const raw = await this.boundary<unknown>(context, 'SELECT hon.mutate_instructor_qualification($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data', [context.externalSubject, action, staffPrincipalId, entityId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId], true);
    if (!exact(raw, ['record','replayed']) || typeof (raw as Record<string,unknown>).replayed !== 'boolean') throw new Error('Unsafe qualification command receipt.');
    return raw as { record: unknown; replayed: boolean };
  }
  async create(context: InstructorQualificationContext, input: CreateInstructorQualificationInput): Promise<{ record: InstructorQualificationDefinition; replayed: boolean }> { try { validateCreateInstructorQualification(input); } catch { invalid(); } const r=await this.mutate(context,'QUALIFICATION_CREATE',null,null,input); return {record:parseDefinition(r.record),replayed:r.replayed}; }
  async retire(context: InstructorQualificationContext, qualificationId: string, input: RetireInstructorQualificationInput): Promise<{ record: InstructorQualificationDefinition; replayed: boolean }> { try { validateInstructorQualificationUuid(qualificationId); validateRetireInstructorQualification(input); } catch { invalid(); } const r=await this.mutate(context,'QUALIFICATION_RETIRE',null,qualificationId,input); return {record:parseDefinition(r.record),replayed:r.replayed}; }
  async record(context: InstructorQualificationContext, staffPrincipalId: string, input: RecordInstructorQualificationEvidenceInput): Promise<{ record: InstructorQualificationEvidence; replayed: boolean }> { try { validateInstructorQualificationUuid(staffPrincipalId); validateRecordInstructorQualificationEvidence(input); } catch { invalid(); } const r=await this.mutate(context,'EVIDENCE_RECORD',staffPrincipalId,null,input); return {record:parseEvidence(r.record,staffPrincipalId),replayed:r.replayed}; }
  async review(context: InstructorQualificationContext, staffPrincipalId: string, evidenceId: string, input: ReviewInstructorQualificationEvidenceInput): Promise<{ record: InstructorQualificationEvidence; replayed: boolean }> { try { validateInstructorQualificationUuid(staffPrincipalId); validateInstructorQualificationUuid(evidenceId); validateReviewInstructorQualificationEvidence(input); } catch { invalid(); } const r=await this.mutate(context,'EVIDENCE_REVIEW',staffPrincipalId,evidenceId,input); return {record:parseEvidence(r.record,staffPrincipalId),replayed:r.replayed}; }
}
