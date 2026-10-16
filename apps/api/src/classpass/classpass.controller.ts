import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res, UseGuards, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { CLASSPASS_ACTIONS, type ClassPassAction, type ClassPassContext, type ClassPassInput, type ClassPassReadKind } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ClassPassService } from './classpass.service.js';
import { ClassPassCommandDto, ClassPassHumanUiGuard } from './classpass.dto.js';
@Controller('organizations/:organizationId/schools/:schoolId/classpass')
@UseGuards(HonIdentityGuard, ClassPassHumanUiGuard)
export class ClassPassController {
 constructor(private readonly database: RuntimeDatabaseService, private readonly service: ClassPassService) {}
 private async context(org: string, school: string, request: HonRequest, permission: string, key=''): Promise<ClassPassContext> {
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  const externalSubject=request.honIdentity.externalSubject;
  const scope=await this.database.resolveAuthorizedScope(externalSubject,school,permission);
  if (!scope || scope.organizationId!==org || scope.schoolId!==school) throw new ForbiddenException({ code: 'CLASSPASS_FORBIDDEN' });
  const requestId=randomUUID();
  return { ...scope, externalSubject, principalType:'HUMAN_USER',source:'HUMAN_UI',requestId,correlationId:requestId,idempotencyKey:key };
 }
 @Get(':kind/:id')
 async read(@Param('organizationId',new ParseUUIDPipe()) org: string, @Param('schoolId',new ParseUUIDPipe()) school: string,
  @Param('kind') kind: ClassPassReadKind, @Param('id',new ParseUUIDPipe()) id: string, @Req() request: HonRequest, @Res({passthrough:true}) response: Response) {
  const context=await this.context(org,school,request,'classpass.read'); response.setHeader('Cache-Control','private, no-store');
  return { data:await this.service.read(context,kind,id),meta:{requestId:context.requestId,correlationId:context.correlationId} };
 }
 @Post('commands/:action/:target')
 async command(@Param('organizationId',new ParseUUIDPipe()) org: string, @Param('schoolId',new ParseUUIDPipe()) school: string,
  @Param('action') action: ClassPassAction, @Param('target',new ParseUUIDPipe()) target: string, @Headers('idempotency-key') key: string|undefined,
  @Body() input: ClassPassCommandDto, @Req() request: HonRequest, @Res({passthrough:true}) response: Response) {
  if (!CLASSPASS_ACTIONS.includes(action)) throw new BadRequestException({code:'VALIDATION_FAILED'});
  const permission=action==='ADMIT'?'classpass.admit':action.startsWith('REVERSE_')?'classpass.reverse':'classpass.manage';
  const context=await this.context(org,school,request,permission,key??''); response.setHeader('Cache-Control','private, no-store');
  const result=await this.service.command(context,action,target,input as ClassPassInput);
  return {data:result,meta:{requestId:context.requestId,correlationId:context.correlationId,replayed:result.replayed}};
 }
}
