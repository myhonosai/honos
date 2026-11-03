import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS, saasUuid, validateAiUnknownAgent, validateAiUnknownQueue, validateAiUnknownResolutionInput, validateAiUnknownResolutionReceipt } from '@hon/contracts';
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
 * S4-d HQ queue and resolution of lost AI provider outcomes (owner decision AI-D3). The database decides authority:
 * HQ billing readers see the queue; only a human HQ owner resolves, once per call, with closed provider evidence.
 * No provider is called here: the HQ owner enters evidence from the provider's own usage record.
 */
@Injectable()
export class AiUnknownResolutionService {
  constructor(private readonly billing: SaasBillingService) {}
  async queue(subjectId: string) {
    return this.billing.call('readAiUnknownInvocations', [subjectId], validateAiUnknownQueue);
  }
  async resolve(subjectId: string, agent: unknown, invocationId: unknown, body: unknown, key: unknown) {
    const [a, id, input, idempotencyKey] = parse(() => [validateAiUnknownAgent(agent), saasUuid(invocationId), validateAiUnknownResolutionInput(body), saasUuid(key)] as const);
    return this.billing.call('resolveAiUnknownInvocation', [subjectId, a, id, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()],
      validateAiUnknownResolutionReceipt);
  }
}

@Controller('hq/ai/unknown-invocations')
@UseGuards(HonIdentityGuard)
export class AiUnknownResolutionHqController {
  constructor(private readonly unknown: AiUnknownResolutionService) {}
  @Get() @UseGuards(SaasReadGuard)
  async queue(@Req() req: HonRequest) {
    return { data: await this.unknown.queue(subject(req)) };
  }
  @Post(':agent/:invocationId/resolve') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.aiUnknownResolve)
  async resolve(@Req() req: HonRequest, @Param('agent') agent: string, @Param('invocationId') invocationId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.unknown.resolve(subject(req), agent, invocationId, body, key) };
  }
}
