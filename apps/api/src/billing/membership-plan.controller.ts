import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID, type CrmAdultMembershipDraftFromPlanApiResponse, type CrmAdultMembershipPlanOptionsApiResponse, type MembershipPlanCatalogApiResponse, type MembershipPlanCommandApiResponse, type MembershipPlanContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmAdultMembershipNoStoreGuard } from './crm-adult-membership-draft.dto.js';
import {
  CreateMembershipPlanDto, CrmAdultMembershipDraftFromPlanDto, CrmAdultMembershipDraftFromPlanHumanUiGuard, CrmAdultMembershipPlanOptionsHumanUiGuard,
  MembershipPlanCatalogHumanUiGuard, MembershipPlanCreateHumanUiGuard, MembershipPlanReadDto, MembershipPlanReviseHumanUiGuard, ReviseMembershipPlanDto,
} from './membership-plan.dto.js';
import { MembershipPlanService } from './membership-plan.service.js';

// URL scope is a selector only; the signed identity, the live permission scope and PostgreSQL decide.
async function planContext(database: RuntimeDatabaseService, organizationId: string, schoolId: string, key: string, req: HonRequest, permission: string, denied: string): Promise<MembershipPlanContext> {
  if (![organizationId, schoolId].every(id => CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(id)) || !req.honIdentity) throw new ForbiddenException({ code: denied });
  const externalSubject = req.honIdentity.externalSubject;
  const scope = await database.resolveAuthorizedScope(externalSubject, schoolId.toLowerCase(), permission);
  if (!scope || scope.organizationId !== organizationId.toLowerCase() || scope.schoolId !== schoolId.toLowerCase()) throw new ForbiddenException({ code: denied });
  const requestId = randomUUID();
  return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: key };
}

@Controller('organizations/:organizationId/schools/:schoolId/billing/membership-plans')
@UseGuards(CrmAdultMembershipNoStoreGuard, HonIdentityGuard)
export class MembershipPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: MembershipPlanService) {}
  private context(organizationId: string, schoolId: string, key: string, req: HonRequest) {
    return planContext(this.database, organizationId, schoolId, key, req, 'billing.membership_plan.manage', 'MEMBERSHIP_PLAN_FORBIDDEN');
  }
  @Post('catalog') @HttpCode(200) @UseGuards(MembershipPlanCatalogHumanUiGuard)
  async catalog(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Body() _input: MembershipPlanReadDto, @Req() req: HonRequest): Promise<MembershipPlanCatalogApiResponse> {
    const context = await this.context(organizationId, schoolId, '', req);
    return { data: await this.plans.catalog(context), meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false } };
  }
  @Post() @HttpCode(200) @UseGuards(MembershipPlanCreateHumanUiGuard)
  async create(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Headers('idempotency-key') key: string, @Body() input: CreateMembershipPlanDto, @Req() req: HonRequest): Promise<MembershipPlanCommandApiResponse> {
    const context = await this.context(organizationId, schoolId, key, req);
    const result = await this.plans.create(context, input as never);
    return { data: result.plan, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
  @Post(':planId/revisions') @HttpCode(200) @UseGuards(MembershipPlanReviseHumanUiGuard)
  async revise(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('planId') planId: string, @Headers('idempotency-key') key: string, @Body() input: ReviseMembershipPlanDto, @Req() req: HonRequest): Promise<MembershipPlanCommandApiResponse> {
    const context = await this.context(organizationId, schoolId, key, req);
    const result = await this.plans.revise(context, planId, input as never);
    return { data: result.plan, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
}

/** Plan-bound adult DRAFT routes beside the existing adult DRAFT routes; the free-text route is unchanged. */
@Controller('organizations/:organizationId/schools/:schoolId/billing/crm-adult-membership-drafts')
@UseGuards(CrmAdultMembershipNoStoreGuard, HonIdentityGuard)
export class CrmAdultMembershipDraftFromPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: MembershipPlanService) {}
  private context(organizationId: string, schoolId: string, key: string, req: HonRequest) {
    return planContext(this.database, organizationId, schoolId, key, req, 'billing.membership.create', 'CRM_ADULT_MEMBERSHIP_FORBIDDEN');
  }
  @Post('plan-options') @HttpCode(200) @UseGuards(CrmAdultMembershipPlanOptionsHumanUiGuard)
  async options(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Body() _input: MembershipPlanReadDto, @Req() req: HonRequest): Promise<CrmAdultMembershipPlanOptionsApiResponse> {
    const context = await this.context(organizationId, schoolId, '', req);
    return { data: await this.plans.adultDraftPlanOptions(context), meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false } };
  }
  @Post('from-plan') @HttpCode(200) @UseGuards(CrmAdultMembershipDraftFromPlanHumanUiGuard)
  async draft(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Headers('idempotency-key') key: string, @Body() input: CrmAdultMembershipDraftFromPlanDto, @Req() req: HonRequest): Promise<CrmAdultMembershipDraftFromPlanApiResponse> {
    const context = await this.context(organizationId, schoolId, key, req);
    const { replayed, ...data } = await this.plans.draftAdultMembershipFromPlan(context, input as never);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed } };
  }
}
