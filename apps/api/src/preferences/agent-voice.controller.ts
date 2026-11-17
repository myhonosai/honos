import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { UpdateAgentVoiceDto } from './agent-voice.dto.js';
import { AgentVoiceService } from './agent-voice.service.js';

/** 0452: the signed-in person's own voice choice per AI teammate. Reuses the personal interface-preference permissions. */
@Controller('organizations/:organizationId/schools/:schoolId/agent-voices')
@UseGuards(HonIdentityGuard)
export class AgentVoiceController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly preferences: AgentVoiceService) {}

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<CommandContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON voice choices are not available for this school.');
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
  async get(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, 'settings.interface_theme.read', `read:${randomUUID()}`);
    const preference = await this.preferences.get(context);
    return { data: preference, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: UpdateAgentVoiceDto,
    @Req() request: HonRequest,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required to save a voice choice.' });
    }
    const context = await this.context(request, organizationId, schoolId, 'settings.interface_theme.update', idempotencyKey);
    const preference = await this.preferences.save(context, { agentKey: input.agentKey, voiceChoice: input.voiceChoice });
    return { data: preference, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: preference.replayed ?? false } };
  }
}
