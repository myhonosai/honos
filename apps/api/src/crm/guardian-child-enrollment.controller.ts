import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CRM_LEAD_REGISTRATION_UUID, type CrmGuardianChildAdditionApiResponse, type CrmGuardianChildEnrollmentApiResponse, type CrmGuardianChildEnrollmentContext,
  type CrmGuardianChildMembershipDraftFromPlanApiResponse, type CrmGuardianChildPayerDesignationApiResponse,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmAdultMembershipNoStoreGuard } from '../billing/crm-adult-membership-draft.dto.js';
import {
  CrmGuardianChildAdditionDto, CrmGuardianChildAdditionHumanUiGuard, CrmGuardianChildEnrollmentReadDto, CrmGuardianChildEnrollmentReadHumanUiGuard,
  CrmGuardianChildMembershipDraftFromPlanDto, CrmGuardianChildMembershipDraftFromPlanHumanUiGuard, CrmGuardianChildPayerDesignationDto, CrmGuardianChildPayerDesignationHumanUiGuard,
} from './guardian-child-enrollment.dto.js';
import { GuardianChildEnrollmentService } from './guardian-child-enrollment.service.js';

// URL scope is a selector only; the signed identity, the live registration scope and PostgreSQL decide.
async function enrollmentContext(database: RuntimeDatabaseService, organizationId: string, schoolId: string, key: string, req: HonRequest): Promise<CrmGuardianChildEnrollmentContext> {
  if (![organizationId, schoolId].every(id => CRM_LEAD_REGISTRATION_UUID.test(id)) || !req.honIdentity) throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' });
  const externalSubject = req.honIdentity.externalSubject;
  const scope = await database.resolveCrmLeadRegistrationScope(externalSubject, schoolId.toLowerCase());
  if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' });
  const requestId = randomUUID();
  return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: key };
}

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/guardian-child-enrollment')
@UseGuards(CrmAdultMembershipNoStoreGuard, HonIdentityGuard)
export class GuardianChildEnrollmentController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly enrollments: GuardianChildEnrollmentService) {}
  @Post() @HttpCode(200) @UseGuards(CrmGuardianChildEnrollmentReadHumanUiGuard)
  async read(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string, @Body() _input: CrmGuardianChildEnrollmentReadDto, @Req() req: HonRequest): Promise<CrmGuardianChildEnrollmentApiResponse> {
    const context = await enrollmentContext(this.database, organizationId, schoolId, '', req);
    return { data: await this.enrollments.read(context, leadId), meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false } };
  }
  @Post('payer-designation') @HttpCode(200) @UseGuards(CrmGuardianChildPayerDesignationHumanUiGuard)
  async designate(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string, @Headers('idempotency-key') key: string, @Body() input: CrmGuardianChildPayerDesignationDto, @Req() req: HonRequest): Promise<CrmGuardianChildPayerDesignationApiResponse> {
    const context = await enrollmentContext(this.database, organizationId, schoolId, key, req);
    const result = await this.enrollments.designatePayer(context, leadId, input as never);
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
  @Post('children') @HttpCode(200) @UseGuards(CrmGuardianChildAdditionHumanUiGuard)
  async addChild(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string, @Headers('idempotency-key') key: string, @Body() input: CrmGuardianChildAdditionDto, @Req() req: HonRequest): Promise<CrmGuardianChildAdditionApiResponse> {
    const context = await enrollmentContext(this.database, organizationId, schoolId, key, req);
    const result = await this.enrollments.addChild(context, leadId, input as never);
    return { data: result.result, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
}

/** Plan-bound child DRAFT beside the adult DRAFT routes; the plan options come from the existing adult plan-options read. */
@Controller('organizations/:organizationId/schools/:schoolId/billing/crm-guardian-child-membership-drafts')
@UseGuards(CrmAdultMembershipNoStoreGuard, HonIdentityGuard)
export class GuardianChildMembershipDraftController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly enrollments: GuardianChildEnrollmentService) {}
  @Post('from-plan') @HttpCode(200) @UseGuards(CrmGuardianChildMembershipDraftFromPlanHumanUiGuard)
  async draft(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Headers('idempotency-key') key: string, @Body() input: CrmGuardianChildMembershipDraftFromPlanDto, @Req() req: HonRequest): Promise<CrmGuardianChildMembershipDraftFromPlanApiResponse> {
    const context = await enrollmentContext(this.database, organizationId, schoolId, key, req);
    const { replayed, ...data } = await this.enrollments.draftMembershipFromPlan(context, input as never);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed } };
  }
}
