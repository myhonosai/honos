import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { validateAiSchoolUsageRange, validateAiSchoolUsageReport } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * S4-e HQ per-school AI usage and actual provider cost (read only). The database decides authority (HQ billing readers)
 * and reads the append-only AI usage ledger; no provider is called and nothing is written.
 */
@Injectable()
export class AiSchoolUsageService {
  constructor(private readonly billing: SaasBillingService) {}
  async report(subjectId: string, from: unknown, to: unknown) {
    let range: { from: string; to: string };
    try { range = validateAiSchoolUsageRange(from, to); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
    return this.billing.call('readAiSchoolUsage', [subjectId, range.from, range.to], validateAiSchoolUsageReport);
  }
}

@Controller('hq/ai/school-usage')
@UseGuards(HonIdentityGuard)
export class AiSchoolUsageHqController {
  constructor(private readonly usage: AiSchoolUsageService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['from', 'to'])
  async report(@Req() req: HonRequest, @Query() query: Record<string, unknown>) {
    return { data: await this.usage.report(subject(req), query.from, query.to) };
  }
}
