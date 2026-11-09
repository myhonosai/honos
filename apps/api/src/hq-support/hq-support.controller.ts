import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqSupportService } from './hq-support.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * B-HQ-2 HQ support records: HQ-internal cases per customer organization with notes, status, priority and assignment.
 * HQ owner, or HQ operator / support with hq.support.manage. No message is sent and no school access is opened.
 */
@Controller('hq/support/cases')
@UseGuards(HonIdentityGuard)
export class HqSupportController {
  constructor(private readonly support: HqSupportService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status','organizationId','cursor','limit'])
  async list(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.support.list(subject(req), query) }; }
  /** The schools a case can be opened for (names and ids only). Declared before :caseId so it is never read as an id. */
  @Get('schools') @UseGuards(SaasReadGuard)
  async schools(@Req() req: HonRequest) { return { data: await this.support.schools(subject(req)) }; }
  @Get(':caseId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('caseId') caseId: string) { return { data: await this.support.read(subject(req), caseId) }; }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.openSupportCase)
  async open(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.support.open(subject(req), body, key) };
  }
  @Post(':caseId/notes') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.addSupportNote)
  async note(@Req() req: HonRequest, @Param('caseId') caseId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.support.note(subject(req), caseId, body, key) };
  }
  @Post(':caseId/changes') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.changeSupportCase)
  async change(@Req() req: HonRequest, @Param('caseId') caseId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.support.change(subject(req), caseId, body, key) };
  }
}
