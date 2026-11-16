import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CRM_BOARD_STATUSES, type CrmBoardStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MoveCrmLeadStageDto, SaveCrmPipelineStagesDto } from './crm-pipeline-board.dto.js';
import { CrmLeadStageMoveHumanUiGuard, CrmPipelineBoardReadHumanUiGuard, CrmPipelineStagesSaveHumanUiGuard } from './crm-pipeline-board-human-ui.guard.js';
import { CrmPipelineBoardService } from './crm-pipeline-board.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0417: the lead pipeline board. Route identifiers are never authority: the guarded boundary resolves the route scope from
 * the verified session, and each protected database function re-proves the human subject and the live permission.
 */
@Controller('organizations/:organizationId/schools/:schoolId/crm')
@UseGuards(HonIdentityGuard)
export class CrmPipelineBoardController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly board: CrmPipelineBoardService) {}

  @Get('pipeline-board')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CrmPipelineBoardReadHumanUiGuard)
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== 'pipelineId' && key !== 'status')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const status = query.status === undefined ? 'OPEN' : query.status;
    if (typeof status !== 'string' || !(CRM_BOARD_STATUSES as readonly string[]).includes(status)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const pipelineId = query.pipelineId === undefined ? null : query.pipelineId;
    if (pipelineId !== null && (typeof pipelineId !== 'string' || !UUID.test(pipelineId))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '', 'crm.lead.read');
    const data = await this.board.read(context, pipelineId, status as CrmBoardStatus);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('leads/:leadId/stage')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CrmLeadStageMoveHumanUiGuard)
  async move(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MoveCrmLeadStageDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), 'crm.lead.stage.move');
    const result = await this.board.move(context, leadId.toLowerCase(), definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('pipelines/:pipelineId/stages')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CrmPipelineStagesSaveHumanUiGuard)
  async saveStages(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('pipelineId', new ParseUUIDPipe()) pipelineId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveCrmPipelineStagesDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), 'crm.pipeline.manage');
    const result = await this.board.saveStages(context, pipelineId.toLowerCase(), definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(value: string | undefined): string {
    const key = value?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CRM_BOARD_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
