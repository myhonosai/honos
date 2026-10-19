import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable,
  ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  saasUuid, validateSaasCheckoutCancelInput, validateSaasCheckoutReceipt, validateSaasCheckoutSweepReceipt, validateSaasHqCheckoutInput,
  validateSaasPaymentProgramInput, validateSaasPaymentProgramReceipt, validateSaasPaymentRecoveryInput, validateSaasPaymentsView,
  validateSaasProviderEventReceipt, validateSaasSchoolCheckoutInput, validateSaasSchoolPlanOptions,
  type SaasCheckout, type SaasCheckoutReceipt, type SaasPaymentRecoveryResult, type SaasProviderEventReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import { PAYMENT_PROVIDER_ADAPTER, PaymentProviderError, WebhookVerificationError, type PaymentProviderAdapter,
  type VerifiedProviderEvent } from './payment-provider.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}
const PLAN_NAMES = { CORE: 'HON Core', COMPLETE: 'HON Complete' } as const;
const OFFER_LABELS = { REGULAR_MONTHLY: 'monthly', FOUNDER_MONTHLY: 'founder monthly', FOUNDER_LIFETIME: 'founder paid lifetime' } as const;

export interface CheckoutStartResult extends SaasCheckoutReceipt { providerCall: 'OPENED' | 'ALREADY_OPEN' | 'NOT_OPENABLE' }
export interface CheckoutCancelResult extends SaasCheckoutReceipt { providerExpiry: 'REQUESTED' | 'NOT_NEEDED' | 'FAILED' }

/**
 * B5 hosted checkout and provider-verified payment accounting, TEST MODE ONLY. HON never receives card
 * data, never initiates a charge or a refund, and only applies provider events whose signature verified.
 */
@Injectable()
export class SaasPaymentsService {
  constructor(private readonly billing: SaasBillingService, private readonly database: RuntimeDatabaseService,
    @Inject(PAYMENT_PROVIDER_ADAPTER) private readonly provider: PaymentProviderAdapter) {}

  readPayments(subject: string) {
    return this.billing.call('readPayments', [subject], validateSaasPaymentsView);
  }
  readPlanOptions(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readSchoolPlanOptions', [subject, school], validateSaasSchoolPlanOptions);
  }
  setPaymentProgram(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasPaymentProgramInput(body), saasUuid(key)] as const);
    return this.billing.call('setPaymentProgram', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasPaymentProgramReceipt);
  }
  async startSchoolCheckout(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CheckoutStartResult> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateSaasSchoolCheckoutInput(body), saasUuid(key)] as const);
    const receipt = await this.billing.call('createSchoolCheckout', [subject, school, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCheckoutReceipt);
    return this.openWithProvider(subject, receipt);
  }
  async startHqCheckout(subject: string, body: unknown, key: unknown): Promise<CheckoutStartResult> {
    const [input, idempotencyKey] = parse(() => [validateSaasHqCheckoutInput(body), saasUuid(key)] as const);
    const receipt = await this.billing.call('createHqCheckout', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCheckoutReceipt);
    return this.openWithProvider(subject, receipt);
  }
  async cancelCheckout(subject: string, checkoutId: unknown, body: unknown, key: unknown): Promise<CheckoutCancelResult> {
    const [checkout, input, idempotencyKey] = parse(() => [saasUuid(checkoutId), validateSaasCheckoutCancelInput(body), saasUuid(key)] as const);
    const receipt = await this.billing.call('cancelCheckout', [subject, checkout, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCheckoutReceipt);
    const session = receipt.checkout.providerSessionId;
    if (!session) return { ...receipt, providerExpiry: 'NOT_NEEDED' };
    // Best effort: if the hosted session is still paid later, the payment lands in PAID_NEEDS_REVIEW.
    try { await this.provider.expireCheckoutSession(session); return { ...receipt, providerExpiry: 'REQUESTED' }; }
    catch { return { ...receipt, providerExpiry: 'FAILED' }; }
  }
  sweepCheckouts(subject: string, key: unknown) {
    const idempotencyKey = parse(() => saasUuid(key));
    return this.billing.call('sweepCheckouts', [subject, idempotencyKey, randomUUID(), randomUUID()], validateSaasCheckoutSweepReceipt);
  }
  /** Missed-webhook recovery: events re-fetched over the authenticated provider API, applied idempotently. */
  async recoverEvents(subject: string, body: unknown): Promise<SaasPaymentRecoveryResult> {
    const input = parse(() => validateSaasPaymentRecoveryInput(body));
    await this.readPayments(subject); // HQ owner or operator only
    let events: VerifiedProviderEvent[];
    try { events = await this.provider.listRecentEvents(Math.floor(Date.now() / 1000) - input.sinceHours * 3600); }
    catch { throw new BadGatewayException({ code: 'SAAS_PAYMENT_PROVIDER_UNAVAILABLE' }); }
    const results: SaasPaymentRecoveryResult['results'] = [];
    for (const verified of events) {
      try { results.push((await this.ingest(verified)).event); }
      catch (error) { if (!(error instanceof HttpException) || error.getStatus() !== 503) throw error; } // not ready yet: a later recovery applies it
    }
    return { fetched: events.length, results };
  }

  /** Webhook: verify the signature over the exact raw body, then apply. Errors make the provider redeliver. */
  async handleWebhook(rawBody: unknown, signature: string | undefined): Promise<SaasProviderEventReceipt> {
    if (!Buffer.isBuffer(rawBody)) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    let verified: VerifiedProviderEvent;
    try { verified = this.provider.verifyWebhook(rawBody, signature); }
    catch (error) {
      if (error instanceof WebhookVerificationError && error.reason === 'NOT_CONFIGURED') throw new ServiceUnavailableException({ code: 'SAAS_PAYMENTS_NOT_CONFIGURED' });
      throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
    }
    return this.ingest(verified);
  }

  private async ingest(verified: VerifiedProviderEvent): Promise<SaasProviderEventReceipt> {
    let data: unknown;
    try { data = await this.database.callSaasBilling('ingestProviderEvent', [JSON.stringify(verified.event), verified.digest]); }
    catch (error) {
      const { code, message } = (error ?? {}) as { code?: string; message?: string };
      if (message === 'SAAS_PROVIDER_EVENT_NOT_READY' || message === 'SAAS_PAYMENTS_NOT_ACTIVE' || code === '40001' || code === '55P03' || code === '57014')
        throw new ServiceUnavailableException({ code: 'SAAS_PROVIDER_EVENT_RETRY' });
      if (code === '23505') throw new ConflictException({ code: 'SAAS_PROVIDER_EVENT_CONFLICT' });
      if (code === '42501') throw new ForbiddenException({ code: 'SAAS_PROVIDER_EVENT_REFUSED' });
      if (['22023','22P02','22003','22007','22008','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_WEBHOOK' });
      throw new ServiceUnavailableException({ code: 'SAAS_PROVIDER_EVENT_RETRY' });
    }
    try { return validateSaasProviderEventReceipt(data); } catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  /** A replayed receipt carries the checkout as first recorded; re-read its current state. */
  private async current(subject: string, checkout: SaasCheckout): Promise<SaasCheckout> {
    const list = checkout.schoolId
      ? [(await this.readPlanOptions(subject, checkout.schoolId)).checkout]
      : (await this.readPayments(subject)).checkouts;
    return list.find(c => c?.checkoutId === checkout.checkoutId) ?? checkout;
  }

  private async openWithProvider(subject: string, receipt: SaasCheckoutReceipt): Promise<CheckoutStartResult> {
    const checkout: SaasCheckout = receipt.replayed ? await this.current(subject, receipt.checkout) : receipt.checkout;
    receipt = { ...receipt, checkout };
    if (checkout.status === 'OPEN') return { ...receipt, providerCall: 'ALREADY_OPEN' };
    if (checkout.status !== 'CREATED') return { ...receipt, providerCall: 'NOT_OPENABLE' };
    const origin = process.env.HON_PUBLIC_ORIGIN;
    if (!origin || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) throw new ServiceUnavailableException({ code: 'SAAS_PAYMENTS_NOT_CONFIGURED' });
    const back = checkout.schoolId ? `${origin}/schools/${checkout.schoolId}/hon-plan` : `${origin}/hq/billing`;
    let session;
    try {
      // The provider deduplicates on the checkout id, so a retry after an unknown outcome reuses the same session.
      session = await this.provider.createCheckoutSession({ checkoutId: checkout.checkoutId, organizationId: checkout.organizationId,
        planCode: checkout.planCode, offerKind: checkout.offerKind, billingInterval: checkout.billingInterval, amountMinor: checkout.amountMinor,
        productName: `${PLAN_NAMES[checkout.planCode]} — ${OFFER_LABELS[checkout.offerKind]}`, expiresAt: checkout.expiresAt,
        successUrl: `${back}?checkout=${checkout.checkoutId}&result=success`, cancelUrl: `${back}?checkout=${checkout.checkoutId}&result=cancelled` });
    } catch (error) {
      if (error instanceof PaymentProviderError && error.outcome !== 'UNKNOWN') {
        const failed = await this.billing.call('attachCheckoutSession', [subject, checkout.checkoutId,
          JSON.stringify({ outcome: 'FAILED', providerSessionId: null, checkoutUrl: null }), randomUUID(), randomUUID(), randomUUID()], validateSaasCheckoutReceipt);
        throw new BadGatewayException({ code: 'SAAS_PAYMENT_PROVIDER_UNAVAILABLE', checkoutStatus: failed.checkout.status });
      }
      throw new ConflictException({ code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; the provider deduplicates the session.' });
    }
    const opened = await this.billing.call('attachCheckoutSession', [subject, checkout.checkoutId,
      JSON.stringify({ outcome: 'OPENED', providerSessionId: session.providerSessionId, checkoutUrl: session.checkoutUrl }), randomUUID(), randomUUID(), randomUUID()],
      validateSaasCheckoutReceipt);
    // `replayed` describes the checkout command the caller sent, not the internal attach step.
    return { ...opened, replayed: receipt.replayed, providerCall: 'OPENED' };
  }
}
