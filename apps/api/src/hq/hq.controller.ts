import { BadRequestException, Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { HqOverviewService } from './hq-overview.service.js';
import { HqSchoolDirectoryService } from './hq-school-directory.service.js';

@Controller('hq')
@UseGuards(HonIdentityGuard)
export class HqController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly overview: HqOverviewService,
    private readonly schools: HqSchoolDirectoryService,
  ) {}

  @Get('session')
  async session(@Req() request: HonRequest) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveHqOperatorScope(identity.externalSubject, 'hq.dashboard.view');
    if (!scope) throw new ForbiddenException('HON HQ access is not provisioned for this account.');
    return { data: scope };
  }

  /**
   * Fixed HQ-only platform projection. The authenticated subject is the only
   * input; this route deliberately accepts no selector, role, authority, tier,
   * target, body, or time range.
   */
  @Get('overview')
  async readOverview(@Req() request: HonRequest) {
    const hasQuery = Object.keys(request.query ?? {}).length > 0;
    const hasBody = request.body !== undefined && request.body !== null
      && (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0);
    if (hasQuery || hasBody) {
      throw new BadRequestException({ code: 'HQ_OVERVIEW_SELECTOR_REJECTED', detail: 'The HQ overview accepts no selectors or request fields.' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'HQ_OVERVIEW_FORBIDDEN', detail: 'Verified HQ identity is required.' });
    return { data: { overview: await this.overview.read(identity.externalSubject) } };
  }

  /**
   * Fixed HQ-only customer-account directory. The authenticated application
   * subject is the only input; no account, school, organization, tier, source,
   * delegation, support, role, body, query, or action selector is accepted.
   */
  @Get('schools')
  async readSchools(@Req() request: HonRequest) {
    const hasQuery = Object.keys(request.query ?? {}).length > 0;
    const hasBody = request.body !== undefined && request.body !== null
      && (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0);
    if (hasQuery || hasBody) {
      throw new BadRequestException({ code: 'HQ_SCHOOLS_SELECTOR_REJECTED', detail: 'The HQ school directory accepts no selectors or request fields.' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'HQ_SCHOOLS_FORBIDDEN', detail: 'Verified HQ identity is required.' });
    return { data: { directory: await this.schools.read(identity.externalSubject) } };
  }
}
