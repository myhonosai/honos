import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HUMAN_WORK_STATUSES, type HumanWorkContext, type HumanWorkStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { WorkItemService, workUuid } from './work-item.service.js';
import { HumanWorkDto, HumanWorkTransitionDto, WorkItemHumanUiGuard } from './work-item.dto.js';
@Controller('staff/work')
@UseGuards(HonIdentityGuard,WorkItemHumanUiGuard)
export class WorkItemController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly workItems: WorkItemService) {}
  private async context(req: HonRequest,key = ''): Promise<HumanWorkContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveHumanWorkScope(externalSubject);
    if (!scope) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED', detail: 'One unambiguous exact human school work scope is required.' });
    const id = randomUUID();
    return { ...scope,externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key };
  }
  private envelope<T>(c: HumanWorkContext,data: T,replayed = false) { return { data,meta:{ requestId:c.requestId,correlationId:c.correlationId,replayed } }; }
  @Header('Cache-Control','private, no-store') @Get()
  async list(@Query() query: Record<string,unknown>,@Req() req: HonRequest) {
    if (!query || Object.keys(query).some(k => !['queue','status','after'].includes(k)) || (query.queue !== undefined && !['mine','team'].includes(String(query.queue))) || (query.status !== undefined && ![...HUMAN_WORK_STATUSES,'ACTIVE','ALL'].includes(query.status as HumanWorkStatus))) throw new BadRequestException({ code:'VALIDATION_FAILED' });
    const after = query.after ?? null; if (after !== null) workUuid(after);
    const c = await this.context(req);
    return this.envelope(c,await this.workItems.list(c,(query.queue ?? 'mine') as 'mine'|'team',(query.status ?? 'ACTIVE') as HumanWorkStatus|'ACTIVE'|'ALL',after as string|null));
  }
  @Header('Cache-Control','private, no-store') @Get(':id')
  async read(@Param('id') id: string,@Query() query: Record<string,unknown>,@Req() req: HonRequest) {
    workUuid(id);
    if (!query || Object.keys(query).some(k => k !== 'beforeVersion') || (query.beforeVersion !== undefined && (typeof query.beforeVersion !== 'string' || !/^[1-9][0-9]{0,8}$/.test(query.beforeVersion)))) throw new BadRequestException({ code:'VALIDATION_FAILED' });
    const c = await this.context(req); return this.envelope(c,await this.workItems.read(c,id,query.beforeVersion === undefined ? null : Number(query.beforeVersion)));
  }
  @Header('Cache-Control','private, no-store') @Post() @HttpCode(200)
  async create(@Headers('idempotency-key') key: string|undefined,@Body() input: HumanWorkDto,@Req() req: HonRequest) {
    const c = await this.context(req,key ?? ''); const r = await this.workItems.mutate(c,'CREATE',null,input); return this.envelope(c,r.workItem,r.replayed);
  }
  @Header('Cache-Control','private, no-store') @Post(':id/revisions') @HttpCode(200)
  async update(@Param('id') id: string,@Headers('idempotency-key') key: string|undefined,@Body() input: HumanWorkDto,@Req() req: HonRequest) {
    workUuid(id); const c = await this.context(req,key ?? ''); const r = await this.workItems.mutate(c,'UPDATE',id,input); return this.envelope(c,r.workItem,r.replayed);
  }
  @Header('Cache-Control','private, no-store') @Post(':id/transition') @HttpCode(200)
  async transition(@Param('id') id: string,@Headers('idempotency-key') key: string|undefined,@Body() input: HumanWorkTransitionDto,@Req() req: HonRequest) {
    workUuid(id); const c = await this.context(req,key ?? ''); const r = await this.workItems.mutate(c,'TRANSITION',id,input); return this.envelope(c,r.workItem,r.replayed);
  }
}
