import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { HqHonService } from './hq-hon.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * B1 HQ Ask HON (0263): HQ staff ask HON about HON OS itself; HON answers from the HQ platform overview, paid from the
 * separate HQ AI text budget. HQ owner or HQ operator with hq.dashboard.view asks and reads their own turns; the HQ owner
 * alone sets the monthly cap and resolves held turns. No route chooses a provider, model or price, resends a provider call,
 * or names an organization or school.
 */
@Controller('hq/hon')
@UseGuards(HonIdentityGuard)
export class HqHonController {
  constructor(private readonly hon: HqHonService) {}
  @Get() @UseGuards(SaasReadGuard)
  async conversation(@Req() req: HonRequest) { return { data: await this.hon.conversation(subject(req)) }; }
  @Post('turns') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.askHqHon)
  async ask(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.hon.ask(subject(req), body, key) };
  }
  @Post('turns/:turnId/resolution') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.resolveHqHonTurn)
  async resolve(@Req() req: HonRequest, @Param('turnId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.hon.resolve(subject(req), id, body, key) };
  }
  @Post('budget') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqHonBudget)
  async budget(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.hon.setBudget(subject(req), body, key) };
  }
}
