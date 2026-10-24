import type { SaasHonOsRecurringBilling, SaasProviderCode, SaasProviderEvent, SaasSoldBillingInterval, SaasSoldOfferKind } from '@hon/contracts';

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');

/**
 * What HON asks the provider to host. HON never sees or stores card data. `recurring` is decided by the server (legacy
 * monthly or a HON OS accepted offer): NONE is a one-time payment that can never create a recurring obligation.
 */
export interface HostedCheckoutRequest {
  checkoutId: string; organizationId: string; planCode: 'CORE' | 'COMPLETE';
  offerKind: SaasSoldOfferKind; billingInterval: SaasSoldBillingInterval; recurring: SaasHonOsRecurringBilling;
  amountMinor: number; productName: string; expiresAt: string; successUrl: string; cancelUrl: string;
}
export interface HostedCheckoutSession { providerSessionId: string; checkoutUrl: string }
export interface VerifiedProviderEvent { event: SaasProviderEvent; digest: string }

/**
 * Server-only provider adapter, TEST MODE ONLY. Implementations refuse live credentials and live
 * events. Test fakes are injected (a fake transport), never selected by environment.
 */
export interface PaymentProviderAdapter {
  readonly provider: SaasProviderCode | null;
  readiness(): 'READY' | 'NOT_CONFIGURED';
  createCheckoutSession(input: HostedCheckoutRequest): Promise<HostedCheckoutSession>;
  expireCheckoutSession(providerSessionId: string): Promise<void>;
  /** Verifies the webhook signature over the exact raw body, then normalizes the event. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedProviderEvent;
  /** Recovery for missed webhooks: events fetched over the authenticated provider API. */
  listRecentEvents(sinceEpochSeconds: number): Promise<VerifiedProviderEvent[]>;
}

/** PRE_SEND: nothing reached the provider. FAILED: the provider refused. UNKNOWN: it may have acted. */
export class PaymentProviderError extends Error {
  constructor(readonly outcome: 'PRE_SEND' | 'FAILED' | 'UNKNOWN',
    readonly reason: 'NOT_CONFIGURED' | 'LIVE_MODE_REFUSED' | 'INVALID_REQUEST' | 'PROVIDER_REJECTED' | 'PROVIDER_UNKNOWN') { super(reason); }
}
export class WebhookVerificationError extends Error {
  constructor(readonly reason: 'MISSING_SIGNATURE' | 'BAD_SIGNATURE' | 'STALE_TIMESTAMP' | 'LIVE_MODE_REFUSED' | 'MALFORMED_EVENT' | 'UNSUPPORTED_API_VERSION' | 'NOT_CONFIGURED') { super(reason); }
}

/** Selected when no test-mode credentials are configured: every call is refused before sending. */
export class UnconfiguredPaymentProvider implements PaymentProviderAdapter {
  readonly provider = null;
  readiness(): 'NOT_CONFIGURED' { return 'NOT_CONFIGURED'; }
  async createCheckoutSession(): Promise<HostedCheckoutSession> { throw new PaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async expireCheckoutSession(): Promise<void> { throw new PaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  verifyWebhook(): VerifiedProviderEvent { throw new WebhookVerificationError('NOT_CONFIGURED'); }
  async listRecentEvents(): Promise<VerifiedProviderEvent[]> { throw new PaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
}
