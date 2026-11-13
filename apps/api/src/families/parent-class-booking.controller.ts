import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentClassBookingService } from './parent-class-booking.service.js';

/** 0329: each parent class booking call is its own same-origin browser command; the read is GET only. */
@Injectable()
export class ParentClassBookingReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.class_booking.read';
}
@Injectable()
export class ParentClassBookingBookGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.class_booking.book';
}
@Injectable()
export class ParentClassBookingCancelGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.class_booking.cancel';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_CLASS_BOOKING_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}

@Controller('parent/class-bookings')
@UseGuards(HonIdentityGuard)
export class ParentClassBookingController {
  constructor(private readonly bookings: ParentClassBookingService) {}

  @Get()
  @UseGuards(ParentClassBookingReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async choices(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.bookings.choices(request.honIdentity!.externalSubject) };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(ParentClassBookingBookGuard)
  @Header('Cache-Control', 'private, no-store')
  async book(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noSelectors(request, query);
    const result = await this.bookings.book(request.honIdentity!.externalSubject, body, key);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { replayed: result.replayed } };
  }

  @Post(':bookingId/cancel')
  @HttpCode(200)
  @UseGuards(ParentClassBookingCancelGuard)
  @Header('Cache-Control', 'private, no-store')
  async cancel(@Param('bookingId') bookingId: string, @Query() query: Record<string, unknown>, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    const result = await this.bookings.cancel(request.honIdentity!.externalSubject, bookingId, body, key);
    return { data: result.receipt, meta: { replayed: result.replayed } };
  }
}
