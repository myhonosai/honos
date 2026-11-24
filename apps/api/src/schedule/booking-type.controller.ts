import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { BookingTypeBookingStatusHumanUiGuard, BookingTypeReadHumanUiGuard, BookingTypeSaveHumanUiGuard, BookingTypeStatusHumanUiGuard } from './booking-type-human-ui.guard.js';
import { BookingTypeService } from './booking-type.service.js';

const MANAGE = 'schedule.session.manage';

/**
 * School booking types (0286): staff side (Settings > Booking types). Route identifiers are never authority: the guarded boundary
 * resolves the scope from the verified session, and each protected database function re-proves the direct human subject and live
 * schedule.session.manage at the school. Nothing here sends a message or charges anyone.
 */
@Controller('organizations/:organizationId/schools/:schoolId/settings/booking-types')
@UseGuards(HonIdentityGuard)
export class BookingTypeController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly types: BookingTypeService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.types.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get(':typeId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeReadHumanUiGuard)
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('typeId', new ParseUUIDPipe()) typeId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.types.detail(context, typeId.toLowerCase()), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeSaveHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.types.save(context, null, input));
  }

  @Post(':typeId/edit')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeSaveHumanUiGuard)
  async edit(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('typeId', new ParseUUIDPipe()) typeId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.types.save(context, typeId.toLowerCase(), input));
  }

  @Post(':typeId/status')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeStatusHumanUiGuard)
  async status(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('typeId', new ParseUUIDPipe()) typeId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.types.setStatus(context, typeId.toLowerCase(), input));
  }

  @Post('bookings/:bookingId/status')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(BookingTypeBookingStatusHumanUiGuard)
  async bookingStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('bookingId', new ParseUUIDPipe()) bookingId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    return this.receipt(context, await this.types.setBookingStatus(context, bookingId.toLowerCase(), input));
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
      throw new ForbiddenException({ code: 'SCHOOL_BOOKING_TYPE_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** School booking types (0286): the family side. No session, cookie or tenant id is read; the public link id is the only selector. */
@Controller('public/booking-types')
export class PublicBookingTypeController {
  constructor(private readonly types: BookingTypeService) {}

  @Get(':publicId')
  @Header('Cache-Control', 'no-store')
  async published(@Param('publicId') publicId: string) {
    const data = await this.types.published(publicId);
    if (!data) throw new NotFoundException({ result: 'INVALID' });
    return { data };
  }

  @Post(':publicId/bookings')
  @Header('Cache-Control', 'no-store')
  async book(@Param('publicId') publicId: string, @Body() input: unknown, @Headers('idempotency-key') key: string, @Res() res: Response) {
    const outcome = await this.types.book(publicId, input, key);
    if (outcome.result === 'RATE_LIMITED') res.setHeader('Retry-After', '3600');
    const status = { BOOKED: 201, INVALID: 400, CLOSED: 409, FAMILIES_ONLY: 403, FULL: 409, TIME_NOT_OFFERED: 409, ALREADY_BOOKED: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 }[outcome.result];
    return res.status(status).json(outcome);
  }

  @Post(':publicId/cancellations')
  @Header('Cache-Control', 'no-store')
  async cancel(@Param('publicId') publicId: string, @Body() input: unknown, @Res() res: Response) {
    const result = await this.types.cancel(publicId, input);
    if (result === 'RATE_LIMITED') res.setHeader('Retry-After', '3600');
    const status = { CANCELLED: 200, INVALID: 400, STARTED: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 }[result];
    return res.status(status).json({ result });
  }
}
