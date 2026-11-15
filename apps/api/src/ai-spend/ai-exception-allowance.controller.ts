import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS, saasUuid, validateAiExceptionAllowanceInput, validateAiExceptionAllowanceList, validateAiExceptionAllowanceReceipt } from '@hon/contracts';
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
 * 0353: AI for a school on a free HQ access exception, only under a monthly dollar limit (HON's internal provider cost,
 * never a customer balance). The database alone decides authority: a human HQ owner may set or clear the limit, HQ
 * readers may read, everyone else is refused.
 */
@Injectable()
export class AiExceptionAllowanceService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subjectId: string) {
    return this.billing.call('readAiExceptionAllowances', [subjectId], validateAiExceptionAllowanceList);
  }
  async command(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateAiExceptionAllowanceInput(body), saasUuid(key)] as const);
    return this.billing.call('commandAiExceptionAllowance', [subjectId, JSON.stringify(input), idempotencyKey], validateAiExceptionAllowanceReceipt);
  }
}

@Controller('hq/ai/exception-allowances')
@UseGuards(HonIdentityGuard)
export class AiExceptionAllowanceHqController {
  constructor(private readonly allowances: AiExceptionAllowanceService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) {
    return { data: await this.allowances.list(subject(req)) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.aiExceptionAllowance)
  async command(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.allowances.command(subject(req), body, key) };
  }
}
