import { Body, Controller, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { TRIAL_HUMAN_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertSchoolAccountHumanRequest } from './school-staff-invitation.controller.js';
import { HonOsTrialService } from './hon-os-trial.service.js';

/** Same-origin human browser command only; the database decides eligibility again under the account locks. */
@Injectable()
export class HonOsTrialHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, TRIAL_HUMAN_COMMAND); }
}

@Controller() @UseGuards(HonOsTrialHumanGuard, HonIdentityGuard)
export class HonOsTrialController {
  constructor(private readonly trial: HonOsTrialService) {}
  @Post('account/trial') @HttpCode(200)
  start(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.trial.start(r, b, k).then(data => ({ data })); }
  @Get('account/trial')
  status(@Req() r: HonRequest) { return this.trial.status(r).then(data => ({ data })); }
}
