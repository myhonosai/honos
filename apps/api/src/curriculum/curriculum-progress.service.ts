import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CurriculumProgressContext, CreateCurriculumRequirementInput, UpdateCurriculumRequirementInput, CurriculumRequirementSummary, EnrollStudentCurriculumInput, SetStudentCurriculumRankInput, StudentCurriculumEnrollmentSummary, RecordCurriculumProgressInput, CurriculumProgressObservationSummary, CurriculumCommandResult, StaffCurriculumRequirementProgress, StaffCurriculumEnrollmentDetails } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { invalid, uuid, validateCurriculumInput, type CurriculumOperation } from './curriculum-progress.dto.js';
function human(c: CurriculumProgressContext): void {
 if(c.principalType!=='HUMAN_USER'||c.source!=='HUMAN_UI'||c.actionRequestId||c.delegatedByPrincipalId) throw new ForbiddenException({code:'HUMAN_COMMAND_REQUIRED'});
 for(const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) uuid(id);
 if(typeof c.externalSubject!=='string'||!c.externalSubject||c.externalSubject.length>200) invalid();
}
function dbError(e: unknown): never {
 const code=(e as {code?:string}).code;
 if(code==='42501') throw new ForbiddenException({code:'CURRICULUM_FORBIDDEN',detail:'Current scoped human permission and active school entitlement are required.'});
 if(code==='P0002') throw new NotFoundException({code:'CURRICULUM_RECORD_NOT_FOUND'});
 if(['40001','23505','55P03','40P01'].includes(code??'')) throw new ConflictException({code:code==='23505'?'CURRICULUM_DUPLICATE_OR_KEY_REUSED':'VERSION_CONFLICT',detail:'Refresh versions; unchanged retries must retain the original idempotency key.'});
 if(code==='57014') throw new ServiceUnavailableException({code:'CURRICULUM_TIMEOUT',detail:'No success is assumed. Retry the unchanged request with its original key.'});
 if(['22023','22P02','22P05','23514','23503','22021','22003'].includes(code??'')) invalid();
 throw e;
}
@Injectable()
export class CurriculumProgressService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 createRequirement(c: CurriculumProgressContext,curriculumId: string,rankId: string,input: CreateCurriculumRequirementInput): Promise<CurriculumCommandResult<CurriculumRequirementSummary>> { return this.mutate(c,'REQUIREMENT_CREATE',curriculumId,rankId,input); }
 updateRequirement(c: CurriculumProgressContext,curriculumId: string,id: string,input: UpdateCurriculumRequirementInput): Promise<CurriculumCommandResult<CurriculumRequirementSummary>> { return this.mutate(c,'REQUIREMENT_UPDATE',curriculumId,id,input); }
 enroll(c: CurriculumProgressContext,curriculumId: string,input: EnrollStudentCurriculumInput): Promise<CurriculumCommandResult<StudentCurriculumEnrollmentSummary>> { return this.mutate(c,'ENROLL',curriculumId,null,input); }
 setRank(c: CurriculumProgressContext,curriculumId: string,id: string,input: SetStudentCurriculumRankInput): Promise<CurriculumCommandResult<StudentCurriculumEnrollmentSummary>> { return this.mutate(c,'SET_RANK',curriculumId,id,input); }
 observe(c: CurriculumProgressContext,curriculumId: string,id: string,input: RecordCurriculumProgressInput): Promise<CurriculumCommandResult<CurriculumProgressObservationSummary>> { return this.mutate(c,'OBSERVE',curriculumId,id,input); }
 read(c: CurriculumProgressContext,kind: 'REQUIREMENTS',curriculumId: string,id: string): Promise<StaffCurriculumRequirementProgress[]>;
 read(c: CurriculumProgressContext,kind: 'ENROLLMENT',curriculumId: string,id: string): Promise<StaffCurriculumEnrollmentDetails>;
 async read(c: CurriculumProgressContext,kind: 'REQUIREMENTS'|'ENROLLMENT',curriculumId: string,id: string): Promise<StaffCurriculumRequirementProgress[] | StaffCurriculumEnrollmentDetails> {
  human(c); uuid(curriculumId); uuid(id); if(!['REQUIREMENTS','ENROLLMENT'].includes(kind)) invalid();
  try { return await this.database.withTenantTransaction(c,async client=>{
   await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
   await client.query("SET LOCAL statement_timeout='5s'");
   return (await client.query<{data: StaffCurriculumRequirementProgress[] | StaffCurriculumEnrollmentDetails}>('SELECT hon.read_staff_curriculum_progress($1,$2,$3::uuid,$4::uuid) data',[c.externalSubject,kind,curriculumId,id])).rows[0]!.data;
  }); } catch(e) { return dbError(e); }
 }
 private async mutate<T>(c: CurriculumProgressContext,operation: CurriculumOperation,curriculumId: string,id: string|null,input: object): Promise<CurriculumCommandResult<T>> {
  human(c); uuid(curriculumId); if(id!==null) uuid(id); validateCurriculumInput(operation,input);
  if(typeof c.idempotencyKey!=='string'||!c.idempotencyKey||c.idempotencyKey.length>200||c.idempotencyKey.trim()!==c.idempotencyKey||/[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
  try { return await this.database.withTenantTransaction(c,async client=>{
   await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
   await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
   return (await client.query<{data:CurriculumCommandResult<T>}>('SELECT hon.mutate_curriculum_progress($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data',[c.externalSubject,operation,curriculumId,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId])).rows[0]!.data;
  }); } catch(e) { return dbError(e); }
 }
}
