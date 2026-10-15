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
  Get,
  Query,
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
import { CreateLeadDto } from './create-lead.dto.js';
import { LeadService } from './lead.service.js';
import { ListLeadsDto } from './list-leads.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
@UseGuards(HonIdentityGuard)
export class LeadController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly leads: LeadService,
  ) {}

  @Get()
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: ListLeadsDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.lead.read');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON CRM lead read access is not authorized for this school.');
    const requestId = randomUUID();
    const context: CommandContext = {
      organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId,
      principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: `read:${requestId}`, source: 'HUMAN_UI',
    };
    const leads = await this.leads.list(context, query);
    return { data: leads, meta: { requestId, correlationId: requestId } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateLeadDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for lead creation.' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.lead.create');
    if (!scope || scope.organizationId !== organizationId) {
      throw new ForbiddenException('HON lead creation is not authorized for this school.');
    }

    const requestId = randomUUID();
    const command: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.leads.create(command, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.lead, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }
}
