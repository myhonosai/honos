import { Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CrmIntakeStagesReadContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CrmIntakeStagesHumanUiGuard } from './crm-intake-stages-human-ui.guard.js';
import { CrmIntakeStagesService } from './crm-intake-stages.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/intake-stages')
@UseGuards(HonIdentityGuard, CrmIntakeStagesHumanUiGuard)
export class CrmIntakeStagesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly stages: CrmIntakeStagesService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ): Promise<{ data: Awaited<ReturnType<CrmIntakeStagesService['read']>>; meta: { requestId: string; correlationId: string } }> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    // This reuses the canonical lead-create permission before the fixed named
    // projection repeats current-human, entitlement, permission and RLS checks.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.lead.create');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException({ code: 'CRM_INTAKE_STAGES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context: CrmIntakeStagesReadContext = {
      ...scope,
      externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: '',
    };
    return { data: await this.stages.read(context), meta: { requestId, correlationId: requestId } };
  }
}
