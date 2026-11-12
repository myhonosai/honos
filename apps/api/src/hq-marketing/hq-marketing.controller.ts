import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqMarketingService } from './hq-marketing.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * M1 HQ marketing campaigns (0252): HON's own campaign plans for marketing HON OS. HQ owner, or HQ operator with
 * hq.marketing.manage (hq.marketing.read reads only). Planning only: no ad is published and nothing is spent.
 */
@Controller('hq/marketing/campaigns')
@UseGuards(HonIdentityGuard)
export class HqMarketingController {
  constructor(private readonly marketing: HqMarketingService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status','cursor','limit'])
  async list(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.marketing.list(subject(req), query) }; }
  @Get(':campaignId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('campaignId') id: string) { return { data: await this.marketing.read(subject(req), id) }; }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createMarketingCampaign)
  async create(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.marketing.create(subject(req), body, key) };
  }
  @Post(':campaignId/versions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.updateMarketingCampaign)
  async update(@Req() req: HonRequest, @Param('campaignId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.marketing.update(subject(req), id, body, key) };
  }
  @Post(':campaignId/status') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setMarketingCampaignStatus)
  async status(@Req() req: HonRequest, @Param('campaignId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.marketing.status(subject(req), id, body, key) };
  }
}
