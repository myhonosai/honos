import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateParentPlannedAbsenceDto } from './create-parent-planned-absence.dto.js';
import { ParentPlannedAbsenceService } from './parent-planned-absence.service.js';

/**
 * Parent/Eian planned absence submission is deliberately a narrow request
 * boundary: its route has no organization parameter and its only authorization
 * input is the live parent-family resolver.
 */
@Controller('parent/schools/:schoolId/families/:familyId')
@UseGuards(HonIdentityGuard)
export class ParentPlannedAbsenceController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly plannedAbsences: ParentPlannedAbsenceService,
  ) {}

  @Post('planned-absences')
  @HttpCode(HttpStatus.CREATED)
  async requestPlannedAbsence(
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('familyId', new ParseUUIDPipe()) familyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateParentPlannedAbsenceDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for a planned absence request.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // The URL family ID is only a selector. No organization, staff permission,
    // family membership, or client-provided principal can widen parent access.
    const scopes = await this.database.resolveParentFamilyScopes(identity.externalSubject, schoolId);
    const resolvedScope = scopes.find(
      (scope) => scope.schoolId === schoolId && scope.familyId === familyId,
    );
    if (!resolvedScope) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    const requestId = randomUUID();
    const command: CommandContext = {
      organizationId: resolvedScope.organizationId,
      schoolId: resolvedScope.schoolId,
      principalId: resolvedScope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.plannedAbsences.request(
      resolvedScope,
      familyId,
      command,
      input,
    );

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      data: result.plannedAbsenceRequest,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
