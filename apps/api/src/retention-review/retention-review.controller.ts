import { BadRequestException, Controller, ForbiddenException, Get, Post, Body, Header, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RetentionReviewSignalsContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RetentionReviewHumanUiGuard } from './retention-review.dto.js';
import { RetentionReviewService, retentionReviewId } from './retention-review.service.js';

@Controller('staff/retention/review')
@UseGuards(HonIdentityGuard, RetentionReviewHumanUiGuard)
export class RetentionReviewController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly retention: RetentionReviewService) {}

  private async acknowledgementContext(query: Record<string, unknown>, request: HonRequest): Promise<RetentionReviewSignalsContext> {
    if (!query || Object.keys(query).length !== 2 || !Object.hasOwn(query, 'schoolId') || !Object.hasOwn(query, 'membershipId')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    retentionReviewId(query.schoolId); retentionReviewId(query.membershipId);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = request.honIdentity.externalSubject;
    const scope = await this.database.resolveRetentionReviewScope(externalSubject, query.schoolId);
    if (!scope) throw new ForbiddenException({ code: 'RETENTION_REVIEW_SCOPE_DENIED' });
    const requestId = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId };
  }
  @Get('attention-alerts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async attentionAlerts(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionAttentionAlerts: await this.retention.attentionAlerts(context, query.membershipId as string) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Get('attention-evidence')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async attentionEvidence(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionAttentionEvidence: await this.retention.attentionEvidence(context, query.membershipId as string) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Post('attention-alerts/record')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async recordAttention(@Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionAttentionRecord: await this.retention.recordAttention(context, query.membershipId as string, body) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Post('attention-alerts/resolve')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async resolveAttention(@Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionAttentionResolution: await this.retention.resolveAttention(context, query.membershipId as string, body) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Get('acknowledgement-evidence')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async acknowledgementEvidence(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionReviewAcknowledgementEvidence: await this.retention.acknowledgementEvidence(context, query.membershipId as string) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Post('acknowledgement')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async acknowledge(@Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    const context = await this.acknowledgementContext(query, request);
    return { data: { retentionReviewAcknowledgement: await this.retention.acknowledge(context, query.membershipId as string, body) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (!query || Object.keys(query).length !== 2 || !Object.hasOwn(query, 'schoolId') || !Object.hasOwn(query, 'membershipId')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only known schoolId and membershipId selectors are accepted.' });
    }
    retentionReviewId(query.schoolId); retentionReviewId(query.membershipId);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = request.honIdentity.externalSubject;
    const scope = await this.database.resolveRetentionReviewScope(externalSubject, query.schoolId);
    if (!scope) throw new ForbiddenException({ code: 'RETENTION_REVIEW_SCOPE_DENIED' });
    const requestId = randomUUID();
    const context: RetentionReviewSignalsContext = {
      ...scope,
      externalSubject,
      principalType: 'HUMAN_USER',
      source: 'HUMAN_UI',
      requestId,
      correlationId: requestId,
    };
    return { data: { retentionReviewSignals: await this.retention.read(context, query.membershipId) }, meta: { requestId, correlationId: requestId } };
  }
}
