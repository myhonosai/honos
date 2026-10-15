import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FollowUpContext, FollowUpStatus, FollowUpOperation } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { FollowUpService, followUpUuid } from './follow-up.service.js';
import { FollowUpDto, FollowUpTransitionDto, FollowUpHumanUiGuard } from './follow-up.dto.js';
@Controller('staff/crm/follow-ups')
@UseGuards(HonIdentityGuard, FollowUpHumanUiGuard)
export class FollowUpController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly followUps: FollowUpService) {}
  private async context(req: HonRequest, key = ''): Promise<FollowUpContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveFollowUpScope(externalSubject);
    if (!scope) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: FollowUpContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Query() query: Record<string, unknown>, @Req() req: HonRequest) {
    if (!query || Object.keys(query).some(k => !['queue','status','after'].includes(k)) || (query.queue !== undefined && !['mine','team'].includes(String(query.queue))) || (query.status !== undefined && !['OPEN','COMPLETED','CANCELLED','ALL'].includes(String(query.status)))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const after = query.after ?? null; if (after !== null) followUpUuid(after);
    const c = await this.context(req);
    return this.envelope(c, await this.followUps.list(c, (query.queue ?? 'mine') as 'mine' | 'team', (query.status ?? 'OPEN') as FollowUpStatus | 'ALL', after as string | null));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id')
  async read(@Param('id') id: string, @Req() req: HonRequest) { followUpUuid(id); const c = await this.context(req); return this.envelope(c, await this.followUps.read(c, id)); }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Headers('idempotency-key') key: string | undefined, @Body() input: FollowUpDto, @Req() req: HonRequest) {
    const c = await this.context(req, key ?? ''); const r = await this.followUps.mutate(c, 'CREATE', null, input); return this.envelope(c, r.followUp, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/revisions') @HttpCode(200)
  async update(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: FollowUpDto, @Req() req: HonRequest) {
    followUpUuid(id); const c = await this.context(req, key ?? ''); const r = await this.followUps.mutate(c, 'UPDATE', id, input); return this.envelope(c, r.followUp, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/lifecycle/:operation') @HttpCode(200)
  async transition(@Param('id') id: string, @Param('operation') operation: string, @Headers('idempotency-key') key: string | undefined, @Body() input: FollowUpTransitionDto, @Req() req: HonRequest) {
    followUpUuid(id); const op = ({ complete: 'COMPLETE', cancel: 'CANCEL', reopen: 'REOPEN' } as const)[operation as 'complete' | 'cancel' | 'reopen'];
    if (!op) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const c = await this.context(req, key ?? ''); const r = await this.followUps.mutate(c, op as FollowUpOperation, id, input); return this.envelope(c, r.followUp, r.replayed);
  }
}
