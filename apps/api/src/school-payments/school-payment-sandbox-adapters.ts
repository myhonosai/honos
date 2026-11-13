import {
  verifySchoolPayMethodObservation, verifySchoolPayObservation, type SchoolPayCapabilities, type SchoolPayCardBrand, type SchoolPayMethodKind,
  type SchoolPayMethodObservation, type SchoolPayObservation,
} from '@hon/contracts';
import { SchoolPaymentProviderError, type SchoolPaymentAdapter } from './school-payment-adapter.js';
import type { SchoolPayCredential } from './school-payment-vault.js';

/**
 * B-TUI-2 piece 2 (0320): the real provider clients for SCHOOL payments, TEST/SANDBOX MODE ONLY. Hosts are fixed here
 * (Stripe's API in test mode, Square's sandbox); live keys and Square production ids are refused at construction.
 * Credentials are the separate tuition ones (HON_TUITION_*), never HON's SaaS Stripe account. No call carries a fee.
 * Every answer is checked: a network failure, a timeout, a 5xx or an unexpected body is UNKNOWN, never success.
 */
export interface SchoolPayHttpRequest { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }
export interface SchoolPayHttpResponse { status: number; body: unknown }
export type SchoolPayHttp = (request: SchoolPayHttpRequest) => Promise<SchoolPayHttpResponse>;

const STRIPE_API = 'https://api.stripe.com';
const SQUARE_SANDBOX = 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2025-01-23';
const SQUARE_SCOPES = 'MERCHANT_PROFILE_READ PAYMENTS_READ PAYMENTS_WRITE CUSTOMERS_READ CUSTOMERS_WRITE';
const ACCOUNT_REF = /^[A-Za-z0-9_-]{3,100}$/;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/** fetch with a 15 s limit and no redirects; the body is parsed as JSON or null. */
export const defaultSchoolPayHttp: SchoolPayHttp = async ({ method, url, headers, body }) => {
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
};

const unknown = (): never => { throw new SchoolPaymentProviderError('UNKNOWN', 'PROVIDER_UNKNOWN'); };
const rejected = (): never => { throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED'); };
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : unknown());
/** Square's OAuth error shapes: {errors:[{code}]} or {error:'invalid_grant'}. */
function grantInvalid(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const row = body as Record<string, unknown>;
  if (typeof row.error === 'string' && row.error.toLowerCase() === 'invalid_grant') return true;
  return Array.isArray(row.errors) && row.errors.some(e => !!e && typeof e === 'object' && String((e as Record<string, unknown>).code ?? '').toUpperCase() === 'INVALID_GRANT');
}
const PROVIDER_REF = /^[A-Za-z0-9_:-]{3,100}$/;
const providerRef = (value: unknown): string => (typeof value === 'string' && PROVIDER_REF.test(value) ? value : unknown());
const STRIPE_BRANDS: Record<string, SchoolPayCardBrand> = { visa: 'VISA', mastercard: 'MASTERCARD', amex: 'AMEX', discover: 'DISCOVER', jcb: 'JCB', diners: 'DINERS', unionpay: 'UNIONPAY' };
const stripeBrand = (value: unknown): SchoolPayCardBrand => (typeof value === 'string' ? STRIPE_BRANDS[value] ?? 'OTHER' : unknown());
const accountRef = (value: unknown): string => (typeof value === 'string' && ACCOUNT_REF.test(value) ? value : unknown());

/** One provider call. The error never carries the provider's text, the request or a credential. */
async function send(http: SchoolPayHttp, request: SchoolPayHttpRequest): Promise<SchoolPayHttpResponse> {
  let response: SchoolPayHttpResponse;
  try { response = await http(request); } catch { return unknown(); }
  if (!response || typeof response.status !== 'number' || response.status >= 500 || response.status === 429 || response.status < 200) return unknown();
  return response;
}
function hostedUrl(value: unknown, host: string): string {
  if (typeof value !== 'string') return unknown();
  let url: URL;
  try { url = new URL(value); } catch { return unknown(); }
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port) return unknown();
  return url.toString();
}
function returnWith(returnUrl: string, state: string | null): string {
  const url = new URL(returnUrl);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
  if (state !== null) url.searchParams.set('state', state);
  return url.toString();
}

const STRIPE_MANIFEST: SchoolPayCapabilities = Object.freeze({ bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true });

/** Stripe Connect, test mode: accounts with the full Stripe Dashboard, Stripe-hosted onboarding, direct charges later. */
export class StripeConnectTestAdapter implements SchoolPaymentAdapter {
  readonly providerCode = 'STRIPE_CONNECT' as const;
  readonly manifest = STRIPE_MANIFEST;
  readonly credentialKind = 'NONE' as const;

  constructor(private readonly secretKey: string, private readonly http: SchoolPayHttp = defaultSchoolPayHttp) {
    if (!/^(sk|rk)_test_[A-Za-z0-9]{10,200}$/.test(secretKey)) throw new SchoolPaymentProviderError('PRE_SEND', 'LIVE_MODE_REFUSED');
  }
  readiness(): 'READY' { return 'READY'; }

  private async call(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string, connectedAccount?: string): Promise<SchoolPayHttpResponse> {
    return send(this.http, {
      method, url: `${STRIPE_API}${path}`,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Stripe-Version': '2025-03-31.basil', Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(connectedAccount ? { 'Stripe-Account': accountRef(connectedAccount) } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
  }

  async beginOnboarding({ connectionId, accountRef: existing, state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    const back = returnWith(returnUrl, state);
    const again = returnWith(returnUrl, null);
    let account = existing;
    if (account === null) {
      // The school's own account: full Stripe Dashboard, the school pays Stripe's fees, Stripe carries losses and collects
      // requirements. No personal data is sent; the school enters it on Stripe's page. The key makes a retry return the
      // same account (Stripe keeps idempotency keys for 24 hours).
      const created = await this.call('POST', '/v1/accounts', {
        'controller[stripe_dashboard][type]': 'full', 'controller[fees][payer]': 'account', 'controller[losses][payments]': 'stripe',
        'controller[requirement_collection]': 'stripe', 'metadata[hon_connection_id]': connectionId,
      }, `hon-school-pay-account-${connectionId}`);
      if (created.status !== 200) return rejected();
      account = accountRef(object(created.body).id);
    }
    const link = await this.call('POST', '/v1/account_links', { account, type: 'account_onboarding', return_url: back, refresh_url: again });
    if (link.status !== 200) return rejected();
    return { onboardingUrl: hostedUrl(object(link.body).url, 'connect.stripe.com'), accountRef: account };
  }

  async completeOnboarding({ accountRef: existing, authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (!existing || authorizationCode !== undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    return { accountRef: existing };
  }

  async retrieveStatus({ accountRef: ref }: { accountRef: string }): Promise<SchoolPayObservation> {
    const response = await this.call('GET', `/v1/accounts/${encodeURIComponent(ref)}`);
    const body = object(response.body);
    if (response.status === 403 || (response.status !== 200 && object(body.error ?? {}).code === 'account_invalid')) {
      return verifySchoolPayObservation({ accountRef: ref, chargesEnabled: false, payoutsEnabled: false, requirementsDue: true, reauthorizationRequired: true,
        capabilities: { bankDebit: false, offSessionRecurring: false, oneTimeCard: false, refunds: false, storedCard: false } });
    }
    if (response.status !== 200) return rejected();
    if (body.id !== ref || typeof body.charges_enabled !== 'boolean' || typeof body.payouts_enabled !== 'boolean') return unknown();
    const requirements = object(body.requirements ?? {});
    const due = (key: string) => Array.isArray(requirements[key]) && (requirements[key] as unknown[]).length > 0;
    const capabilities = object(body.capabilities ?? {});
    const card = capabilities.card_payments === 'active';
    const ach = capabilities.us_bank_account_ach_payments === 'active';
    return verifySchoolPayObservation({
      accountRef: ref, chargesEnabled: body.charges_enabled, payoutsEnabled: body.payouts_enabled,
      requirementsDue: due('currently_due') || due('past_due') || (requirements.disabled_reason !== null && requirements.disabled_reason !== undefined),
      reauthorizationRequired: false,
      capabilities: { bankDebit: ach, offSessionRecurring: card, oneTimeCard: card, refunds: card, storedCard: card },
    });
  }

  /**
   * 0321: the payer's customer lives on the school's own account (direct charges), so every saved-method call carries
   * Stripe-Account. The idempotency key makes a retried create return the same customer, never an orphan.
   */
  async ensureCustomer({ accountRef: account, billingAccountId, customerRef }: { accountRef: string; billingAccountId: string; customerRef: string | null }) {
    if (customerRef !== null) return { customerRef: providerRef(customerRef) };
    const created = await this.call('POST', '/v1/customers', { 'metadata[hon_billing_account_id]': billingAccountId },
      `hon-school-pay-customer-${account}-${billingAccountId}`, account);
    if (created.status !== 200) return rejected();
    return { customerRef: providerRef(object(created.body).id) };
  }

  /** 0321: Stripe Checkout in setup mode on the school's account; the payer enters the card or bank details on Stripe's page. */
  async beginMethodSetup({ accountRef: account, customerRef, setupId, methodKinds, state, returnUrl }: { accountRef: string; customerRef: string; setupId: string; methodKinds: readonly SchoolPayMethodKind[]; state: string; returnUrl: string }) {
    if (!methodKinds.length) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    const form: Record<string, string> = { mode: 'setup', customer: providerRef(customerRef), success_url: returnWith(returnUrl, state), cancel_url: returnWith(returnUrl, null),
      'metadata[hon_setup_id]': setupId };
    [...methodKinds].sort().forEach((kind, i) => { form[`payment_method_types[${i}]`] = kind === 'CARD' ? 'card' : 'us_bank_account'; });
    const created = await this.call('POST', '/v1/checkout/sessions', form, `hon-school-pay-setup-${setupId}`, account);
    if (created.status !== 200) return rejected();
    const body = object(created.body);
    return { setupRef: providerRef(body.id), setupUrl: hostedUrl(body.url, 'checkout.stripe.com') };
  }

  /** 0321: the saved method read from Stripe with the platform key (the browser return proves nothing). */
  async retrieveMethodSetup({ accountRef: account, customerRef, setupRef }: { accountRef: string; customerRef: string; setupRef: string }): Promise<SchoolPayMethodObservation> {
    const response = await this.call('GET', `/v1/checkout/sessions/${encodeURIComponent(providerRef(setupRef))}?expand[]=setup_intent.payment_method`, undefined, undefined, account);
    if (response.status !== 200) return rejected();
    const session = object(response.body);
    if (session.id !== setupRef || session.mode !== 'setup' || session.customer !== customerRef) return unknown();
    const intent = session.setup_intent && typeof session.setup_intent === 'object' ? object(session.setup_intent) : null;
    if (session.status !== 'complete' || !intent || intent.status !== 'succeeded') throw new SchoolPaymentProviderError('FAILED', 'SETUP_INCOMPLETE');
    const method = object(intent.payment_method);
    if (method.customer !== customerRef) return unknown();
    if (method.type === 'card') {
      const card = object(method.card);
      return verifySchoolPayMethodObservation({ customerRef, methodRef: providerRef(method.id), kind: 'CARD', brand: stripeBrand(card.brand), last4: card.last4,
        expMonth: card.exp_month, expYear: card.exp_year });
    }
    if (method.type === 'us_bank_account') {
      const bank = object(method.us_bank_account);
      return verifySchoolPayMethodObservation({ customerRef, methodRef: providerRef(method.id), kind: 'US_BANK_ACCOUNT', brand: 'BANK', last4: bank.last4, expMonth: null, expYear: null });
    }
    return unknown();
  }

  /** 0321: detach a removed method from the payer's customer on the school's account. */
  async detachMethod({ accountRef: account, methodRef }: { accountRef: string; methodRef: string }): Promise<void> {
    const response = await this.call('POST', `/v1/payment_methods/${encodeURIComponent(providerRef(methodRef))}/detach`, {}, `hon-school-pay-detach-${methodRef}`, account);
    if (response.status !== 200) return rejected();
  }

  /** A full-dashboard account is the school's: the platform's secret key cannot revoke it, and HON never deletes it. */
  async disconnect(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'REVOKE_NOT_SUPPORTED'); }
}

const SQUARE_MANIFEST: SchoolPayCapabilities = Object.freeze({ bankDebit: false, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true });

/** Square, sandbox only: OAuth code flow into the school's own seller account; tokens go to the vault. */
export class SquareSandboxAdapter implements SchoolPaymentAdapter {
  readonly providerCode = 'SQUARE' as const;
  readonly manifest = SQUARE_MANIFEST;
  readonly credentialKind = 'OAUTH_TOKENS' as const;

  constructor(private readonly applicationId: string, private readonly applicationSecret: string,
    private readonly http: SchoolPayHttp = defaultSchoolPayHttp, private readonly now: () => Date = () => new Date()) {
    if (!/^sandbox-sq0idb-[A-Za-z0-9_-]{10,100}$/.test(applicationId) || !/^sandbox-sq0csb-[A-Za-z0-9_-]{10,200}$/.test(applicationSecret)) {
      throw new SchoolPaymentProviderError('PRE_SEND', 'LIVE_MODE_REFUSED');
    }
  }
  readiness(): 'READY' { return 'READY'; }

  private call(method: 'GET' | 'POST', path: string, authorization: string | null, body?: Record<string, string>): Promise<SchoolPayHttpResponse> {
    return send(this.http, {
      method, url: `${SQUARE_SANDBOX}${path}`,
      headers: { ...(authorization === null ? {} : { Authorization: authorization }), 'Square-Version': SQUARE_VERSION, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  private credentialFrom(response: SchoolPayHttpResponse, expectedMerchant?: string): { accountRef: string; credential: SchoolPayCredential } {
    if (response.status === 400 || response.status === 401 || response.status === 403) return rejected();
    if (response.status !== 200) return unknown();
    const body = object(response.body);
    const merchant = accountRef(body.merchant_id);
    if (expectedMerchant !== undefined && merchant !== expectedMerchant) return unknown();
    const expires = typeof body.expires_at === 'string' ? new Date(body.expires_at) : null;
    if (typeof body.access_token !== 'string' || !TOKEN.test(body.access_token) || typeof body.refresh_token !== 'string' || !TOKEN.test(body.refresh_token)
      || !expires || Number.isNaN(expires.getTime())) return unknown();
    return { accountRef: merchant, credential: { accessToken: body.access_token, refreshToken: body.refresh_token, accessExpiresAt: expires.toISOString() } };
  }

  async beginOnboarding({ state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    returnWith(returnUrl, state); // the redirect itself is the one set in the Square app
    const url = new URL(`${SQUARE_SANDBOX}/oauth2/authorize`);
    url.searchParams.set('client_id', this.applicationId);
    url.searchParams.set('scope', SQUARE_SCOPES);
    url.searchParams.set('session', 'false');
    url.searchParams.set('state', state);
    return { onboardingUrl: url.toString(), accountRef: null };
  }

  async completeOnboarding({ authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (authorizationCode === undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    const response = await this.call('POST', '/oauth2/token', null, {
      client_id: this.applicationId, client_secret: this.applicationSecret, grant_type: 'authorization_code', code: authorizationCode,
    });
    return this.credentialFrom(response);
  }

  needsRenewal(credential: SchoolPayCredential): boolean {
    return new Date(credential.accessExpiresAt).getTime() - this.now().getTime() < RENEW_WITHIN_MS;
  }

  async renewCredential({ accountRef: ref, credential }: { accountRef: string; credential: SchoolPayCredential }): Promise<SchoolPayCredential> {
    const response = await this.call('POST', '/oauth2/token', null, {
      client_id: this.applicationId, client_secret: this.applicationSecret, grant_type: 'refresh_token', refresh_token: credential.refreshToken,
    });
    // A seller who revoked HON (or a dead refresh token) answers 401 or invalid_grant: that is a known outcome, not UNKNOWN.
    if (response.status === 401 || (response.status === 400 && grantInvalid(response.body))) throw new SchoolPaymentProviderError('FAILED', 'GRANT_REVOKED');
    return this.credentialFrom(response, ref).credential;
  }

  async retrieveStatus({ accountRef: ref, credential }: { accountRef: string; credential?: SchoolPayCredential }): Promise<SchoolPayObservation> {
    if (!credential) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    const bearer = `Bearer ${credential.accessToken}`;
    const revoked = () => verifySchoolPayObservation({ accountRef: ref, chargesEnabled: false, payoutsEnabled: false, requirementsDue: true, reauthorizationRequired: true,
      capabilities: { bankDebit: false, offSessionRecurring: false, oneTimeCard: false, refunds: false, storedCard: false } });
    const merchantResponse = await this.call('GET', `/v2/merchants/${encodeURIComponent(ref)}`, bearer);
    if (merchantResponse.status === 401) return revoked();
    if (merchantResponse.status !== 200) return rejected();
    const merchant = object(object(merchantResponse.body).merchant);
    if (merchant.id !== ref || typeof merchant.status !== 'string') return unknown();
    const locationsResponse = await this.call('GET', '/v2/locations', bearer);
    if (locationsResponse.status === 401) return revoked();
    if (locationsResponse.status !== 200) return rejected();
    const locations = object(locationsResponse.body).locations ?? [];
    if (!Array.isArray(locations)) return unknown();
    const cardLocation = locations.some(l => { const row = object(l); return row.status === 'ACTIVE' && Array.isArray(row.capabilities) && row.capabilities.includes('CREDIT_CARD_PROCESSING'); });
    const active = merchant.status === 'ACTIVE';
    const charges = active && cardLocation;
    return verifySchoolPayObservation({
      accountRef: ref, chargesEnabled: charges, payoutsEnabled: active, requirementsDue: !charges, reauthorizationRequired: false,
      capabilities: { bankDebit: false, offSessionRecurring: charges, oneTimeCard: charges, refunds: charges, storedCard: charges },
    });
  }

  /**
   * 0321: saving a Square card needs the Web Payments SDK on a HON-hosted page and the seller's token from the vault; that
   * is a later piece. Until then every saved-method call is refused before anything is sent (the simulator covers it).
   */
  async ensureCustomer(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async beginMethodSetup(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async retrieveMethodSetup(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async detachMethod(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }

  /** Revokes this application's access to the merchant (all its tokens). The seller account itself stays. */
  async disconnect({ accountRef: ref }: { accountRef: string }): Promise<void> {
    const response = await this.call('POST', '/oauth2/revoke', `Client ${this.applicationSecret}`, { client_id: this.applicationId, merchant_id: ref });
    if (response.status !== 200 || object(response.body).success !== true) return rejected();
  }
}
