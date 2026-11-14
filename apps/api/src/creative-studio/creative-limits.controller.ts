import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import {
  SAAS_COMMANDS, saasUuid, validateCreativeLimitsHqView, validateCreativeProviderDailyLimitInput, validateCreativeProviderDailyLimitReceipt,
  validateCreativeSchoolDailyCapsInput, validateCreativeSchoolDailyCapsReceipt,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * C1 (0354) HON's daily spend guard per creative provider and the per-school daily caps. HON's own provider cost in
 * micro-USD, never a customer balance. The database alone decides authority: a human HQ owner may change them, HQ billing
 * staff may read. A provider without a limit can never receive a real submission.
 */
@Injectable()
export class CreativeLimitsService {
  constructor(private readonly billing: SaasBillingService) {}
  read(subjectId: string) {
    return this.billing.call('readCreativeLimitsFromHq', [subjectId], validateCreativeLimitsHqView);
  }
  setProviderLimit(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateCreativeProviderDailyLimitInput(body), saasUuid(key)] as const);
    return this.billing.call('commandCreativeProviderDailyLimit', [subjectId, JSON.stringify(input), idempotencyKey], validateCreativeProviderDailyLimitReceipt);
  }
  setSchoolCaps(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateCreativeSchoolDailyCapsInput(body), saasUuid(key)] as const);
    return this.billing.call('commandCreativeSchoolDailyCaps', [subjectId, JSON.stringify(input), idempotencyKey], validateCreativeSchoolDailyCapsReceipt);
  }
}

@Controller('hq/creative/limits')
@UseGuards(HonIdentityGuard)
export class CreativeLimitsHqController {
  constructor(private readonly limits: CreativeLimitsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest) {
    return { data: await this.limits.read(subject(req)) };
  }
  @Post('providers') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.creativeProviderDailyLimit)
  async setProviderLimit(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.limits.setProviderLimit(subject(req), body, key) };
  }
  @Post('schools') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.creativeSchoolDailyCaps)
  async setSchoolCaps(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.limits.setSchoolCaps(subject(req), body, key) };
  }
}
