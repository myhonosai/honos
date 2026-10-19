import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID, type CrmAdultMembershipDraftContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmAdultMembershipDraftService } from './crm-adult-membership-draft.service.js';
import { CrmAdultMembershipDraftDto, CrmAdultMembershipPreparationDto, CrmAdultMembershipDraftHumanUiGuard, CrmAdultMembershipPreparationHumanUiGuard, CrmAdultMembershipNoStoreGuard } from './crm-adult-membership-draft.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/billing/crm-adult-membership-drafts')
@UseGuards(CrmAdultMembershipNoStoreGuard, HonIdentityGuard)
export class CrmAdultMembershipDraftController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly memberships: CrmAdultMembershipDraftService) {}
  private async context(organizationId: string, schoolId: string, key: string, req: HonRequest): Promise<CrmAdultMembershipDraftContext> {
    if (![organizationId,schoolId].every(id => CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(id)) || !req.honIdentity) throw new ForbiddenException({ code: 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveAuthorizedScope(externalSubject, schoolId.toLowerCase(), 'billing.membership.create');
    if (!scope || scope.organizationId !== organizationId.toLowerCase() || scope.schoolId !== schoolId.toLowerCase()) throw new ForbiddenException({ code: 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: key };
  }
  @Post('preparation') @HttpCode(200) @UseGuards(CrmAdultMembershipPreparationHumanUiGuard)
  async prepare(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Body() input: CrmAdultMembershipPreparationDto, @Req() req: HonRequest) {
    const context = await this.context(organizationId, schoolId, '', req);
    return { data: await this.memberships.prepare(context, input), meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: false } };
  }
  @Post() @HttpCode(200) @UseGuards(CrmAdultMembershipDraftHumanUiGuard)
  async draft(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Headers('idempotency-key') key: string, @Body() input: CrmAdultMembershipDraftDto, @Req() req: HonRequest) {
    const context = await this.context(organizationId, schoolId, key, req);
    const result = await this.memberships.draft(context, input);
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
}
