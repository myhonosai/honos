import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CONTACT_EMAIL_RESEND_COMMAND, CONTACT_HISTORY_READ_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ContactMessagesService } from './contact-messages.service.js';

/** 0424: each call is its own same-origin browser command; reads are GET only. */
@Injectable()
export class ContactHistoryReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONTACT_HISTORY_READ_COMMAND;
}
@Injectable()
export class ContactEmailResendGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONTACT_EMAIL_RESEND_COMMAND;
}

const HISTORY_KEYS = new Set(['range', 'search', 'beforeAt', 'beforeId']);

/** The history filters arrive as plain query strings; anything else, or a repeated key, is refused. */
function historyQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!HISTORY_KEYS.has(key) || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (key === 'range' || key === 'search') out[key] = value;
  }
  const at = query?.beforeAt, id = query?.beforeId;
  if ((at === undefined) !== (id === undefined)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (at !== undefined) out.before = { at, id };
  return out;
}

/**
 * One person's messages, the exact email view and "Resend to saved address". Route identifiers are never authority: the
 * guarded boundary resolves the scope from the verified session with the needed permission, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/people/:personId/messages')
@UseGuards(HonIdentityGuard)
export class ContactMessagesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly messages: ContactMessagesService) {}

  @Get()
  @UseGuards(ContactHistoryReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async history(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, 'conversation.read', '');
    return { data: await this.messages.history(context, personId, historyQuery(query)), meta: { requestId: context.requestId } };
  }

  @Get(':messageId/email')
  @UseGuards(ContactHistoryReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async email(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, 'conversation.read', '');
    return { data: await this.messages.email(context, personId, messageId), meta: { requestId: context.requestId } };
  }

  @Post(':messageId/resend')
  @HttpCode(201)
  @UseGuards(ContactEmailResendGuard)
  @Header('Cache-Control', 'private, no-store')
  async resend(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noQuery(request, query);
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, 'conversation.manage', key);
    const result = await this.messages.resend(context, personId, messageId, body);
    response.status(result.replayed ? 200 : 201);
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
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CONTACT_HISTORY_SELECTORS_NOT_ACCEPTED' });
}
