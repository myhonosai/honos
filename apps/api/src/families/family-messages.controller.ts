import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { FamilyMessagesService } from './family-messages.service.js';

const MANAGE = 'family_messages.manage';

/** 0330: each family message call is its own same-origin browser command; reads are GET only. */
@Injectable()
export class ParentFamilyMessagesReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.family_messages.read';
}
@Injectable()
export class ParentFamilyMessagesSendGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.family_messages.send';
}
@Injectable()
export class FamilyMessagesInboxReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'family_messages.read';
}
@Injectable()
export class FamilyMessagesMarkReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'family_messages.mark_read';
}
@Injectable()
export class FamilyMessagesReplyGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'family_messages.reply';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'FAMILY_MESSAGES_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}

/** Parent side: the signed-in guardian's one family thread with the school. */
@Controller('parent/messages/school')
@UseGuards(HonIdentityGuard)
export class ParentFamilyMessagesController {
  constructor(private readonly messages: FamilyMessagesService) {}

  @Get()
  @UseGuards(ParentFamilyMessagesReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.messages.parentRead(request.honIdentity!.externalSubject) };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(ParentFamilyMessagesSendGuard)
  @Header('Cache-Control', 'private, no-store')
  async send(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noSelectors(request, query);
    const result = await this.messages.parentSend(request.honIdentity!.externalSubject, body, key);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { replayed: result.replayed } };
  }
}

/**
 * Staff side: the school's family inbox. Route identifiers are never authority: the guarded boundary resolves the scope from
 * the verified session with family_messages.manage, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/family-messages')
@UseGuards(HonIdentityGuard)
export class FamilyMessagesInboxController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly messages: FamilyMessagesService) {}

  @Get()
  @UseGuards(FamilyMessagesInboxReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async inbox(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.messages.inbox(context), meta: { requestId: context.requestId } };
  }

  @Get(':threadId')
  @UseGuards(FamilyMessagesInboxReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async thread(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('threadId') threadId: string, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.messages.thread(context, threadId), meta: { requestId: context.requestId } };
  }

  @Post(':threadId/read')
  @HttpCode(200)
  @UseGuards(FamilyMessagesMarkReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async markRead(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('threadId') threadId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.messages.markRead(context, threadId, body), meta: { requestId: context.requestId } };
  }

  @Post(':threadId/replies')
  @HttpCode(201)
  @UseGuards(FamilyMessagesReplyGuard)
  @Header('Cache-Control', 'private, no-store')
  async reply(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('threadId') threadId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    noSelectors(request, query);
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, key);
    const result = await this.messages.reply(context, threadId, body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity!;
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, MANAGE);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
