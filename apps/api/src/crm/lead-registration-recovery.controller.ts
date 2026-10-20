import { Body, Controller, ForbiddenException, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CrmLeadRegistrationRecoveryApiResponse, CrmLeadRegistrationRecoveryContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmLeadRegistrationRecoveryDto, LeadRegistrationRecoveryHumanUiGuard } from './lead-registration-recovery.dto.js';
import { LeadRegistrationRecoveryService } from './lead-registration-recovery.service.js';
import { crmRegistrationUuid } from './lead-registration.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
@UseGuards(HonIdentityGuard, LeadRegistrationRecoveryHumanUiGuard)
export class LeadRegistrationRecoveryController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly recoveries: LeadRegistrationRecoveryService) {}
  @Post(':leadId/registration-recovery') @HttpCode(200)
  async recover(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string, @Body() _input: CrmLeadRegistrationRecoveryDto, @Req() req: HonRequest): Promise<CrmLeadRegistrationRecoveryApiResponse> {
    crmRegistrationUuid(organizationId); crmRegistrationUuid(schoolId); crmRegistrationUuid(leadId);
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    // URL scope is a selector only; the signed identity and live database scope decide.
    const scope = await this.database.resolveCrmLeadRegistrationScope(externalSubject, schoolId.toLowerCase());
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    const context: CrmLeadRegistrationRecoveryContext = { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: '' };
    const data = await this.recoveries.recover(context, leadId.toLowerCase());
    return { data, meta: { requestId: id, correlationId: id, replayed: false } };
  }
}
