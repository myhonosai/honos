import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ACTION_REVIEW_STATUSES, ACTION_REVIEW_UUID, type ActionReviewContext, type ActionReviewStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ActionDecisionDto, ActionReviewHumanUiGuard } from './action-decision.dto.js';
import { ActionEngineService } from './action-engine.service.js';
async function context(database: RuntimeDatabaseService, schoolId: string, req: HonRequest, key = ''): Promise<ActionReviewContext> {
  if (!req.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
  const externalSubject=req.honIdentity.externalSubject;
  const scope=await database.resolveAuthorizedScope(externalSubject,schoolId,'action.approve');
  if (!scope) throw new ForbiddenException({code:'PERMISSION_DENIED'});
  const id=randomUUID();
  return {...scope,externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key};
}
function envelope<T>(c: ActionReviewContext,data:T) { return {data,meta:{requestId:c.requestId,correlationId:c.correlationId}}; }
function key(header:string|undefined):string {
  if (!header || header.trim()!==header || header.length>200 || /[\u0000-\u001f\u007f]/.test(header)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
  return header;
}
@Controller('staff/action-center/approvals/:schoolId')
@UseGuards(HonIdentityGuard,ActionReviewHumanUiGuard)
export class ActionApprovalWorkbenchController {
  constructor(private readonly database:RuntimeDatabaseService,private readonly actions:ActionEngineService) {}
  @Header('Cache-Control','private, no-store') @Get()
  async list(@Param('schoolId',new ParseUUIDPipe()) school:string,@Query() q:Record<string,unknown>,@Req() req:HonRequest) {
    if (Object.keys(q).some(k=>!['status','after'].includes(k)) || (q.status!==undefined && ![...ACTION_REVIEW_STATUSES,'ALL'].includes(q.status as ActionReviewStatus|'ALL')) || (q.after!==undefined && (typeof q.after!=='string' || !ACTION_REVIEW_UUID.test(q.after)))) throw new BadRequestException({code:'VALIDATION_FAILED'});
    const c=await context(this.database,school,req);return envelope(c,await this.actions.listForReview(c,(q.status??'AWAITING_APPROVAL') as ActionReviewStatus|'ALL',(q.after??null) as string|null));
  }
  @Header('Cache-Control','private, no-store') @Get(':actionRequestId')
  async read(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('actionRequestId',new ParseUUIDPipe()) id:string,@Query() q:Record<string,unknown>,@Req() req:HonRequest) {
    if (Object.keys(q).length) throw new BadRequestException({code:'VALIDATION_FAILED'});
    const c=await context(this.database,school,req);return envelope(c,await this.actions.getForReview(c,id));
  }
  @Header('Cache-Control','private, no-store') @Post(':actionRequestId/decision') @HttpCode(200)
  async decide(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('actionRequestId',new ParseUUIDPipe()) id:string,@Body() input:ActionDecisionDto,@Headers('idempotency-key') header:string|undefined,@Query() q:Record<string,unknown>,@Req() req:HonRequest) {
    if (Object.keys(q).length) throw new BadRequestException({code:'VALIDATION_FAILED'});
    const c=await context(this.database,school,req,key(header));return envelope(c,await this.actions.decide(c,{...input,actionRequestId:id}));
  }
}
// Retain the pre-existing school API contract, now with the same exact binding
// and human transport guard; no older bypass path to decisions remains.
@Controller('organizations/:organizationId/schools/:schoolId/action-requests')
@UseGuards(HonIdentityGuard,ActionReviewHumanUiGuard)
export class ActionReviewController {
  constructor(private readonly database:RuntimeDatabaseService,private readonly actions:ActionEngineService) {}
  private async reviewContext(org:string,school:string,req:HonRequest,k='') {
    const c=await context(this.database,school,req,k);
    if(c.organizationId!==org) throw new ForbiddenException({code:'TENANT_SCOPE_DENIED'});return c;
  }
  @Header('Cache-Control','private, no-store') @Get(':actionRequestId')
  async getForReview(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('actionRequestId',new ParseUUIDPipe()) id:string,@Req() req:HonRequest) {
    const c=await this.reviewContext(org,school,req);return envelope(c,await this.actions.getForReview(c,id));
  }
  @Header('Cache-Control','private, no-store') @Post(':actionRequestId/decision') @HttpCode(200)
  async decide(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('actionRequestId',new ParseUUIDPipe()) id:string,@Body() input:ActionDecisionDto,@Headers('idempotency-key') header:string|undefined,@Req() req:HonRequest) {
    const c=await this.reviewContext(org,school,req,key(header));return envelope(c,await this.actions.decide(c,{...input,actionRequestId:id}));
  }
}
