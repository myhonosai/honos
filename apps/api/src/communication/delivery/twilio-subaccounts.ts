import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * T1 (0351, docs/architecture/SCHOOL_OWN_SENDERS.md §4): each school's texting lives on its own Twilio subaccount
 * under HON's parent account. HON acts on a subaccount with the parent credentials; the subaccount's own auth token is
 * needed only to check webhook signatures, so it is kept sealed in the database and opened only in API memory.
 */
export const TWILIO_SUBACCOUNT_DIRECTORY = Symbol('TWILIO_SUBACCOUNT_DIRECTORY');

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[a-z0-9-]{1,40}$/;
const TOKEN = /^[\x21-\x7e]{1,256}$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

export interface TwilioSubaccountCredential { accountSid: string; authToken: string }
export interface TwilioSubaccountBinding { schoolId: string; accountSid: string }

function refuse(): never { throw new Error('TWILIO_SUBACCOUNT_VAULT_REFUSED'); }
function bindingOk(binding: TwilioSubaccountBinding): boolean {
  return UUID.test(binding.schoolId.toLowerCase()) && ACCOUNT_SID.test(binding.accountSid);
}
function aad(binding: TwilioSubaccountBinding, keyId: string): Buffer {
  return Buffer.from(`hon-twilio-subaccount:v1:${keyId}:${binding.schoolId.toLowerCase()}:${binding.accountSid}`, 'utf8');
}

/** AES-256-GCM with a fresh IV per seal; key id, school and account SID are authenticated, so a moved token never opens. */
export class TwilioSubaccountVault {
  constructor(private readonly key: Buffer, readonly keyId: string) {
    if (key.length !== 32 || !KEY_ID.test(keyId)) refuse();
  }

  seal(binding: TwilioSubaccountBinding, authToken: string): string {
    if (!bindingOk(binding) || typeof authToken !== 'string' || !TOKEN.test(authToken)) refuse();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(binding, this.keyId));
    const body = Buffer.concat([cipher.update(authToken, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  open(binding: TwilioSubaccountBinding, keyId: string, sealed: string): string {
    const parts = typeof sealed === 'string' && sealed.length <= 1024 ? SEALED.exec(sealed) : null;
    if (keyId !== this.keyId || !parts || !bindingOk(binding)) refuse();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1]!, 'base64url'));
      decipher.setAAD(aad(binding, keyId));
      decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
      const token = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
      if (!TOKEN.test(token)) refuse();
      return token;
    } catch { return refuse(); }
  }
}

/** Same key as the school payment vault (HON_SCHOOL_PAY_VAULT_KEY), with its own authenticated label. */
export function twilioSubaccountVaultFromEnvironment(env: NodeJS.ProcessEnv = process.env): TwilioSubaccountVault | null {
  const encoded = env.HON_SCHOOL_PAY_VAULT_KEY ?? '';
  const keyId = env.HON_SCHOOL_PAY_VAULT_KEY_ID ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || !KEY_ID.test(keyId)) return null;
  return new TwilioSubaccountVault(Buffer.from(encoded, 'base64'), keyId);
}

/** Worker-database reads (0351 definer functions); the API never reads the table. */
export interface TwilioSubaccountStore {
  isConfigured(): boolean;
  readTwilioWebhookAccount?(accountSid: string): Promise<{ schoolId: string; organizationId: string; sealedAuthToken: string; vaultKeyId: string } | null>;
  readTwilioSendAccount?(schoolId: string, serviceSid: string): Promise<{ accountSid: string; status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' } | null>;
  twilioNumberInAccount?(accountSid: string, phoneE164: string): Promise<boolean>;
  beginSchoolTwilioAccount?(schoolId: string, leaseSeconds: number):
    Promise<{ state: 'ACTIVE'; accountSid: string } | { state: 'CLAIMED'; claimToken: string } | { state: 'BUSY' }>;
  completeSchoolTwilioAccount?(schoolId: string, claimToken: string, accountSid: string, sealedAuthToken: string, vaultKeyId: string):
    Promise<{ accountSid: string }>;
}

/** What the webhook controller and the text adapter need to know about subaccounts. */
export interface TwilioSubaccountDirectory {
  /** The ACTIVE subaccount's token and school, or null (unknown, not ACTIVE, or the sealed token does not open). */
  webhookCredential(accountSid: string): Promise<(TwilioSubaccountCredential & { schoolId: string }) | null>;
  /** The subaccount the school's Messaging Service lives on, or null when it is on the parent account (0248 hand-entered). */
  sendAccount(schoolId: string, serviceSid: string): Promise<{ accountSid: string; status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' } | null>;
  /** True when the number is a sender of that subaccount's school, on that subaccount. */
  numberInAccount(accountSid: string, phoneE164: string): Promise<boolean>;
}

export class WorkerTwilioSubaccountDirectory implements TwilioSubaccountDirectory {
  constructor(private readonly store: TwilioSubaccountStore, private readonly vault: () => TwilioSubaccountVault | null = () => twilioSubaccountVaultFromEnvironment()) {}

  private require<K extends keyof TwilioSubaccountStore>(name: K): NonNullable<TwilioSubaccountStore[K]> {
    const fn = this.store[name];
    if (!this.store.isConfigured() || typeof fn !== 'function') throw new Error('TWILIO_SUBACCOUNT_STORE_NOT_CONFIGURED');
    return (fn as (...args: unknown[]) => unknown).bind(this.store) as NonNullable<TwilioSubaccountStore[K]>;
  }

  async webhookCredential(accountSid: string) {
    if (!ACCOUNT_SID.test(accountSid)) return null;
    const row = await this.require('readTwilioWebhookAccount')(accountSid);
    const vault = this.vault();
    if (!row || !vault) return null;
    try {
      return { accountSid, authToken: vault.open({ schoolId: row.schoolId, accountSid }, row.vaultKeyId, row.sealedAuthToken), schoolId: row.schoolId };
    } catch { return null; }
  }

  async sendAccount(schoolId: string, serviceSid: string) {
    if (!SERVICE_SID.test(serviceSid) || !UUID.test(schoolId.toLowerCase())) return null;
    return this.require('readTwilioSendAccount')(schoolId, serviceSid);
  }

  async numberInAccount(accountSid: string, phoneE164: string) {
    if (!ACCOUNT_SID.test(accountSid) || !E164.test(phoneE164)) return false;
    return this.require('twilioNumberInAccount')(accountSid, phoneE164);
  }
}

/** RETRYABLE: Twilio certainly did nothing. FAILED: refused. UNKNOWN: it may have acted; resolve by reading, never redo. */
export class TwilioProvisioningError extends Error {
  constructor(readonly outcome: 'RETRYABLE' | 'FAILED' | 'UNKNOWN', readonly code = 'TWILIO_PROVISIONING_FAILED') { super(`${outcome}:${code}`); }
}

export interface TwilioProvisioningClient {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  findSubaccount(friendlyName: string): Promise<TwilioSubaccountCredential | null>;
  createSubaccount(friendlyName: string): Promise<TwilioSubaccountCredential>;
}

/** The subaccount's Twilio name: HON's school id only, never the school's or owner's name. */
export function subaccountFriendlyName(schoolId: string): string {
  if (!UUID.test(schoolId)) throw new Error('INVALID_SCHOOL_ID');
  return `hon-school-${schoolId}`;
}

/**
 * Real Twilio Accounts API. READY only with the parent TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN AND
 * HON_TWILIO_PROVISIONING_APPROVED exactly 'true' (off in every environment until the owner turns it on).
 */
export class TwilioRestProvisioningClient implements TwilioProvisioningClient {
  constructor(private readonly environment: () => Record<string, string | undefined> = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') && env.TWILIO_AUTH_TOKEN?.trim() && env.HON_TWILIO_PROVISIONING_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  private auth(): string {
    if (this.readiness() !== 'READY') throw new TwilioProvisioningError('RETRYABLE', 'PROVISIONING_NOT_READY');
    const env = this.environment();
    return `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`;
  }

  private static credential(value: unknown): TwilioSubaccountCredential | null {
    const row = value as { sid?: unknown; auth_token?: unknown } | null;
    return row && typeof row.sid === 'string' && ACCOUNT_SID.test(row.sid) && typeof row.auth_token === 'string' && TOKEN.test(row.auth_token)
      ? { accountSid: row.sid, authToken: row.auth_token } : null;
  }

  async findSubaccount(friendlyName: string): Promise<TwilioSubaccountCredential | null> {
    const authorization = this.auth();
    const query = new URLSearchParams({ FriendlyName: friendlyName, Status: 'active' });
    let response: Response;
    try {
      response = await this.transport(`https://api.twilio.com/2010-04-01/Accounts.json?${query.toString()}`, {
        method: 'GET', headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_UNREACHABLE'); }
    if (response.status !== 200) throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED');
    let body: { accounts?: unknown };
    try { body = await response.json() as typeof body; } catch { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED'); }
    const found = (Array.isArray(body.accounts) ? body.accounts : []).map(TwilioRestProvisioningClient.credential).filter(Boolean);
    // Two active subaccounts with one school's name would mean a duplicate was made: stop for an operator.
    if (found.length > 1) throw new TwilioProvisioningError('FAILED', 'DUPLICATE_SUBACCOUNT');
    return found[0] ?? null;
  }

  async createSubaccount(friendlyName: string): Promise<TwilioSubaccountCredential> {
    const authorization = this.auth();
    let response: Response;
    try {
      response = await this.transport('https://api.twilio.com/2010-04-01/Accounts.json', {
        method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ FriendlyName: friendlyName }).toString(), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new TwilioProvisioningError('UNKNOWN'); }
    if (response.status === 201 || response.status === 200) {
      let body: unknown;
      try { body = await response.json(); } catch { throw new TwilioProvisioningError('UNKNOWN'); }
      const credential = TwilioRestProvisioningClient.credential(body);
      if (!credential) throw new TwilioProvisioningError('UNKNOWN');
      return credential;
    }
    if (response.status === 429 || response.status === 401 || response.status === 403) throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED');
    if (response.status >= 400 && response.status < 500) throw new TwilioProvisioningError('FAILED', 'PROVIDER_REJECTED');
    throw new TwilioProvisioningError('UNKNOWN');
  }
}

/**
 * Deterministic fake for tests and local environments: SIDs and tokens derive from the friendly name. Refused in
 * production and staging deployments. `loseNextCreate` creates the account but loses the response (UNKNOWN).
 */
export class FakeTwilioProvisioningClient implements TwilioProvisioningClient {
  readonly created: string[] = [];
  private lose: boolean;
  constructor(options: { loseNextCreate?: boolean } = {}, env: NodeJS.ProcessEnv = process.env) {
    const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
    if (deployment === 'production' || deployment === 'staging' || (deployment === undefined && env.NODE_ENV === 'production')) {
      throw new Error('FAKE_TWILIO_PROVISIONING_REFUSED');
    }
    this.lose = Boolean(options.loseNextCreate);
  }
  readiness() { return 'READY' as const; }
  private static sidOf(name: string) { return `AC${createHash('sha256').update(`sid:${name}`).digest('hex').slice(0, 32)}`; }
  tokenOf(accountSid: string) { return createHash('sha256').update(`token:${accountSid}`).digest('hex').slice(0, 32); }
  async findSubaccount(friendlyName: string) {
    const sid = FakeTwilioProvisioningClient.sidOf(friendlyName);
    return this.created.includes(sid) ? { accountSid: sid, authToken: this.tokenOf(sid) } : null;
  }
  async createSubaccount(friendlyName: string) {
    const sid = FakeTwilioProvisioningClient.sidOf(friendlyName);
    this.created.push(sid);
    if (this.lose) { this.lose = false; throw new TwilioProvisioningError('UNKNOWN'); }
    return { accountSid: sid, authToken: this.tokenOf(sid) };
  }
}

export const SUBACCOUNT_CLAIM_SECONDS = 300;

/**
 * One subaccount per school. A database claim (lease) keeps two workers from creating at once; Twilio is always asked
 * first for an account with the school's name, so a create whose response was lost is found, never made twice.
 */
export class SchoolTwilioAccounts {
  constructor(private readonly store: TwilioSubaccountStore, private readonly client: TwilioProvisioningClient,
    private readonly vault: TwilioSubaccountVault | null) {}

  async ensure(schoolId: string): Promise<{ outcome: 'ACTIVE'; accountSid: string } | { outcome: 'BUSY' } | { outcome: 'NOT_READY' }> {
    const name = subaccountFriendlyName(schoolId);
    if (this.client.readiness() !== 'READY' || !this.vault || !this.store.isConfigured()
      || !this.store.beginSchoolTwilioAccount || !this.store.completeSchoolTwilioAccount) return { outcome: 'NOT_READY' };
    const claim = await this.store.beginSchoolTwilioAccount(schoolId, SUBACCOUNT_CLAIM_SECONDS);
    if (claim.state === 'ACTIVE') return { outcome: 'ACTIVE', accountSid: claim.accountSid };
    if (claim.state === 'BUSY') return { outcome: 'BUSY' };
    const account = await this.client.findSubaccount(name) ?? await this.client.createSubaccount(name);
    const sealed = this.vault.seal({ schoolId, accountSid: account.accountSid }, account.authToken);
    const done = await this.store.completeSchoolTwilioAccount(schoolId, claim.claimToken, account.accountSid, sealed, this.vault.keyId);
    return { outcome: 'ACTIVE', accountSid: done.accountSid };
  }
}
