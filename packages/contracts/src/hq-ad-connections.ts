// HQ ad account connections (migration 0677): HON's own Google Ads and Meta accounts, connected through Zernio by a
// current HQ owner (spec docs/architecture/HQ_AD_ACCOUNT_CONNECTIONS.md). Connecting only records which account HON may
// later use: nothing here publishes an ad, runs one or spends money.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const HQ_AD_PROVIDERS = ['GOOGLE_ADS', 'META_ADS'] as const;
export type HqAdProvider = typeof HQ_AD_PROVIDERS[number];
export const HQ_AD_ACCOUNT_STATUSES = ['CONNECTED', 'DISCONNECTED'] as const;
export type HqAdAccountStatus = typeof HQ_AD_ACCOUNT_STATUSES[number];
/** Human-command header values, one per command route. */
export const HQ_AD_COMMANDS = { connect: 'hq-ad-connect', complete: 'hq-ad-connect-complete', disconnect: 'hq-ad-disconnect' } as const;
/** Where Zernio sends the browser back after consent. */
export const HQ_AD_CONNECT_RETURN_PATH = '/hq/marketing/ads/return';
export const HQ_AD_STATE = /^[A-Za-z0-9_-]{43}$/;
export type HqAdProviderRemoval = 'REMOVED' | 'NOT_REMOVED' | 'NOT_ATTEMPTED';

export interface HqAdPerson { principalId: string; displayName: string }
export interface HqAdAccount {
  accountId: string; provider: HqAdProvider; displayName: string; status: HqAdAccountStatus; version: number;
  connectedBy: HqAdPerson; connectedAt: string; updatedAt: string; disconnectedAt: string | null;
}
export interface HqAdAccountList {
  profileLinked: boolean; accounts: HqAdAccount[]; viewer: HqAdPerson & { canConnect: boolean }; checkedAt: string;
  /** True only when the HQ Zernio switch is on and HON has an https public address. */
  connectEnabled: boolean;
}
export interface HqAdConnectStart { authUrl: string; provider: HqAdProvider; expiresAt: string }
export interface HqAdConnectResult { provider: HqAdProvider; connected: number; conflicts: number; accounts: HqAdAccount[] }
export interface HqAdDisconnectReceipt { account: HqAdAccount; providerRemoval: HqAdProviderRemoval; replayed: boolean }

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

// ---------- inputs ----------
export function validateHqAdConnectInput(value: unknown): { provider: HqAdProvider } {
  const r = record(value, invalid); exactKeys(r, ['provider'], invalid);
  if (!has(HQ_AD_PROVIDERS, r.provider)) invalid();
  return { provider: r.provider as HqAdProvider };
}
export function validateHqAdConnectCompleteInput(value: unknown): { state: string } {
  const r = record(value, invalid); exactKeys(r, ['state'], invalid);
  if (typeof r.state !== 'string' || !HQ_AD_STATE.test(r.state)) invalid();
  return { state: r.state };
}
export function validateHqAdDisconnectInput(value: unknown): { expectedVersion: number } {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion'], invalid);
  if (!isInt(r.expectedVersion, 1, 999_999_999)) invalid();
  return { expectedVersion: r.expectedVersion as number };
}

// ---------- responses ----------
function person(value: unknown): HqAdPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return { principalId: p.principalId, displayName: p.displayName };
}
export function verifyHqAdAccount(value: unknown): HqAdAccount {
  const a = record(value, drift);
  exactKeys(a, ['accountId', 'provider', 'displayName', 'status', 'version', 'connectedBy', 'connectedAt', 'updatedAt', 'disconnectedAt'], drift);
  if (!isUuid(a.accountId) || !has(HQ_AD_PROVIDERS, a.provider) || !label(a.displayName, 120) || CONTROL.test(a.displayName as string)
    || !has(HQ_AD_ACCOUNT_STATUSES, a.status) || !isInt(a.version, 1, 999_999_999) || !isTimestamp(a.connectedAt) || !isTimestamp(a.updatedAt)
    || (a.disconnectedAt !== null && !isTimestamp(a.disconnectedAt)) || (a.status === 'DISCONNECTED') !== (a.disconnectedAt !== null)) drift();
  return { accountId: a.accountId as string, provider: a.provider as HqAdProvider, displayName: a.displayName as string, status: a.status as HqAdAccountStatus,
    version: a.version as number, connectedBy: person(a.connectedBy), connectedAt: a.connectedAt as string, updatedAt: a.updatedAt as string,
    disconnectedAt: a.disconnectedAt as string | null };
}
function accounts(value: unknown): HqAdAccount[] {
  if (!Array.isArray(value) || value.length > 500) drift();
  return value.map(verifyHqAdAccount);
}
export function verifyHqAdAccountList(value: unknown): HqAdAccountList {
  const v = record(value, drift); exactKeys(v, ['profileLinked', 'accounts', 'viewer', 'checkedAt', 'connectEnabled'], drift);
  const viewer = record(v.viewer, drift); exactKeys(viewer, ['principalId', 'displayName', 'canConnect'], drift);
  if (typeof v.profileLinked !== 'boolean' || typeof v.connectEnabled !== 'boolean' || !isTimestamp(v.checkedAt) || typeof viewer.canConnect !== 'boolean') drift();
  return { profileLinked: v.profileLinked as boolean, accounts: accounts(v.accounts),
    viewer: { ...person({ principalId: viewer.principalId, displayName: viewer.displayName }), canConnect: viewer.canConnect as boolean },
    checkedAt: v.checkedAt as string, connectEnabled: v.connectEnabled as boolean };
}
export function verifyHqAdConnectStart(value: unknown): HqAdConnectStart {
  const v = record(value, drift); exactKeys(v, ['authUrl', 'provider', 'expiresAt'], drift);
  if (typeof v.authUrl !== 'string' || v.authUrl.length > 4096 || !has(HQ_AD_PROVIDERS, v.provider) || !isTimestamp(v.expiresAt)) drift();
  // The API has already checked the host; here only the shape (an absolute http(s) address, no spaces).
  if (!/^https?:\/\/[^\s]+$/.test(v.authUrl as string)) drift();
  return { authUrl: v.authUrl as string, provider: v.provider as HqAdProvider, expiresAt: v.expiresAt as string };
}
export function verifyHqAdConnectResult(value: unknown): HqAdConnectResult {
  const v = record(value, drift); exactKeys(v, ['provider', 'connected', 'conflicts', 'accounts'], drift);
  if (!has(HQ_AD_PROVIDERS, v.provider) || !isInt(v.connected, 0, 25) || !isInt(v.conflicts, 0, 25)) drift();
  return { provider: v.provider as HqAdProvider, connected: v.connected as number, conflicts: v.conflicts as number, accounts: accounts(v.accounts) };
}
export function verifyHqAdDisconnectReceipt(value: unknown): HqAdDisconnectReceipt {
  const v = record(value, drift); exactKeys(v, ['account', 'providerRemoval', 'replayed'], drift);
  if (!has(['REMOVED', 'NOT_REMOVED', 'NOT_ATTEMPTED'], v.providerRemoval) || typeof v.replayed !== 'boolean') drift();
  const account = verifyHqAdAccount(v.account);
  if (account.status !== 'DISCONNECTED') drift();
  return { account, providerRemoval: v.providerRemoval as HqAdProviderRemoval, replayed: v.replayed as boolean };
}
