import { Body, Controller, ForbiddenException, Header, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CrmLeadRegistrationContext, RegisterCrmLeadInput } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RegisterCrmLeadDto, LeadRegistrationHumanUiGuard } from './lead-registration.dto.js';
import { crmRegistrationUuid, LeadRegistrationService } from './lead-registration.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
@UseGuards(HonIdentityGuard, LeadRegistrationHumanUiGuard)
export class LeadRegistrationController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly registrations: LeadRegistrationService) {}
  @Header('Cache-Control','private, no-store') @Post(':leadId/register') @HttpCode(200)
  async register(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('leadId') leadId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: RegisterCrmLeadDto, @Req() req: HonRequest) {
    crmRegistrationUuid(organizationId); crmRegistrationUuid(schoolId); crmRegistrationUuid(leadId); crmRegistrationUuid(key);
    if (!req.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    const externalSubject=req.honIdentity.externalSubject;
    const scope=await this.database.resolveCrmLeadRegistrationScope(externalSubject,schoolId);
    if(!scope || scope.organizationId.toLowerCase()!==organizationId.toLowerCase() || scope.schoolId.toLowerCase()!==schoolId.toLowerCase()) throw new ForbiddenException({code:'STAFF_SCOPE_DENIED'});
    const id=randomUUID(); const context: CrmLeadRegistrationContext={...scope,externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key};
    const result=await this.registrations.register(context,leadId,input as unknown as RegisterCrmLeadInput);
    return {data:result.result,meta:{requestId:id,correlationId:id,replayed:result.replayed}};
  }
}
