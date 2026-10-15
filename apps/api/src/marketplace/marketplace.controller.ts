import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MarketplaceContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MarketplaceService, marketplaceId } from './marketplace.service.js';
import { MarketplaceDto, MarketplaceSelectionDto, MarketplaceHumanUiGuard } from './marketplace.dto.js';
@Controller('staff/marketplace')
@UseGuards(HonIdentityGuard, MarketplaceHumanUiGuard)
export class MarketplaceController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly marketplace: MarketplaceService) {}
  private async context(req: HonRequest, q: Record<string, unknown>, allowed: string[], key = ''): Promise<MarketplaceContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    if (!q || Object.keys(q).some(k => !['schoolId', ...allowed].includes(k))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    marketplaceId(q.schoolId); const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveMarketplaceScope(externalSubject, q.schoolId);
    if (!scope) throw new ForbiddenException({ code: 'MARKETPLACE_SCOPE_DENIED' });
    const id = randomUUID(); return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: MarketplaceContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get('access')
  async access(@Query() q: Record<string, unknown>, @Req() req: HonRequest) { const c = await this.context(req, q, []); return this.envelope(c, await this.marketplace.read(c, 'ACCESS')); }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    const c = await this.context(req, q, ['mode', 'after']); const mode = q.mode ?? 'BROWSE';
    if (!['BROWSE', 'OWN', 'SAVED'].includes(mode as string)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const after = q.after ?? null; if (after !== null) marketplaceId(after);
    return this.envelope(c, await this.marketplace.read(c, mode as 'BROWSE' | 'OWN' | 'SAVED', null, after as string | null));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id/history')
  async history(@Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    marketplaceId(id); const c = await this.context(req, q, ['before']);
    if (q.before !== undefined && (typeof q.before !== 'string' || !/^[1-9][0-9]{0,8}$/.test(q.before))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.envelope(c, await this.marketplace.read(c, 'HISTORY', id, null, q.before === undefined ? null : Number(q.before)));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id')
  async read(@Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    marketplaceId(id); const c = await this.context(req, q, ['mode']); const mode = q.mode ?? 'BROWSE';
    if (!['BROWSE', 'OWN'].includes(mode as string)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.envelope(c, await this.marketplace.read(c, mode as 'BROWSE' | 'OWN', id));
  }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: MarketplaceDto, @Req() req: HonRequest) {
    const c = await this.context(req, q, [], key ?? ''); const r = await this.marketplace.mutate(c, 'ASSET', null, p); return this.envelope(c, r.result, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/revisions') @HttpCode(200)
  async revise(@Param('id') id: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: MarketplaceDto, @Req() req: HonRequest) {
    marketplaceId(id); const c = await this.context(req, q, [], key ?? ''); const r = await this.marketplace.mutate(c, 'ASSET', id, p); return this.envelope(c, r.result, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/selections') @HttpCode(200)
  async save(@Param('id') id: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() p: MarketplaceSelectionDto, @Req() req: HonRequest) {
    marketplaceId(id); const c = await this.context(req, q, [], key ?? ''); const r = await this.marketplace.mutate(c, 'SAVE', id, p); return this.envelope(c, r.result, r.replayed);
  }
}
