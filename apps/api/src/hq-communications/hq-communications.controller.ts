import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqCommunicationsService } from './hq-communications.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * HQ-COMM (0281) HQ texting and email to the current owners of one school. HQ owner, or an HQ operator / support person
 * with the permission of the message purpose. The sender is set by the HQ owner only. No address is ever returned.
 */
@Controller('hq/communications')
@UseGuards(HonIdentityGuard)
export class HqCommunicationsController {
  constructor(private readonly comms: HqCommunicationsService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['schoolId', 'cursor', 'limit'])
  async view(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.comms.view(subject(req), query) }; }
  @Get('messages/:messageId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('messageId') id: string) { return { data: await this.comms.read(subject(req), id) }; }
  @Post('senders') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqCommunicationSender)
  async setSender(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.comms.setSender(subject(req), body, key) };
  }
  @Post('senders/:senderId/retire') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.retireHqCommunicationSender)
  async retireSender(@Req() req: HonRequest, @Param('senderId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.comms.retireSender(subject(req), id, body, key) };
  }
  @Post('messages') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createHqMessage)
  async create(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.comms.create(subject(req), body, key) };
  }
  @Post('messages/:messageId/queue') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.queueHqMessage)
  async queue(@Req() req: HonRequest, @Param('messageId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.comms.queue(subject(req), id, body, key) };
  }
  @Post('messages/:messageId/cancel') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.cancelHqMessage)
  async cancel(@Req() req: HonRequest, @Param('messageId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.comms.cancel(subject(req), id, body, key) };
  }
}
