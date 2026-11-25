import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isAgentSpeechAgent } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AgentSpeechService, type AgentSpeechContext } from './agent-speech.service.js';

/** 0652: reading the voice status and asking for one clip are each their own same-origin browser command. */
@Injectable() export class AgentSpeechReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'agent.speech.read'; }
@Injectable() export class AgentSpeechSpeakHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'agent.speech.speak'; }

/**
 * Staff agent natural voices. Route identifiers are never authority: the scope comes from the verified session (the
 * agent's own switch at this school, 0635), and the database re-proves both agent keys, Complete and every S4 spend
 * control before any clip is made.
 */
@Controller('organizations/:organizationId/schools/:schoolId/agents/:agentKey/speech')
@UseGuards(HonIdentityGuard)
export class AgentSpeechController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly speech: AgentSpeechService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AgentSpeechReadHumanUiGuard)
  async status(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('agentKey') agent: string,
    @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, agent);
    return { data: await this.speech.status(context, agent), meta: { requestId: context.requestId } };
  }

  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AgentSpeechSpeakHumanUiGuard)
  async speak(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('agentKey') agent: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, agent);
    return { data: await this.speech.speak(context, agent, input, k?.trim()), meta: { requestId: context.requestId } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, agent: string): Promise<AgentSpeechContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length || !isAgentSpeechAgent(agent)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, `ai.agent.${agent}.use`);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'AGENT_SPEECH_FORBIDDEN' });
    return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), externalSubject: identity.externalSubject };
  }
}
