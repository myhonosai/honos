import { Body, Controller, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { SIGNUP_HUMAN_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertSchoolAccountHumanRequest } from './school-staff-invitation.controller.js';
import { HonOsSignupService } from './hon-os-signup.service.js';

/** Same-origin human browser command only; the database decides eligibility again under the account locks. */
@Injectable()
export class HonOsSignupHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, SIGNUP_HUMAN_COMMAND); }
}

@Controller() @UseGuards(HonOsSignupHumanGuard, HonIdentityGuard)
export class HonOsSignupController {
  constructor(private readonly signup: HonOsSignupService) {}
  @Post('account/sign-up') @HttpCode(200)
  register(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.signup.register(r, b, k).then(data => ({ data })); }
  @Get('account/sign-up')
  status(@Req() r: HonRequest) { return this.signup.status(r).then(data => ({ data })); }
}
