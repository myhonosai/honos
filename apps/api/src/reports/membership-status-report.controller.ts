import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipStatusSummaryHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { MembershipDateRevisionService } from '../billing/membership-date-revision.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

/**
 * E1b-1 (0178) school membership status summary. A separate route, so the operations report and every other existing
 * response contract are unchanged. Lifecycle totals stay as stored; lifecycle-ACTIVE is split into SCHEDULED,
 * IN_EFFECT, ENDED and UNDATED (no confirmed dates). No money, names or reasons.
 */
@Controller('organizations/:organizationId/schools/:schoolId/reports/membership-status')
@UseGuards(HonIdentityGuard, MembershipStatusSummaryHumanUiGuard)
export class MembershipStatusReportController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly dates: MembershipDateRevisionService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    // Route identifiers are not authority. The SECURITY DEFINER resolver derives the live human principal and tenant
    // scope from the verified session identity; the database function re-checks reporting.view live.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'reporting.view');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON membership status reporting is not authorized for this school.');
    }
    const requestId = randomUUID();
    const data = await this.dates.statusSummary({ ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: '',
      source: 'HUMAN_UI', externalSubject: identity.externalSubject });
    return { data, meta: { requestId, correlationId: requestId } };
  }
}
