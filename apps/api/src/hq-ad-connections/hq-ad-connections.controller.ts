import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { HqAdConnectionsService } from './hq-ad-connections.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * 0677 HON's own Google Ads and Meta accounts, connected through Zernio by a current HQ owner. Reading follows the HQ
 * marketing read rule. Connecting records accounts only: nothing here publishes an ad, runs one or spends money.
 */
@Controller('hq/marketing/ad-accounts')
@UseGuards(HonIdentityGuard)
export class HqAdConnectionsController {
  constructor(private readonly connections: HqAdConnectionsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) { return { data: await this.connections.list(subject(req)) }; }
  @Post('connect') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.connectHqAdAccount)
  async connect(@Req() req: HonRequest, @Body() body: unknown) { return { data: await this.connections.start(subject(req), body) }; }
  @Post('connect/complete') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.completeHqAdConnect)
  async complete(@Req() req: HonRequest, @Body() body: unknown) { return { data: await this.connections.complete(subject(req), body) }; }
  @Post(':accountId/disconnect') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.disconnectHqAdAccount)
  async disconnect(@Req() req: HonRequest, @Param('accountId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.connections.disconnect(subject(req), id, body, key) };
  }
}
