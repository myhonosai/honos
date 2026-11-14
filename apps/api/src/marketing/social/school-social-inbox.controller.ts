import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import {
  SchoolSocialInboxChangeHumanUiGuard, SchoolSocialInboxCommentHumanUiGuard, SchoolSocialInboxReplyHumanUiGuard, SchoolSocialInboxResolveHumanUiGuard,
  SchoolSocialReadHumanUiGuard,
} from './school-social.guard.js';
import { SchoolSocialInboxService } from './school-social-inbox.service.js';
import type { SchoolSocialContext } from './school-social.service.js';

const INBOX = 'marketing.social.inbox';

/**
 * School social inbox (0349). Route ids are never authority: scope comes from the verified session and every database
 * call re-proves the person with marketing.social.inbox at the session school.
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/social/inbox')
@UseGuards(HonIdentityGuard)
export class SchoolSocialInboxController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly inbox: SchoolSocialInboxService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.read(request, organizationId, schoolId, idempotencyKey);
    return { data: await this.inbox.list(context, { ...query }), meta: this.meta(context) };
  }

  @Get('conversations/:conversationId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialReadHumanUiGuard)
  async conversation(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const context = await this.read(request, organizationId, schoolId, idempotencyKey);
    return { data: await this.inbox.conversation(context, conversationId), meta: this.meta(context) };
  }

  @Post('conversations/:conversationId')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialInboxChangeHumanUiGuard)
  async change(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    const { conversation, replayed } = await this.inbox.change(context, conversationId, input);
    return { data: conversation, meta: { ...this.meta(context), replayed } };
  }

  @Post('conversations/:conversationId/reply')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialInboxReplyHumanUiGuard)
  async reply(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    const { reply, replayed } = await this.inbox.reply(context, conversationId, input);
    return { data: reply, meta: { ...this.meta(context), replayed } };
  }

  @Post('conversations/:conversationId/comment')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialInboxCommentHumanUiGuard)
  async comment(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('conversationId', new ParseUUIDPipe()) conversationId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    const { result, replayed } = await this.inbox.comment(context, conversationId, input);
    return { data: result, meta: { ...this.meta(context), replayed } };
  }

  @Post('messages/:messageId/resolve')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialInboxResolveHumanUiGuard)
  async resolve(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey);
    const { message, replayed } = await this.inbox.resolve(context, messageId, input);
    return { data: message, meta: { ...this.meta(context), replayed } };
  }

  private meta(context: SchoolSocialContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }

  private read(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined): Promise<SchoolSocialContext> {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    return this.context(request, organizationId, schoolId, '');
  }

  private command(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined): Promise<SchoolSocialContext> {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.context(request, organizationId, schoolId, idempotencyKey);
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<SchoolSocialContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, INBOX);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
