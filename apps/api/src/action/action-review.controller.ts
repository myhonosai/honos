import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ActionDecisionDto } from './action-decision.dto.js';
import { ActionEngineService } from './action-engine.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/action-requests')
@UseGuards(HonIdentityGuard)
export class ActionReviewController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly actions: ActionEngineService) {}

  private async reviewContext(organizationId: string, schoolId: string, request: HonRequest, idempotencyKey?: string): Promise<CommandContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'action.approve');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON Action Engine review is not authorized for this school.');
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: idempotencyKey ?? `review:${requestId}`, source: 'HUMAN_UI' };
  }

  @Get(':actionRequestId')
  async getForReview(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('actionRequestId', new ParseUUIDPipe()) actionRequestId: string,
    @Req() request: HonRequest,
  ) {
    const context = await this.reviewContext(organizationId, schoolId, request);
    return { data: await this.actions.getForReview(context, actionRequestId), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post(':actionRequestId/decision')
  async decide(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('actionRequestId', new ParseUUIDPipe()) actionRequestId: string,
    @Body() input: ActionDecisionDto,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Req() request: HonRequest,
  ) {
    const idempotencyKey = idempotencyHeader?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'Action review requires an Idempotency-Key header of at most 200 characters.' });
    }
    const context = await this.reviewContext(organizationId, schoolId, request, idempotencyKey);
    const decision = input.reason === undefined
      ? { actionRequestId, decision: input.decision }
      : { actionRequestId, decision: input.decision, reason: input.reason };
    const result = await this.actions.decide(context, decision);
    return { data: result, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
}
