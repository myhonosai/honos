import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_AI_FILE_COMMAND, CONVERSATION_AI_ITEM_SAVE_COMMAND, CONVERSATION_AI_ITEM_STATUS_COMMAND, CONVERSATION_AI_KNOWLEDGE_COMMAND,
  CONVERSATION_AI_READ_COMMAND, CONVERSATION_AI_SETTINGS_COMMAND, CONVERSATION_AI_TEST_ASK_COMMAND, CONVERSATION_AI_TEST_READ_COMMAND,
  CONVERSATION_AI_UPLOAD_COMMAND, SAAS_COMMANDS,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { ConversationAiProgramService, ConversationAiService } from './conversation-ai.service.js';
import { ConversationAiTestService } from './conversation-ai-test.service.js';

/** 0420: each Train AI call is its own same-origin browser command; reads are GET only. */
@Injectable()
export class ConversationAiReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_READ_COMMAND;
}
@Injectable()
export class ConversationAiKnowledgeGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_KNOWLEDGE_COMMAND;
}
@Injectable()
export class ConversationAiFileGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_FILE_COMMAND;
}
@Injectable()
export class ConversationAiSettingsGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_SETTINGS_COMMAND;
}
@Injectable()
export class ConversationAiUploadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_UPLOAD_COMMAND;
}
@Injectable()
export class ConversationAiItemSaveGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_ITEM_SAVE_COMMAND;
}
@Injectable()
export class ConversationAiItemStatusGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_ITEM_STATUS_COMMAND;
}
/** CE2 (0667): reading the test chat and asking a test question are each their own browser command. */
@Injectable()
export class ConversationAiTestReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_TEST_READ_COMMAND;
}
@Injectable()
export class ConversationAiTestAskGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONVERSATION_AI_TEST_ASK_COMMAND;
}

function noQuery(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CONVERSATION_AI_SELECTORS_NOT_ACCEPTED' });
}

/**
 * Staff side of Train AI. Route identifiers are never authority: the guarded boundary resolves the scope from the verified
 * session with conversation.read, and every database call re-proves it (conversation.ai.configure for changes).
 */
@Controller('organizations/:organizationId/schools/:schoolId/conversation-ai')
@UseGuards(HonIdentityGuard)
export class ConversationAiController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly ai: ConversationAiService, private readonly tests: ConversationAiTestService) {}

  @Get()
  @UseGuards(ConversationAiReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async overview(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.ai.overview(context), meta: { requestId: context.requestId } };
  }

  @Get('knowledge')
  @UseGuards(ConversationAiKnowledgeGuard)
  @Header('Cache-Control', 'private, no-store')
  async knowledge(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.ai.knowledge(context), meta: { requestId: context.requestId } };
  }

  @Get('files/:fileId')
  @UseGuards(ConversationAiFileGuard)
  @Header('Cache-Control', 'private, no-store')
  async file(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('fileId') fileId: string, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.ai.file(context, fileId), meta: { requestId: context.requestId } };
  }

  @Post('settings')
  @HttpCode(200)
  @UseGuards(ConversationAiSettingsGuard)
  @Header('Cache-Control', 'private, no-store')
  async settings(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.ai.settings(context, body), 200);
  }

  @Post('files')
  @HttpCode(201)
  @UseGuards(ConversationAiUploadGuard)
  @Header('Cache-Control', 'private, no-store')
  async upload(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.ai.upload(context, body));
  }

  @Post('items')
  @HttpCode(200)
  @UseGuards(ConversationAiItemSaveGuard)
  @Header('Cache-Control', 'private, no-store')
  async saveItem(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.ai.saveItem(context, body), 200);
  }

  @Post('items/status')
  @HttpCode(200)
  @UseGuards(ConversationAiItemStatusGuard)
  @Header('Cache-Control', 'private, no-store')
  async setItemStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    return this.run(request, query, organizationId, schoolId, key, response, context => this.ai.setItemStatus(context, body), 200);
  }

  /** CE2: whether Chad can answer a test now, and the staff member's own last 10 tests. */
  @Get('test')
  @UseGuards(ConversationAiTestReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async testState(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.tests.state(context), meta: { requestId: context.requestId } };
  }

  /** CE2: one test question. One provider call at most per key; the answer is shown only to the asker and never sent. */
  @Post('test')
  @HttpCode(200)
  @UseGuards(ConversationAiTestAskGuard)
  @Header('Cache-Control', 'private, no-store')
  async testAsk(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query);
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, key);
    return { data: await this.tests.ask(context, body), meta: { requestId: context.requestId } };
  }

  private async run<T>(request: HonRequest, query: Record<string, unknown>, organizationId: string, schoolId: string, key: string | undefined,
    response: Response, action: (context: MembershipLifecycleContext) => Promise<{ receipt: T; replayed: boolean }>, created = 201) {
    noQuery(request, query);
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, key);
    const result = await action(context);
    response.status(result.replayed ? 200 : created);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'conversation.read');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CONVERSATION_AI_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/** HQ: the Conversation AI program switch (OFF, TEST_MODE, LIVE). It starts OFF; turning it LIVE is an owner decision. */
@Controller('hq/conversation-ai/program')
@UseGuards(HonIdentityGuard)
export class ConversationAiProgramHqController {
  constructor(private readonly program: ConversationAiProgramService) {}
  @Get() @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest) {
    return { data: await this.program.read(subject(req)) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.conversationAiProgram)
  async command(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.program.command(subject(req), body, key) };
  }
}
