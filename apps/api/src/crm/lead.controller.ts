import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  BadRequestException,
  Header,
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
import { isEmail } from 'class-validator';
import { CRM_LEAD_CREATE_UUID, validateCreateHumanCrmLeadInput } from '@hon/contracts';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateHumanLeadDto } from './create-lead.dto.js';
import { assertDirectHumanLeadCreateRequest, LeadCreateHumanUiGuard } from './lead-create-human-ui.guard.js';
import { LeadService } from './lead.service.js';
import { ListLeadsDto } from './list-leads.dto.js';
import { crmAccessMeta } from './crm-entitlement.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads')
export class LeadController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly leads: LeadService,
  ) {}

  @Get()
  @UseGuards(HonIdentityGuard)
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
    const { leads, access, nextCursor, limit } = await this.leads.list(context, query, { externalSubject: identity.externalSubject });
    return { data: leads, meta: { requestId, correlationId: requestId, ...crmAccessMeta(access), limit, nextCursor } };
  }

  @Post()
  @UseGuards(LeadCreateHumanUiGuard, HonIdentityGuard)
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateHumanLeadDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertDirectHumanLeadCreateRequest(request);
    try { validateCreateHumanCrmLeadInput(input); }
    catch { throw new BadRequestException({ code: 'INVALID_LEAD_CREATE_INPUT' }); }
    if (input.primaryContact.email !== undefined && !isEmail(input.primaryContact.email)) throw new BadRequestException({ code: 'INVALID_LEAD_CREATE_INPUT' });
    if (!idempotencyKey || !CRM_LEAD_CREATE_UUID.test(idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for lead creation.' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.lead.create');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException('HON lead creation is not authorized for this school.');
    }

    const requestId = randomUUID();
    const command: CommandContext & { externalSubject: string } = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.leads.create(command, input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    const { id, status, pipelineStageId, primaryPersonId, version, createdAt } = result.lead;
    return { data: { id, status, pipelineStageId, primaryPersonId, version, createdAt }, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }
}
