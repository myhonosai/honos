import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ApproveKnowledgeArticleDto, CreateKnowledgeArticleDto } from './knowledge-article.dto.js';
import { KnowledgeArticleService } from './knowledge-article.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/knowledge/articles')
@UseGuards(HonIdentityGuard)
export class KnowledgeArticleController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly articles: KnowledgeArticleService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateKnowledgeArticleDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.authorizedContext(
      organizationId,
      schoolId,
      idempotencyKey,
      request,
      'knowledge.manage',
      'Knowledge article creation',
    );
    const result = await this.articles.create(context, input);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      data: result.article,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    };
  }

  @Post(':articleId/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('articleId', new ParseUUIDPipe()) articleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ApproveKnowledgeArticleDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.authorizedContext(
      organizationId,
      schoolId,
      idempotencyKey,
      request,
      'knowledge.approve',
      'Knowledge article approval',
    );
    const result = await this.articles.approve(context, articleId, input);
    response.status(HttpStatus.OK);
    return {
      data: result.article,
      meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed },
    };
  }

  private async authorizedContext(
    organizationId: string,
    schoolId: string,
    idempotencyKey: string | undefined,
    request: HonRequest,
    permission: 'knowledge.manage' | 'knowledge.approve',
    operation: string,
  ): Promise<CommandContext> {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: `A unique Idempotency-Key header of at most 200 characters is required for ${operation.toLowerCase()}.`,
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // Authority comes only from the live resolver; never from a request body,
    // a caller-supplied role, an AI identity, or a path organization assertion.
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      permission,
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException(`${operation} is not authorized for this school.`);
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
