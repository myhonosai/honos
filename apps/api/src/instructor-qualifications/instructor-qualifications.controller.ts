import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { InstructorQualificationContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { InstructorQualificationsService } from './instructor-qualifications.service.js';
import { CreateInstructorQualificationDto, InstructorQualificationsHumanUiGuard, RecordInstructorQualificationEvidenceDto, RetireInstructorQualificationDto, ReviewInstructorQualificationEvidenceDto } from './instructor-qualifications.dto.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function known(value: unknown): asserts value is string { if(typeof value!=='string'||!UUID.test(value)) throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Use an already-known staff, course-program, qualification, or evidence UUID. Directory browsing is not available.'}); }
function idempotency(value: string|undefined): string { const v=value?.trim(); if(!v||v.length>200||/[\u0000-\u001f\u007f]/.test(v)) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A bounded Idempotency-Key is required for each human command.'}); return v; }

@Controller('staff/instructor-qualifications')
@UseGuards(HonIdentityGuard,InstructorQualificationsHumanUiGuard)
export class InstructorQualificationsController {
  constructor(private readonly database:RuntimeDatabaseService,private readonly service:InstructorQualificationsService) {}
  private async context(request:HonRequest,key=`read-${randomUUID()}`):Promise<InstructorQualificationContext> {
    if(!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    // The resolver returns a scope only when this direct human has exactly one live
    // school with the bounded feature. No actor/organization/school input exists.
    const scope=await this.database.resolveInstructorQualificationScope(request.honIdentity.externalSubject);
    if(!scope) throw new ForbiddenException({code:'INSTRUCTOR_QUALIFICATION_SCOPE_DENIED'});
    const requestId=randomUUID(); return {...scope,externalSubject:request.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',idempotencyKey:key,requestId,correlationId:requestId};
  }
  private envelope<T>(context:InstructorQualificationContext,data:T,replayed=false){return {data,meta:{requestId:context.requestId,correlationId:context.correlationId,replayed}};}
  @Get('access') @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') async access(@Req() request:HonRequest){const c=await this.context(request);return this.envelope(c,await this.service.access(c));}
  @Get('qualifications/:qualificationId') @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') async qualification(@Param('qualificationId') qualificationId:string,@Req() request:HonRequest){known(qualificationId);const c=await this.context(request);return this.envelope(c,await this.service.qualification(c,qualificationId));}
  @Get('staff/:staffPrincipalId/evidence/:evidenceId') @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') async evidence(@Param('staffPrincipalId') staff:string,@Param('evidenceId') evidence:string,@Req() request:HonRequest){known(staff);known(evidence);const c=await this.context(request);return this.envelope(c,await this.service.evidence(c,staff,evidence));}
  @Post('qualifications') @HttpCode(HttpStatus.CREATED) @Header('Cache-Control','private, no-store') async create(@Body() input:CreateInstructorQualificationDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HonRequest,@Res({passthrough:true}) response:Response){const c=await this.context(request,idempotency(key));const r=await this.service.create(c,input);response.status(r.replayed?200:201);return this.envelope(c,r.record,r.replayed);}
  @Post('qualifications/:qualificationId/retire') @HttpCode(HttpStatus.OK) @Header('Cache-Control','private, no-store') async retire(@Param('qualificationId') qualification:string,@Body() input:RetireInstructorQualificationDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HonRequest){known(qualification);const c=await this.context(request,idempotency(key));const r=await this.service.retire(c,qualification,input);return this.envelope(c,r.record,r.replayed);}
  @Post('staff/:staffPrincipalId/evidence') @HttpCode(HttpStatus.CREATED) @Header('Cache-Control','private, no-store') async record(@Param('staffPrincipalId') staff:string,@Body() input:RecordInstructorQualificationEvidenceDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HonRequest,@Res({passthrough:true}) response:Response){known(staff);const c=await this.context(request,idempotency(key));const r=await this.service.record(c,staff,input);response.status(r.replayed?200:201);return this.envelope(c,r.record,r.replayed);}
  @Post('staff/:staffPrincipalId/evidence/:evidenceId/review') @HttpCode(HttpStatus.OK) @Header('Cache-Control','private, no-store') async review(@Param('staffPrincipalId') staff:string,@Param('evidenceId') evidence:string,@Body() input:ReviewInstructorQualificationEvidenceDto,@Headers('idempotency-key') key:string|undefined,@Req() request:HonRequest){known(staff);known(evidence);const c=await this.context(request,idempotency(key));const r=await this.service.review(c,staff,evidence,input);return this.envelope(c,r.record,r.replayed);}
}
