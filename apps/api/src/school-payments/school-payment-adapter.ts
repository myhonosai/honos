import { createHash } from 'node:crypto';
import {
  NO_SCHOOL_PAY_CAPABILITIES,
  SCHOOL_PAY_PROVIDER_CODES,
  verifySchoolPayObservation,
  type SchoolPayCapabilities,
  type SchoolPayObservation,
  type SchoolPayProviderCode,
} from '@hon/contracts';
import type { SchoolPayCredential } from './school-payment-vault.js';
import { schoolPaymentVaultFromEnvironment } from './school-payment-vault.js';
import { SquareSandboxAdapter, StripeConnectTestAdapter } from './school-payment-sandbox-adapters.js';

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
  /** OAUTH_TOKENS: the provider gives per-school tokens that HON keeps sealed in the 0320 vault. NONE: the platform key is enough. */
  readonly credentialKind: 'NONE' | 'OAUTH_TOKENS';
  readiness(): 'READY' | 'NOT_CONFIGURED';
  /** A hosted onboarding (Stripe Account Link) or authorization (Square OAuth) URL that returns to `returnUrl` with `state`. */
  beginOnboarding(input: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }): Promise<{ onboardingUrl: string; accountRef: string | null }>;
  /** After the school returns: the provider account the school authorized (Square exchanges the authorization code). */
  completeOnboarding(input: { connectionId: string; accountRef: string | null; authorizationCode?: string }): Promise<{ accountRef: string; credential?: SchoolPayCredential }>;
  /** Authenticated retrieval of the account's status. Never derived from a browser return. */
  retrieveStatus(input: { accountRef: string; credential?: SchoolPayCredential }): Promise<SchoolPayObservation>;
  /** OAUTH_TOKENS providers: whether the access token should be renewed before use, and the renewal. */
  needsRenewal?(credential: SchoolPayCredential): boolean;
  renewCredential?(input: { accountRef: string; credential: SchoolPayCredential }): Promise<SchoolPayCredential>;
  /** Revoke HON's access to the school's account; the school's own account and objects stay. */
  disconnect(input: { accountRef: string }): Promise<void>;
}

/** PRE_SEND: nothing reached the provider. FAILED: the provider refused. UNKNOWN: it may have acted. */
export class SchoolPaymentProviderError extends Error {
  constructor(readonly outcome: 'PRE_SEND' | 'FAILED' | 'UNKNOWN',
    readonly reason: 'NOT_CONFIGURED' | 'LIVE_MODE_REFUSED' | 'INVALID_REQUEST' | 'PROVIDER_REJECTED' | 'PROVIDER_UNKNOWN' | 'REVOKE_NOT_SUPPORTED'
      /** The school withdrew HON's access (a renewal answered 401 or invalid_grant): record reauthorization required. */
      | 'GRANT_REVOKED') { super(reason); }
}

export const SCHOOL_PAYMENT_ADAPTERS = Symbol('SCHOOL_PAYMENT_ADAPTERS');

/** Every call refused before sending: the provider has no test credentials in this environment. */
export class UnconfiguredSchoolPaymentAdapter implements SchoolPaymentAdapter {
  readonly manifest = NO_SCHOOL_PAY_CAPABILITIES;
  readonly credentialKind = 'NONE' as const;
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
  abstract readonly credentialKind: 'NONE' | 'OAUTH_TOKENS';
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
  abstract completeOnboarding(input: { connectionId: string; accountRef: string | null; authorizationCode?: string }): Promise<{ accountRef: string; credential?: SchoolPayCredential }>;
  async retrieveStatus({ accountRef }: { accountRef: string; credential?: SchoolPayCredential }): Promise<SchoolPayObservation> {
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
  readonly credentialKind = 'NONE' as const;
  async beginOnboarding({ connectionId, accountRef, state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    const account = accountRef ?? this.ref('acct_sim', connectionId);
    return { onboardingUrl: this.returnTo(returnUrl, state), accountRef: account };
  }
  async completeOnboarding({ accountRef, authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (!accountRef || authorizationCode !== undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    return { accountRef };
  }
}

/**
 * Square (sandbox): OAuth code flow; the merchant is known only after the code exchange. Cards only for recurring. Like
 * the real sandbox it hands back synthetic per-school tokens (30-day access token), which HON seals in the vault.
 */
export class SimulatedSquareAdapter extends SimulatedSchoolPaymentAdapter {
  readonly providerCode = 'SQUARE' as const;
  readonly manifest: SchoolPayCapabilities = Object.freeze({ ...ALL, bankDebit: false });
  readonly credentialKind = 'OAUTH_TOKENS' as const;
  /** Access tokens seen by status calls and renewals (the proof checks the vault round trip with them). */
  readonly seenTokens: string[] = [];
  renewals = 0;
  now: () => Date = () => new Date();
  private token(kind: string, connectionId: string): string { return `sim${kind}_${createHash('sha256').update(`${kind}:${connectionId}:${this.renewals}`).digest('hex').slice(0, 24)}`; }
  needsRenewal(credential: SchoolPayCredential): boolean { return new Date(credential.accessExpiresAt).getTime() - this.now().getTime() < 7 * 86_400_000; }
  async renewCredential({ credential }: { accountRef: string; credential: SchoolPayCredential }): Promise<SchoolPayCredential> {
    this.renewals += 1;
    return { accessToken: this.token('acc', credential.refreshToken), refreshToken: credential.refreshToken, accessExpiresAt: new Date(this.now().getTime() + 30 * 86_400_000).toISOString() };
  }
  override async retrieveStatus(input: { accountRef: string; credential?: SchoolPayCredential }): Promise<SchoolPayObservation> {
    if (!input.credential) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    this.seenTokens.push(input.credential.accessToken);
    return super.retrieveStatus(input);
  }
  async beginOnboarding({ connectionId, state, returnUrl }: { connectionId: string; accountRef: string | null; state: string; returnUrl: string }) {
    return { onboardingUrl: this.returnTo(returnUrl, state, { code: `sim_${connectionId.replaceAll('-', '')}` }), accountRef: null };
  }
  async completeOnboarding({ connectionId, authorizationCode }: { connectionId: string; accountRef: string | null; authorizationCode?: string }) {
    if (authorizationCode === undefined) throw new SchoolPaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    if (authorizationCode !== `sim_${connectionId.replaceAll('-', '')}`) throw new SchoolPaymentProviderError('FAILED', 'PROVIDER_REJECTED');
    return { accountRef: this.ref('MLSIM', connectionId), credential: { accessToken: this.token('acc', connectionId), refreshToken: this.token('ref', connectionId),
      accessExpiresAt: new Date(this.now().getTime() + 30 * 86_400_000).toISOString() } };
  }
}

/**
 * The adapters for this process. HON_SCHOOL_PAY_SIMULATORS=1 (never in production) keeps the in-process simulators.
 * Otherwise a provider gets its real TEST/SANDBOX adapter only when its separate tuition credentials are present and
 * valid (a live key is refused) and, for token providers, the vault key is set; else it stays NOT_CONFIGURED.
 * HON's SaaS Stripe key is never read here.
 */
export function schoolPaymentAdaptersFromEnvironment(env: NodeJS.ProcessEnv = process.env): Map<SchoolPayProviderCode, SchoolPaymentAdapter> {
  const simulate = env.HON_SCHOOL_PAY_SIMULATORS === '1' && env.NODE_ENV !== 'production';
  const real = (code: SchoolPayProviderCode): SchoolPaymentAdapter => {
    try {
      if (code === 'STRIPE_CONNECT' && env.HON_TUITION_STRIPE_TEST_SECRET_KEY) return new StripeConnectTestAdapter(env.HON_TUITION_STRIPE_TEST_SECRET_KEY);
      if (code === 'SQUARE' && env.HON_TUITION_SQUARE_SANDBOX_APP_ID && env.HON_TUITION_SQUARE_SANDBOX_APP_SECRET && schoolPaymentVaultFromEnvironment(env)) {
        return new SquareSandboxAdapter(env.HON_TUITION_SQUARE_SANDBOX_APP_ID, env.HON_TUITION_SQUARE_SANDBOX_APP_SECRET);
      }
    } catch { /* a live or malformed credential: not configured */ }
    return new UnconfiguredSchoolPaymentAdapter(code);
  };
  return new Map<SchoolPayProviderCode, SchoolPaymentAdapter>(SCHOOL_PAY_PROVIDER_CODES.map(code => [code,
    !simulate ? real(code) : code === 'STRIPE_CONNECT' ? new SimulatedStripeConnectAdapter() : new SimulatedSquareAdapter()]));
}
