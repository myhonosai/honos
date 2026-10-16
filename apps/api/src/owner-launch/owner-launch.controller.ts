import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { OwnerLaunchContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { OwnerLaunchHumanUiGuard } from './owner-launch-human-ui.guard.js';
import { OwnerLaunchService } from './owner-launch.service.js';
@Controller()
@UseGuards(HonIdentityGuard,OwnerLaunchHumanUiGuard)
export class OwnerLaunchController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly launch: OwnerLaunchService) {}
  private async context(request: HonRequest, key?: string): Promise<OwnerLaunchContext> {
    if (Object.keys(request.query??{}).length || request.headers['x-hon-source'] || request.headers['x-hon-action-request-id'] || request.headers['x-hon-delegated-by-principal-id']) throw new BadRequestException('No selector, delegated or action context is accepted.');
    if (!request.honIdentity) throw new ForbiddenException('Verified human session required.');
    const scope=await this.database.resolveOwnerLaunchScope(request.honIdentity.externalSubject);
    if (!scope) throw new ForbiddenException('One live permitted school and active tier are required; needs staff for ambiguous scope.');
    const requestId=randomUUID();
    return {...scope,externalSubject:request.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId,correlationId:requestId,idempotencyKey:key??`read:${requestId}`};
  }
  @Get('owner-launch')
  async read(@Req() request: HonRequest, @Res({passthrough:true}) response: Response) {
    response.setHeader('Cache-Control','private, no-store');
    return {data:await this.launch.read(await this.context(request))};
  }
  @Post('organizations/:organizationId/schools/:schoolId/student-registrations')
  async register(@Param('organizationId',new ParseUUIDPipe()) organizationId:string,@Param('schoolId',new ParseUUIDPipe()) schoolId:string,@Headers('idempotency-key') key:string|undefined,@Body() input:unknown,@Req() request:HonRequest,@Res({passthrough:true}) response:Response) {
    if (!key) throw new BadRequestException('Idempotency-Key required.');
    const context=await this.context(request,key);
    if (context.organizationId!==organizationId || context.schoolId!==schoolId) throw new ForbiddenException('Entered IDs do not grant current-school authority.');
    const result=await this.launch.register(context,input);
    response.setHeader('Cache-Control','private, no-store'); response.status(result.replayed?200:201);
    return {data:result.receipt,meta:{requestId:context.requestId,correlationId:context.correlationId,replayed:result.replayed}};
  }
}
