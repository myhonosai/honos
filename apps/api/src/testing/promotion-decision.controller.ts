import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { DecidePromotionDto } from './decide-promotion.dto.js';
import { PromotionDecisionService } from './promotion-decision.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/testing/candidates')
@UseGuards(HonIdentityGuard)
export class PromotionDecisionController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly promotionDecisions: PromotionDecisionService,
  ) {}

  /**
   * This endpoint is deliberately a direct human-instructor command, not an
   * Action Engine proposal or executor. Its only accepted input is the final
   * decision and the instructor's rationale.
   */
  @Post(':candidateId/promotion-decision')
  async decide(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('candidateId', new ParseUUIDPipe()) candidateId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: DecidePromotionDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for a promotion decision.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'testing.promotion.decide',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON promotion decision is not authorized for this school.');
    }

    const requestId = randomUUID();
    // Deliberately hard-coded: request payloads cannot provide actor, source,
    // AI, delegation, or action-request data for this restricted command.
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.promotionDecisions.decide(context, candidateId, input);

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      data: result.decision,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
