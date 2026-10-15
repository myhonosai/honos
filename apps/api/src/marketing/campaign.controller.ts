import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CampaignContext, CampaignPermission } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CampaignService } from './campaign.service.js';
import { CampaignHumanUiGuard } from './campaign-human-ui.guard.js';
import { CampaignFunnelQueryDto, CampaignStatusDto, SaveCampaignDto } from './campaign.dto.js';

@Controller('marketing/campaigns')
@UseGuards(HonIdentityGuard, CampaignHumanUiGuard)
export class CampaignController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly campaigns: CampaignService) {}
  private async context(req: HonRequest, permission: CampaignPermission, key?: string): Promise<CampaignContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveCampaignScope(req.honIdentity.externalSubject, permission);
    if (!scope) throw new ForbiddenException({ code: 'CAMPAIGN_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject: req.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key ?? '' };
  }
  private envelope<T>(c: CampaignContext, data: T, replayed = false) {
    return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } };
  }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.read');
    return this.envelope(c, await this.campaigns.list(c));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':campaignId')
  async current(@Param('campaignId', new ParseUUIDPipe()) id: string, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.read');
    return this.envelope(c, await this.campaigns.read(c, id));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':campaignId/versions/:version')
  async saved(@Param('campaignId', new ParseUUIDPipe()) id: string, @Param('version', new ParseIntPipe()) version: number, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.read');
    return this.envelope(c, await this.campaigns.read(c, id, version));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':campaignId/funnel')
  async funnel(@Param('campaignId', new ParseUUIDPipe()) id: string, @Query() query: CampaignFunnelQueryDto, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.read');
    return this.envelope(c, await this.campaigns.funnel(c, id, query.from, query.to));
  }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Headers('idempotency-key') key: string | undefined, @Body() input: SaveCampaignDto, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.create', key), r = await this.campaigns.save(c, null, input);
    return this.envelope(c, r.campaign, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':campaignId/versions') @HttpCode(200)
  async update(@Param('campaignId', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: SaveCampaignDto, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.update', key), r = await this.campaigns.save(c, id, input);
    return this.envelope(c, r.campaign, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':campaignId/status') @HttpCode(200)
  async status(@Param('campaignId', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: CampaignStatusDto, @Req() req: HonRequest) {
    const c = await this.context(req, 'marketing.campaign.status', key), r = await this.campaigns.status(c, id, input);
    return this.envelope(c, r.campaign, r.replayed);
  }
}
