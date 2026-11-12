import { createHash } from 'node:crypto';
import {
  NO_SCHOOL_PAY_CAPABILITIES,
  SCHOOL_PAY_PROVIDER_CODES,
  verifySchoolPayObservation,
  type SchoolPayCapabilities,
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
}

/** PRE_SEND: nothing reached the provider. FAILED: the provider refused. UNKNOWN: it may have acted. */
export class SchoolPaymentProviderError extends Error {
  constructor(readonly outcome: 'PRE_SEND' | 'FAILED' | 'UNKNOWN',
    readonly reason: 'NOT_CONFIGURED' | 'LIVE_MODE_REFUSED' | 'INVALID_REQUEST' | 'PROVIDER_REJECTED' | 'PROVIDER_UNKNOWN') { super(reason); }
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
}

const ALL: SchoolPayCapabilities = Object.freeze({ bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true });

export interface SimulatedAccountStatus { chargesEnabled: boolean; payoutsEnabled: boolean; requirementsDue: boolean; reauthorizationRequired: boolean }

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
}

/** Stripe Connect (test mode): the connected account exists before onboarding, like Accounts + Account Links. */
export class SimulatedStripeConnectAdapter extends SimulatedSchoolPaymentAdapter {
  readonly providerCode = 'STRIPE_CONNECT' as const;
  readonly manifest = ALL;
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
