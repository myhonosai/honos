// HQ plan promotions (migration 0308). An HQ owner writes a short in-app promotion that links to one offer of the published
// HON OS offer set, picks which schools see it and when, previews the exact wording and reach, and starts it by echoing the
// preview digest. School staff with billing.hon.purchase at a targeted school see it while it is live, the offer is on sale
// and the school may buy it now; they can mark it seen, opened or dismissed. A promotion never sets a price, starts a
// checkout, switches a plan, gives credit or sends an email or text.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const HQ_PLAN_PROMOTION_AUDIENCES = ['ALL_SCHOOLS','MONTHLY_PLAN','ANNUAL_PLAN','TRIAL','NO_PLAN','SELECTED_SCHOOLS'] as const;
export const HQ_PLAN_PROMOTION_STATUSES = ['DRAFT','ACTIVE','PAUSED','ENDED'] as const;
export const HQ_PLAN_PROMOTION_LIST_FILTERS = ['OPEN', ...HQ_PLAN_PROMOTION_STATUSES] as const;
export const SCHOOL_PLAN_PROMOTION_EVENT_KINDS = ['SEEN','OPENED','DISMISSED'] as const;
export type HqPlanPromotionAudience = typeof HQ_PLAN_PROMOTION_AUDIENCES[number];
export type HqPlanPromotionStatus = typeof HQ_PLAN_PROMOTION_STATUSES[number];
export type HqPlanPromotionListFilter = typeof HQ_PLAN_PROMOTION_LIST_FILTERS[number];
export type HqPlanPromotionTargetStatus = Exclude<HqPlanPromotionStatus, 'DRAFT'>;
export type SchoolPlanPromotionEventKind = typeof SCHOOL_PLAN_PROMOTION_EVENT_KINDS[number];
/** Human-command header values, one per command route. */
export const HQ_PLAN_PROMOTION_COMMANDS = { create: 'hq-plan-promotion-create', update: 'hq-plan-promotion-update',
  status: 'hq-plan-promotion-status', schoolEvent: 'school-plan-promotion-event' } as const;
export const HQ_PLAN_PROMOTION_LIMITS = { code: 40, headline: 80, body: 400, buttonLabel: 30, schools: 500, days: 90 } as const;
/** The status moves the database allows. ENDED is final. Only DRAFT -> ACTIVE needs the preview digest. */
export const HQ_PLAN_PROMOTION_TRANSITIONS: Readonly<Record<HqPlanPromotionStatus, readonly HqPlanPromotionTargetStatus[]>> = {
  DRAFT: ['ACTIVE','ENDED'], ACTIVE: ['PAUSED','ENDED'], PAUSED: ['ACTIVE','ENDED'], ENDED: [],
};
/** v1 is in-app only: no email or text is sent for a promotion. */
export const HQ_PLAN_PROMOTION_MESSAGING = 'IN_APP_ONLY' as const;

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const CONTROL = /[\u0000-\u001F\u007F]/;
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const CODE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const version = (v: unknown): number => (isInt(v, 1, 999_999_999) ? v as number : invalid());
const nullableUuid = (v: unknown) => v === null || isUuid(v);

// ---------- inputs ----------
export interface HqPlanPromotionContent {
  headline: string; body: string; buttonLabel: string; offerId: string; audience: HqPlanPromotionAudience; schoolIds: string[];
  startsAt: string; endsAt: string; marketingCampaignId: string | null;
}
export interface HqPlanPromotionCreateInput extends HqPlanPromotionContent { code: string }
export interface HqPlanPromotionUpdateInput extends HqPlanPromotionContent { expectedVersion: number }
export interface HqPlanPromotionStatusInput { expectedVersion: number; status: HqPlanPromotionTargetStatus; previewDigest: string | null }
export interface SchoolPlanPromotionEventInput { kind: SchoolPlanPromotionEventKind }
const CONTENT_KEYS = ['headline','body','buttonLabel','offerId','audience','schoolIds','startsAt','endsAt','marketingCampaignId'] as const;

function content(r: Record<string, unknown>, fail: () => never): HqPlanPromotionContent {
  const L = HQ_PLAN_PROMOTION_LIMITS;
  if (!text(r.headline, 3, L.headline) || !text(r.body, 3, L.body) || !text(r.buttonLabel, 2, L.buttonLabel) || !isUuid(r.offerId)
    || !has(HQ_PLAN_PROMOTION_AUDIENCES, r.audience) || !Array.isArray(r.schoolIds) || r.schoolIds.length > L.schools
    || !(r.schoolIds as unknown[]).every(isUuid) || !isTimestamp(r.startsAt) || !isTimestamp(r.endsAt) || !nullableUuid(r.marketingCampaignId)) fail();
  const ids = (r.schoolIds as string[]).map(s => s.toLowerCase());
  const span = Date.parse(r.endsAt as string) - Date.parse(r.startsAt as string);
  if (new Set(ids).size !== ids.length || (r.audience === 'SELECTED_SCHOOLS') !== (ids.length > 0) || span <= 0 || span > L.days * 86_400_000) fail();
  return { headline: r.headline as string, body: r.body as string, buttonLabel: r.buttonLabel as string, offerId: (r.offerId as string).toLowerCase(),
    audience: r.audience as HqPlanPromotionAudience, schoolIds: ids, startsAt: r.startsAt as string, endsAt: r.endsAt as string,
    marketingCampaignId: r.marketingCampaignId === null ? null : (r.marketingCampaignId as string).toLowerCase() };
}
export function validateHqPlanPromotionCreateInput(value: unknown): HqPlanPromotionCreateInput {
  const r = record(value, invalid); exactKeys(r, ['code', ...CONTENT_KEYS], invalid);
  if (typeof r.code !== 'string' || !CODE.test(r.code)) invalid();
  return { code: r.code as string, ...content(r, invalid) };
}
export function validateHqPlanPromotionUpdateInput(value: unknown): HqPlanPromotionUpdateInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion', ...CONTENT_KEYS], invalid);
  return { expectedVersion: version(r.expectedVersion), ...content(r, invalid) };
}
export function validateHqPlanPromotionStatusInput(value: unknown): HqPlanPromotionStatusInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion','status','previewDigest'], invalid);
  if (!has(['ACTIVE','PAUSED','ENDED'], r.status) || !(r.previewDigest === null || (typeof r.previewDigest === 'string' && DIGEST.test(r.previewDigest)))) invalid();
  if (r.status !== 'ACTIVE' && r.previewDigest !== null) invalid();
  return { expectedVersion: version(r.expectedVersion), status: r.status as HqPlanPromotionTargetStatus, previewDigest: r.previewDigest as string | null };
}
export function validateSchoolPlanPromotionEventInput(value: unknown): SchoolPlanPromotionEventInput {
  const r = record(value, invalid); exactKeys(r, ['kind'], invalid);
  if (!has(SCHOOL_PLAN_PROMOTION_EVENT_KINDS, r.kind)) invalid();
  return { kind: r.kind as SchoolPlanPromotionEventKind };
}

// ---------- list query ----------
export interface HqPlanPromotionCursor { createdAt: string; promotionId: string }
export interface HqPlanPromotionListQuery { status: HqPlanPromotionListFilter | null; cursor: HqPlanPromotionCursor | null; limit: number }
export function encodeHqPlanPromotionCursor(c: HqPlanPromotionCursor): string { return `${c.createdAt}~${c.promotionId}`; }
export function validateHqPlanPromotionListQuery(value: unknown): HqPlanPromotionListQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status','cursor','limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(HQ_PLAN_PROMOTION_LIST_FILTERS, status)) || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: HqPlanPromotionCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [createdAt, promotionId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(createdAt) || !isUuid(promotionId)) invalid();
    decoded = { createdAt: createdAt as string, promotionId: (promotionId as string).toLowerCase() };
  }
  return { status: status as HqPlanPromotionListFilter | null, cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

// ---------- responses ----------
export interface HqPlanPromotionPerson { principalId: string; displayName: string }
export interface HqPlanPromotionViewer extends HqPlanPromotionPerson { canManage: boolean }
export interface HqPlanPromotionOffer {
  offerId: string; offerCode: string; offerKind: string; billingInterval: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME'; displayName: string;
  priceMinor: number; currency: 'USD'; offerSetVersion: number; onSale: boolean;
}
export interface HqPlanPromotion extends HqPlanPromotionContent {
  promotionId: string; code: string; offer: HqPlanPromotionOffer; status: HqPlanPromotionStatus; live: boolean;
  approvedDigest: string | null; firstStartedAt: string | null; createdBy: HqPlanPromotionPerson; createdAt: string; updatedAt: string; version: number;
}
export interface HqPlanPromotionReach {
  seenSchools: number; openedSchools: number; dismissedSchools: number; purchaseStartedSchools: number; countsAre: 'RECORDED_EVENTS_NOT_ESTIMATES';
}
export interface HqPlanPromotionPreview { digest: string; offerOnSale: boolean; audienceSchools: number; eligibleSchools: number; asOf: string }
export interface HqPlanPromotionListItem extends HqPlanPromotion { reach: HqPlanPromotionReach }
export interface HqPlanPromotionList {
  promotions: HqPlanPromotionListItem[]; limit: number; nextCursor: HqPlanPromotionCursor | null; offers: HqPlanPromotionOffer[];
  viewer: HqPlanPromotionViewer; messaging: typeof HQ_PLAN_PROMOTION_MESSAGING; asOf: string;
}
export interface HqPlanPromotionSnapshot extends Omit<HqPlanPromotionContent, never> { status: HqPlanPromotionStatus }
export interface HqPlanPromotionVersion { version: number; kind: 'CREATED' | 'UPDATED' | 'STATUS'; actor: HqPlanPromotionPerson; snapshot: HqPlanPromotionSnapshot; recordedAt: string }
export interface HqPlanPromotionDetail {
  promotion: HqPlanPromotion; preview: HqPlanPromotionPreview; reach: HqPlanPromotionReach; versions: HqPlanPromotionVersion[];
  viewer: HqPlanPromotionViewer; asOf: string;
}
export interface HqPlanPromotionReceipt { operation: 'CREATE' | 'UPDATE' | 'STATUS'; promotion: HqPlanPromotion; replayed: boolean }
export interface SchoolPlanPromotionOffer {
  offerId: string; offerCode: string; offerKind: string; billingInterval: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME'; displayName: string; priceMinor: number; currency: 'USD';
}
export interface SchoolPlanPromotion { promotionId: string; headline: string; body: string; buttonLabel: string; offer: SchoolPlanPromotionOffer; endsAt: string; dismissed: boolean }
export interface SchoolPlanPromotions { schoolId: string; promotions: SchoolPlanPromotion[]; asOf: string }
export interface SchoolPlanPromotionEventReceipt { promotionId: string; kind: SchoolPlanPromotionEventKind; recorded: boolean }

const COUNT_MAX = 100_000_000;
const INTERVALS = ['MONTHLY','ANNUAL','ONE_TIME'];
function person(value: unknown): HqPlanPromotionPerson {
  const p = record(value, drift); exactKeys(p, ['principalId','displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return p as unknown as HqPlanPromotionPerson;
}
function viewer(value: unknown): HqPlanPromotionViewer {
  const v = record(value, drift); exactKeys(v, ['principalId','displayName','canManage'], drift);
  if (!isUuid(v.principalId) || !label(v.displayName, 120) || typeof v.canManage !== 'boolean') drift();
  return v as unknown as HqPlanPromotionViewer;
}
function schoolOffer(o: Record<string, unknown>): void {
  if (!isUuid(o.offerId) || !label(o.offerCode, 48) || !label(o.offerKind, 40) || !has(INTERVALS, o.billingInterval) || !label(o.displayName, 80)
    || !isInt(o.priceMinor, 100, 10_000_000) || o.currency !== 'USD') drift();
}
function offer(value: unknown): HqPlanPromotionOffer {
  const o = record(value, drift);
  exactKeys(o, ['offerId','offerCode','offerKind','billingInterval','displayName','priceMinor','currency','offerSetVersion','onSale'], drift);
  schoolOffer(o); if (!isInt(o.offerSetVersion, 1, 999_999_999) || typeof o.onSale !== 'boolean') drift();
  return o as unknown as HqPlanPromotionOffer;
}
function snapshot(value: unknown): HqPlanPromotionSnapshot {
  const s = record(value, drift); exactKeys(s, [...CONTENT_KEYS, 'status'], drift);
  if (!has(HQ_PLAN_PROMOTION_STATUSES, s.status)) drift();
  content(s, drift);
  return s as unknown as HqPlanPromotionSnapshot;
}
function promotion(value: unknown, extra: readonly string[] = []): HqPlanPromotion {
  const p = record(value, drift);
  exactKeys(p, ['promotionId','code', ...CONTENT_KEYS.filter(k => k !== 'offerId'), 'offer','status','live','approvedDigest','firstStartedAt',
    'createdBy','createdAt','updatedAt','version', ...extra], drift);
  if (!isUuid(p.promotionId) || typeof p.code !== 'string' || !CODE.test(p.code) || !has(HQ_PLAN_PROMOTION_STATUSES, p.status) || typeof p.live !== 'boolean'
    || !(p.approvedDigest === null || (typeof p.approvedDigest === 'string' && DIGEST.test(p.approvedDigest)))
    || (p.approvedDigest === null) !== (p.firstStartedAt === null) || (p.firstStartedAt !== null && !isTimestamp(p.firstStartedAt))
    || (p.live && p.status !== 'ACTIVE') || (p.status === 'DRAFT' && p.approvedDigest !== null)
    || !isTimestamp(p.createdAt) || !isTimestamp(p.updatedAt) || Date.parse(p.updatedAt as string) < Date.parse(p.createdAt as string)
    || !isInt(p.version, 1, 999_999_999)) drift();
  const o = offer(p.offer); content({ ...p, offerId: o.offerId }, drift); person(p.createdBy);
  return p as unknown as HqPlanPromotion;
}
function reach(value: unknown): HqPlanPromotionReach {
  const r = record(value, drift); exactKeys(r, ['seenSchools','openedSchools','dismissedSchools','purchaseStartedSchools','countsAre'], drift);
  if (['seenSchools','openedSchools','dismissedSchools','purchaseStartedSchools'].some(k => !isInt(r[k], 0, COUNT_MAX))
    || r.countsAre !== 'RECORDED_EVENTS_NOT_ESTIMATES' || (r.purchaseStartedSchools as number) > (r.seenSchools as number)) drift();
  return r as unknown as HqPlanPromotionReach;
}
export function validateHqPlanPromotionList(value: unknown): HqPlanPromotionList {
  const r = record(value, drift); exactKeys(r, ['promotions','limit','nextCursor','offers','viewer','messaging','asOf'], drift);
  if (!Array.isArray(r.promotions) || !isInt(r.limit, 1, 100) || r.promotions.length > (r.limit as number) || !Array.isArray(r.offers)
    || r.messaging !== HQ_PLAN_PROMOTION_MESSAGING || !isTimestamp(r.asOf)) drift();
  const items = (r.promotions as unknown[]).map(v => { const p = promotion(v, ['reach']); reach((v as Record<string, unknown>).reach); return p; });
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1]!, b = items[i]!;
    if (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.promotionId <= b.promotionId)) drift();
  }
  (r.offers as unknown[]).forEach(offer); viewer(r.viewer);
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['createdAt','promotionId'], drift);
    const last = items.at(-1);
    if (!last || items.length !== r.limit || c.createdAt !== last.createdAt || c.promotionId !== last.promotionId) drift();
  }
  return r as unknown as HqPlanPromotionList;
}
export function validateHqPlanPromotionDetail(value: unknown): HqPlanPromotionDetail {
  const r = record(value, drift); exactKeys(r, ['promotion','preview','reach','versions','viewer','asOf'], drift);
  const p = promotion(r.promotion); reach(r.reach); viewer(r.viewer);
  const pv = record(r.preview, drift); exactKeys(pv, ['digest','offerOnSale','audienceSchools','eligibleSchools','asOf'], drift);
  if (typeof pv.digest !== 'string' || !DIGEST.test(pv.digest) || typeof pv.offerOnSale !== 'boolean' || !isInt(pv.audienceSchools, 0, COUNT_MAX)
    || !isInt(pv.eligibleSchools, 0, COUNT_MAX) || (pv.eligibleSchools as number) > (pv.audienceSchools as number) || !isTimestamp(pv.asOf)) drift();
  if (!Array.isArray(r.versions) || r.versions.length !== p.version || !isTimestamp(r.asOf)) drift();
  (r.versions as unknown[]).forEach((value, i) => {
    const v = record(value, drift); exactKeys(v, ['version','kind','actor','snapshot','recordedAt'], drift);
    if (v.version !== i + 1 || !has(['CREATED','UPDATED','STATUS'], v.kind) || (v.kind === 'CREATED') !== (i === 0) || !isTimestamp(v.recordedAt)) drift();
    person(v.actor); snapshot(v.snapshot);
  });
  const last = (r.versions as HqPlanPromotionVersion[]).at(-1)!.snapshot;
  if (last.status !== p.status || last.offerId !== p.offer.offerId || last.headline !== p.headline || last.endsAt !== p.endsAt) drift();
  return r as unknown as HqPlanPromotionDetail;
}
export function validateHqPlanPromotionReceipt(value: unknown): HqPlanPromotionReceipt {
  const r = record(value, drift); exactKeys(r, ['operation','promotion','replayed'], drift);
  if (!has(['CREATE','UPDATE','STATUS'], r.operation) || typeof r.replayed !== 'boolean') drift();
  promotion(r.promotion);
  return r as unknown as HqPlanPromotionReceipt;
}
export function validateSchoolPlanPromotions(value: unknown): SchoolPlanPromotions {
  const r = record(value, drift); exactKeys(r, ['schoolId','promotions','asOf'], drift);
  if (!isUuid(r.schoolId) || !Array.isArray(r.promotions) || r.promotions.length > 20 || !isTimestamp(r.asOf)) drift();
  for (const value of r.promotions as unknown[]) {
    const p = record(value, drift); exactKeys(p, ['promotionId','headline','body','buttonLabel','offer','endsAt','dismissed'], drift);
    if (!isUuid(p.promotionId) || !text(p.headline, 3, 80) || !text(p.body, 3, 400) || !text(p.buttonLabel, 2, 30) || !isTimestamp(p.endsAt)
      || typeof p.dismissed !== 'boolean') drift();
    const o = record(p.offer, drift); exactKeys(o, ['offerId','offerCode','offerKind','billingInterval','displayName','priceMinor','currency'], drift);
    schoolOffer(o);
  }
  return r as unknown as SchoolPlanPromotions;
}
export function validateSchoolPlanPromotionEventReceipt(value: unknown): SchoolPlanPromotionEventReceipt {
  const r = record(value, drift); exactKeys(r, ['promotionId','kind','recorded'], drift);
  if (!isUuid(r.promotionId) || !has(SCHOOL_PLAN_PROMOTION_EVENT_KINDS, r.kind) || typeof r.recorded !== 'boolean') drift();
  return r as unknown as SchoolPlanPromotionEventReceipt;
}
