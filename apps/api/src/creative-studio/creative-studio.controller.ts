import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { CreativeStudioService } from './creative-studio.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * CS1 Creative Studio generations for staff of one school (ai.premium.request at that exact school, enforced in the
 * database; the path is only a selector). Paid from that school's creative wallet only; the AI team is never charged.
 * There is no route that chooses a provider, model or price, resends a provider call or settles credits directly.
 */
@Controller('schools/:schoolId/creative-studio/generations')
@UseGuards(HonIdentityGuard)
export class CreativeStudioController {
  constructor(private readonly studio: CreativeStudioService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.studio.list(subject(req), schoolId) };
  }
  @Get(':generationId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('generationId') generationId: string) {
    return { data: await this.studio.read(subject(req), schoolId, generationId) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCreativeGeneration)
  async create(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.studio.create(subject(req), schoolId, body, key) };
  }
}
