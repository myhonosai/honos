import { createHash } from 'node:crypto';
import {
  NO_SCHOOL_PAY_CAPABILITIES,
  SCHOOL_PAY_PROVIDER_CODES,
  verifySchoolPayMethodObservation,
  verifySchoolPayObservation,
  type SchoolPayCapabilities,
  type SchoolPayMethodKind,
  type SchoolPayMethodObservation,
  type SchoolPayObservation,
  type SchoolPayProviderCode,
} from '@hon/contracts';

/**
 * B-TUI-2 provider seam for SCHOOL payments (tuition), separate from the SaaS PAYMENT_PROVIDER_ADAPTER: HON's own money
 * never uses these adapters and these adapters never touch HON's SaaS account, keys or webhooks. Every provider-specific
 * call lives behind this interface, so HON's own processor later is one more adapter. TEST/SANDBOX MODE ONLY. HON takes
 * no fee on any school payment, so no adapter ever sends an application fee.
 */
export interface SchoolPaymentAdapter {
  readonly providerCode: SchoolPayProviderCode;
  /** What the adapter can do at all; the provider's own status narrows it per connection. */
  readonly manifest: SchoolPayCapabilities;
  readiness(): 'READY' | 'NOT_CONFIGURED';
  /** A hosted onboarding (Stripe Account Link) or authorization (Square OAuth) URL that returns to `returnUrl` with `state`. */
  beginOnboarding(input: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }): Promise<{ onboardingUrl: string; accountRef: string | null }>;
  /** After the school returns: the provider account the school authorized (Square exchanges the authorization code). */
  completeOnboarding(input: { connectionId: string; accountRef: string | null; authorizationCode?: string }): Promise<{ accountRef: string }>;
  /** Authenticated retrieval of the account's status. Never derived from a browser return. */
  retrieveStatus(input: { accountRef: string }): Promise<SchoolPayObservation>;
  /** Revoke HON's access to the school's account; the school's own account and objects stay. */
  disconnect(input: { accountRef: string }): Promise<void>;
  /** 0290: the payer's customer on the school's account (created once; an existing reference is returned as is). */
  ensureCustomer(input: { accountRef: string; billingAccountId: string; customerRef: string | null }): Promise<{ customerRef: string }>;
  /**
   * 0290: a hosted page where the payer enters a card or bank account (Stripe SetupIntent / Checkout setup mode, Square Web
   * Payments SDK card on file) that returns to `returnUrl` with `state`. The card number never reaches HON.
   */
  beginMethodSetup(input: { accountRef: string; customerRef: string; setupId: string; methodKinds: readonly SchoolPayMethodKind[]; state: string; returnUrl: string }): Promise<{ setupRef: string; setupUrl: string }>;
  /** 0290: authenticated retrieval of the saved method of one setup; never derived from a browser return. */
  retrieveMethodSetup(input: { accountRef: string; customerRef: string; setupRef: string }): Promise<SchoolPayMethodObservation>;
  /** 0290: detach a removed method from the payer's customer at the provider. */
  detachMethod(input: { accountRef: string; methodRef: string }): Promise<void>;
}

/** PRE_SEND: nothing reached the provider. FAILED: the provider refused. UNKNOWN: it may have acted. */
export class SchoolPaymentProviderError extends Error {
  constructor(readonly outcome: 'PRE_SEND' | 'FAILED' | 'UNKNOWN',
    readonly reason: 'NOT_CONFIGURED' | 'LIVE_MODE_REFUSED' | 'INVALID_REQUEST' | 'PROVIDER_REJECTED' | 'PROVIDER_UNKNOWN' | 'SETUP_INCOMPLETE') { super(reason); }
}

export const SCHOOL_PAYMENT_ADAPTERS = Symbol('SCHOOL_PAYMENT_ADAPTERS');

/** Every call refused before sending: the provider has no test credentials in this environment. */
export class UnconfiguredSchoolPaymentAdapter implements SchoolPaymentAdapter {
  readonly manifest = NO_SCHOOL_PAY_CAPABILITIES;
  constructor(readonly providerCode: SchoolPayProviderCode) {}
  readiness(): 'NOT_CONFIGURED' { return 'NOT_CONFIGURED'; }
  async beginOnboarding(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async completeOnboarding(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async retrieveStatus(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async disconnect(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async ensureCustomer(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async beginMethodSetup(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async retrieveMethodSetup(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
  async detachMethod(): Promise<never> { throw new SchoolPaymentProviderError('PRE_SEND', 'NOT_CONFIGURED'); }
}

const ALL: SchoolPayCapabilities = Object.freeze({ bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true });

export interface SimulatedAccountStatus { chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: boolean; reauthorizationRequired: boolean }
/** What the simulated payer entered on the hosted setup page; `incomplete` means the payer left without saving. */
export interface SimulatedSetupOutcome { kind: SchoolPayMethodKind; brand: SchoolPayMethodObservation['brand']; last4: string; expMonth: number | null; expYear: number | null; incomplete: boolean; customerRef: string }

/**
 * Deterministic in-process stand-ins for the Stripe Connect test API and the Square sandbox (no network, no credentials).
 * The "hosted" page returns straight to HON. Account status can be overridden per account to exercise every state.
 */
abstract class SimulatedSchoolPaymentAdapter implements SchoolPaymentAdapter {
  abstract readonly providerCode: SchoolPayProviderCode;
  abstract readonly manifest: SchoolPayCapabilities;
  readonly statuses = new Map<string, Partial<SimulatedAccountStatus>>();
  readonly revoked = new Set<string>();
  readiness(): 'READY' { return 'READY'; }
  protected ref(prefix: string, connectionId: string): string {
    return `${prefix}${createHash('sha256').update(`${this.providerCode}:${connectionId}`).digest('hex').slice(0, 16)}`;
  }
  protected returnTo(returnUrl: string, state: string, extra: Record<string, string> = {}): string {
    const url = new URL(returnUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    url.searchParams.set('state', state);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return url.toString();
  }
  abstract beginOnboarding(input: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }): Promise<{ onboardingUrl: string; accountRef: string | null }>;
  abstract completeOnboarding(input: { connectionId: string; accountRef: string | null; authorizationCode?: string }): Promise<{ accountRef: string }>;
  async retrieveStatus({ accountRef }: { accountRef: string }): Promise<SchoolPayObservation> {
    const status = this.statuses.get(accountRef) ?? {};
    return verifySchoolPayObservation({
      accountRef,
      chargesEnabled: status.chargesEnabled ?? true,
      payoutsEnabled: status.payoutsEnabled ?? true,
      requirementsDue: status.requirementsDue ?? false,
      reauthorizationRequired: this.revoked.has(accountRef) || (status.reauthorizationRequired ?? false),
      capabilities: { ...this.manifest },
    });
  }
  async disconnect({ accountRef }: { accountRef: string }): Promise<void> { this.revoked.add(accountRef); }

  protected abstract readonly refs: { customer: string; setup: string; method: string };
  /** Per setup reference: what the payer "entered". The default is a test Visa ending 4242 (or a bank account ending 6789). */
  readonly setupOutcomes = new Map<string, Partial<SimulatedSetupOutcome>>();
  readonly setups = new Map<string, { accountRef: string; customerRef: string; methodKinds: readonly SchoolPayMethodKind[] }>();
  readonly detached = new Set<string>();
  protected hash(value: string): string { return createHash('sha256').update(`${this.providerCode}:${value}`).digest('hex').slice(0, 16); }
  async ensureCustomer({ accountRef, billingAccountId, customerRef }: { accountRef: string; billingAccountId: string; customerRef: string | null }) {
    if (this.revoked.has(accountRef)) throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED');
    return { customerRef: customerRef ?? `${this.refs.customer}${this.hash(`${accountRef}:${billingAccountId}`)}` };
  }
  async beginMethodSetup({ accountRef, customerRef, setupId, methodKinds, state, returnUrl }: { accountRef: string; customerRef: string; setupId: string; methodKinds: readonly SchoolPayMethodKind[]; state: string; returnUrl: string }) {
    if (this.revoked.has(accountRef)) throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED');
    if (methodKinds.includes('US_BANK_ACCOUNT') && !this.manifest.bankDebit) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    const setupRef = `${this.refs.setup}${this.hash(setupId)}`;
    const setupUrl = this.returnTo(returnUrl, state);
    this.setups.set(setupRef, { accountRef, customerRef, methodKinds: [...methodKinds] });
    return { setupRef, setupUrl };
  }
  async retrieveMethodSetup({ accountRef, customerRef, setupRef }: { accountRef: string; customerRef: string; setupRef: string }): Promise<SchoolPayMethodObservation> {
    const setup = this.setups.get(setupRef);
    if (!setup || setup.accountRef !== accountRef || setup.customerRef !== customerRef) throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED');
    const outcome = this.setupOutcomes.get(setupRef) ?? {};
    if (outcome.incomplete) throw new SchoolPaymentProviderError('FAILED', 'SETUP_INCOMPLETE');
    const kind = outcome.kind ?? setup.methodKinds[0] ?? 'CARD';
    const card = kind === 'CARD';
    return verifySchoolPayMethodObservation({
      customerRef: outcome.customerRef ?? customerRef, methodRef: `${this.refs.method}${this.hash(setupRef)}`, kind,
      brand: outcome.brand ?? (card ? 'VISA' : 'BANK'), last4: outcome.last4 ?? (card ? '4242' : '6789'),
      expMonth: outcome.expMonth !== undefined ? outcome.expMonth : card ? 12 : null, expYear: outcome.expYear !== undefined ? outcome.expYear : card ? 2034 : null,
    });
  }
  async detachMethod({ methodRef }: { accountRef: string; methodRef: string }): Promise<void> { this.detached.add(methodRef); }
}

/** Stripe Connect (test mode): the connected account exists before onboarding, like Accounts + Account Links. */
export class SimulatedStripeConnectAdapter extends SimulatedSchoolPaymentAdapter {
  readonly providerCode = 'STRIPE_CONNECT' as const;
  readonly manifest = ALL;
  protected readonly refs = { customer: 'cus_sim', setup: 'seti_sim', method: 'pm_sim' };
  async beginOnboarding({ connectionId, accountRef, state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    const account = accountRef ?? this.ref('acct_sim', connectionId);
    return { onboardingUrl: this.returnTo(returnUrl, state), accountRef: account };
  }
  async completeOnboarding({ accountRef, authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (!accountRef || authorizationCode !== undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    return { accountRef };
  }
}

/** Square (sandbox): OAuth code flow; the merchant is known only after the code exchange. Cards only for recurring. */
export class SimulatedSquareAdapter extends SimulatedSchoolPaymentAdapter {
  readonly providerCode = 'SQUARE' as const;
  readonly manifest: SchoolPayCapabilities = Object.freeze({ ...ALL, bankDebit: false });
  protected readonly refs = { customer: 'SQCUSTSIM', setup: 'sqsetup_sim', method: 'ccof:sim' };
  async beginOnboarding({ connectionId, state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    return { onboardingUrl: this.returnTo(returnUrl, state, { code: `sim_${connectionId.replaceAll('-', '')}` }), accountRef: null };
  }
  async completeOnboarding({ connectionId, authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (authorizationCode === undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    if (authorizationCode !== `sim_${connectionId.replaceAll('-', '')}`) throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED');
    return { accountRef: this.ref('MLSIM', connectionId) };
  }
}

/**
 * The adapters for this process. Simulators are used only when HON_SCHOOL_PAY_SIMULATORS=1 and never in production;
 * otherwise every provider is NOT_CONFIGURED until the real sandbox adapters (piece 2) and their credentials exist.
 */
export function schoolPaymentAdaptersFromEnvironment(env: NodeJS.ProcessEnv = process.env): Map<SchoolPayProviderCode, SchoolPaymentAdapter> {
  const simulate = env.HON_SCHOOL_PAY_SIMULATORS === '1' && env.NODE_ENV !== 'production';
  return new Map<SchoolPayProviderCode, SchoolPaymentAdapter>(SCHOOL_PAY_PROVIDER_CODES.map(code => [code,
    !simulate ? new UnconfiguredSchoolPaymentAdapter(code) : code === 'STRIPE_CONNECT' ? new SimulatedStripeConnectAdapter() : new SimulatedSquareAdapter()]));
}
