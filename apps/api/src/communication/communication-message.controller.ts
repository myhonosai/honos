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
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CommunicationMessageService } from './communication-message.service.js';
import {
  CreateCommunicationMessageDto,
  ListCommunicationMessagesDto,
  QueueCommunicationMessageDto,
} from './communication-message.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/communications/messages')
@UseGuards(HonIdentityGuard)
export class CommunicationMessageController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly messages: CommunicationMessageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateCommunicationMessageDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.commandContext(
      organizationId, schoolId, request, idempotencyKey, 'communication.message.create', 'message creation',
    );
    const result = await this.messages.create(context, input);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      data: result.message,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    };
  }

  @Post(':messageId/queue')
  @HttpCode(HttpStatus.OK)
  async queue(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: QueueCommunicationMessageDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.commandContext(
      organizationId, schoolId, request, idempotencyKey, 'communication.message.queue', 'message queueing',
    );
    const result = await this.messages.queue(context, messageId, input);
    return {
      data: result.message,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    };
  }

  @Get()
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: ListCommunicationMessagesDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject, schoolId, 'communication.message.read',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON communication message read is not authorized for this school.');
    }
    const requestId = randomUUID();
    const data = await this.messages.list({
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
    }, query);
    return { data, meta: { requestId, correlationId: requestId } };
  }

  private async commandContext(
    organizationId: string,
    schoolId: string,
    request: HonRequest,
    idempotencyKey: string | undefined,
    permission: 'communication.message.create' | 'communication.message.queue',
    operation: string,
  ): Promise<CommandContext> {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: `A unique Idempotency-Key header of at most 200 characters is required for ${operation}.`,
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException(`HON ${operation} is not authorized for this school.`);
    }
    const requestId = randomUUID();
    return {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
  }
}
