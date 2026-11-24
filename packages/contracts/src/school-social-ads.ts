// School social ads (0445; Google Search ads 0453, docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4C): boost a Facebook post HON already
// published, inside the school's own monthly ad spend cap. Every ad is created PAUSED; turning it on is a separate
// human command. Creating and turning on need HON_ZERNIO_ADS_APPROVED on the API server.
export const SOCIAL_AD_STATUSES = ['DRAFT', 'CREATING', 'PAUSED', 'ACTIVATING', 'ACTIVE', 'PAUSING', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export const SOCIAL_AD_OPERATIONS = ['CREATE', 'ACTIVATE', 'PAUSE'] as const;
export const SOCIAL_AD_RESOLVE_STATES = ['NOT_CREATED', 'ACTIVE', 'PAUSED'] as const;
export const SOCIAL_AD_CAP_MAX_CENTS = 1_000_000;
export const SOCIAL_AD_MAX_DAYS = 31;
export const SOCIAL_ADS_BUDGET_COMMAND = 'marketing.social.ads.budget';
export const SOCIAL_AD_CREATE_COMMAND = 'marketing.social.ads.create';
export const SOCIAL_AD_OPERATION_COMMAND = 'marketing.social.ads.operation';
export const SOCIAL_AD_CANCEL_COMMAND = 'marketing.social.ads.cancel';
export const SOCIAL_AD_RESOLVE_COMMAND = 'marketing.social.ads.resolve';
/** 0453: draft a Google Search ad on the school's connected Google Ads account. */
export const SOCIAL_GOOGLE_AD_CREATE_COMMAND = 'marketing.social.ads.google.create';
export const SOCIAL_AD_CHANNELS = ['META_BOOST', 'GOOGLE_SEARCH'] as const;
/** Google responsive search ad limits HON enforces before anything reaches Zernio. */
export const GOOGLE_AD_LIMITS = { headlines: [3, 15, 30], descriptions: [2, 4, 90], keywords: [1, 20, 80] } as const;
/** Owner decision 2026-11-17: every ad (Google and Meta) reaches people within this many miles of the school's street address. */
export const SOCIAL_AD_RADIUS_MILES = 5;

export type SocialAdStatus = typeof SOCIAL_AD_STATUSES[number];
export type SocialAdOperation = typeof SOCIAL_AD_OPERATIONS[number];
export type SocialAdResolveState = typeof SOCIAL_AD_RESOLVE_STATES[number];
export type SocialAdChannel = typeof SOCIAL_AD_CHANNELS[number];
export interface GoogleAdContent { headlines: string[]; descriptions: string[]; finalUrl: string; keywords: string[] }
/** Where an ad is shown: a radius around the school's saved street address (hon.school_locations). */
export interface SocialAdLocation {
  addressLine1: string; addressLine2: string | null; city: string; region: string | null; postalCode: string | null; country: string;
  radiusMiles: typeof SOCIAL_AD_RADIUS_MILES;
}
export interface SocialAdBudget { monthlyCapCents: number; currency: string; version: number }
export interface SocialAd {
  adId: string; channel: SocialAdChannel; accountId: string;
  /** A Meta boost's post target and post; null for a Google ad. */
  targetId: string | null; postId: string | null; accountName: string; budgetCents: number; currency: string;
  startsOn: string; endsOn: string; status: SocialAdStatus; operation: SocialAdOperation | null; resolvedByPerson: boolean; createdAt: string; version: number;
  /** The school's own Google ad text; null for a Meta boost. */
  google: GoogleAdContent | null;
}
export interface SocialAdsView {
  budget: SocialAdBudget | null; committedThisMonthCents: number; ads: SocialAd[]; today: string; checkedAt: string; adsEnabled: boolean;
  /** True when PAUSE can reach Zernio. Pausing never needs the ads switch, so this can be true while adsEnabled is false. */
  pauseEnabled: boolean;
}
export interface SocialAdBudgetInput { monthlyCapCents: number; currency: string; expectedVersion?: number }
export interface SocialAdDraftInput { targetId: string; budgetCents: number; startsOn: string; endsOn: string }
export interface SocialGoogleAdDraftInput extends GoogleAdContent { accountId: string; budgetCents: number; startsOn: string; endsOn: string }
export interface SocialAdOperationInput { operation: SocialAdOperation; expectedVersion: number }
export interface SocialAdCancelInput { expectedVersion: number }
export interface SocialAdResolveInput { state: SocialAdResolveState; expectedVersion: number }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
function fail(what: string): never { throw new Error(`Unverified school social ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>, present = Object.keys(o);
  if (keys.some(k => !present.includes(k)) || present.some(k => !keys.includes(k) && !optional.includes(k))) fail(what);
  return o;
}
function id(v: unknown, what: string): string { if (typeof v !== 'string' || !UUID.test(v)) fail(what); return v.toLowerCase(); }
function int(v: unknown, what: string, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(what);
  return v as number;
}
function day(v: unknown, what: string): string {
  if (typeof v !== 'string' || !DAY.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) fail(what);
  return v;
}
function currency(v: unknown, what: string): string { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) fail(what); return v; }
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
const URL_OK = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(\/[!-~]*)?$/;
const KEYWORD_BAD = /[\][!@%^*()={};~<>?|"]/;
/** Same rules as the database: min..max distinct (ignoring case) trimmed one-line texts of 1..len characters. */
function texts(v: unknown, [min, max, len]: readonly [number, number, number], what: string, keyword = false): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(what);
  const out = v.map((t) => {
    if (typeof t !== 'string' || [...t].length < 1 || [...t].length > len || t.trim() !== t || CONTROL.test(t) || (keyword && KEYWORD_BAD.test(t))) fail(what);
    return t;
  });
  if (new Set(out.map(t => t.toLowerCase())).size !== out.length) fail(what);
  return out;
}
function googleContent(v: unknown, what: string): GoogleAdContent {
  const o = record(v, ['headlines', 'descriptions', 'finalUrl', 'keywords'], what);
  if (typeof o.finalUrl !== 'string' || o.finalUrl.length > 2000 || !URL_OK.test(o.finalUrl)) fail(what);
  return { headlines: texts(o.headlines, GOOGLE_AD_LIMITS.headlines, what), descriptions: texts(o.descriptions, GOOGLE_AD_LIMITS.descriptions, what),
    finalUrl: o.finalUrl, keywords: texts(o.keywords, GOOGLE_AD_LIMITS.keywords, what, true) };
}

export function verifySocialAd(v: unknown): SocialAd {
  const o = record(v, ['adId', 'channel', 'accountId', 'targetId', 'postId', 'accountName', 'budgetCents', 'currency', 'startsOn', 'endsOn', 'status', 'operation',
    'resolvedByPerson', 'createdAt', 'version', 'google'], 'ad');
  // A Meta boost has a post and no Google text; a Google ad has Google text and no post.
  if (!SOCIAL_AD_CHANNELS.includes(o.channel as SocialAdChannel)
    || (o.channel === 'META_BOOST' ? o.targetId === null || o.postId === null || o.google !== null : o.targetId !== null || o.postId !== null || o.google === null)) fail('ad');
  if (!SOCIAL_AD_STATUSES.includes(o.status as SocialAdStatus) || (o.operation !== null && !SOCIAL_AD_OPERATIONS.includes(o.operation as SocialAdOperation))
    || typeof o.resolvedByPerson !== 'boolean' || typeof o.accountName !== 'string' || o.accountName.length < 1 || o.accountName.length > 120 || CONTROL.test(o.accountName)
    || typeof o.createdAt !== 'string' || !ISO.test(o.createdAt)) fail('ad');
  const startsOn = day(o.startsOn, 'ad'), endsOn = day(o.endsOn, 'ad');
  if (days(startsOn, endsOn) < 0 || days(startsOn, endsOn) > SOCIAL_AD_MAX_DAYS - 1) fail('ad');
  // A draft has no operation yet; everything that reached Zernio has one.
  if ((o.status === 'DRAFT') !== (o.operation === null) && o.status !== 'CANCELLED') fail('ad');
  return { adId: id(o.adId, 'ad'), channel: o.channel as SocialAdChannel, accountId: id(o.accountId, 'ad'),
    targetId: o.targetId === null ? null : id(o.targetId, 'ad'), postId: o.postId === null ? null : id(o.postId, 'ad'), accountName: o.accountName,
    budgetCents: int(o.budgetCents, 'ad', 100, SOCIAL_AD_CAP_MAX_CENTS), currency: currency(o.currency, 'ad'), startsOn, endsOn, status: o.status as SocialAdStatus,
    operation: o.operation as SocialAdOperation | null, resolvedByPerson: o.resolvedByPerson, createdAt: o.createdAt, version: int(o.version, 'ad', 1, 999_999_999),
    google: o.google === null ? null : googleContent(o.google, 'ad') };
}
export function verifySocialAdsView(v: unknown): SocialAdsView {
  const o = record(v, ['budget', 'committedThisMonthCents', 'ads', 'today', 'checkedAt', 'adsEnabled', 'pauseEnabled'], 'ads');
  let budget: SocialAdBudget | null = null;
  if (o.budget !== null) {
    const b = record(o.budget, ['monthlyCapCents', 'currency', 'version'], 'ad budget');
    budget = { monthlyCapCents: int(b.monthlyCapCents, 'ad budget', 0, SOCIAL_AD_CAP_MAX_CENTS), currency: currency(b.currency, 'ad budget'), version: int(b.version, 'ad budget', 1, 999_999_999) };
  }
  if (!Array.isArray(o.ads) || o.ads.length > 100 || typeof o.adsEnabled !== 'boolean' || typeof o.pauseEnabled !== 'boolean' || (o.adsEnabled === true && o.pauseEnabled !== true) || typeof o.checkedAt !== 'string' || !ISO.test(o.checkedAt)) fail('ads');
  return { budget, committedThisMonthCents: int(o.committedThisMonthCents, 'ads', 0, Number.MAX_SAFE_INTEGER), ads: o.ads.map(verifySocialAd), today: day(o.today, 'ads'),
    checkedAt: o.checkedAt, adsEnabled: o.adsEnabled, pauseEnabled: o.pauseEnabled };
}

export function validateSocialAdBudgetInput(v: unknown): SocialAdBudgetInput {
  const o = record(v, ['monthlyCapCents', 'currency'], 'ad budget input', ['expectedVersion']);
  const out: SocialAdBudgetInput = { monthlyCapCents: int(o.monthlyCapCents, 'ad budget input', 0, SOCIAL_AD_CAP_MAX_CENTS), currency: currency(o.currency, 'ad budget input') };
  if ('expectedVersion' in o) out.expectedVersion = int(o.expectedVersion, 'ad budget input', 1, 999_999_999);
  return out;
}
export function validateSocialAdDraftInput(v: unknown): SocialAdDraftInput {
  const o = record(v, ['targetId', 'budgetCents', 'startsOn', 'endsOn'], 'ad input');
  const startsOn = day(o.startsOn, 'ad input'), endsOn = day(o.endsOn, 'ad input');
  if (days(startsOn, endsOn) < 0 || days(startsOn, endsOn) > SOCIAL_AD_MAX_DAYS - 1) fail('ad input');
  return { targetId: id(o.targetId, 'ad input'), budgetCents: int(o.budgetCents, 'ad input', 100, SOCIAL_AD_CAP_MAX_CENTS), startsOn, endsOn };
}
/** 0453: a Google Search ad draft. At least 1.00 a day over its 1 to 31 days. */
export function validateSocialGoogleAdDraftInput(v: unknown): SocialGoogleAdDraftInput {
  const o = record(v, ['accountId', 'budgetCents', 'startsOn', 'endsOn', 'headlines', 'descriptions', 'finalUrl', 'keywords'], 'google ad input');
  const startsOn = day(o.startsOn, 'google ad input'), endsOn = day(o.endsOn, 'google ad input');
  if (days(startsOn, endsOn) < 0 || days(startsOn, endsOn) > SOCIAL_AD_MAX_DAYS - 1) fail('google ad input');
  const budgetCents = int(o.budgetCents, 'google ad input', 100, SOCIAL_AD_CAP_MAX_CENTS);
  if (budgetCents < 100 * (days(startsOn, endsOn) + 1)) fail('google ad input');
  const { headlines, descriptions, finalUrl, keywords } = googleContent({ headlines: o.headlines, descriptions: o.descriptions, finalUrl: o.finalUrl, keywords: o.keywords }, 'google ad input');
  return { accountId: id(o.accountId, 'google ad input'), budgetCents, startsOn, endsOn, headlines, descriptions, finalUrl, keywords };
}
export function validateSocialAdOperationInput(v: unknown): SocialAdOperationInput {
  const o = record(v, ['operation', 'expectedVersion'], 'ad operation input');
  if (!SOCIAL_AD_OPERATIONS.includes(o.operation as SocialAdOperation)) fail('ad operation input');
  return { operation: o.operation as SocialAdOperation, expectedVersion: int(o.expectedVersion, 'ad operation input', 1, 999_999_999) };
}
export function validateSocialAdCancelInput(v: unknown): SocialAdCancelInput {
  const o = record(v, ['expectedVersion'], 'ad cancel input');
  return { expectedVersion: int(o.expectedVersion, 'ad cancel input', 1, 999_999_999) };
}
export function validateSocialAdResolveInput(v: unknown): SocialAdResolveInput {
  const o = record(v, ['state', 'expectedVersion'], 'ad resolve input');
  if (!SOCIAL_AD_RESOLVE_STATES.includes(o.state as SocialAdResolveState)) fail('ad resolve input');
  return { state: o.state as SocialAdResolveState, expectedVersion: int(o.expectedVersion, 'ad resolve input', 1, 999_999_999) };
}
