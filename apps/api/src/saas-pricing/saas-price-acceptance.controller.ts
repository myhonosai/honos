import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasPriceAcceptanceService } from './saas-price-acceptance.service.js';
const subject = (req: HonRequest) => { if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' }); return req.honIdentity.externalSubject; };
/** HQ owner records a schedule; operator reads. This does not publish an offer or authorize a provider. */
@Controller('hq/saas/price-schedules') @UseGuards(HonIdentityGuard)
export class SaasPriceScheduleHqController {
  constructor(private readonly pricing: SaasPriceAcceptanceService) {}
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordPriceSchedule)
  record(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.pricing.record(subject(req), body, key).then(data => ({ data }));
  }
  @Get(':scheduleId') @UseGuards(SaasReadGuard)
  read(@Req() req: HonRequest, @Param('scheduleId') id: string) { return this.pricing.schedule(subject(req), id).then(data => ({ data })); }
}
/** Exact-school billing.hon.purchase authorization is independently enforced by PostgreSQL, including replay. */
@Controller('schools/:schoolId/hon-os-price-acceptances') @UseGuards(HonIdentityGuard)
export class SaasPriceAcceptanceSchoolController {
  constructor(private readonly pricing: SaasPriceAcceptanceService) {}
  @Get('preview/:scheduleId') @UseGuards(SaasReadGuard)
  preview(@Req() req: HonRequest, @Param('schoolId') school: string, @Param('scheduleId') id: string) {
    return this.pricing.preview(subject(req), school, id).then(data => ({ data }));
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.acceptPriceSchedule)
  accept(@Req() req: HonRequest, @Param('schoolId') school: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.pricing.accept(subject(req), school, body, key).then(data => ({ data }));
  }
  @Get(':acceptanceId') @UseGuards(SaasReadGuard)
  read(@Req() req: HonRequest, @Param('schoolId') school: string, @Param('acceptanceId') id: string) {
    return this.pricing.acceptance(subject(req), school, id).then(data => ({ data }));
  }
}
