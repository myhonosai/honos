import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { HqSchoolPlansService } from './hq-school-plans.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * HQ school plan assignments (0676): give a school a published HON OS offer or a custom plan, change it, or remove it.
 * HQ owner commands; HQ owner or hq.billing.manage operator reads. Records only: nothing is charged.
 */
@Controller('hq/schools/:schoolId/plan')
@UseGuards(HonIdentityGuard)
export class HqSchoolPlansController {
  constructor(private readonly plans: HqSchoolPlansService) {}
  @Get() @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string) { return { data: await this.plans.read(subject(req), schoolId) }; }
  @Post('assign') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.assignSchoolPlan)
  async assign(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.plans.assign(subject(req), schoolId, body, key) };
  }
  @Post('remove') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.removeSchoolPlan)
  async remove(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.plans.remove(subject(req), schoolId, body, key) };
  }
}
