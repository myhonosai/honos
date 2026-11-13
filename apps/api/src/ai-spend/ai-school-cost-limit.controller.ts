import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS, saasUuid, validateAiSchoolCostAlertAckInput, validateAiSchoolCostAlertAckReceipt, validateAiSchoolCostAlertList,
  validateAiSchoolCostLimitInput, validateAiSchoolCostLimitReceipt, validateAiSchoolCostStatusList } from '@hon/contracts';
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
 * R2 (0288) per-school internal AI cost ceiling and single-school pause. HON's internal provider cost for the included
 * AI team, never a customer balance. The database alone decides authority: a human HQ owner may change a school's
 * ceiling or pause it, HQ billing staff may read, everyone else is refused.
 */
@Injectable()
export class AiSchoolCostLimitService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subjectId: string) {
    return this.billing.call('readAiSchoolCostLimits', [subjectId], validateAiSchoolCostStatusList);
  }
  async command(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateAiSchoolCostLimitInput(body), saasUuid(key)] as const);
    return this.billing.call('commandAiSchoolCostLimit', [subjectId, JSON.stringify(input), idempotencyKey], validateAiSchoolCostLimitReceipt);
  }
  /** 0343: alerts at 75%, 90% and 100% of a school's ceiling. HQ billing readers read; only the HQ owner acknowledges. */
  async alerts(subjectId: string) {
    return this.billing.call('readAiSchoolCostAlerts', [subjectId], validateAiSchoolCostAlertList);
  }
  async acknowledge(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateAiSchoolCostAlertAckInput(body), saasUuid(key)] as const);
    return this.billing.call('commandAiSchoolCostAlertAck', [subjectId, JSON.stringify(input), idempotencyKey], validateAiSchoolCostAlertAckReceipt);
  }
}

@Controller('hq/ai/school-cost-limits')
@UseGuards(HonIdentityGuard)
export class AiSchoolCostLimitHqController {
  constructor(private readonly limits: AiSchoolCostLimitService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) {
    return { data: await this.limits.list(subject(req)) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.aiSchoolCostLimit)
  async command(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.limits.command(subject(req), body, key) };
  }
}

@Controller('hq/ai/school-cost-alerts')
@UseGuards(HonIdentityGuard)
export class AiSchoolCostAlertHqController {
  constructor(private readonly limits: AiSchoolCostLimitService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) {
    return { data: await this.limits.alerts(subject(req)) };
  }
  @Post('acknowledgements') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.aiSchoolCostAlertAck)
  async acknowledge(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.limits.acknowledge(subject(req), body, key) };
  }
}
