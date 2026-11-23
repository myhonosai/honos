import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RANK_CHART_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RankSetupHumanUiGuard } from './rank-setup.controller.js';
import { RankChartDraftService, type RankChartContext } from './rank-chart-draft.service.js';

/** The rank setup guard rules (same origin, no selectors, no other X-Hon header) with this feature's own command. */
@Injectable() export class RankChartDraftHumanUiGuard extends RankSetupHumanUiGuard { protected override readonly command: string = RANK_CHART_COMMAND; }

/**
 * Rank chart AI drafts (0636), under Rank setup. The school in the path is never authority: the scope comes from the verified
 * session (curriculum.manage at this school), and the database re-proves rank setup, the Kai capability and the Complete plan.
 */
@Controller('staff/schools/:schoolId/rank-setup/ai-drafts')
@UseGuards(HonIdentityGuard, RankChartDraftHumanUiGuard)
export class StaffRankChartDraftController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly drafts: RankChartDraftService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async list(@Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, s, '');
    return { data: { aiAvailable: this.drafts.available(), requests: await this.drafts.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async request(@Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, s, this.key(k));
    return { data: await this.drafts.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(200) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async close(@Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const status = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' ? (input as { status: unknown }).status : null;
    if (status !== 'APPLIED' && status !== 'DISMISSED') throw new BadRequestException({ code: 'RANK_CHART_INVALID' });
    const context = await this.context(r, s, this.key(k));
    return { data: await this.drafts.close(context, id, status), meta: this.meta(context) };
  }

  private meta(context: RankChartContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, schoolId: string, idempotencyKey: string): Promise<RankChartContext> {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'curriculum.manage');
    if (!scope || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'RANK_CHART_SCOPE_DENIED' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: request.honIdentity.externalSubject };
  }
}
