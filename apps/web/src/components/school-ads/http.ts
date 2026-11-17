import {
  SOCIAL_AD_CANCEL_COMMAND, SOCIAL_AD_CREATE_COMMAND, SOCIAL_AD_OPERATION_COMMAND, SOCIAL_AD_RESOLVE_COMMAND, SOCIAL_ADS_BUDGET_COMMAND,
  validateSocialAdBudgetInput, validateSocialAdCancelInput, validateSocialAdDraftInput, validateSocialAdOperationInput, validateSocialAdResolveInput,
  verifySocialAd, verifySocialAdsView, verifySocialPostList,
  type SocialAd, type SocialAdBudgetInput, type SocialAdDraftInput, type SocialAdOperationInput, type SocialAdResolveInput, type SocialAdsView, type SocialPostList,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School Meta ads (0437). Reads are plain same-origin GETs; every write sends its own X-HON-Human-Command and an
 * Idempotency-Key, so a retried request with the same key is replayed, never sent twice. The server decides the
 * permission, the cap and whether ads are turned on. Nothing here is authority.
 */
export type AdsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing changed. */ | 'DENIED'
  /** Ads from HON are not turned on yet. Nothing was created or spent. */ | 'NOT_ENABLED'
  /** No monthly limit set yet. */ | 'NO_BUDGET'
  /** Would go over the monthly limit. */ | 'OVER_CAP'
  /** Ads are off for that Facebook Page. */ | 'ADS_OFF'
  /** The post is not published on Facebook by HON. */ | 'NOT_PUBLISHED'
  /** The ad moved on or its dates passed. */ | 'STATE'
  /** Currency cannot change once ads exist. */ | 'CURRENCY_FIXED'
  /** Someone changed this first. */ | 'STALE'
  /** The ad or post is gone. */ | 'GONE'
  /** Too many attempts. */ | 'LIMIT'
  /** Not accepted as written. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class AdsError extends Error { constructor(readonly kind: AdsErrorKind, readonly code: string | null = null) { super(kind); } }
export type AdsScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function base(scope: AdsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new AdsError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/marketing/social`;
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AdsError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new AdsError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const CONFLICTS: Readonly<Record<string, AdsErrorKind>> = {
  SOCIAL_AD_NO_BUDGET: 'NO_BUDGET', SOCIAL_AD_OVER_CAP: 'OVER_CAP', SOCIAL_ADS_OFF: 'ADS_OFF', SOCIAL_AD_POST_NOT_PUBLISHED: 'NOT_PUBLISHED',
  SOCIAL_AD_STATE: 'STATE', SOCIAL_AD_CURRENCY_FIXED: 'CURRENCY_FIXED', SOCIAL_VERSION_CONFLICT: 'STALE',
  IDEMPOTENCY_KEY_REUSED: 'INVALID', IDEMPOTENCY_KEY_REQUIRED: 'INVALID',
};
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function adsErrorFor(status: number, code: string | null): AdsError {
  if (status === 403) return new AdsError('DENIED', code);
  if (status === 404) return new AdsError('GONE', code);
  if (status === 429) return new AdsError('LIMIT', code);
  if (status === 503 && code === 'SOCIAL_ADS_NOT_ENABLED') return new AdsError('NOT_ENABLED', code);
  if (status === 400) return new AdsError('INVALID', code);
  if (status === 409 && code && CONFLICTS[code]) return new AdsError(CONFLICTS[code]!, code);
  return new AdsError('UNKNOWN', code);
}
/** Only an unknown outcome may be retried, and only with the same key. */
export const keepAdsForRetry = (error: unknown) => error instanceof AdsError && error.kind === 'UNKNOWN';

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof AdsError || signal.aborted) throw error; throw new AdsError('UNKNOWN'); }
  if (answer.status !== 200) throw adsErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new AdsError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new AdsError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof AdsError) throw error; throw new AdsError('UNKNOWN'); }
  if (answer.status !== 200) throw adsErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new AdsError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new AdsError('INVALID'); } }
function adId(id: string): string { if (!UUID.test(id)) throw new AdsError('INVALID'); return id.toLowerCase(); }
const sameAd = (id: string) => (v: unknown): SocialAd => { const ad = verifySocialAd(v); if (ad.adId !== id.toLowerCase()) throw new Error('ad'); return ad; };

export const adsApi = {
  async read(scope: AdsScope, signal: AbortSignal, owned: Owned): Promise<SocialAdsView> {
    return read(`${base(scope)}/ads`, verifySocialAdsView, signal, owned);
  },
  /** Posts from the last 99 days, to find the ones HON published on Facebook. */
  async posts(scope: AdsScope, now: Date, signal: AbortSignal, owned: Owned): Promise<SocialPostList> {
    const to = new Date(now.getTime() + 86_400_000), from = new Date(now.getTime() - 99 * 86_400_000);
    return read(`${base(scope)}/posts?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`, verifySocialPostList, signal, owned);
  },
  async budget(scope: AdsScope, input: SocialAdBudgetInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAdsView> {
    return command(`${base(scope)}/ads/budget`, SOCIAL_ADS_BUDGET_COMMAND, checked(() => validateSocialAdBudgetInput(input)), key, verifySocialAdsView, signal, owned);
  },
  async draft(scope: AdsScope, input: SocialAdDraftInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAd> {
    const body = checked(() => validateSocialAdDraftInput(input));
    return command(`${base(scope)}/ads`, SOCIAL_AD_CREATE_COMMAND, body, key, (v) => { const ad = verifySocialAd(v); if (ad.targetId !== body.targetId) throw new Error('ad'); return ad; }, signal, owned);
  },
  async operation(scope: AdsScope, id: string, input: SocialAdOperationInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAd> {
    return command(`${base(scope)}/ads/${adId(id)}/operation`, SOCIAL_AD_OPERATION_COMMAND, checked(() => validateSocialAdOperationInput(input)), key, sameAd(id), signal, owned);
  },
  async cancel(scope: AdsScope, id: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAd> {
    return command(`${base(scope)}/ads/${adId(id)}/cancel`, SOCIAL_AD_CANCEL_COMMAND, checked(() => validateSocialAdCancelInput({ expectedVersion })), key, sameAd(id), signal, owned);
  },
  async resolve(scope: AdsScope, id: string, input: SocialAdResolveInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAd> {
    return command(`${base(scope)}/ads/${adId(id)}/resolve`, SOCIAL_AD_RESOLVE_COMMAND, checked(() => validateSocialAdResolveInput(input)), key, sameAd(id), signal, owned);
  },
};
export type AdsApi = typeof adsApi;

/** "25", "25.5" or "25.50" in the school's currency to cents; anything else is null. */
export function toCents(text: string): number | null {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
