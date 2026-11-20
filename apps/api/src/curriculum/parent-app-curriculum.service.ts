import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { closedLibraryObject, isCurriculumLibraryId, isValidCurriculumAppSettingsInput, isValidCurriculumCycleName, verifyCurriculumAppChild, verifyCurriculumAppState, verifyParentCurriculumApp, verifyStaffParentAppCurriculum,
  type CurriculumAppChild, type CurriculumAppState, type ParentCurriculumApp, type CurriculumResourceContext, type ParentAppCurriculumOperation, type StaffParentAppCurriculum } from '@hon/contracts';
import { randomUUID } from 'node:crypto';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const NAMED_CONFLICTS = ['CYCLE_IS_CURRENT', 'SETTINGS_REQUIRED', 'CYCLE_NAME_TAKEN'];
function human(c: CurriculumResourceContext) {
 if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
 if (![c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId].every(isCurriculumLibraryId) || typeof c.externalSubject !== 'string' || !c.externalSubject.trim() || c.externalSubject.length > 200)
  throw new ForbiddenException({ code: 'PARENT_APP_CURRICULUM_SCOPE_DENIED' });
}
export function parentAppCurriculumDatabaseError(e: unknown): never {
 if (e instanceof HttpException) throw e;
 const { code, message } = e as { code?: string; message?: string };
 if (message && NAMED_CONFLICTS.includes(message) && ['55000', '23505'].includes(code ?? '')) throw new ConflictException({ code: message });
 if (message === 'CYCLE_LIMIT') throw new BadRequestException({ code: 'CYCLE_LIMIT' });
 if (code === '42501') throw new ForbiddenException({ code: message === 'FAMILY_FORBIDDEN' ? 'FAMILY_FORBIDDEN' : 'PARENT_APP_CURRICULUM_FORBIDDEN' });
 if (code === 'P0002') throw new NotFoundException({ code: 'PARENT_APP_CURRICULUM_TARGET_NOT_FOUND' });
 if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'PARENT_APP_CURRICULUM_VERSION_OR_KEY_CONFLICT' });
 if (['22023', '22P02', '23514', '23503', '22003', '22008', '22007'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
 if (code === '57014') throw new ServiceUnavailableException({ code: 'PARENT_APP_CURRICULUM_TIMEOUT' });
 throw e;
}
const version = (v: unknown, min = 1) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= 999999999;
/** Closed input per operation (contract checks); the database checks every field again. */
export function validateParentAppCurriculumInput(op: ParentAppCurriculumOperation, input: unknown): void {
 let ok = false;
 try {
  if (op === 'SAVE_SETTINGS') ok = isValidCurriculumAppSettingsInput(input);
  else if (op === 'CYCLE_CREATE') ok = isValidCurriculumCycleName(closedLibraryObject(input, ['name']).name);
  else if (op === 'CYCLE_RENAME') { const r = closedLibraryObject(input, ['expectedVersion', 'name']); ok = version(r.expectedVersion) && isValidCurriculumCycleName(r.name); }
  else if (op === 'CYCLE_ARCHIVE' || op === 'SWITCH_CYCLE') ok = version(closedLibraryObject(input, ['expectedVersion']).expectedVersion);
  else if (op === 'CYCLE_ORDER') { const ids = closedLibraryObject(input, ['cycleIds']).cycleIds; ok = Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 && ids.every(isCurriculumLibraryId) && new Set(ids).size === ids.length; }
 } catch { ok = false; }
 if (!ok) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed parent app curriculum fields and the current expected version.' });
}

@Injectable()
export class ParentAppCurriculumService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 async read(c: CurriculumResourceContext): Promise<StaffParentAppCurriculum> {
  human(c);
  try { return await this.database.withTenantTransaction(c, async (client) => {
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
   return verifyStaffParentAppCurriculum((await client.query('SELECT hon.read_staff_parent_app_curriculum($1) data', [c.externalSubject])).rows[0]?.data);
  }); } catch (e) { return parentAppCurriculumDatabaseError(e); }
 }
 async command(c: CurriculumResourceContext, op: ParentAppCurriculumOperation, curriculumId: string, targetId: string | null, input: object): Promise<{ record: CurriculumAppState; replayed: boolean }> {
  human(c); validateParentAppCurriculumInput(op, input);
  if (!isCurriculumLibraryId(curriculumId) || (targetId !== null && !isCurriculumLibraryId(targetId))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey))
   throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  try { return await this.database.withTenantTransaction(c, async (client) => {
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
   const r = closedLibraryObject((await client.query('SELECT hon.mutate_parent_app_curriculum($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data',
    [c.externalSubject, op, curriculumId, targetId, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId])).rows[0]?.data, ['record', 'replayed']);
   if (typeof r.replayed !== 'boolean') throw new Error('Invalid parent app curriculum receipt.');
   const record = verifyCurriculumAppState(r.record);
   if (record.curriculumId !== curriculumId) throw new Error('Parent app curriculum receipt names another curriculum.');
   return { record, replayed: r.replayed };
  }); } catch (e) { return parentAppCurriculumDatabaseError(e); }
 }
 async preview(c: CurriculumResourceContext, studentId: string): Promise<CurriculumAppChild> {
  human(c);
  if (!isCurriculumLibraryId(studentId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  try { return await this.database.withTenantTransaction(c, async (client) => {
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
   return verifyCurriculumAppChild((await client.query('SELECT hon.read_staff_parent_app_curriculum_preview($1,$2::uuid) data', [c.externalSubject, studentId])).rows[0]?.data);
  }); } catch (e) { return parentAppCurriculumDatabaseError(e); }
 }
 /** Authenticated subject only. Never accept a client organization, school, family or child. */
 async parent(subject: string): Promise<{ data: ParentCurriculumApp; meta: { requestId: string; correlationId: string } }> {
  const requestId = randomUUID();
  try {
   if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new ForbiddenException({ code: 'FAMILY_FORBIDDEN' });
   const scopes = await this.database.resolveParentJourneyScopes(subject);
   if (scopes.length !== 1) throw new ForbiddenException({ code: 'FAMILY_SCOPE_UNAVAILABLE' });
   const scope = scopes[0]!;
   const data = await this.database.withTenantTransaction({ ...scope, principalType: 'HUMAN_USER', requestId }, async (client) => {
    await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
    return verifyParentCurriculumApp((await client.query('SELECT hon.read_parent_curriculum_app($1,$2::uuid) data', [subject, scope.familyId])).rows[0]?.data);
   });
   const live = await this.database.resolveParentJourneyScopes(subject);
   if (live.length !== 1 || !sameScope(scope, live[0]!)) throw new ForbiddenException({ code: 'FAMILY_SCOPE_CHANGED' });
   return { data, meta: { requestId, correlationId: requestId } };
  } catch (e) { return parentAppCurriculumDatabaseError(e); }
 }
}
function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope) { return (['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'] as const).every((k) => a[k] === b[k]); }
