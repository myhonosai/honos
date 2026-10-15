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
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext, CommunicationConsentChannel } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CommunicationConsentService } from './communication-consent.service.js';
import { RecordCommunicationConsentDto } from './record-communication-consent.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/people')
@UseGuards(HonIdentityGuard)
export class CommunicationConsentController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly consents: CommunicationConsentService,
  ) {}

  @Put(':personId/communication-consents/:channel')
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string,
    @Param('channel') channel: CommunicationConsentChannel,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RecordCommunicationConsentDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for communication consent recording.',
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'communication.consent.manage',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON communication consent recording is not authorized for this school.');
    }

    const requestId = randomUUID();
    // Principal type and runtime request source are server-forced; neither can
    // be supplied by the consent body, and the service rejects bypass attempts.
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.consents.record(context, personId, channel, input);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      data: result.consent,
      meta: { requestId, correlationId: requestId, replayed: result.replayed },
    };
  }

  @Get(':personId/communication-consents')
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'communication.consent.read',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON communication consent read is not authorized for this school.');
    }
    const requestId = randomUUID();
    const data = await this.consents.list({
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
    }, personId);
    return { data, meta: { requestId, correlationId: requestId } };
  }
}
