import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqPlanPromotionsService } from './hq-plan-promotions.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * HQ plan promotions (0308): in-app promotions of a published HON OS offer to schools. HQ owner commands; HQ owner or
 * HQ marketing operator reads. In-app only: no email or text is sent, and nothing changes prices, offers or plans.
 */
@Controller('hq/plan-promotions')
@UseGuards(HonIdentityGuard)
export class HqPlanPromotionsController {
  constructor(private readonly promotions: HqPlanPromotionsService) {}
  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status','cursor','limit'])
  async list(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.promotions.list(subject(req), query) }; }
  @Get(':promotionId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('promotionId') id: string) { return { data: await this.promotions.read(subject(req), id) }; }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createPlanPromotion)
  async create(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.promotions.create(subject(req), body, key) };
  }
  @Post(':promotionId/versions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.updatePlanPromotion)
  async update(@Req() req: HonRequest, @Param('promotionId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.promotions.update(subject(req), id, body, key) };
  }
  @Post(':promotionId/status') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setPlanPromotionStatus)
  async status(@Req() req: HonRequest, @Param('promotionId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.promotions.status(subject(req), id, body, key) };
  }
}

/** The promotions shown to a school purchaser (billing.hon.purchase at the exact school) now, and seen/opened/dismissed. */
@Controller('schools/:schoolId/plan-promotions')
@UseGuards(HonIdentityGuard)
export class SchoolPlanPromotionsController {
  constructor(private readonly promotions: HqPlanPromotionsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('schoolId') schoolId: string) { return { data: await this.promotions.school(subject(req), schoolId) }; }
  @Post(':promotionId/events') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordSchoolPlanPromotionEvent)
  async event(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('promotionId') id: string, @Body() body: unknown) {
    return { data: await this.promotions.schoolEvent(subject(req), schoolId, id, body) };
  }
}
