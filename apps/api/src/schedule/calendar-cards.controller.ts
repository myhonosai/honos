import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { CalendarCardCreateHumanUiGuard, CalendarCardMoveHumanUiGuard, CalendarCardsReadHumanUiGuard } from './calendar-cards-human-ui.guard.js';
import { CreateCalendarCardDto, MoveCalendarCardDto } from './calendar-cards.dto.js';
import { CalendarCardsService } from './calendar-cards.service.js';

const MANAGE = 'schedule.session.manage';
const READ = 'schedule.session.read';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0567 calendar cards: create a class or a roster from the calendar, move or resize one class, and read each class's card
 * details. Route identifiers are never authority: the guarded boundary resolves the route scope from the verified session,
 * and each protected database function re-proves the direct human subject and the live school-scoped permission. Nothing
 * here contacts families, charges, or runs on a timer.
 */
@Controller('organizations/:organizationId/schools/:schoolId/schedule/calendar')
@UseGuards(HonIdentityGuard)
export class CalendarCardsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly cards: CalendarCardsService) {}

  @Get('cards')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarCardsReadHumanUiGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const keys = Object.keys(query ?? {});
    if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to') || Object.values(query).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.cards.read(context, { from: query.from, to: query.to });
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('cards')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarCardCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreateCalendarCardDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.cards.create(context, definedFields(input)));
  }

  @Post('cards/:sessionId/move')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CalendarCardMoveHumanUiGuard)
  async move(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: MoveCalendarCardDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.cards.move(context, sessionId, definedFields(input)));
  }

  private receipt(context: MembershipLifecycleContext, result: { receipt: unknown; replayed: boolean }) {
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: permission === READ ? 'CLASS_SESSIONS_READ_FORBIDDEN' : 'CLASS_SERIES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
