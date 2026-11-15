import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { CreativeWebsiteService } from './creative-website.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * WB1 AI website drafts for staff of one school (the database decides authority at that exact school; the path is only a
 * selector). Paid from that school's creative credits at the HQ-published website rate; the AI team is never charged.
 * There is no route that chooses a provider, model or price, resends a provider call, settles credits or publishes a site.
 */
@Controller('schools/:schoolId/creative-studio/website-drafts')
@UseGuards(HonIdentityGuard)
export class CreativeWebsiteController {
  constructor(private readonly websites: CreativeWebsiteService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.websites.list(subject(req), schoolId) };
  }
  @Get(':draftId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('draftId') draftId: string) {
    return { data: await this.websites.read(subject(req), schoolId, draftId) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCreativeWebsiteDraft)
  async create(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.websites.create(subject(req), schoolId, body, key) };
  }
}
