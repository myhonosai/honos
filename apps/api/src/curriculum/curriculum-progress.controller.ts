import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CurriculumApiResponse, CurriculumProgressContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumProgressService } from './curriculum-progress.service.js';
import { CurriculumHumanUiGuard } from './curriculum-human-ui.guard.js';
import { CreateCurriculumRequirementDto, UpdateCurriculumRequirementDto, EnrollStudentCurriculumDto, SetStudentCurriculumRankDto, RecordCurriculumProgressDto } from './curriculum-progress.dto.js';
@Controller('organizations/:organizationId/schools/:schoolId/curricula/:curriculumId')
@UseGuards(HonIdentityGuard,CurriculumHumanUiGuard)
export class CurriculumProgressController {
 constructor(private readonly database: RuntimeDatabaseService,private readonly progress: CurriculumProgressService) {}
 private async context(request: HonRequest,organizationId:string,schoolId:string,permission:'curriculum.manage'|'curriculum.progress.record',key:string|undefined): Promise<CurriculumProgressContext> {
  if(!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
  const scope=await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject,schoolId,permission);
  if(!scope||scope.organizationId!==organizationId||scope.schoolId!==schoolId) throw new ForbiddenException({code:'CURRICULUM_SCOPE_DENIED'});
  const id=randomUUID(); return {...scope,externalSubject:request.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key??''};
 }
 private envelope<T>(c: CurriculumProgressContext,r:{record:T;replayed:boolean}): CurriculumApiResponse<T> {return {data:r.record,meta:{requestId:c.requestId,correlationId:c.correlationId,replayed:r.replayed}};}
 @Header('Cache-Control','private, no-store') @Get('ranks/:rankId/requirements')
 async requirements(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('rankId',new ParseUUIDPipe()) rank:string,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.manage',undefined);return this.envelope(c,{record:await this.progress.read(c,'REQUIREMENTS',curriculum,rank),replayed:false});
 }
 @Header('Cache-Control','private, no-store') @Get('enrollments/:enrollmentId')
 async enrollment(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('enrollmentId',new ParseUUIDPipe()) id:string,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.progress.record',undefined);return this.envelope(c,{record:await this.progress.read(c,'ENROLLMENT',curriculum,id),replayed:false});
 }
 @Header('Cache-Control','private, no-store') @Post('ranks/:rankId/requirements') @HttpCode(200)
 async createRequirement(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('rankId',new ParseUUIDPipe()) rank:string,@Headers('idempotency-key') key:string|undefined,@Body() input:CreateCurriculumRequirementDto,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.manage',key);return this.envelope(c,await this.progress.createRequirement(c,curriculum,rank,input));
 }
 @Header('Cache-Control','private, no-store') @Post('requirements/:requirementId/versions') @HttpCode(200)
 async updateRequirement(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('requirementId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:UpdateCurriculumRequirementDto,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.manage',key);return this.envelope(c,await this.progress.updateRequirement(c,curriculum,id,input));
 }
 @Header('Cache-Control','private, no-store') @Post('enrollments') @HttpCode(200)
 async enroll(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Headers('idempotency-key') key:string|undefined,@Body() input:EnrollStudentCurriculumDto,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.progress.record',key);return this.envelope(c,await this.progress.enroll(c,curriculum,input));
 }
 @Header('Cache-Control','private, no-store') @Post('enrollments/:enrollmentId/current-rank') @HttpCode(200)
 async setRank(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('enrollmentId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:SetStudentCurriculumRankDto,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.progress.record',key);return this.envelope(c,await this.progress.setRank(c,curriculum,id,input));
 }
 @Header('Cache-Control','private, no-store') @Post('enrollments/:enrollmentId/observations') @HttpCode(200)
 async observe(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('curriculumId',new ParseUUIDPipe()) curriculum:string,@Param('enrollmentId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:RecordCurriculumProgressDto,@Req() req:HonRequest) {
  const c=await this.context(req,org,school,'curriculum.progress.record',key);return this.envelope(c,await this.progress.observe(c,curriculum,id,input));
 }
}
