import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RENEWAL_STATUSES, type RenewalContext, type RenewalStatus } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RenewalService, renewalUuid } from './renewal.service.js';
import { RenewalDto, RenewalHumanUiGuard } from './renewal.dto.js';
@Controller('staff/billing/renewals')
@UseGuards(HonIdentityGuard, RenewalHumanUiGuard)
export class RenewalController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly renewals: RenewalService) {}
  private async context(req: HonRequest, key = ''): Promise<RenewalContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveRenewalScope(externalSubject);
    if (!scope) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: RenewalContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Query() query: Record<string, unknown>, @Req() req: HonRequest) {
    if (!query || Object.keys(query).some(k => !['status', 'after'].includes(k)) || (query.status !== undefined && ![...RENEWAL_STATUSES, 'ALL'].includes(query.status as RenewalStatus | 'ALL'))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const after = query.after ?? null; if (after !== null) renewalUuid(after);
    const c = await this.context(req); return this.envelope(c, await this.renewals.list(c, (query.status ?? 'OPEN') as RenewalStatus | 'ALL', after as string | null));
  }
  @Header('Cache-Control', 'private, no-store') @Get('memberships/:id')
  async membership(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: HonRequest) {
    if (Object.keys(query).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    renewalUuid(id); const c = await this.context(req); return this.envelope(c, await this.renewals.membership(c, id));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id/history')
  async history(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: HonRequest) {
    if (Object.keys(query).some(k => k !== 'before') || (query.before !== undefined && (typeof query.before !== 'string' || !/^[1-9][0-9]{0,8}$/.test(query.before)))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    renewalUuid(id); const c = await this.context(req); return this.envelope(c, await this.renewals.history(c, id, query.before === undefined ? null : Number(query.before)));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':id')
  async read(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: HonRequest) {
    if (Object.keys(query).some(k => k !== 'version') || (query.version !== undefined && (typeof query.version !== 'string' || !/^[1-9][0-9]{0,8}$/.test(query.version)))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    renewalUuid(id); const c = await this.context(req); return this.envelope(c, await this.renewals.read(c, id, query.version === undefined ? null : Number(query.version)));
  }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Headers('idempotency-key') key: string | undefined, @Body() input: RenewalDto, @Req() req: HonRequest) {
    const c = await this.context(req, key ?? ''); const r = await this.renewals.mutate(c, 'CREATE', null, input); return this.envelope(c, r.renewal, r.replayed);
  }
  @Header('Cache-Control', 'private, no-store') @Post(':id/revisions') @HttpCode(200)
  async revise(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: RenewalDto, @Req() req: HonRequest) {
    renewalUuid(id); const c = await this.context(req, key ?? ''); const r = await this.renewals.mutate(c, 'REVISE', id, input); return this.envelope(c, r.renewal, r.replayed);
  }
}
