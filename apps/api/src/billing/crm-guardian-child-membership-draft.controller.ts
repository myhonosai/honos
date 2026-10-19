import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  verifyCrmGuardianChildMembershipDraftApiResponse,
  verifyCrmGuardianChildMembershipDraftConfirmationApiResponse,
  verifyCrmGuardianChildMembershipPreparationApiResponse,
  verifyCrmGuardianChildPayerDesignationApiResponse,
  verifyCrmGuardianChildPayerDesignationPreparationApiResponse,
  type CrmGuardianChildMembershipDraftContext,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  CrmGuardianChildMembershipConfirmationHumanUiGuard,
  CrmGuardianChildMembershipDraftConfirmationDto,
  CrmGuardianChildMembershipDraftDto,
  CrmGuardianChildMembershipHumanUiGuard,
  CrmGuardianChildMembershipNoStoreGuard,
  CrmGuardianChildMembershipPreparationDto,
  CrmGuardianChildMembershipPreparationHumanUiGuard,
  CrmGuardianChildPayerDesignationDto,
  CrmGuardianChildPayerDesignationHumanUiGuard,
  CrmGuardianChildPayerDesignationPreparationDto,
  CrmGuardianChildPayerDesignationPreparationHumanUiGuard,
} from './crm-guardian-child-membership-draft.dto.js';
import { CrmGuardianChildMembershipDraftService } from './crm-guardian-child-membership-draft.service.js';

abstract class CrmGuardianChildMembershipBaseController {
  constructor(protected readonly database: RuntimeDatabaseService, protected readonly guardianChildMemberships: CrmGuardianChildMembershipDraftService) {}

  protected async context(organizationId: string, schoolId: string, idempotencyKey: string, request: HonRequest): Promise<CrmGuardianChildMembershipDraftContext> {
    if (![organizationId, schoolId].every(id => CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(id)) || !request.honIdentity) {
      throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' });
    }
    const externalSubject = request.honIdentity.externalSubject;
    const scope = await this.database.resolveAuthorizedScope(externalSubject, schoolId.toLowerCase(), 'billing.membership.create');
    if (!scope || scope.organizationId !== organizationId.toLowerCase() || scope.schoolId !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return {
      ...scope,
      externalSubject,
      principalType: 'HUMAN_USER',
      source: 'HUMAN_UI',
      requestId,
      correlationId: requestId,
      idempotencyKey,
    };
  }
}

@Controller('organizations/:organizationId/schools/:schoolId/billing/crm-guardian-child-payer-designations')
@UseGuards(CrmGuardianChildMembershipNoStoreGuard, HonIdentityGuard)
export class CrmGuardianChildPayerDesignationController extends CrmGuardianChildMembershipBaseController {
  constructor(database: RuntimeDatabaseService, guardianChildMemberships: CrmGuardianChildMembershipDraftService) {
    super(database, guardianChildMemberships);
  }

  @Post('preparation')
  @HttpCode(200)
  @UseGuards(CrmGuardianChildPayerDesignationPreparationHumanUiGuard)
  async prepare(
    @Param('organizationId') organizationId: string,
    @Param('schoolId') schoolId: string,
    @Body() input: CrmGuardianChildPayerDesignationPreparationDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(organizationId, schoolId, '', request);
    return verifyCrmGuardianChildPayerDesignationPreparationApiResponse({
      data: await this.guardianChildMemberships.preparePayerDesignation(context, input),
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false },
    });
  }

  @Post()
  @HttpCode(200)
  @UseGuards(CrmGuardianChildPayerDesignationHumanUiGuard)
  async designate(
    @Param('organizationId') organizationId: string,
    @Param('schoolId') schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() input: CrmGuardianChildPayerDesignationDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(organizationId, schoolId, idempotencyKey, request);
    const result = await this.guardianChildMemberships.designatePayer(context, input);
    return verifyCrmGuardianChildPayerDesignationApiResponse({
      data: result.receipt,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    });
  }
}

@Controller('organizations/:organizationId/schools/:schoolId/billing/crm-guardian-child-membership-drafts')
@UseGuards(CrmGuardianChildMembershipNoStoreGuard, HonIdentityGuard)
export class CrmGuardianChildMembershipDraftController extends CrmGuardianChildMembershipBaseController {
  constructor(database: RuntimeDatabaseService, guardianChildMemberships: CrmGuardianChildMembershipDraftService) {
    super(database, guardianChildMemberships);
  }

  @Post('preparation')
  @HttpCode(200)
  @UseGuards(CrmGuardianChildMembershipPreparationHumanUiGuard)
  async prepare(
    @Param('organizationId') organizationId: string,
    @Param('schoolId') schoolId: string,
    @Body() input: CrmGuardianChildMembershipPreparationDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(organizationId, schoolId, '', request);
    return verifyCrmGuardianChildMembershipPreparationApiResponse({
      data: await this.guardianChildMemberships.prepareMembershipDraft(context, input),
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false },
    });
  }

  @Post('confirmation')
  @HttpCode(200)
  @UseGuards(CrmGuardianChildMembershipConfirmationHumanUiGuard)
  async confirmCurrentDraft(
    @Param('organizationId') organizationId: string,
    @Param('schoolId') schoolId: string,
    @Body() input: CrmGuardianChildMembershipDraftConfirmationDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(organizationId, schoolId, '', request);
    return verifyCrmGuardianChildMembershipDraftConfirmationApiResponse({
      data: await this.guardianChildMemberships.confirmCurrentMembershipDraft(context, input),
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false },
    });
  }

  @Post()
  @HttpCode(200)
  @UseGuards(CrmGuardianChildMembershipHumanUiGuard)
  async draft(
    @Param('organizationId') organizationId: string,
    @Param('schoolId') schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() input: CrmGuardianChildMembershipDraftDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(organizationId, schoolId, idempotencyKey, request);
    const result = await this.guardianChildMemberships.draftMembership(context, input);
    return verifyCrmGuardianChildMembershipDraftApiResponse({
      data: result.receipt,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    }, input);
  }
}
