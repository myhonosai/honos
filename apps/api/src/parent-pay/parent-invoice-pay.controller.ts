import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Injectable, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { EianReadGuard, rejectEianReadInputs } from '../eian/eian.controller.js';
import { ParentInvoicePayService } from './parent-invoice-pay.service.js';

/** Each payment step is its own same-origin browser (or native app) command, so no step can be replayed as another. */
@Injectable()
export class ParentInvoicePayStartGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.invoice.pay.start';
}
@Injectable()
export class ParentInvoicePayConfirmGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.invoice.pay.confirm';
}
@Injectable()
export class ParentInvoicePayCancelGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.invoice.pay.cancel';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>, body: unknown): string {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')
    || (body !== undefined && body !== null && (typeof body !== 'object' || Object.keys(body as object).length > 0))) {
    throw new BadRequestException({ code: 'PARENT_INVOICE_PAY_SELECTORS_NOT_ACCEPTED' });
  }
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** 0530: the signed-in guardian's invoice payments. Family, school and organization come only from the verified session. */
@Controller('parent/invoice-payments')
@UseGuards(HonIdentityGuard)
export class ParentInvoicePayController {
  constructor(private readonly pay: ParentInvoicePayService) {}

  @Get()
  @UseGuards(EianReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async list(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectEianReadInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.pay.list(request.honIdentity.externalSubject) };
  }

  @Post(':invoiceId/start')
  @HttpCode(200)
  @UseGuards(ParentInvoicePayStartGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async start(@Param('invoiceId') invoiceId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    return { data: await this.pay.start(noSelectors(request, query, body), invoiceId) };
  }

  @Post(':invoiceId/confirm')
  @HttpCode(200)
  @UseGuards(ParentInvoicePayConfirmGuard)
  @Header('Cache-Control', 'private, no-store')
  async confirm(@Param('invoiceId') invoiceId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    return { data: await this.pay.confirm(noSelectors(request, query, body), invoiceId) };
  }

  @Post(':invoiceId/cancel')
  @HttpCode(200)
  @UseGuards(ParentInvoicePayCancelGuard)
  @Header('Cache-Control', 'private, no-store')
  async cancel(@Param('invoiceId') invoiceId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    return { data: await this.pay.cancel(noSelectors(request, query, body), invoiceId) };
  }
}
