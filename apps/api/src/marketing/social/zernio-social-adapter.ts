import { createHash } from 'node:crypto';
import type { SocialPlatform } from '@hon/contracts';

type Env = Record<string, string | undefined>;
export const ZERNIO_SOCIAL_ADAPTER = Symbol('ZERNIO_SOCIAL_ADAPTER');
const API = 'https://zernio.com/api/v1';
const KEY = /^(?:sk_|zrk_)[a-fA-F0-9]{64}$/;
const ID = /^[0-9A-Za-z_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Hosts a connect URL may point at: Zernio's own consent pages and Meta's login pages. */
const CONNECT_HOSTS = [/^(?:[a-z0-9-]+\.)*zernio\.com$/, /^(?:www\.|m\.|web\.)?facebook\.com$/, /^(?:www\.)?instagram\.com$/];

export type SocialProviderFailure = 'NOT_ENABLED' | 'REJECTED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'UNKNOWN';
export class SocialProviderError extends Error {
  constructor(readonly failure: SocialProviderFailure) { super(failure); }
}
export interface ProviderSocialAccount { providerAccountId: string; platform: SocialPlatform; displayName: string }

/**
 * The only Zernio operations S1 and S2 use. Callers pass HON's own values; nothing a browser sent reaches these methods.
 * Every method throws SocialProviderError, never a raw provider body, header or key.
 */
export interface ZernioSocialAdapter {
  readonly kind: 'ZERNIO' | 'FAKE' | 'NONE';
  /** READY only when connecting is approved (or the fake runs outside production). */
  ready(): boolean;
  /** The profile named `name`, created only if none exists, so a retry after an unknown answer makes no second one. */
  findOrCreateProfile(name: string): Promise<string>;
  /** The consent URL for one platform on one profile. Checked: https on an allowed host. */
  connectUrl(input: { profileId: string; platform: SocialPlatform; redirectUrl: string; state: string }): Promise<string>;
  /** Accounts connected on one profile. Provider order and extra fields are dropped. */
  listAccounts(profileId: string): Promise<ProviderSocialAccount[]>;
  removeAccount(providerAccountId: string): Promise<void>;
  /** S2: READY only when publishing is approved (or the fake runs outside production). */
  publishReady(): boolean;
  /**
   * S2: publish one text post now to one connected account. `idempotencyKey` is HON's target id. Resolves with the
   * provider post id; a lost or unclear answer throws UNKNOWN (the caller never sends it again).
   */
  publishPost(input: PublishPostInput): Promise<{ providerPostId: string }>;
}
export interface PublishPostInput { profileId: string | null; providerAccountId: string; platform: SocialPlatform; text: string; linkUrl: string | null; idempotencyKey: string }
const POST_ID = /^[0-9A-Za-z_:.-]{1,128}$/;

export function zernioConnectApproved(env: Env): boolean {
  return KEY.test(env.ZERNIO_API_KEY ?? '') && env.HON_ZERNIO_CONNECT_APPROVED === 'true';
}
export function zernioPublishApproved(env: Env): boolean {
  return KEY.test(env.ZERNIO_API_KEY ?? '') && env.HON_ZERNIO_PUBLISH_APPROVED === 'true';
}
/** The deterministic fake runs only with HON_ZERNIO_FAKE_PROVIDER=1 outside production and staging. */
export function zernioFakeEnabled(env: Env): boolean {
  if (env.HON_ZERNIO_FAKE_PROVIDER !== '1') return false;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  if (deployment === 'production' || deployment === 'staging') return false;
  return !(deployment === undefined && env.NODE_ENV === 'production');
}

/** True when the URL is https on an allowed consent host (or, for the fake, exactly HON's own return page). */
export function allowedConnectUrl(value: string, fakeReturn?: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || value.length > 4096) return false;
  if (fakeReturn !== undefined) {
    const expected = new URL(fakeReturn);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  }
  return url.protocol === 'https:' && !url.port && CONNECT_HOSTS.some(host => host.test(url.hostname));
}

function displayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean.length ? clean : null;
}
function platformOf(value: unknown): SocialPlatform | null {
  return value === 'facebook' ? 'FACEBOOK' : value === 'instagram' ? 'INSTAGRAM' : null;
}

/**
 * Zernio over HTTPS. The endpoint paths and field names are the build-time assumptions listed in
 * SOCIAL_POSTING_INBOX_ADS.md §5 and must be confirmed against Zernio's docs before HON_ZERNIO_CONNECT_APPROVED is set.
 */
export class ZernioHttpSocialAdapter implements ZernioSocialAdapter {
  readonly kind = 'ZERNIO' as const;
  constructor(private readonly environment: () => Env = () => process.env,
    private readonly send: typeof fetch = (...args) => fetch(...args)) {}

  ready(): boolean { return zernioConnectApproved(this.environment()); }
  publishReady(): boolean { return zernioPublishApproved(this.environment()); }

  async publishPost(input: PublishPostInput): Promise<{ providerPostId: string }> {
    if (!this.publishReady()) throw new SocialProviderError('NOT_ENABLED');
    if (!ID.test(input.providerAccountId) || input.platform !== 'FACEBOOK') throw new SocialProviderError('REJECTED');
    const content = input.linkUrl ? `${input.text}\n\n${input.linkUrl}` : input.text;
    const answer = await this.call('POST', '/posts', {
      content, publishNow: true, platforms: [{ platform: 'facebook', accountId: input.providerAccountId }],
    }, 'publish', input.idempotencyKey);
    const post = ((answer as { post?: unknown })?.post ?? answer) as Record<string, unknown> | null;
    const id = post && typeof post === 'object' ? (post._id ?? post.id) : undefined;
    if (typeof id !== 'string' || !POST_ID.test(id)) throw new SocialProviderError('UNKNOWN');
    return { providerPostId: id };
  }

  async findOrCreateProfile(name: string): Promise<string> {
    const listed = await this.call('GET', '/profiles');
    const profiles = Array.isArray(listed) ? listed : Array.isArray((listed as { profiles?: unknown })?.profiles) ? (listed as { profiles: unknown[] }).profiles : null;
    if (!profiles) throw new SocialProviderError('UNKNOWN');
    const matches = profiles.filter(p => p && typeof p === 'object' && (p as Record<string, unknown>).name === name);
    if (matches.length > 1) throw new SocialProviderError('UNKNOWN');
    const existing = matches[0] as Record<string, unknown> | undefined;
    const id = (value: unknown) => {
      const raw = value && typeof value === 'object' ? ((value as Record<string, unknown>)._id ?? (value as Record<string, unknown>).id) : undefined;
      if (typeof raw !== 'string' || !ID.test(raw)) throw new SocialProviderError('UNKNOWN');
      return raw;
    };
    if (existing) return id(existing);
    const created = await this.call('POST', '/profiles', { name, description: 'HON OS school profile' });
    return id((created as { profile?: unknown })?.profile ?? created);
  }

  async connectUrl(input: { profileId: string; platform: SocialPlatform; redirectUrl: string; state: string }): Promise<string> {
    const query = new URLSearchParams({ profileId: input.profileId, redirect_url: input.redirectUrl, state: input.state });
    const answer = await this.call('GET', `/connect/${input.platform === 'FACEBOOK' ? 'facebook' : 'instagram'}?${query}`);
    const url = (answer as { authUrl?: unknown })?.authUrl;
    if (typeof url !== 'string' || !allowedConnectUrl(url)) throw new SocialProviderError('UNKNOWN');
    return url;
  }

  async listAccounts(profileId: string): Promise<ProviderSocialAccount[]> {
    const answer = await this.call('GET', `/accounts?${new URLSearchParams({ profileId })}`);
    const list = Array.isArray(answer) ? answer : (answer as { accounts?: unknown })?.accounts;
    if (!Array.isArray(list)) throw new SocialProviderError('UNKNOWN');
    const out: ProviderSocialAccount[] = [];
    let owned = 0;
    for (const item of list.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      const owner = typeof a.profileId === 'string' ? a.profileId : (a.profileId as { _id?: unknown } | null | undefined)?._id;
      if (typeof owner === 'string') owned += 1;
      // Fail closed: only an account that names exactly this profile is the school's. A missing owner could be an
      // account another school connected at Zernio and has not recorded yet, so it is never taken.
      const platform = platformOf(a.platform), rawId = a._id ?? a.id, name = displayName(a.displayName ?? a.name ?? a.username);
      if (owner !== profileId || !platform || typeof rawId !== 'string' || !ID.test(rawId) || !name) continue;
      out.push({ providerAccountId: rawId, platform, displayName: name });
    }
    // An answer whose accounts carry no owner at all means the assumed shape is wrong: unknown, never "no accounts".
    if (list.length > 0 && owned === 0) throw new SocialProviderError('UNKNOWN');
    return out;
  }

  async removeAccount(providerAccountId: string): Promise<void> {
    if (!ID.test(providerAccountId)) throw new SocialProviderError('UNKNOWN');
    await this.call('DELETE', `/accounts/${providerAccountId}`);
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, purpose: 'connect' | 'publish' = 'connect', idempotencyKey?: string): Promise<unknown> {
    const env = this.environment(), key = env.ZERNIO_API_KEY;
    if (!(purpose === 'publish' ? this.publishReady() : this.ready()) || !key) throw new SocialProviderError('NOT_ENABLED');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await this.send(API + path, { method, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new SocialProviderError('REJECTED');
        if (response.status === 429) throw new SocialProviderError('RATE_LIMITED');
        if (purpose === 'publish' && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409) throw new SocialProviderError('REJECTED');
        // A 5xx on a write may still have happened: the caller treats it as unknown, never as "nothing happened".
        throw new SocialProviderError(method === 'GET' ? 'UNAVAILABLE' : 'UNKNOWN');
      }
      if (response.status === 204) return null;
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new SocialProviderError('UNKNOWN'); }
      const reader = response.body?.getReader();
      if (!reader) throw new SocialProviderError('UNKNOWN');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 262_144) { await reader.cancel(); throw new SocialProviderError('UNKNOWN'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof SocialProviderError) throw error;
      throw new SocialProviderError('UNKNOWN'); // Never pass on provider bodies, headers, the key or raw errors.
    } finally { clearTimeout(timer); }
  }
}

/**
 * Deterministic stand-in for tests and local fixtures. Connecting a platform on a profile "connects" one synthetic
 * account whose id is derived from the profile, so the same school always gets the same account back. The consent URL
 * goes straight to HON's own return page with the state.
 */
export class FakeZernioSocialAdapter implements ZernioSocialAdapter {
  readonly kind = 'FAKE' as const;
  readonly profiles = new Map<string, string>();
  readonly connected = new Map<string, ProviderSocialAccount[]>();
  readonly removed: string[] = [];
  /** Test hooks: make the next call of a method fail. */
  failNext: Partial<Record<'findOrCreateProfile' | 'connectUrl' | 'listAccounts' | 'removeAccount' | 'publishPost', SocialProviderFailure>> = {};
  /** Every publish the fake accepted, in order (HON's target id -> the fake post id). */
  readonly published: { idempotencyKey: string; providerAccountId: string; text: string; linkUrl: string | null; providerPostId: string }[] = [];
  /** Extra accounts a test wants a profile to report (for example an account another school holds). */
  extra = new Map<string, ProviderSocialAccount[]>();
  constructor(private readonly environment: () => Env = () => process.env) {}

  ready(): boolean { return zernioFakeEnabled(this.environment()); }

  private check(method: keyof FakeZernioSocialAdapter['failNext']): void {
    if (!this.ready()) throw new SocialProviderError('NOT_ENABLED');
    const failure = this.failNext[method];
    if (failure) { delete this.failNext[method]; throw new SocialProviderError(failure); }
  }
  async findOrCreateProfile(name: string): Promise<string> {
    this.check('findOrCreateProfile');
    let id = this.profiles.get(name);
    if (!id) { id = 'fakeprofile_' + createHash('sha256').update(name).digest('hex').slice(0, 24); this.profiles.set(name, id); }
    return id;
  }
  async connectUrl(input: { profileId: string; platform: SocialPlatform; redirectUrl: string; state: string }): Promise<string> {
    this.check('connectUrl');
    const suffix = createHash('sha256').update(input.profileId + ':' + input.platform).digest('hex').slice(0, 20);
    const account: ProviderSocialAccount = { providerAccountId: (input.platform === 'FACEBOOK' ? 'fbpage_' : 'igbiz_') + suffix, platform: input.platform,
      displayName: input.platform === 'FACEBOOK' ? 'Synthetic Dojo Page' : 'synthetic.dojo' };
    const list = (this.connected.get(input.profileId) ?? []).filter(a => a.providerAccountId !== account.providerAccountId);
    this.connected.set(input.profileId, [...list, account]);
    return `${input.redirectUrl}?${new URLSearchParams({ state: input.state, connected: input.platform.toLowerCase() })}`;
  }
  async listAccounts(profileId: string): Promise<ProviderSocialAccount[]> {
    this.check('listAccounts');
    return [...(this.connected.get(profileId) ?? []), ...(this.extra.get(profileId) ?? [])];
  }
  publishReady(): boolean { return this.ready(); }
  async publishPost(input: PublishPostInput): Promise<{ providerPostId: string }> {
    this.check('publishPost');
    if (input.platform !== 'FACEBOOK') throw new SocialProviderError('REJECTED');
    // Same key, same post: a fake retry never makes a second post (HON itself never retries).
    const prior = this.published.find(p => p.idempotencyKey === input.idempotencyKey);
    if (prior) return { providerPostId: prior.providerPostId };
    const providerPostId = 'fakepost_' + createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24);
    this.published.push({ idempotencyKey: input.idempotencyKey, providerAccountId: input.providerAccountId, text: input.text, linkUrl: input.linkUrl, providerPostId });
    return { providerPostId };
  }
  async removeAccount(providerAccountId: string): Promise<void> {
    this.check('removeAccount');
    this.removed.push(providerAccountId);
    for (const [profile, list] of this.connected) this.connected.set(profile, list.filter(a => a.providerAccountId !== providerAccountId));
  }
}

/** Chooses the real adapter when connecting or publishing is approved, else the fake when allowed, else none (never ready). */
export function zernioSocialAdapterFactory(env: Env = process.env): ZernioSocialAdapter {
  if (zernioConnectApproved(env) || zernioPublishApproved(env)) return new ZernioHttpSocialAdapter();
  if (zernioFakeEnabled(env)) return new FakeZernioSocialAdapter();
  return { kind: 'NONE', ready: () => false, publishReady: () => false,
    publishPost: () => Promise.reject(new SocialProviderError('NOT_ENABLED')),
    findOrCreateProfile: () => Promise.reject(new SocialProviderError('NOT_ENABLED')),
    connectUrl: () => Promise.reject(new SocialProviderError('NOT_ENABLED')),
    listAccounts: () => Promise.reject(new SocialProviderError('NOT_ENABLED')),
    removeAccount: () => Promise.reject(new SocialProviderError('NOT_ENABLED')) };
}
