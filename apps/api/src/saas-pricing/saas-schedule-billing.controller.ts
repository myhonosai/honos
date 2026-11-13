import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasScheduleBillingService } from './saas-schedule-billing.service.js';

const subject = (r: HonRequest) => { if (!r.honIdentity) throw new ForbiddenException({ code:'SAAS_FORBIDDEN' }); return r.honIdentity.externalSubject; };

@Controller('schools/:schoolId/hon-os-subscription-schedule-bindings') @UseGuards(HonIdentityGuard)
export class SaasScheduleBindingSchoolController {
  constructor(private readonly schedules: SaasScheduleBillingService) {}
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startScheduleBinding)
  start(@Req() r: HonRequest,@Param('schoolId') school: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.schedules.start(subject(r),school,body,key).then(data => ({data}));
  }
  /** 0341: the switch-to-lifetime quote; declared before ':bindingId' so the literal path wins. */
  @Get('lifetime-switch-quote') @UseGuards(SaasReadGuard)
  lifetimeSwitchQuote(@Req() r: HonRequest,@Param('schoolId') school: string) {
    return this.schedules.lifetimeSwitchQuote(subject(r),school).then(data => ({data}));
  }
  @Post('lifetime-switch') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startLifetimeSwitch)
  startLifetimeSwitch(@Req() r: HonRequest,@Param('schoolId') school: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.schedules.startLifetimeSwitch(subject(r),school,body,key).then(data => ({data}));
  }
  @Get(':bindingId') @UseGuards(SaasReadGuard)
  read(@Req() r: HonRequest,@Param('schoolId') school: string,@Param('bindingId') binding: string) {
    return this.schedules.read(subject(r),school,binding).then(data => ({data}));
  }
  @Post(':bindingId/cancel') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.cancelScheduleBinding)
  cancel(@Req() r: HonRequest,@Param('schoolId') school: string,@Param('bindingId') binding: string,@Headers('idempotency-key') key: string | undefined) {
    return this.schedules.cancelBeforePayment(subject(r),school,binding,key).then(data => ({data}));
  }
}

@Controller('hq/saas/subscription-schedule-bindings') @UseGuards(HonIdentityGuard)
export class SaasScheduleBindingHqController {
  constructor(private readonly schedules: SaasScheduleBillingService) {}
  /** 0341: every switch to lifetime, newest first. */
  @Get('lifetime-switches') @UseGuards(SaasReadGuard)
  lifetimeSwitches(@Req() r: HonRequest) { return this.schedules.hqLifetimeSwitches(subject(r)).then(data => ({data})); }
  @Get(':bindingId') @UseGuards(SaasReadGuard)
  read(@Req() r: HonRequest,@Param('bindingId') binding: string) { return this.schedules.readHq(subject(r),binding).then(data => ({data})); }
  @Post(':bindingId/access-retry') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.retryScheduleAccess)
  retryAccess(@Req() r: HonRequest,@Param('bindingId') binding: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.schedules.retryAccess(subject(r),binding,body,key).then(data => ({data}));
  }
  @Post(':bindingId/welcome-credit') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.applyScheduleWelcomeCredit)
  applyWelcomeCredit(@Req() r: HonRequest,@Param('bindingId') binding: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.schedules.applyWelcomeCredit(subject(r),binding,body,key).then(data => ({data}));
  }
}
