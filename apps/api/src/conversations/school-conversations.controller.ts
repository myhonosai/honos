import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_CREATE_LEAD_COMMAND, CONVERSATION_LINK_COMMAND, CONVERSATION_MARK_READ_COMMAND, CONVERSATION_READ_COMMAND, CONVERSATION_REPLY_COMMAND,
  CONVERSATION_UPDATE_COMMAND,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolConversationsService } from './school-conversations.service.js';

/** 0364: each conversation call is its own same-origin browser command; reads are GET only. */
@Injectable()
export class ConversationReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_READ_COMMAND;
}
@Injectable()
export class ConversationReplyGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_REPLY_COMMAND;
}
@Injectable()
export class ConversationUpdateGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_UPDATE_COMMAND;
}
@Injectable()
export class ConversationMarkReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_MARK_READ_COMMAND;
}
@Injectable()
export class ConversationLinkGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_LINK_COMMAND;
}
@Injectable()
export class ConversationCreateLeadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_CREATE_LEAD_COMMAND;
}

const LIST_KEYS = new Set(['status', 'assigned', 'unreadOnly', 'tag', 'search', 'beforeAt', 'beforeId', 'personId']);

/** The list filters arrive as plain query strings; anything else, or a repeated key, is refused. */
function listQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!LIST_KEYS.has(key) || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (key === 'unreadOnly') {
      if (value !== 'true' && value !== 'false') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
      out.unreadOnly = value === 'true';
    } else if (key !== 'beforeAt' && key !== 'beforeId') out[key] = value;
  }
  const at = query?.beforeAt, id = query?.beforeId;
  if ((at === undefined) !== (id === undefined)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (at !== undefined) out.before = { at, id };
  return out;
}

/**
 * Staff side of the school's conversations inbox. Route identifiers are never authority: the guarded boundary resolves the
 * scope from the verified session with the needed permission, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/conversations')
@UseGuards(HonIdentityGuard)
export class SchoolConversationsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly conversations: SchoolConversationsService) {}

  @Get()
  @UseGuards(ConversationReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, 'conversation.read', '');
    return { data: await this.conversations.list(context, listQuery(query)), meta: { requestId: context.requestId } };
  }

  @Get(':conversationId')
  @UseGuards(ConversationReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const keys = Object.keys(query ?? {});
    if (keys.some(k => k !== 'before') || (query.before !== undefined && typeof query.before !== 'string')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'conversation.read', '');
    return { data: await this.conversations.detail(context, conversationId, (query.before as string | undefined) ?? null), meta: { requestId: context.requestId } };
  }

  @Post(':conversationId/read')
  @HttpCode(200)
  @UseGuards(ConversationMarkReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async markRead(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, 'conversation.read', '');
    return { data: await this.conversations.markRead(context, conversationId, body), meta: { requestId: context.requestId } };
  }

  @Post(':conversationId/replies')
  @HttpCode(201)
  @UseGuards(ConversationReplyGuard)
  @Header('Cache-Control', 'private, no-store')
  async reply(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.conversations.reply(context, conversationId, body));
  }

  @Post(':conversationId/update')
  @HttpCode(200)
  @UseGuards(ConversationUpdateGuard)
  @Header('Cache-Control', 'private, no-store')
  async update(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.conversations.update(context, conversationId, body), 200);
  }

  @Post(':conversationId/link')
  @HttpCode(200)
  @UseGuards(ConversationLinkGuard)
  @Header('Cache-Control', 'private, no-store')
  async link(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.conversations.link(context, conversationId, body), 200);
  }

  @Post(':conversationId/lead')
  @HttpCode(201)
  @UseGuards(ConversationCreateLeadGuard)
  @Header('Cache-Control', 'private, no-store')
  async createLead(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId') conversationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.conversations.createLead(context, conversationId, body));
  }

  private async run<T>(request: HonRequest, query: Record<string, unknown>, organizationId: string, schoolId: string, key: string | undefined,
    response: Response, action: (context: MembershipLifecycleContext) => Promise<{ receipt: T; replayed: boolean }>, created = 201) {
    noQuery(request, query);
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, 'conversation.manage', key);
    const result = await action(context);
    response.status(result.replayed ? 200 : created);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CONVERSATION_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

function noQuery(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CONVERSATION_SELECTORS_NOT_ACCEPTED' });
}
