import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { HqCreativeService } from './hq-creative.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * M2 HQ Creative Studio (0253): HON's own image and video requests for marketing HON OS, paid from the separate HQ credit
 * budget. HQ owner or HQ operator with hq.marketing.manage requests; hq.marketing.read reads; the HQ owner alone sets the
 * monthly cap and resolves held requests. No route chooses a provider, model or price, resends a provider call or touches
 * a school creative wallet.
 */
@Controller('hq/marketing/creative')
@UseGuards(HonIdentityGuard)
export class HqCreativeController {
  constructor(private readonly creative: HqCreativeService) {}
  @Get() @UseGuards(SaasReadGuard)
  async studio(@Req() req: HonRequest) { return { data: await this.creative.studio(subject(req)) }; }
  @Get('generations/:generationId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('generationId') id: string) { return { data: await this.creative.read(subject(req), id) }; }
  @Post('generations') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createHqCreativeGeneration)
  async create(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.creative.create(subject(req), body, key) };
  }
  @Post('generations/:generationId/resolution') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.resolveHqCreativeGeneration)
  async resolve(@Req() req: HonRequest, @Param('generationId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.creative.resolve(subject(req), id, body, key) };
  }
  @Post('budget') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqCreativeBudget)
  async budget(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.creative.setBudget(subject(req), body, key) };
  }
}
