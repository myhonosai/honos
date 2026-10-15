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
import { DecidePlannedAbsenceRequestDto } from './decide-planned-absence-request.dto.js';
import { PlannedAbsenceReviewService } from './planned-absence-review.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/planned-absence-requests')
@UseGuards(HonIdentityGuard)
export class PlannedAbsenceReviewController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly plannedAbsenceReviews: PlannedAbsenceReviewService,
  ) {}

  /**
   * A separate staff-only boundary for final absence-request review. The route
   * scope is independently matched to a live permission-derived staff scope;
   * reviewers cannot nominate an actor, organization, school, or source.
   */
  @Post(':requestId/decision')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: DecidePlannedAbsenceRequestDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for a planned absence review decision.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'schedule.planned_absence.review',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON planned absence review is not authorized for this school.');
    }

    const commandRequestId = randomUUID();
    // All command context fields are derived by this guarded boundary. The DTO
    // accepts only a decision, note, and optimistic version; the authenticated
    // resolver is the sole source of reviewer principal attribution.
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId: commandRequestId,
      correlationId: commandRequestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.plannedAbsenceReviews.decide(context, requestId, input);

    response.status(HttpStatus.OK);
    return {
      data: result.plannedAbsenceRequest,
      meta: {
        requestId: commandRequestId,
        correlationId: commandRequestId,
        replayed: result.replayed,
      },
    };
  }
}
