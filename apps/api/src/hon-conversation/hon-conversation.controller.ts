import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpException, Injectable,
  NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  composeHonConversationReadiness, validateHonConversationCreate, validateHonConversationSummary, validateHonConversationThread, validateHonOrchestrationList, type HonOrchestrationList,
  validateHonTurnReceipt, validateHonTurnRequest, type HonConversationPage, type HonDelegateAgentKey, type HonTurnReceipt,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ResolvedPrincipalScope } from '../foundation/runtime-database.service.js';
import { CampaignHumanUiGuard } from '../marketing/campaign-human-ui.guard.js';
import { MarketingAssistantService } from '../marketing/marketing-assistant.service.js';
import { TeachingAssistantService } from '../teaching-assistant/teaching-assistant.service.js';
import { ChadFollowUpAssistantService } from '../chad-follow-up-assistant/chad-follow-up-assistant.service.js';
import { AiTeamReadinessService } from '../ai-team/ai-team-readiness.controller.js';
import { HonReplyService } from './hon-reply.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Scope = ResolvedPrincipalScope & { externalSubject: string };
type Begun = { turnId: string; agentKey: HonDelegateAgentKey | 'hon'; delegation: Record<string, unknown> | null; handOff: boolean };
type Failure = 'AGENT_NOT_AUTHORIZED' | 'AGENT_REQUEST_INVALID' | 'AGENT_TARGET_NOT_FOUND' | 'AGENT_REQUEST_CONFLICT';

function boundaryError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? '';
  // S4 spend decision (HQ pause, HQ exception, access state) refused a question before any turn or call was recorded.
  if (code === '42501' && /^AI_[A-Z_]+$/.test(message)) throw new ForbiddenException({ code: 'HON_AI_SPEND_REFUSED', reason: message });
  if (code === '42501') throw new ForbiddenException({ code: 'HON_CONVERSATION_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'HON_CONVERSATION_NOT_FOUND' });
  if (code === '23505') throw new ConflictException({ code: 'HON_IDEMPOTENCY_CONFLICT', detail: 'This Idempotency-Key was already used with a different request.' });
  if (code === '23514') throw new ConflictException({ code: 'HON_CONVERSATION_FULL', detail: 'Start a new conversation.' });
  if (code === '22023' || code === '22P02') {
    throw new BadRequestException({ code: ['HON_DELEGATION_REQUIRED', 'HON_REPLY_NOT_CONTINUABLE', 'HON_SUGGESTION_NOT_CONFIRMABLE', 'HON_GROUP_NOT_SUMMARIZABLE'].includes(message) ? message : 'INVALID_HON_CONVERSATION_REQUEST' });
  }
  if (code === '57014' || code === '55P03') throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_TIMEOUT', detail: 'No success assumed. Read the conversation before resending.' });
  throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' });
}

function encodeCursor(next: { beforeUpdatedAt: string; beforeId: string } | null): string | null {
  return next ? Buffer.from(JSON.stringify([next.beforeUpdatedAt, next.beforeId]), 'utf8').toString('base64url') : null;
}
function decodeCursor(cursor: unknown): [string, string] {
  const bad = () => new BadRequestException({ code: 'INVALID_HON_CONVERSATION_QUERY' });
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[0])
    || !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== 'string' || !UUID.test(parsed[1])) throw bad();
  return [parsed[0], parsed[1]];
}

/** Maps a specialist's refusal before it recorded anything. Timeouts and unknown errors are never recorded as failure. */
function refusal(error: unknown): Failure | null {
  if (error instanceof ForbiddenException) return 'AGENT_NOT_AUTHORIZED';
  if (error instanceof BadRequestException) return 'AGENT_REQUEST_INVALID';
  if (error instanceof NotFoundException) return 'AGENT_TARGET_NOT_FOUND';
  if (error instanceof ConflictException) return 'AGENT_REQUEST_CONFLICT';
  return null;
}

/**
 * C1 HON conversation. The conversation and turn are stored here; the work is done by the named specialist's existing
 * service (its own actor gate, S4 spend protections, plan, provider runtime, usage evidence and Action Engine CONFIRM
 * proposal). The specialist's idempotency key is the turn id, so resending a turn never creates a second request or a
 * second provider call. A question turn (C2, delegation null) is answered by HonReplyService through the same secure
 * runtime; this service itself never calls a provider.
 */
@Injectable()
export class HonConversationService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly marcus: MarketingAssistantService,
    private readonly claire: TeachingAssistantService,
    private readonly chad: ChadFollowUpAssistantService,
    private readonly team: AiTeamReadinessService,
    private readonly reply: HonReplyService,
  ) {}

  private async transaction<T>(scope: Scope, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const requestId = randomUUID();
    try {
      const run = async (client: PoolClient) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [scope.externalSubject]);
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        return work(client);
      };
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER' as const, requestId };
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, run) : await this.database.withTenantTransaction(context, run);
    } catch (error) { return boundaryError(error); }
  }

  async readiness(scope: Scope) {
    const { data, meta } = await this.team.read(scope);
    return { data: composeHonConversationReadiness(data), meta };
  }

  async list(scope: Scope, query: Record<string, unknown>): Promise<HonConversationPage> {
    if (Object.keys(query).some((k) => k !== 'cursor' && k !== 'limit')) throw new BadRequestException({ code: 'INVALID_HON_CONVERSATION_QUERY' });
    const limit = query.limit === undefined ? 20 : typeof query.limit === 'string' && /^[1-9][0-9]?$/.test(query.limit) && Number(query.limit) <= 50 ? Number(query.limit) : NaN;
    if (Number.isNaN(limit)) throw new BadRequestException({ code: 'INVALID_HON_CONVERSATION_QUERY' });
    const [before, beforeId] = query.cursor === undefined ? [null, null] : decodeCursor(query.cursor);
    const page = await this.transaction(scope, async (client) => (await client.query<{ data: { items: unknown[]; next: { beforeUpdatedAt: string; beforeId: string } | null } }>(
      'SELECT hon.list_my_hon_conversations($1,$2::timestamptz,$3::uuid,$4) data', [scope.externalSubject, before, beforeId, limit])).rows[0]!.data, true);
    try {
      return { items: page.items.map((x) => validateHonConversationSummary(x)), nextCursor: encodeCursor(page.next) };
    } catch { throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' }); }
  }

  async read(scope: Scope, id: string) {
    const data = await this.transaction(scope, async (client) => (await client.query<{ data: unknown }>('SELECT hon.read_hon_conversation($1,$2::uuid) data', [scope.externalSubject, id])).rows[0]!.data, true);
    try { return validateHonConversationThread(data); } catch { throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' }); }
  }

  /** C3a: the specialists confirmed from each HON answer's suggestions, with their derived group status. Read only. */
  async orchestrations(scope: Scope, id: string): Promise<HonOrchestrationList> {
    const data = await this.transaction(scope, async (client) => (await client.query<{ data: unknown }>('SELECT hon.read_hon_orchestrations($1,$2::uuid) data', [scope.externalSubject, id])).rows[0]!.data, true);
    try { return validateHonOrchestrationList(data); } catch { throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' }); }
  }

  async create(scope: Scope, input: unknown, key: string | undefined) {
    if (typeof key !== 'string' || !UUID.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    let normalized;
    try { normalized = validateHonConversationCreate(input); } catch { throw new BadRequestException({ code: 'INVALID_HON_CONVERSATION_REQUEST' }); }
    const data = await this.transaction(scope, async (client) => (await client.query<{ data: unknown }>('SELECT hon.begin_hon_conversation($1,$2::jsonb,$3::uuid) data', [scope.externalSubject, JSON.stringify(normalized), key])).rows[0]!.data);
    try { return validateHonConversationSummary(data); } catch { throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' }); }
  }

  async sendTurn(scope: Scope, conversationId: string, input: unknown, key: string | undefined): Promise<HonTurnReceipt> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    let normalized;
    try { normalized = validateHonTurnRequest(input); } catch { throw new BadRequestException({ code: 'INVALID_HON_TURN', detail: 'Ask HON (delegation null) or name one specialist (marcus, claire or chad) with its own target, with a safe message; never credentials or personal records.' }); }
    const begun = await this.transaction(scope, async (client) => (await client.query<{ data: Begun }>('SELECT hon.begin_hon_turn($1,$2::uuid,$3::jsonb,$4::uuid) data', [scope.externalSubject, conversationId, JSON.stringify(normalized), key])).rows[0]!.data);
    if (begun.agentKey === 'hon') {
      try {
        if (begun.handOff) await this.reply.run(scope, begun.turnId);
        else await this.reply.releaseHeld(scope, begun.turnId);
      } catch (error) { boundaryError(error); }
      return this.receipt(scope, begun.turnId);
    }
    if (begun.handOff) {
      const failure = await this.handOff(scope, begun as Begun & { delegation: Record<string, unknown> });
      if (failure) await this.transaction(scope, async (client) => { await client.query('SELECT hon.fail_hon_turn($1,$2::uuid,$3)', [scope.externalSubject, begun.turnId, failure]); });
    }
    return this.receipt(scope, begun.turnId);
  }

  private async receipt(scope: Scope, turnId: string): Promise<HonTurnReceipt> {
    const data = await this.transaction(scope, async (client) => (await client.query<{ data: unknown }>('SELECT hon.read_hon_turn_receipt($1,$2::uuid) data', [scope.externalSubject, turnId])).rows[0]!.data, true);
    try { return validateHonTurnReceipt(data); } catch { throw new ServiceUnavailableException({ code: 'HON_CONVERSATION_UNAVAILABLE' }); }
  }

  /** Hands the turn to the specialist's own service at this exact school. Returns a refusal to record, or null. */
  private async handOff(scope: Scope, begun: Begun & { delegation: Record<string, unknown> }): Promise<Failure | null> {
    const agentScope = begun.agentKey === 'marcus' ? await this.database.resolveCampaignScope(scope.externalSubject, 'marketing.campaign.read')
      : begun.agentKey === 'kai' ? await this.database.resolveTeachingAssistantScope(scope.externalSubject)
      : await this.database.resolveChadFollowUpAssistantScope(scope.externalSubject);
    // The specialist resolves its own school from the verified identity; it must be this conversation's school and human.
    if (!agentScope || agentScope.organizationId !== scope.organizationId || agentScope.schoolId !== scope.schoolId || agentScope.principalId !== scope.principalId) return 'AGENT_NOT_AUTHORIZED';
    const requestId = randomUUID();
    const context = { ...agentScope, externalSubject: scope.externalSubject, principalType: 'HUMAN_USER' as const, source: 'HUMAN_UI' as const, requestId, correlationId: requestId, idempotencyKey: begun.turnId };
    try {
      if (begun.agentKey === 'marcus') await this.marcus.submit(context, begun.delegation);
      else if (begun.agentKey === 'kai') await this.claire.submit(context, begun.delegation);
      else await this.chad.submit(context, begun.delegation);
      return null;
    } catch (error) {
      return refusal(error);
    }
  }
}

@Injectable()
export class HonConversationHumanUiGuard extends CampaignHumanUiGuard { protected readonly command: string = 'hon-conversation'; }

@Controller('organizations/:organizationId/schools/:schoolId/hon')
@UseGuards(HonIdentityGuard, HonConversationHumanUiGuard)
export class HonConversationController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly conversations: HonConversationService) {}

  /** The path is not authority: the live resolver derives principal and school from the verified identity. */
  private async scope(request: HonRequest, organizationId: string, schoolId: string): Promise<Scope> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'HON_CONVERSATION_FORBIDDEN' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'ai.invocation.plan');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'HON_CONVERSATION_FORBIDDEN' });
    return { ...scope, externalSubject: identity.externalSubject };
  }
  private noQuery(query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException({ code: 'INVALID_HON_CONVERSATION_QUERY' }); }

  @Header('Cache-Control', 'private, no-store') @Get('readiness')
  async readiness(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Query() query: Record<string, unknown>) {
    this.noQuery(query); return this.conversations.readiness(await this.scope(req, org, school));
  }
  @Header('Cache-Control', 'private, no-store') @Get('conversations')
  async list(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Query() query: Record<string, unknown>) {
    return { data: await this.conversations.list(await this.scope(req, org, school), query) };
  }
  @Header('Cache-Control', 'private, no-store') @Post('conversations') @HttpCode(200)
  async create(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>) {
    this.noQuery(query); return { data: await this.conversations.create(await this.scope(req, org, school), input, key) };
  }
  @Header('Cache-Control', 'private, no-store') @Get('conversations/:conversationId')
  async read(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('conversationId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) {
    this.noQuery(query); return { data: await this.conversations.read(await this.scope(req, org, school), id) };
  }
  @Header('Cache-Control', 'private, no-store') @Get('conversations/:conversationId/orchestrations')
  async orchestrations(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('conversationId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) {
    this.noQuery(query); return { data: await this.conversations.orchestrations(await this.scope(req, org, school), id) };
  }
  @Header('Cache-Control', 'private, no-store') @Post('conversations/:conversationId/turns') @HttpCode(200)
  async send(@Req() req: HonRequest, @Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('conversationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>) {
    this.noQuery(query); return { data: await this.conversations.sendTurn(await this.scope(req, org, school), id, input, key) };
  }
}
