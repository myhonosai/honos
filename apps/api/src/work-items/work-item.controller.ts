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
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  CreateWorkItemDto,
  ListWorkItemsQueryDto,
  TransitionWorkItemDto,
} from './work-item.dto.js';
import { WorkItemService } from './work-item.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/work-items')
@UseGuards(HonIdentityGuard)
export class WorkItemController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly workItems: WorkItemService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateWorkItemDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.resolveCommandContext(
      request,
      organizationId,
      schoolId,
      'work_item.create',
      idempotencyKey,
      'work-item creation',
    );
    const result = await this.workItems.create(context, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      data: result.workItem,
      meta: {
        requestId: context.requestId,
        correlationId: context.correlationId,
        replayed: result.replayed,
      },
    };
  }

  @Post(':workItemId/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workItemId', new ParseUUIDPipe()) workItemId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: TransitionWorkItemDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.resolveCommandContext(
      request,
      organizationId,
      schoolId,
      'work_item.manage',
      idempotencyKey,
      'work-item transition',
    );
    const result = await this.workItems.transition(context, workItemId, input);
    response.status(HttpStatus.OK);
    return {
      data: result.workItem,
      meta: {
        requestId: context.requestId,
        correlationId: context.correlationId,
        replayed: result.replayed,
      },
    };
  }

  @Get()
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: ListWorkItemsQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'work_item.read',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON work-item read is not authorized for this school.');
    }
    const requestId = randomUUID();
    const workItems = await this.workItems.list({
      ...scope,
      principalType: 'HUMAN_USER',
      requestId,
    }, query.limit);
    return {
      data: workItems,
      meta: { requestId, correlationId: requestId },
    };
  }

  private async resolveCommandContext(
    request: HonRequest,
    organizationId: string,
    schoolId: string,
    permission: 'work_item.create' | 'work_item.manage',
    idempotencyKey: string | undefined,
    commandName: string,
  ): Promise<CommandContext> {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: `A unique Idempotency-Key header of at most 200 characters is required for ${commandName}.`,
      });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // resolve_authorized_scope is a SECURITY DEFINER boundary that only joins a
    // verified application user to an active HUMAN_USER principal; no body field
    // can nominate a principal, tenant, source, or delegation.
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      permission,
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException(`HON ${commandName} is not authorized for this school.`);
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
