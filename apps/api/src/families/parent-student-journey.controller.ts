import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ParentStudentJourneyService } from './parent-student-journey.service.js';

/**
 * Parent/Eian has a separate, non-directory route shape: the school and family
 * are solely lookup inputs for an authenticated parent-family resolver. There is
 * intentionally no organization id, list route, mutation, Action Engine, AI,
 * billing, or provider operation here.
 */
@Controller('parent/schools/:schoolId/families/:familyId')
@UseGuards(HonIdentityGuard)
export class ParentStudentJourneyController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly journeys: ParentStudentJourneyService,
  ) {}

  @Get('student-journey')
  async getStudentJourney(
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('familyId', new ParseUUIDPipe()) familyId: string,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // The resolver is the sole authorization source for parent family access.
    // In particular, organization/school scope is never accepted from a client.
    const scopes = await this.database.resolveParentFamilyScopes(identity.externalSubject, schoolId);
    const resolvedScope = scopes.find(
      (scope) => scope.schoolId === schoolId && scope.familyId === familyId,
    );
    if (!resolvedScope) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    const requestId = randomUUID();
    return {
      data: await this.journeys.get(resolvedScope, familyId, requestId),
      meta: {
        requestId,
        correlationId: requestId,
      },
    };
  }
}
