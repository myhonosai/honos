import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasPaymentsService } from './saas-payments.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function assertEmptyBody(body: unknown): void {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
}

/**
 * School owner's HON plan purchase (test mode): staff with billing.hon.purchase at the exact school.
 * Only the plan matching the school's entitlement is offered; checkout is hosted by the provider.
 */
@Controller('schools/:schoolId/hon-plan')
@UseGuards(HonIdentityGuard)
export class SaasPlanSchoolController {
  constructor(private readonly payments: SaasPaymentsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async options(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.payments.readPlanOptions(subject(req), schoolId) };
  }
  @Post('checkout') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startCheckout)
  async checkout(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.payments.startSchoolCheckout(subject(req), schoolId, body, key) };
  }
  @Post('checkout/:checkoutId/cancel') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.cancelCheckout)
  async cancel(@Req() req: HonRequest, @Param('checkoutId') checkoutId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.payments.cancelCheckout(subject(req), checkoutId, body, key) };
  }
}

/** HQ view and control of the test-mode payment program, checkouts, provider events and reconciliation. */
@Controller('hq/saas/payments')
@UseGuards(HonIdentityGuard)
export class SaasPaymentsHqController {
  constructor(private readonly payments: SaasPaymentsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async overview(@Req() req: HonRequest) {
    return { data: await this.payments.readPayments(subject(req)) };
  }
  @Post('program') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setPaymentProgram)
  async program(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.payments.setPaymentProgram(subject(req), body, key) };
  }
  @Post('checkouts') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startCheckout)
  async checkout(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.payments.startHqCheckout(subject(req), body, key) };
  }
  @Post('checkouts/sweep') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.sweepCheckouts)
  async sweep(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.payments.sweepCheckouts(subject(req), key) };
  }
  @Post('checkouts/:checkoutId/cancel') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.cancelCheckout)
  async cancel(@Req() req: HonRequest, @Param('checkoutId') checkoutId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.payments.cancelCheckout(subject(req), checkoutId, body, key) };
  }
  @Post('recover') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recoverPaymentEvents)
  async recover(@Req() req: HonRequest, @Body() body: unknown) {
    return { data: await this.payments.recoverEvents(subject(req), body) };
  }
}

/**
 * Provider webhook. No HON identity: authenticity is the provider signature over the raw body, which
 * paymentWebhookTransport keeps as a Buffer. A non-2xx response makes the provider redeliver.
 */
@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(private readonly payments: SaasPaymentsService) {}
  @Post('stripe') @HttpCode(200)
  async stripe(@Req() req: HonRequest, @Headers('stripe-signature') signature: string | undefined) {
    const receipt = await this.payments.handleWebhook(req.body, signature);
    return { received: true, outcome: receipt.event.outcome, replayed: receipt.replayed };
  }
}
