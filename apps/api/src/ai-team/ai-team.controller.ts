import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { UpdateAiTeamPresentationDto } from './ai-team-presentation.dto.js';
import { AiTeamService } from './ai-team.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/ai/team')
@UseGuards(HonIdentityGuard)
export class AiTeamController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly aiTeam: AiTeamService,
  ) {}

  /**
   * Resolves human identity, school scope, and the sensitive live permission on
   * the server. Path values, request payload, and any client tier claim are
   * never authority.
   */
  private async context(
    request: HonRequest,
    organizationId: string,
    schoolId: string,
    idempotencyKey: string,
  ): Promise<CommandContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'ai.team.configure',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON AI Team presentation access is not authorized for this school.');
    }
    const requestId = randomUUID();
    return {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey,
      source: 'HUMAN_UI',
    };
  }

  @Get()
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, `read:${randomUUID()}`);
    const directory = await this.aiTeam.list(context);
    return {
      data: directory,
      meta: { requestId: context.requestId, correlationId: context.correlationId },
    };
  }

  @Patch(':agentKey/presentation')
  @HttpCode(HttpStatus.OK)
  async updatePresentation(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('agentKey') agentKey: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: UpdateAiTeamPresentationDto,
    @Req() request: HonRequest,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for an AI Team presentation update.',
      });
    }
    const context = await this.context(request, organizationId, schoolId, normalizedIdempotencyKey);
    const result = await this.aiTeam.update(context, agentKey, input);
    return {
      data: result.agent,
      meta: {
        requestId: context.requestId,
        correlationId: context.correlationId,
        replayed: result.replayed,
      },
    };
  }
}
