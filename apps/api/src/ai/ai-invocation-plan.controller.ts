import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from './ai-invocation-plan.service.js';

/** Read only. No generic plan/execute/provider endpoint exists. */
@Controller('organizations/:organizationId/schools/:schoolId/ai/invocation-plans')
@UseGuards(HonIdentityGuard)
export class AiInvocationPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService) {}

  @Get(':planId')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Req() request: HonRequest,
  ) {
    if (!request.honIdentity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'ai.invocation.plan');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('AI plan access is not authorized in this school.');
    const requestId = randomUUID();
    const plan = await this.plans.read({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: randomUUID() }, planId);
    return { data: plan, meta: { requestId, correlationId: requestId } };
  }
}
