import { ConflictException, ForbiddenException, Injectable, BadRequestException, NotFoundException, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isCurriculumLibraryId, verifyStaffCurriculumLibrary, verifyParentCurriculumLibrary, verifyCurriculumResourceRecord, closedLibraryObject, type CurriculumResourceContext, type CurriculumResourceRecord, type CurriculumResourceCreateInput, type CurriculumResourceUpdateInput, type CurriculumResourceArchiveInput } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { validateLibraryInput, type LibraryOperation } from './library.dto.js';
function human(c: CurriculumResourceContext) {
 if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({code:'HUMAN_COMMAND_REQUIRED'});
 if (![c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId].every(isCurriculumLibraryId) || typeof c.externalSubject !== 'string' || !c.externalSubject.trim() || c.externalSubject.length>200) throw new ForbiddenException({code:'LIBRARY_SCOPE_DENIED'});
}
function databaseError(e: unknown): never {
 if(e instanceof HttpException) throw e;
 const code=(e as {code?: string}).code;
 if(code==='42501') throw new ForbiddenException({code:'LIBRARY_FORBIDDEN'});
 if(code==='P0002') throw new NotFoundException({code:'LIBRARY_TARGET_NOT_FOUND'});
 if(['40001','23505','55P03','40P01'].includes(code??'')) throw new ConflictException({code:'LIBRARY_VERSION_OR_KEY_CONFLICT'});
 if(['22023','22P02','23514','23503','22003'].includes(code??'')) throw new BadRequestException({code:'VALIDATION_FAILED'});
 if(code==='57014') throw new ServiceUnavailableException({code:'LIBRARY_TIMEOUT'});
 throw e;
}
function same(a: ResolvedParentFamilyScope,b: ResolvedParentFamilyScope) { return ['principalId','organizationId','schoolId','familyId','accessLevel'].every(k=>a[k as keyof typeof a]===b[k as keyof typeof b]); }
@Injectable()
export class CurriculumLibraryService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 async list(c: CurriculumResourceContext) {
  human(c);
  try { return await this.database.withTenantTransaction(c,async client=>{
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
   return verifyStaffCurriculumLibrary((await client.query('SELECT hon.read_staff_curriculum_library($1) data',[c.externalSubject])).rows[0]?.data);
  }); } catch(e) { return databaseError(e); }
 }
 create(c: CurriculumResourceContext,input: CurriculumResourceCreateInput) { return this.mutate(c,'CREATE',null,input); }
 update(c: CurriculumResourceContext,id: string,input: CurriculumResourceUpdateInput) { return this.mutate(c,'UPDATE',id,input); }
 archive(c: CurriculumResourceContext,id: string,input: CurriculumResourceArchiveInput) { return this.mutate(c,'ARCHIVE',id,input); }
 private async mutate(c: CurriculumResourceContext,op: LibraryOperation,id: string|null,input: object): Promise<{record:CurriculumResourceRecord;replayed:boolean}> {
  human(c); validateLibraryInput(op,input);
  if(id!==null&&!isCurriculumLibraryId(id)) throw new BadRequestException({code:'VALIDATION_FAILED'});
  if(typeof c.idempotencyKey!=='string'||!c.idempotencyKey||c.idempotencyKey.length>200||c.idempotencyKey.trim()!==c.idempotencyKey||/[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
  try { return await this.database.withTenantTransaction(c,async client=>{
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
   const r=closedLibraryObject((await client.query('SELECT hon.mutate_curriculum_resource($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data',[c.externalSubject,op,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId])).rows[0]?.data,['record','replayed']);
   if(typeof r.replayed!=='boolean') throw new Error('Invalid library receipt.');
   return {record:verifyCurriculumResourceRecord(r.record),replayed:r.replayed};
  }); } catch(e) { return databaseError(e); }
 }
 /** Authenticated subject only. Never accept a client organization, school, family or child. */
 async parent(subject: string) {
  const requestId=randomUUID();
  try {
   if(typeof subject!=='string'||!subject.trim()||subject.length>200) throw new ForbiddenException({code:'FAMILY_FORBIDDEN'});
   const scopes=await this.database.resolveParentJourneyScopes(subject);
   if(scopes.length!==1) throw new ForbiddenException({code:'FAMILY_SCOPE_UNAVAILABLE'});
   const scope=scopes[0]!;
   const data=await this.database.withTenantTransaction({...scope,principalType:'HUMAN_USER',requestId},async client=>{
    await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
    return verifyParentCurriculumLibrary((await client.query('SELECT hon.read_parent_curriculum_library($1,$2::uuid) data',[subject,scope.familyId])).rows[0]?.data);
   });
   const live=await this.database.resolveParentJourneyScopes(subject);
   if(live.length!==1||!same(scope,live[0]!)) throw new ForbiddenException({code:'FAMILY_SCOPE_CHANGED'});
   return {data,meta:{requestId,correlationId:requestId}};
  } catch(e) { return databaseError(e); }
 }
}
