import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreatePipelineDto } from './create-pipeline.dto.js';
import { PipelineService } from './pipeline.service.js';
import { StarterPipelineHumanUiGuard } from './starter-pipeline-human-ui.guard.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/pipelines')
export class PipelineController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly pipelines: PipelineService) {}
  @Get()
  @UseGuards(HonIdentityGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // Lead creators need the stage picker; readers see stage names on the lead list. Either permission reads the funnel.
    let permission: 'crm.lead.create' | 'crm.lead.read' = 'crm.lead.create';
    let scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope) { permission = 'crm.lead.read'; scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission); }
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON CRM pipeline read access is not authorized for this school.');
    const requestId = randomUUID(); const context: CommandContext = { organizationId:scope.organizationId, schoolId:scope.schoolId, principalId:scope.principalId, principalType:'HUMAN_USER', requestId, correlationId:requestId, idempotencyKey:`read:${requestId}`, source:'HUMAN_UI' };
    return { data: await this.pipelines.list(context, { externalSubject: identity.externalSubject, permission }), meta:{ requestId, correlationId:requestId } };
  }

  @Post('starter')
  @UseGuards(StarterPipelineHumanUiGuard, HonIdentityGuard)
  async createStarter(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Headers('idempotency-key') idempotencyKey: string, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.pipeline.manage');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON pipeline management is not authorized for this school.');
    const requestId = randomUUID(); const context: CommandContext = { organizationId:scope.organizationId, schoolId:scope.schoolId, principalId:scope.principalId, principalType:'HUMAN_USER', requestId, correlationId:requestId, idempotencyKey, source:'HUMAN_UI' };
    const result = await this.pipelines.createStarter(context, { externalSubject: identity.externalSubject });
    response.status(result.created && !result.replayed ? HttpStatus.CREATED : HttpStatus.OK);
    return { data:result.pipeline, meta:{ requestId, correlationId:requestId, created:result.created, replayed:result.replayed } };
  }

  @Post()
  @UseGuards(HonIdentityGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreatePipelineDto, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code:'IDEMPOTENCY_KEY_REQUIRED', detail:'A unique Idempotency-Key header is required for pipeline creation.' });
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.pipeline.manage');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON pipeline management is not authorized for this school.');
    const requestId = randomUUID(); const context: CommandContext = { organizationId:scope.organizationId, schoolId:scope.schoolId, principalId:scope.principalId, principalType:'HUMAN_USER', requestId, correlationId:requestId, idempotencyKey, source:'HUMAN_UI' };
    const result = await this.pipelines.create(context, input); response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data:result.pipeline, meta:{ requestId, correlationId:requestId, replayed:result.replayed } };
  }
}
