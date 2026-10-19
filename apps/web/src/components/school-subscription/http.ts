import {
  SAAS_COMMANDS, saasUuid, validateSaasCheckoutReceipt, validateSaasSchoolCheckoutInput,
  validateSaasSchoolCredits, validateSaasSchoolPlanOptions,
  type SaasCheckoutReceipt, type SaasPlanOffer, type SaasSchoolCredits, type SaasSchoolPlanOptions,
} from '@hon/contracts';
import { verifyCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';

export type SchoolAccount = { context: { organizationId: string; schoolId: string }; plan: SaasSchoolPlanOptions };
export type CheckoutResult = SaasCheckoutReceipt & { providerCall: 'OPENED' | 'ALREADY_OPEN' | 'NOT_OPENABLE' };
export class SchoolCheckoutError extends Error {
  constructor(readonly kind: 'UNAUTHORIZED' | 'DENIED' | 'UNAVAILABLE' | 'INVALID' | 'SCOPE' | 'CHANGED' | 'UNKNOWN' | 'PROVIDER', message: string) { super(message); }
}
function invalid(): never { throw new SchoolCheckoutError('INVALID', 'HON could not verify the billing response. Refresh before continuing.'); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((k) => !Object.hasOwn(row, k))) invalid();
  return row;
}
async function request(path: string, options: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...options, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SchoolCheckoutError(options.method === 'POST' ? 'UNKNOWN' : 'UNAVAILABLE', options.method === 'POST' ? 'Checkout outcome is unknown. Refresh status before retrying the identical request.' : 'School billing is unavailable. No current payment or access state is assumed.');
  }
  if (!response.ok) {
    if (response.status === 401) throw new SchoolCheckoutError('UNAUTHORIZED', 'Sign in again to verify school billing access.');
    if (response.status === 403) throw new SchoolCheckoutError('DENIED', 'School billing permission was denied. No purchase or account access is assumed.');
    // Only closed backend error codes select safe local copy; never display private bodies/details.
    let code: unknown;
    if (options.method === 'POST') { try { const body: unknown = await response.json(); if (body && typeof body === 'object' && 'code' in body) code = body.code; } catch { /* unknown outcome stays unknown */ } }
    if (code === 'SAAS_OUTCOME_UNKNOWN') throw new SchoolCheckoutError('UNKNOWN', 'Provider outcome is unknown. Refresh, then retry this same checkout with its original retry key.');
    if (code === 'SAAS_PAYMENT_PROVIDER_UNAVAILABLE' || code === 'SAAS_PAYMENTS_NOT_CONFIGURED') throw new SchoolCheckoutError('PROVIDER', 'The test payment provider is unavailable or not configured. Refresh the recorded checkout before trying again.');
    throw new SchoolCheckoutError(options.method === 'POST' ? 'UNKNOWN' : 'UNAVAILABLE', options.method === 'POST' ? 'Checkout was not confirmed. Availability or authorization may have changed. Refresh before an explicit retry.' : 'School billing is unavailable. Refresh to verify current records.');
  }
  if (response.status !== 200 || response.redirected
    || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) invalid();
  if (response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)) invalid();
  let body: unknown; try { body = await response.json(); } catch { invalid(); }
  return exact(body, ['data']).data;
}
const read = (path: string, signal?: AbortSignal) => request(path, { method: 'GET', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
function canonical<T>(validate: (value: unknown) => T, value: unknown): T { try { return validate(value); } catch { invalid(); } }

/** No caller-supplied school, URL, saved preference or HQ scope. B5 independently authorizes purchase. */
export async function loadSchoolAccount(signal?: AbortSignal): Promise<SchoolAccount> {
  const data = await read('/api/v1/staff/current-reporting-school', signal);
  const context = canonical(verifyCurrentStaffReportingSchool, { data });
  if (context.state !== 'RESOLVED') throw new SchoolCheckoutError('SCOPE', 'A single current school could not be verified. Multi-school purchasing needs school selection support.');
  const plan = canonical(validateSaasSchoolPlanOptions, await read(`/api/v1/schools/${context.schoolId}/hon-plan`, signal));
  if (plan.schoolId !== context.schoolId || (plan.subscription && plan.subscription.organizationId !== context.organizationId)) invalid();
  const c = plan.checkout;
  if (c && (c.schoolId !== context.schoolId || c.organizationId !== context.organizationId || c.requesterKind !== 'SCHOOL_OWNER')) invalid();
  if (c?.status === 'COMPLETED' && (!plan.subscription || c.subscriptionId !== plan.subscription.subscriptionId || c.planCode !== plan.subscription.planCode || c.offerId !== plan.subscription.offerId)) invalid();
  if (new Set(plan.offers.map((o) => o.offerId)).size !== plan.offers.length || new Set(plan.offers.map((o) => o.offerKind)).size !== plan.offers.length) invalid();
  return { context: { organizationId: context.organizationId, schoolId: context.schoolId }, plan };
}
export async function loadSchoolAllowance(account: SchoolAccount, signal?: AbortSignal): Promise<SaasSchoolCredits> {
  try { saasUuid(account.context.schoolId); } catch { invalid(); }
  const credits = canonical(validateSaasSchoolCredits, await read(`/api/v1/schools/${account.context.schoolId}/ai-credits`, signal));
  const a = credits.currentAllowance;
  if (credits.schoolId !== account.context.schoolId || (a && (!account.plan.subscription || a.subscriptionId !== account.plan.subscription.subscriptionId || a.planCode !== account.plan.subscription.planCode))) invalid();
  if (credits.subscriptionStatus !== (account.plan.subscription?.status === 'VOIDED' ? null : account.plan.subscription?.status ?? null)) invalid();
  return credits;
}
export function offerFingerprint(account: SchoolAccount, offer: SaasPlanOffer): string {
  return JSON.stringify([account.context.organizationId, account.context.schoolId, account.plan.entitlementTier, account.plan.payments.status, account.plan.payments.mode,
    offer.offerId, offer.planCode, offer.offerKind, offer.billingInterval, offer.priceMinor, offer.currency, offer.monthlyPremiumCredits]);
}
export function reviewFingerprint(account: SchoolAccount, offer: SaasPlanOffer): string {
  return JSON.stringify([offerFingerprint(account, offer), account.plan.subscription, account.plan.checkout]);
}
export function canPurchase(account: SchoolAccount, offer: SaasPlanOffer | undefined): boolean {
  return account.plan.payments.status === 'TEST_MODE' && account.plan.payments.mode === 'TEST' && !account.plan.subscription
    && !['CREATED', 'OPEN', 'PAID_NEEDS_REVIEW'].includes(account.plan.checkout?.status ?? '') && !!offer
    && offer.planCode === account.plan.entitlementTier && account.plan.offers.some((o) => o.offerId === offer.offerId)
    && (offer.offerKind === 'REGULAR_MONTHLY' || offer.founderSlotsRemaining !== null && offer.founderSlotsRemaining > 0);
}
export function hostedCheckoutUrl(checkout: SaasCheckoutReceipt['checkout']): string | null {
  if (checkout.status !== 'OPEN' || checkout.mode !== 'TEST' || !checkout.providerSessionId?.startsWith('cs_test_') || !checkout.checkoutUrl) return null;
  let url: URL; try { url = new URL(checkout.checkoutUrl); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) invalid();
  // A deterministic simulator is never presented as an actual Stripe hosted session.
  if (checkout.provider === 'STRIPE_SIMULATED') { if (url.hostname !== 'checkout.simulated.invalid') invalid(); return null; }
  if (checkout.provider !== 'STRIPE' || url.hostname !== 'checkout.stripe.com') invalid();
  return url.href;
}
export async function startSchoolCheckout(account: SchoolAccount, offer: SaasPlanOffer, key: string): Promise<CheckoutResult> {
  try { saasUuid(key); saasUuid(account.context.schoolId); saasUuid(account.context.organizationId); } catch { invalid(); }
  if (account.plan.schoolId !== account.context.schoolId || !account.plan.offers.some((o) => o.offerId === offer.offerId && offerFingerprint(account, o) === offerFingerprint(account, offer))) invalid();
  const input = canonical(validateSaasSchoolCheckoutInput, { offerId: offer.offerId });
  const value = exact(await request(`/api/v1/schools/${account.context.schoolId}/hon-plan/checkout`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': SAAS_COMMANDS.startCheckout },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000),
  }), ['checkout', 'replayed', 'providerCall']);
  if (!['OPENED', 'ALREADY_OPEN', 'NOT_OPENABLE'].includes(value.providerCall as string)) invalid();
  const receipt = canonical(validateSaasCheckoutReceipt, { checkout: value.checkout, replayed: value.replayed });
  const c = receipt.checkout;
  if (c.schoolId !== account.context.schoolId || c.organizationId !== account.context.organizationId || c.requesterKind !== 'SCHOOL_OWNER'
    || c.offerId !== offer.offerId || c.planCode !== offer.planCode || c.offerKind !== offer.offerKind || c.billingInterval !== offer.billingInterval || c.amountMinor !== offer.priceMinor || c.currency !== offer.currency) invalid();
  if ((c.status === 'OPEN') !== (value.providerCall !== 'NOT_OPENABLE')) invalid();
  hostedCheckoutUrl(c);
  return { ...receipt, providerCall: value.providerCall as CheckoutResult['providerCall'] };
}
