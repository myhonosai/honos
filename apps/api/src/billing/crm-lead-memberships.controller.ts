import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmLeadMembershipsService } from './crm-lead-memberships.service.js';
import { CrmLeadMembershipsHumanUiGuard } from './membership-activation-human-ui.guard.js';
import type { MembershipLifecycleContext } from './membership.service.js';

/**
 * D-M1 (0200): which memberships did this lead's own CRM workflow create, and what lifecycle state are they in now.
 * Lets a new session find an activated (or still DRAFT) membership again; detail stays behind activation-context.
 * Exactly one lead id; no search, no query parameters, no school-wide list.
 */
@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
@UseGuards(HonIdentityGuard, CrmLeadMembershipsHumanUiGuard)
export class CrmLeadMembershipsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly discovery: CrmLeadMembershipsService) {}

  @Get(':leadId/memberships')
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Req() request: HonRequest,
  ) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    // URL scope is a selector only; the signed identity, live scope and the database actor proof decide.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId.toLowerCase(), 'billing.membership.activate');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CRM_LEAD_MEMBERSHIPS_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context: MembershipLifecycleContext = { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId,
      idempotencyKey: '', externalSubject: identity.externalSubject };
    const data = await this.discovery.read(context, leadId.toLowerCase());
    return { data, meta: { requestId, correlationId: requestId } };
  }
}
