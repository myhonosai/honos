import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Header,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyPlannedAbsenceDecisionReceipt, type PlannedAbsenceReviewContext } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { DecidePlannedAbsenceRequestDto } from './decide-planned-absence-request.dto.js';
import { PlannedAbsenceReviewService } from './planned-absence-review.service.js';
import { PlannedAbsenceReviewHumanUiGuard, rejectPlannedAbsenceReviewInputs } from './planned-absence-review-human-ui.guard.js';

@Controller('organizations/:organizationId/schools/:schoolId/planned-absence-requests')
@UseGuards(HonIdentityGuard, PlannedAbsenceReviewHumanUiGuard)
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
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async decide(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: DecidePlannedAbsenceRequestDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    rejectPlannedAbsenceReviewInputs(request);
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(normalizedIdempotencyKey)) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for a planned absence review decision.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolvePlannedAbsenceReviewScope(identity.externalSubject);
    if (!scope || scope.organizationId !== organizationId.toLowerCase() || scope.schoolId !== schoolId.toLowerCase()) {
      throw new ForbiddenException('HON planned absence review is not authorized for this school.');
    }

    const commandRequestId = randomUUID();
    // All command context fields are derived by this guarded boundary. The DTO
    // accepts only a decision, note, and optimistic version; the authenticated
    // resolver is the sole source of reviewer principal attribution.
    const context: PlannedAbsenceReviewContext = {
      externalSubject: identity.externalSubject,
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId: commandRequestId,
      correlationId: commandRequestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    let result;
    try { result = await this.plannedAbsenceReviews.decide(context, requestId, input); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'PLANNED_ABSENCE_REVIEW_FORBIDDEN' });
      throw new ServiceUnavailableException({ code: 'PLANNED_ABSENCE_REVIEW_UNAVAILABLE' });
    }

    response.status(HttpStatus.OK);
    return {
      data: verifyPlannedAbsenceDecisionReceipt({ id: result.plannedAbsenceRequest.id, status: result.plannedAbsenceRequest.status, version: result.plannedAbsenceRequest.version, reviewedAt: result.plannedAbsenceRequest.reviewedAt }),
      meta: {
        requestId: commandRequestId,
        correlationId: commandRequestId,
        replayed: result.replayed,
      },
    };
  }
}
