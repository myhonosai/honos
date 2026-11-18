import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isKaiJournalRange } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SaveKaiJournalEntryDto } from './kai-journal.dto.js';
import { KaiJournalReadHumanUiGuard, KaiJournalSaveHumanUiGuard, KaiTeamJournalReadHumanUiGuard } from './kai-journal-human-ui.guard.js';
import { KaiJournalService } from './kai-journal.service.js';

const USE = 'teaching.journal.use';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0497: the Kai teaching journal. Route identifiers are never authority: the boundary resolves the route scope from the
 * verified session for teaching.journal.use, and each protected database function proves the direct human subject, the
 * permission and Complete access again. An instructor only ever changes their own entries; the team read shows, read-only,
 * the entries other instructors at the same school chose to share.
 */
@Controller('organizations/:organizationId/schools/:schoolId/staff/kai/journal')
@UseGuards(HonIdentityGuard)
export class KaiJournalController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly journal: KaiJournalService) {}

  @Get('entries/:from/:to')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(KaiJournalReadHumanUiGuard)
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('from') from: string,
    @Param('to') to: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    if (!isKaiJournalRange(from, to)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '');
    const data = await this.journal.read(context, from, to);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('team/:from/:to')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(KaiTeamJournalReadHumanUiGuard)
  async readTeam(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('from') from: string,
    @Param('to') to: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    if (!isKaiJournalRange(from, to)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '');
    const data = await this.journal.readTeam(context, from, to);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('entries')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(KaiJournalSaveHumanUiGuard)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveKaiJournalEntryDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const context = await this.context(request, organizationId, schoolId, key);
    const result = await this.journal.save(context, definedFields(input));
    return { data: result.entry, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  /** The session must hold teaching.journal.use at exactly this route's school; the database decides again. */
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, USE);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'KAI_JOURNAL_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
