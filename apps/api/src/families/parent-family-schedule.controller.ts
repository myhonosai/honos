import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  normalizeParentFamilyScheduleRange,
  ParentFamilyScheduleQueryDto,
} from './parent-family-schedule-query.dto.js';
import { ParentFamilyScheduleService } from './parent-family-schedule.service.js';

/**
 * Parent/Eian schedule reads have no organization parameter or school-wide
 * authorization fallback. The URL school/family pair is only a lookup input to
 * the authenticated parent-family resolver.
 */
@Controller('parent/schools/:schoolId/families/:familyId')
@UseGuards(HonIdentityGuard)
export class ParentFamilyScheduleController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly schedules: ParentFamilyScheduleService,
  ) {}

  @Get('schedule')
  async getSchedule(
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('familyId', new ParseUUIDPipe()) familyId: string,
    @Query() query: ParentFamilyScheduleQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // resolveParentFamilyScopes is the exclusive authorization source. In
    // particular, neither an organization id nor a broad school/staff scope is
    // accepted from a client.
    const scopes = await this.database.resolveParentFamilyScopes(identity.externalSubject, schoolId);
    const resolvedScope = scopes.find(
      (scope) => scope.schoolId === schoolId && scope.familyId === familyId,
    );
    if (!resolvedScope) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    const range = normalizeParentFamilyScheduleRange(query);
    const requestId = randomUUID();
    return {
      data: await this.schedules.get(resolvedScope, familyId, range, requestId),
      meta: {
        requestId,
        correlationId: requestId,
      },
    };
  }
}
