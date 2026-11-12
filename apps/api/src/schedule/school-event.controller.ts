import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SchoolEventBookingStatusHumanUiGuard, SchoolEventReadHumanUiGuard, SchoolEventSaveHumanUiGuard, SchoolEventStatusHumanUiGuard } from './school-event-human-ui.guard.js';
import { SchoolEventService } from './school-event.service.js';

const MANAGE = 'schedule.session.manage';

/**
 * B-SCH-3 (0261): staff side of school events with bookable time slots. Route identifiers are never authority: the guarded
 * boundary resolves the scope from the verified session, and each protected database function re-proves the direct human
 * subject and live schedule.session.manage at the school. Nothing here sends a message or charges anyone.
 */
@Controller('organizations/:organizationId/schools/:schoolId/schedule/events')
@UseGuards(HonIdentityGuard)
export class SchoolEventController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly events: SchoolEventService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.events.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get(':eventId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventReadHumanUiGuard)
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('eventId', new ParseUUIDPipe()) eventId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.events.detail(context, eventId.toLowerCase()), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventSaveHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.events.save(context, null, input));
  }

  @Post(':eventId/edit')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventSaveHumanUiGuard)
  async edit(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('eventId', new ParseUUIDPipe()) eventId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.events.save(context, eventId.toLowerCase(), input));
  }

  @Post(':eventId/status')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventStatusHumanUiGuard)
  async status(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('eventId', new ParseUUIDPipe()) eventId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.events.setStatus(context, eventId.toLowerCase(), input));
  }

  @Post('bookings/:bookingId/status')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolEventBookingStatusHumanUiGuard)
  async bookingStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('bookingId', new ParseUUIDPipe()) bookingId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.events.setBookingStatus(context, bookingId.toLowerCase(), input));
  }

  private receipt<R>(context: MembershipLifecycleContext, result: { receipt: R; replayed: boolean }) {
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

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, MANAGE);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_EVENT_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** B-SCH-3 (0261): the family side. No session, cookie or tenant id is read; the public link id is the only selector. */
@Controller('public/events')
export class PublicSchoolEventController {
  constructor(private readonly events: SchoolEventService) {}

  @Get(':publicId')
  @Header('Cache-Control', 'no-store')
  async published(@Param('publicId') publicId: string) {
    const data = await this.events.published(publicId);
    if (!data) throw new NotFoundException({ result: 'INVALID' });
    return { data };
  }

  @Post(':publicId/bookings')
  @Header('Cache-Control', 'no-store')
  async book(@Param('publicId') publicId: string, @Body() input: unknown, @Headers('idempotency-key') key: string, @Res() res: Response) {
    const outcome = await this.events.book(publicId, input, key);
    if (outcome.result === 'RATE_LIMITED') res.setHeader('Retry-After', '3600');
    const status = { BOOKED: 201, INVALID: 400, CLOSED: 409, FULL: 409, STARTED: 409, ALREADY_BOOKED: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 }[outcome.result];
    return res.status(status).json(outcome);
  }

  @Post(':publicId/cancellations')
  @Header('Cache-Control', 'no-store')
  async cancel(@Param('publicId') publicId: string, @Body() input: unknown, @Res() res: Response) {
    const result = await this.events.cancel(publicId, input);
    if (result === 'RATE_LIMITED') res.setHeader('Retry-After', '3600');
    const status = { CANCELLED: 200, INVALID: 400, STARTED: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 }[result];
    return res.status(status).json({ result });
  }
}
