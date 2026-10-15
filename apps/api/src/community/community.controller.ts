import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommunityContext, CommunityKind } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CommunityService, communityId } from './community.service.js';
import { CommunityDto, CommunityProfileDto, CommunityConsentDto, CommunityHumanUiGuard } from './community.dto.js';
@Controller('staff/community')
@UseGuards(HonIdentityGuard, CommunityHumanUiGuard)
export class CommunityController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly community: CommunityService) {}
  private async context(req: HonRequest, query: Record<string, unknown>, allowed: string[], key = ''): Promise<CommunityContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    if (!query || Object.keys(query).some(k => !['schoolId', ...allowed].includes(k))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    communityId(query.schoolId);
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveCommunityScope(externalSubject, query.schoolId);
    if (!scope) throw new ForbiddenException({ code: 'COMMUNITY_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: CommunityContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  private filter(query: Record<string, unknown>) {
    const kind = query.kind ?? 'TOPIC', parentId = query.parentId ?? null;
    if (!['TOPIC', 'POST', 'COMMENT'].includes(kind as string) || ((kind === 'TOPIC') !== (parentId === null))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (parentId !== null) communityId(parentId); return { kind: kind as CommunityKind, parentId: parentId as string | null };
  }
  @Header('Cache-Control', 'private, no-store') @Get('profile')
  async profile(@Query() q: Record<string, unknown>, @Req() req: HonRequest) { const c = await this.context(req, q, []); return this.envelope(c, await this.community.profile(c)); }
  @Header('Cache-Control', 'private, no-store') @Post('profile') @HttpCode(200)
  async saveProfile(@Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: CommunityProfileDto, @Req() req: HonRequest) {
    const c = await this.context(req, q, [], key ?? ''); const r = await this.community.mutate(c, 'PROFILE', null, p); return this.envelope(c, r.result, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post('organization') @HttpCode(200)
  async consent(@Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: CommunityConsentDto, @Req() req: HonRequest) {
    const c = await this.context(req, q, [], key ?? ''); const r = await this.community.mutate(c, 'CONSENT', null, p); return this.envelope(c, r.result, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    const c = await this.context(req, q, ['kind', 'parentId', 'after']); const f = this.filter(q); const after = q.after ?? null; if (after !== null) communityId(after);
    return this.envelope(c, await this.community.list(c, f.kind, f.parentId, after as string | null));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id/history')
  async history(@Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    const c = await this.context(req, q, ['before']); communityId(id);
    if (q.before !== undefined && (typeof q.before !== 'string' || !/^[1-9][0-9]{0,8}$/.test(q.before))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.envelope(c, await this.community.history(c, id, q.before === undefined ? null : Number(q.before)));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id')
  async read(@Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    const c = await this.context(req, q, ['kind', 'parentId']); const f = this.filter(q); communityId(id); return this.envelope(c, await this.community.read(c, f.kind, f.parentId, id));
  }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: CommunityDto, @Req() req: HonRequest) {
    const c = await this.context(req, q, [], key ?? ''); const r = await this.community.mutate(c, 'CONTENT', null, p); return this.envelope(c, r.result, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/revisions') @HttpCode(200)
  async revise(@Param('id') id: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: CommunityDto, @Req() req: HonRequest) {
    communityId(id); const c = await this.context(req, q, [], key ?? ''); const r = await this.community.mutate(c, 'CONTENT', id, p); return this.envelope(c, r.result, r.replayed);
  }
}
