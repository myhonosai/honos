import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasSubscriptionGenerationService } from './saas-subscription-generation.service.js';
const subject = (r: HonRequest) => { if (!r.honIdentity) throw new ForbiddenException({code:'SAAS_FORBIDDEN'}); return r.honIdentity.externalSubject; };
@Controller('schools/:schoolId/hon-os-subscription-generations') @UseGuards(HonIdentityGuard)
export class SaasSubscriptionGenerationSchoolController {
  constructor(private readonly generations: SaasSubscriptionGenerationService) {}
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordSubscriptionGeneration)
  record(@Req() r: HonRequest,@Param('schoolId') school: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.generations.record(subject(r),school,body,key).then(data => ({data}));
  }
  @Get(':generationId') @UseGuards(SaasReadGuard)
  read(@Req() r: HonRequest,@Param('schoolId') school: string,@Param('generationId') id: string) {
    return this.generations.read(subject(r),school,id).then(data => ({data}));
  }
}
@Controller('hq/saas/subscription-generations') @UseGuards(HonIdentityGuard)
export class SaasSubscriptionGenerationHqController {
  constructor(private readonly generations: SaasSubscriptionGenerationService) {}
  @Get(':generationId') @UseGuards(SaasReadGuard)
  read(@Req() r: HonRequest,@Param('generationId') id: string) { return this.generations.readHq(subject(r),id).then(data => ({data})); }
}
