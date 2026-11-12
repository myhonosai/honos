import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasFounderService } from './saas-founder.service.js';

const subject = (r: HonRequest) => { if (!r.honIdentity) throw new ForbiddenException({ code:'SAAS_FORBIDDEN' }); return r.honIdentity.externalSubject; };

@Controller('hq/saas/founder-pool') @UseGuards(HonIdentityGuard)
export class SaasFounderPoolHqController {
  constructor(private readonly founder: SaasFounderService) {}
  @Get() @UseGuards(SaasReadGuard)
  pool(@Req() r: HonRequest) { return this.founder.pool(subject(r)).then(data => ({data})); }
}

@Controller('schools/:schoolId/hon-os-founder-availability') @UseGuards(HonIdentityGuard)
export class SaasFounderAvailabilitySchoolController {
  constructor(private readonly founder: SaasFounderService) {}
  @Get() @UseGuards(SaasReadGuard)
  availability(@Req() r: HonRequest, @Param('schoolId') school: string) { return this.founder.schoolAvailability(subject(r),school).then(data => ({data})); }
}
