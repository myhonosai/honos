// School social connections (0347, docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4): each school connects its own
// Facebook Page and Instagram professional account through Zernio. Each account has three switches (publishing, inbox,
// ads), all off when connected. Connecting needs HON_ZERNIO_CONNECT_APPROVED on the API server; nothing here posts,
// sends or spends.

export const SOCIAL_PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const;
export const SOCIAL_ACCOUNT_STATUSES = ['CONNECTED', 'DISCONNECTED'] as const;
export const SOCIAL_CONNECT_COMMAND = 'marketing.social.connect';
export const SOCIAL_CONNECT_COMPLETE_COMMAND = 'marketing.social.connect.complete';
export const SOCIAL_ACCOUNT_CHANGE_COMMAND = 'marketing.social.account.change';
export const SOCIAL_READ_COMMAND = 'marketing.social.read';
/** The page Zernio sends the browser back to, on HON's own public origin. Fixed, never taken from a request. */
export const SOCIAL_CONNECT_RETURN_PATH = '/staff/marketing/social/return';
/** 32 random bytes, base64url without padding. */
export const SOCIAL_CONNECT_STATE = /^[A-Za-z0-9_-]{43}$/;

export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];
export type SocialAccountStatus = typeof SOCIAL_ACCOUNT_STATUSES[number];
export type SocialProviderRemoval = 'REMOVED' | 'NOT_REMOVED' | 'NOT_ATTEMPTED';
export interface SocialAccount {
  accountId: string; platform: SocialPlatform; displayName: string; status: SocialAccountStatus;
  publishEnabled: boolean; inboxEnabled: boolean; adsEnabled: boolean; version: number;
  connectedAt: string; updatedAt: string; disconnectedAt: string | null;
}
export interface SocialAccountList { profileLinked: boolean; connectEnabled: boolean; accounts: SocialAccount[]; checkedAt: string }
export interface SocialConnectStart { authUrl: string; platform: SocialPlatform; expiresAt: string }
export interface SocialConnectResult { platform: SocialPlatform; connected: number; conflicts: number; accounts: SocialAccount[] }
export interface SocialConnectInput { platform: SocialPlatform }
export interface SocialConnectCompleteInput { state: string }
export type SocialAccountChangeInput =
  | { expectedVersion: number; publishEnabled: boolean; inboxEnabled: boolean; adsEnabled: boolean }
  | { expectedVersion: number; disconnect: true };
export interface SocialAccountChange { account: SocialAccount; providerRemoval: SocialProviderRemoval }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
function fail(what: string): never { throw new Error(`Unverified school social ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return o;
}
function time(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what);
  return v;
}
function count(v: unknown, what: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 25) fail(what);
  return v as number;
}

export function verifySocialAccount(v: unknown): SocialAccount {
  const o = record(v, ['accountId', 'platform', 'displayName', 'status', 'publishEnabled', 'inboxEnabled', 'adsEnabled', 'version', 'connectedAt', 'updatedAt', 'disconnectedAt'], 'account');
  if (typeof o.accountId !== 'string' || !UUID.test(o.accountId) || !SOCIAL_PLATFORMS.includes(o.platform as SocialPlatform)
    || typeof o.displayName !== 'string' || o.displayName.length < 1 || o.displayName.length > 120 || CONTROL.test(o.displayName)
    || !SOCIAL_ACCOUNT_STATUSES.includes(o.status as SocialAccountStatus)
    || typeof o.publishEnabled !== 'boolean' || typeof o.inboxEnabled !== 'boolean' || typeof o.adsEnabled !== 'boolean'
    || !Number.isSafeInteger(o.version) || (o.version as number) < 1) fail('account');
  const disconnectedAt = time(o.disconnectedAt, 'account', true);
  // A disconnected account never has a switch on, and only a disconnected account has a disconnect time.
  if ((o.status === 'DISCONNECTED') !== (disconnectedAt !== null)
    || (o.status === 'DISCONNECTED' && (o.publishEnabled || o.inboxEnabled || o.adsEnabled))) fail('account');
  return {
    accountId: o.accountId, platform: o.platform as SocialPlatform, displayName: o.displayName, status: o.status as SocialAccountStatus,
    publishEnabled: o.publishEnabled, inboxEnabled: o.inboxEnabled, adsEnabled: o.adsEnabled, version: o.version as number,
    connectedAt: time(o.connectedAt, 'account')!, updatedAt: time(o.updatedAt, 'account')!, disconnectedAt,
  };
}
function accounts(v: unknown): SocialAccount[] {
  if (!Array.isArray(v) || v.length > 200) fail('account list');
  return v.map(verifySocialAccount);
}
export function verifySocialAccountList(v: unknown): SocialAccountList {
  const o = record(v, ['profileLinked', 'connectEnabled', 'accounts', 'checkedAt'], 'account list');
  if (typeof o.profileLinked !== 'boolean' || typeof o.connectEnabled !== 'boolean') fail('account list');
  return { profileLinked: o.profileLinked, connectEnabled: o.connectEnabled, accounts: accounts(o.accounts), checkedAt: time(o.checkedAt, 'account list')! };
}
export function verifySocialConnectStart(v: unknown): SocialConnectStart {
  const o = record(v, ['authUrl', 'platform', 'expiresAt'], 'connect start');
  // https only; plain http is accepted solely for a loopback development return page (the fake provider).
  if (typeof o.authUrl !== 'string' || o.authUrl.length > 4096 || !(o.authUrl.startsWith('https://') || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(o.authUrl))
    || !SOCIAL_PLATFORMS.includes(o.platform as SocialPlatform)) fail('connect start');
  return { authUrl: o.authUrl, platform: o.platform as SocialPlatform, expiresAt: time(o.expiresAt, 'connect start')! };
}
export function verifySocialConnectResult(v: unknown): SocialConnectResult {
  const o = record(v, ['platform', 'connected', 'conflicts', 'accounts'], 'connect result');
  if (!SOCIAL_PLATFORMS.includes(o.platform as SocialPlatform)) fail('connect result');
  return { platform: o.platform as SocialPlatform, connected: count(o.connected, 'connect result'), conflicts: count(o.conflicts, 'connect result'), accounts: accounts(o.accounts) };
}
export function verifySocialAccountChange(v: unknown): SocialAccountChange {
  const o = record(v, ['account', 'providerRemoval'], 'account change');
  if (!['REMOVED', 'NOT_REMOVED', 'NOT_ATTEMPTED'].includes(o.providerRemoval as string)) fail('account change');
  return { account: verifySocialAccount(o.account), providerRemoval: o.providerRemoval as SocialProviderRemoval };
}

export function validateSocialConnectInput(v: unknown): SocialConnectInput {
  const o = record(v, ['platform'], 'connect input');
  if (!SOCIAL_PLATFORMS.includes(o.platform as SocialPlatform)) fail('connect input');
  return { platform: o.platform as SocialPlatform };
}
export function validateSocialConnectCompleteInput(v: unknown): SocialConnectCompleteInput {
  const o = record(v, ['state'], 'connect complete input');
  if (typeof o.state !== 'string' || !SOCIAL_CONNECT_STATE.test(o.state)) fail('connect complete input');
  return { state: o.state };
}
export function validateSocialAccountChangeInput(v: unknown): SocialAccountChangeInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('account change input');
  const version = (v as Record<string, unknown>).expectedVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 999_999_999) fail('account change input');
  if (Object.hasOwn(v, 'disconnect')) {
    const o = record(v, ['expectedVersion', 'disconnect'], 'account change input');
    if (o.disconnect !== true) fail('account change input');
    return { expectedVersion: version as number, disconnect: true };
  }
  const o = record(v, ['expectedVersion', 'publishEnabled', 'inboxEnabled', 'adsEnabled'], 'account change input');
  if (typeof o.publishEnabled !== 'boolean' || typeof o.inboxEnabled !== 'boolean' || typeof o.adsEnabled !== 'boolean') fail('account change input');
  return { expectedVersion: version as number, publishEnabled: o.publishEnabled, inboxEnabled: o.inboxEnabled, adsEnabled: o.adsEnabled };
}
