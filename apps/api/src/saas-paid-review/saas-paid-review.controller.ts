import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasPaidReviewService } from './saas-paid-review.service.js';

const subject = (r: HonRequest) => { if (!r.honIdentity) throw new ForbiddenException({ code:'SAAS_FORBIDDEN' }); return r.honIdentity.externalSubject; };

@Controller('hq/saas/paid-reviews') @UseGuards(HonIdentityGuard)
export class SaasPaidReviewHqController {
  constructor(private readonly reviews: SaasPaidReviewService) {}
  @Get() @UseGuards(SaasReadGuard)
  list(@Req() r: HonRequest,@Query('cursor') cursor: unknown) { return this.reviews.list(subject(r),cursor).then(data => ({data})); }
  @Post('resolve') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.resolvePaidReview)
  resolve(@Req() r: HonRequest,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.reviews.resolve(subject(r),body,key).then(data => ({data}));
  }
  @Post(':resolutionId/verify-refund') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.verifyPaidReviewRefund)
  verifyRefund(@Req() r: HonRequest,@Param('resolutionId') resolution: string,@Body() body: unknown,@Headers('idempotency-key') key: string | undefined) {
    return this.reviews.verifyRefund(subject(r),resolution,body,key).then(data => ({data}));
  }
}
