import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS, saasUuid, validateAiSpendPauseInput, validateAiSpendPauseList, validateAiSpendPauseReceipt } from '@hon/contracts';
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
 * S4-c HQ emergency AI spend pause. The database alone decides authority: a human HQ owner may pause or resume, HQ
 * billing staff may read, everyone else is refused. The pause applies before any provider call, in every AI path.
 */
@Injectable()
export class AiSpendPauseService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subjectId: string) {
    return this.billing.call('readAiSpendPauses', [subjectId], validateAiSpendPauseList);
  }
  async command(subjectId: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateAiSpendPauseInput(body), saasUuid(key)] as const);
    return this.billing.call('commandAiSpendPause', [subjectId, JSON.stringify(input), idempotencyKey], validateAiSpendPauseReceipt);
  }
}

@Controller('hq/ai/spend-pauses')
@UseGuards(HonIdentityGuard)
export class AiSpendPauseHqController {
  constructor(private readonly pauses: AiSpendPauseService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) {
    return { data: await this.pauses.list(subject(req)) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.aiSpendPause)
  async command(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.pauses.command(subject(req), body, key) };
  }
}
