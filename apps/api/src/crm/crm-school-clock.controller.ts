import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Param, ParseUUIDPipe, Req, UseGuards, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { CrmSchoolClockService } from './crm-school-clock.service.js';

/** Any one of these, live at the route school, admits the read (the database re-checks the same set). */
const CLOCK_PERMISSIONS = ['crm.trial.schedule', 'crm.trial.manage', 'crm.follow_up.manage', 'crm.follow_up.self_manage'] as const;

/** Browser read only: no query selectors, no delegated, automated or cross-site selectors (GET carries no body). */
@Injectable()
export class CrmSchoolClockHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.school-clock';
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CRM_SCHOOL_CLOCK_SELECTORS_NOT_ACCEPTED' });
    return super.canActivate(context);
  }
}

/** B-CRM-3 (0236): the verified school's timezone and local date for CRM time entry. */
@Controller('organizations/:organizationId/schools/:schoolId/crm/school-clock')
@UseGuards(HonIdentityGuard, CrmSchoolClockHumanUiGuard)
export class CrmSchoolClockController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly clock: CrmSchoolClockService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // Route identifiers are not authority: the scope comes from the verified session identity and is re-decided live
    // inside the read by the definer function.
    for (const permission of CLOCK_PERMISSIONS) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (scope && scope.organizationId.toLowerCase() === organizationId.toLowerCase() && scope.schoolId.toLowerCase() === schoolId.toLowerCase()) {
        const requestId = randomUUID();
        const context: MembershipLifecycleContext = { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: identity.externalSubject,
          requestId, correlationId: requestId, idempotencyKey: '' };
        const data = await this.clock.read(context);
        return { data, meta: { requestId, correlationId: requestId } };
      }
    }
    throw new ForbiddenException({ code: 'CRM_SCHOOL_CLOCK_FORBIDDEN' });
  }
}
