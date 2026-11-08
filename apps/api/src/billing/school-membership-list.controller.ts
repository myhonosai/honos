import { Controller, ForbiddenException, Get, Header, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { SCHOOL_MEMBERSHIP_LIST_STATES, type SchoolMembershipListState } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MAX_LIST_CURSOR_LENGTH } from '../foundation/list-cursor.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from './membership-activation-human-ui.guard.js';
import type { MembershipLifecycleContext } from './membership.service.js';
import { SchoolMembershipListService } from './school-membership-list.service.js';

/** Any one of these, live at the route school, admits the list (the database re-checks the same set). */
const LIST_PERMISSIONS = ['billing.membership.read', 'billing.membership.activate', 'billing.membership.dates.revise'] as const;

export class SchoolMembershipListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  /** Opaque signed cursor from the previous page's meta.nextCursor. */
  @IsOptional() @IsString() @MaxLength(MAX_LIST_CURSOR_LENGTH)
  cursor?: string;

  /** Lifecycle state filter. */
  @IsOptional() @IsIn(SCHOOL_MEMBERSHIP_LIST_STATES)
  state?: SchoolMembershipListState;
}

/** Browser read only: no delegated, automated or cross-site selectors (GET carries no body). */
@Injectable()
export class SchoolMembershipListHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.list';
}

/** U6 (0220): read-only school-wide membership list of the verified school. */
@Controller('organizations/:organizationId/schools/:schoolId/billing/memberships')
@UseGuards(HonIdentityGuard, SchoolMembershipListHumanUiGuard)
export class SchoolMembershipListController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly memberships: SchoolMembershipListService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: SchoolMembershipListQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // Route identifiers are not authority: the scope comes from the verified session identity and is re-decided live
    // inside the read by the definer function.
    for (const permission of LIST_PERMISSIONS) {
      const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
      if (scope && scope.organizationId === organizationId && scope.schoolId === schoolId) {
        const requestId = randomUUID();
        const context: MembershipLifecycleContext = { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: identity.externalSubject,
          requestId, correlationId: requestId, idempotencyKey: '' };
        const result = await this.memberships.list(context, { limit: query.limit, cursor: query.cursor, state: query.state });
        return { data: result.items, meta: { requestId, correlationId: requestId, limit: result.limit, nextCursor: result.nextCursor,
          schoolTimezone: result.schoolTimezone, localToday: result.localToday } };
      }
    }
    throw new ForbiddenException({ code: 'MEMBERSHIP_LIST_FORBIDDEN' });
  }
}
