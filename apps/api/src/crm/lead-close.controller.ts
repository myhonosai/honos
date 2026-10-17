import { Body, Controller, ForbiddenException, Header, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CrmLeadCloseContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CloseCrmLeadDto, LeadCloseHumanUiGuard } from './lead-close.dto.js';
import { crmCloseUuid, LeadCloseService } from './lead-close.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
@UseGuards(HonIdentityGuard, LeadCloseHumanUiGuard)
export class LeadCloseController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly leads: LeadCloseService) {}
  @Header('Cache-Control', 'private, no-store') @Post(':leadId/close') @HttpCode(200)
  async close(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CloseCrmLeadDto, @Req() req: HonRequest) {
    crmCloseUuid(organizationId); crmCloseUuid(schoolId); crmCloseUuid(leadId); crmCloseUuid(key);
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveCrmLeadCloseScope(externalSubject, schoolId);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    const c: CrmLeadCloseContext = { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
    const r = await this.leads.close(c, leadId, input);
    return { data: r.receipt, meta: { requestId: id, correlationId: id, replayed: r.replayed } };
  }
}
