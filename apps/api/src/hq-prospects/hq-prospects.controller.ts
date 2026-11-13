import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqProspectsService } from './hq-prospects.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/** HQ-COMM E1 (0283) HON prospects: HQ owner or hq.marketing.manage. Contact details are shown; nothing is sent. */
@Controller('hq/prospects')
@UseGuards(HonIdentityGuard)
export class HqProspectsController {
  constructor(private readonly prospects: HqProspectsService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status', 'campaignId', 'cursor', 'limit'])
  async list(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.prospects.list(subject(req), query) }; }
  @Get(':prospectId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('prospectId') id: string) { return { data: await this.prospects.read(subject(req), id) }; }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createHqProspect)
  async create(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.prospects.create(subject(req), body, key) };
  }
  @Post(':prospectId') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.updateHqProspect)
  async update(@Req() req: HonRequest, @Param('prospectId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.prospects.update(subject(req), id, body, key) };
  }
  @Post(':prospectId/consents') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordHqProspectConsent)
  async consent(@Req() req: HonRequest, @Param('prospectId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.prospects.consent(subject(req), id, body, key) };
  }
}
