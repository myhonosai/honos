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
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ParentFamilyKnowledgeService } from './parent-family-knowledge.service.js';

/**
 * Parent/Eian knowledge has no organization route parameter, staff fallback,
 * or list authority. The route school/family pair is only lookup input to the
 * authenticated parent-family scope resolver.
 */
@Controller('parent/schools/:schoolId/families/:familyId')
@UseGuards(HonIdentityGuard)
export class ParentFamilyKnowledgeController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly knowledge: ParentFamilyKnowledgeService,
  ) {}

  @Get('knowledge')
  async getKnowledge(
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('familyId', new ParseUUIDPipe()) familyId: string,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // resolveParentFamilyScopes is the exclusive authority source. In
    // particular, a client cannot provide an organization, staff scope, role,
    // or fallback family relationship to widen this Parent/Eian read.
    const scopes = await this.database.resolveParentFamilyScopes(identity.externalSubject, schoolId);
    const resolvedScope = scopes.find(
      (scope) => scope.schoolId === schoolId && scope.familyId === familyId,
    );
    if (!resolvedScope) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    const requestId = randomUUID();
    return {
      data: await this.knowledge.get(resolvedScope, familyId, requestId),
      meta: {
        requestId,
        correlationId: requestId,
      },
    };
  }
}
