import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { REVENUE_PLAN_PERMISSION, type RevenuePlanningContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RevenuePlanningService } from './revenue-planning.service.js';
import { RevenuePlanningHumanUiGuard } from './revenue-planning-human-ui.guard.js';
import { SaveRevenuePlanDto } from './revenue-planning.dto.js';
@Controller('organizations/:organizationId/schools/:schoolId/planning/revenue')
@UseGuards(HonIdentityGuard,RevenuePlanningHumanUiGuard)
export class RevenuePlanningController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly planning: RevenuePlanningService) {}
  private async context(req: HonRequest,org: string,school: string,key?: string): Promise<RevenuePlanningContext> {
    if(!req.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    const scope = await this.database.resolveAuthorizedScope(req.honIdentity.externalSubject,school,REVENUE_PLAN_PERMISSION);
    if(!scope || scope.organizationId !== org || scope.schoolId !== school) throw new ForbiddenException({code:'REVENUE_PLANNING_SCOPE_DENIED'});
    const id = randomUUID();
    return {...scope,externalSubject:req.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key ?? ''};
  }
  private envelope<T>(c: RevenuePlanningContext,data: T,replayed=false) { return {data,meta:{requestId:c.requestId,correlationId:c.correlationId,replayed}}; }
  @Header('Cache-Control','private, no-store') @Get()
  async list(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Req() req:HonRequest) {
    const c=await this.context(req,org,school); return this.envelope(c,await this.planning.list(c));
  }
  @Header('Cache-Control','private, no-store') @Get(':planId')
  async current(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('planId',new ParseUUIDPipe()) id:string,@Req() req:HonRequest) {
    const c=await this.context(req,org,school); return this.envelope(c,await this.planning.read(c,id));
  }
  @Header('Cache-Control','private, no-store') @Get(':planId/versions/:version')
  async saved(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('planId',new ParseUUIDPipe()) id:string,@Param('version',new ParseIntPipe()) version:number,@Req() req:HonRequest) {
    const c=await this.context(req,org,school); return this.envelope(c,await this.planning.read(c,id,version));
  }
  @Header('Cache-Control','private, no-store') @Post() @HttpCode(200)
  async create(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Headers('idempotency-key') key:string|undefined,@Body() input:SaveRevenuePlanDto,@Req() req:HonRequest) {
    const c=await this.context(req,org,school,key),r=await this.planning.save(c,null,input); return this.envelope(c,r.projection,r.replayed);
  }
  @Header('Cache-Control','private, no-store') @Post(':planId/versions') @HttpCode(200)
  async update(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('planId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:SaveRevenuePlanDto,@Req() req:HonRequest) {
    const c=await this.context(req,org,school,key),r=await this.planning.save(c,id,input); return this.envelope(c,r.projection,r.replayed);
  }
}
