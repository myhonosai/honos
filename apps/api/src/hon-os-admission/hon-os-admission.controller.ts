import { Body, Controller, Get, Headers, HttpCode, Injectable, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ADMISSION_LIMITS_COMMAND, SIGNUP_PROGRAMS_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { HonOsAdmissionService } from './hon-os-admission.service.js';

/** Same-origin human browser only; the change needs its own command header. The database decides HQ authority. */
@Injectable()
export class HonOsAdmissionHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, ADMISSION_LIMITS_COMMAND); }
}

@Controller('hq/admission') @UseGuards(HonOsAdmissionHumanGuard, HonIdentityGuard)
export class HonOsAdmissionHqController {
  constructor(private readonly admission: HonOsAdmissionService) {}
  @Get()
  status(@Req() r: HonRequest) { return this.admission.status(r).then(data => ({ data })); }
  @Post('limits') @HttpCode(200)
  set(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.admission.set(r, b, k).then(data => ({ data })); }
}

/** 0710: opening or closing sign-up and trials has its own command header, separate from the limits change. */
@Injectable()
export class HonOsProgramsHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, SIGNUP_PROGRAMS_COMMAND); }
}

@Controller('hq/signup-programs') @UseGuards(HonOsProgramsHumanGuard, HonIdentityGuard)
export class HonOsProgramsHqController {
  constructor(private readonly admission: HonOsAdmissionService) {}
  @Get()
  status(@Req() r: HonRequest) { return this.admission.programs(r).then(data => ({ data })); }
  @Post() @HttpCode(200)
  set(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.admission.setPrograms(r, b, k).then(data => ({ data })); }
}
