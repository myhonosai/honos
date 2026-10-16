import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Req, Res, UseGuards, HttpCode } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { KioskContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { KioskService } from './kiosk.service.js';
import { KioskClaimDto, KioskHumanUiGuard, KioskPublicDto, KioskRetireDto, KioskTerminalDto } from './kiosk.dto.js';
@Controller('organizations/:organizationId/schools/:schoolId/kiosk')
@UseGuards(KioskHumanUiGuard, HonIdentityGuard)
export class KioskStaffController {
 constructor(private readonly database: RuntimeDatabaseService, private readonly service: KioskService) {}
 private async context(org: string, school: string, request: HonRequest, permission: string): Promise<KioskContext> {
  if (!request.honIdentity) throw new ForbiddenException({code:'KIOSK_FORBIDDEN'});
  const externalSubject=request.honIdentity.externalSubject;
  const scope=await this.database.resolveAuthorizedScope(externalSubject,school,permission);
  if (!scope || scope.organizationId!==org || scope.schoolId!==school) throw new ForbiddenException({code:'KIOSK_FORBIDDEN'});
  const id=randomUUID();
  return {...scope,externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:''};
 }
 @Post('terminals/:id/activate')
 async activate(@Param('organizationId',new ParseUUIDPipe()) org: string,@Param('schoolId',new ParseUUIDPipe()) school: string,@Param('id',new ParseUUIDPipe()) id: string,@Body() input: KioskTerminalDto,@Req() request: HonRequest) {
  return {data:await this.service.activate(await this.context(org,school,request,'kiosk.terminal.manage'),id,input)};
 }
 @Post('terminals/:id/retire')
 async retire(@Param('organizationId',new ParseUUIDPipe()) org: string,@Param('schoolId',new ParseUUIDPipe()) school: string,@Param('id',new ParseUUIDPipe()) id: string,@Body() input: KioskRetireDto,@Req() request: HonRequest) {
  return {data:await this.service.retire(await this.context(org,school,request,'kiosk.terminal.manage'),id,input)};
 }
 @Post('claims/:id/provision')
 async provision(@Param('organizationId',new ParseUUIDPipe()) org: string,@Param('schoolId',new ParseUUIDPipe()) school: string,@Param('id',new ParseUUIDPipe()) id: string,@Body() input: KioskClaimDto,@Req() request: HonRequest) {
  return {data:await this.service.provision(await this.context(org,school,request,'kiosk.handoff.provision'),id,input)};
 }
 @Get('claims/:id')
 async recover(@Param('organizationId',new ParseUUIDPipe()) org: string,@Param('schoolId',new ParseUUIDPipe()) school: string,@Param('id',new ParseUUIDPipe()) id: string,@Req() request: HonRequest) {
  return {data:await this.service.recover(await this.context(org,school,request,'kiosk.handoff.read'),id)};
 }
}
// main.ts has global /v1; Next's existing rewrite exposes /api/v1/kiosk/handoffs.
@Controller('kiosk')
export class KioskPublicController {
 constructor(private readonly service: KioskService) {}
 @Post('handoffs') @HttpCode(200)
 async submit(@Body() input: KioskPublicDto,@Res({passthrough:true}) response: Response) {
  response.setHeader('Cache-Control','private, no-store');
  return this.service.submit(input);
 }
}
