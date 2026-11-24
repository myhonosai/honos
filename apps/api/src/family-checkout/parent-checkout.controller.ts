import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { EianReadGuard, rejectEianReadInputs } from '../eian/eian.controller.js';
import { ParentCheckoutService } from './parent-checkout.service.js';

/** Each step is its own same-origin browser (or native app) command, so no step can be replayed as another. */
@Injectable()
export class ParentCheckoutOrderGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.checkout.order';
}
@Injectable()
export class ParentCheckoutStartGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.checkout.pay.start';
}
@Injectable()
export class ParentCheckoutConfirmGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.checkout.pay.confirm';
}
@Injectable()
export class ParentCheckoutCancelGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.checkout.pay.cancel';
}

function subjectOf(request: HonRequest, query: Record<string, unknown>): string {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'FAMILY_CHECKOUT_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}
function noBody(body: unknown): void {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Object.keys(body as object).length > 0)) {
    throw new BadRequestException({ code: 'FAMILY_CHECKOUT_SELECTORS_NOT_ACCEPTED' });
  }
}

/** 0598: the signed-in family's checkout pages and orders. Family, school and organization come only from the verified session. */
@Controller('parent/checkout-pages')
@UseGuards(HonIdentityGuard)
export class ParentCheckoutController {
  constructor(private readonly checkout: ParentCheckoutService) {}

  @Get()
  @UseGuards(EianReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async list(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectEianReadInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.checkout.list(request.honIdentity.externalSubject) };
  }

  @Post('orders')
  @HttpCode(200)
  @UseGuards(ParentCheckoutOrderGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async order(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    return { data: await this.checkout.order(subjectOf(request, query), body, key?.trim() ?? '') };
  }

  @Post('orders/:orderId/start')
  @HttpCode(200)
  @UseGuards(ParentCheckoutStartGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async start(@Param('orderId') orderId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    noBody(body);
    return { data: await this.checkout.start(subjectOf(request, query), orderId) };
  }

  @Post('orders/:orderId/confirm')
  @HttpCode(200)
  @UseGuards(ParentCheckoutConfirmGuard)
  @Header('Cache-Control', 'private, no-store')
  async confirm(@Param('orderId') orderId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    noBody(body);
    return { data: await this.checkout.confirm(subjectOf(request, query), orderId) };
  }

  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  @UseGuards(ParentCheckoutCancelGuard)
  @Header('Cache-Control', 'private, no-store')
  async cancel(@Param('orderId') orderId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    noBody(body);
    return { data: await this.checkout.cancel(subjectOf(request, query), orderId) };
  }
}
