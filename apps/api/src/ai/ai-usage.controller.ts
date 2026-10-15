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
import { AiUsageQueryDto } from './ai-usage.dto.js';
import { AiUsageService } from './ai-usage.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/ai/usage')
@UseGuards(HonIdentityGuard)
export class AiUsageController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly usage: AiUsageService,
  ) {}

  @Get()
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: AiUsageQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // The route organization value is not authority. The live SECURITY DEFINER
    // resolver derives the human principal and tenant scope from verified identity.
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'ai.usage.read',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON AI usage read is not authorized for this school.');
    }

    const requestId = randomUUID();
    const usage = await this.usage.read({
      ...scope,
      principalType: 'HUMAN_USER',
      requestId,
    }, query);
    return {
      data: usage,
      meta: { requestId, correlationId: requestId },
    };
  }
}
