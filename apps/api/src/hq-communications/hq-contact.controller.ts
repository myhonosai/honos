import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { HqContactService } from './hq-contact.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/** HQ-COMM (0282) the signed-in person's own number for texts from HON HQ. No user id in any path: the identity is the subject. */
@Controller('me/hq-contact')
@UseGuards(HonIdentityGuard)
export class HqContactController {
  constructor(private readonly contact: HqContactService) {}
  @Get() @UseGuards(SaasReadGuard)
  async view(@Req() req: HonRequest) { return { data: await this.contact.view(subject(req)) }; }
  @Post('phone') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startMyHqPhone)
  async startPhone(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.contact.startPhone(subject(req), body, key) };
  }
  @Post('texting') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setMyHqTexting)
  async setTexting(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.contact.setTexting(subject(req), body, key) };
  }
  @Post('phone/remove') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.removeMyHqPhone)
  async removePhone(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.contact.removePhone(subject(req), body, key) };
  }
}
