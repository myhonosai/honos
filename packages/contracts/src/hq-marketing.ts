// M1 HQ marketing campaigns (migration 0252): HON's own marketing of HON OS. HQ-internal campaign plans with a channel,
// dates and a planned budget, plus an immutable version history. HQ owner, or an HQ operator holding hq.marketing.manage
// (hq.marketing.read reads only). A planned budget is a planning number: nothing here publishes an ad, contacts Google or
// Meta, spends money or touches a school's campaigns, billing or creative credits.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const HQ_MARKETING_AUDIENCES = ['NEW_SCHOOLS','TRIAL_SCHOOLS','EXISTING_SCHOOLS','PARTNERS','OTHER'] as const;
export const HQ_MARKETING_CHANNELS = ['GOOGLE_ADS','META_ADS','ORGANIC_SOCIAL','EMAIL','REFERRAL','EVENT','WEBSITE','PARTNERSHIP','OTHER'] as const;
export const HQ_MARKETING_STATUSES = ['DRAFT','ACTIVE','PAUSED','ARCHIVED'] as const;
export const HQ_MARKETING_LIST_FILTERS = ['OPEN', ...HQ_MARKETING_STATUSES] as const;
export type HqMarketingAudience = typeof HQ_MARKETING_AUDIENCES[number];
export type HqMarketingChannel = typeof HQ_MARKETING_CHANNELS[number];
export type HqMarketingStatus = typeof HQ_MARKETING_STATUSES[number];
export type HqMarketingListFilter = typeof HQ_MARKETING_LIST_FILTERS[number];
export type HqMarketingTargetStatus = Exclude<HqMarketingStatus, 'DRAFT'>;
/** Human-command header values, one per campaign command route. */
export const HQ_MARKETING_COMMANDS = { create: 'hq-marketing-campaign-create', update: 'hq-marketing-campaign-update', status: 'hq-marketing-campaign-status' } as const;
export const HQ_MARKETING_BUDGET_MAX_MINOR = 10_000_000_000;
export const HQ_MARKETING_MAX_DAYS = 731;
export const HQ_MARKETING_LIMITS = { code: 40, name: 120, goal: 500, offerLabel: 120 } as const;
/** The status moves the database allows. ARCHIVED is final. */
export const HQ_MARKETING_TRANSITIONS: Readonly<Record<HqMarketingStatus, readonly HqMarketingTargetStatus[]>> = {
  DRAFT: ['ACTIVE','ARCHIVED'], ACTIVE: ['PAUSED','ARCHIVED'], PAUSED: ['ACTIVE','ARCHIVED'], ARCHIVED: [],
};

/**
 * HON's own ad accounts. M1 is planning only: neither is connected and nothing can publish or spend. Connecting HON's real
 * Google Ads or Meta accounts needs the owner's explicit approval (spec docs/architecture/HQ_MARKETING_AND_CREATIVE.md, M3).
 */
export const HQ_MARKETING_AD_ACCOUNTS = Object.freeze([
  Object.freeze({ provider: 'GOOGLE_ADS', connection: 'NOT_CONNECTED', externalExecutionAvailable: false, reason: 'OWNER_APPROVAL_REQUIRED' }),
  Object.freeze({ provider: 'META_ADS', connection: 'NOT_CONNECTED', externalExecutionAvailable: false, reason: 'OWNER_APPROVAL_REQUIRED' }),
] as const);

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const CONTROL = /[\u0000-\u001F\u007F]/;
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const CODE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const DATE = /^(20[2-9]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A real calendar date, YYYY-MM-DD, years 2020–2099. */
export function isHqMarketingDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
const uuid = (v: unknown): string => (isUuid(v) ? (v as string).toLowerCase() : invalid());
const version = (v: unknown): number => (isInt(v, 1, 999_999_999) ? v as number : invalid());

// ---------- inputs ----------
export interface HqMarketingPlan {
  name: string; goal: string; audience: HqMarketingAudience; offerLabel: string; channel: HqMarketingChannel;
  startsOn: string; endsOn: string; plannedBudgetMinor: number;
}
export interface HqMarketingCreateInput extends HqMarketingPlan { code: string }
export interface HqMarketingUpdateInput extends HqMarketingPlan { expectedVersion: number }
export interface HqMarketingStatusInput { expectedVersion: number; status: HqMarketingTargetStatus }
const PLAN_KEYS = ['name','goal','audience','offerLabel','channel','startsOn','endsOn','plannedBudgetMinor'] as const;

function plan(r: Record<string, unknown>, fail: () => never): HqMarketingPlan {
  if (!text(r.name, 3, HQ_MARKETING_LIMITS.name) || !text(r.goal, 3, HQ_MARKETING_LIMITS.goal) || !text(r.offerLabel, 1, HQ_MARKETING_LIMITS.offerLabel)
    || !has(HQ_MARKETING_AUDIENCES, r.audience) || !has(HQ_MARKETING_CHANNELS, r.channel) || !isHqMarketingDate(r.startsOn) || !isHqMarketingDate(r.endsOn)
    || days(r.startsOn, r.endsOn) < 0 || days(r.startsOn, r.endsOn) > HQ_MARKETING_MAX_DAYS
    || !isInt(r.plannedBudgetMinor, 0, HQ_MARKETING_BUDGET_MAX_MINOR)) fail();
  return { name: r.name as string, goal: r.goal as string, audience: r.audience as HqMarketingAudience, offerLabel: r.offerLabel as string,
    channel: r.channel as HqMarketingChannel, startsOn: r.startsOn as string, endsOn: r.endsOn as string, plannedBudgetMinor: r.plannedBudgetMinor as number };
}
export function validateHqMarketingCreateInput(value: unknown): HqMarketingCreateInput {
  const r = record(value, invalid); exactKeys(r, ['code', ...PLAN_KEYS], invalid);
  if (typeof r.code !== 'string' || !CODE.test(r.code)) invalid();
  return { code: r.code as string, ...plan(r, invalid) };
}
export function validateHqMarketingUpdateInput(value: unknown): HqMarketingUpdateInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion', ...PLAN_KEYS], invalid);
  return { expectedVersion: version(r.expectedVersion), ...plan(r, invalid) };
}
export function validateHqMarketingStatusInput(value: unknown): HqMarketingStatusInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion','status'], invalid);
  if (!has(['ACTIVE','PAUSED','ARCHIVED'], r.status)) invalid();
  return { expectedVersion: version(r.expectedVersion), status: r.status as HqMarketingTargetStatus };
}

// ---------- list query ----------
export interface HqMarketingCursor { createdAt: string; campaignId: string }
export interface HqMarketingListQuery { status: HqMarketingListFilter | null; cursor: HqMarketingCursor | null; limit: number }
export function encodeHqMarketingCursor(c: HqMarketingCursor): string { return `${c.createdAt}~${c.campaignId}`; }
export function validateHqMarketingListQuery(value: unknown): HqMarketingListQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status','cursor','limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(HQ_MARKETING_LIST_FILTERS, status)) || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: HqMarketingCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [createdAt, campaignId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(createdAt) || !isUuid(campaignId)) invalid();
    decoded = { createdAt: createdAt as string, campaignId: (campaignId as string).toLowerCase() };
  }
  return { status: status as HqMarketingListFilter | null, cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

// ---------- responses ----------
export interface HqMarketingPerson { principalId: string; displayName: string }
export interface HqMarketingViewer extends HqMarketingPerson { canManage: boolean }
export interface HqMarketingCampaign extends HqMarketingPlan {
  campaignId: string; code: string; status: HqMarketingStatus; currency: 'USD'; createdBy: HqMarketingPerson;
  createdAt: string; updatedAt: string; version: number;
}
export interface HqMarketingSnapshot extends HqMarketingPlan { status: HqMarketingStatus }
export interface HqMarketingVersion { version: number; kind: 'CREATED' | 'UPDATED' | 'STATUS'; actor: HqMarketingPerson; snapshot: HqMarketingSnapshot; recordedAt: string }
export interface HqMarketingSummary { DRAFT: number; ACTIVE: number; PAUSED: number; ARCHIVED: number; plannedBudgetOpenMinor: number }
export interface HqMarketingCampaignList { campaigns: HqMarketingCampaign[]; limit: number; nextCursor: HqMarketingCursor | null; summary: HqMarketingSummary; viewer: HqMarketingViewer; asOf: string }
export interface HqMarketingCampaignDetail { campaign: HqMarketingCampaign; versions: HqMarketingVersion[]; viewer: HqMarketingViewer; asOf: string }
export interface HqMarketingReceipt { operation: 'CREATE' | 'UPDATE' | 'STATUS'; campaign: HqMarketingCampaign; replayed: boolean }

const COUNT_MAX = 100_000_000;
function person(value: unknown): HqMarketingPerson {
  const p = record(value, drift); exactKeys(p, ['principalId','displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return p as unknown as HqMarketingPerson;
}
function viewer(value: unknown): HqMarketingViewer {
  const v = record(value, drift); exactKeys(v, ['principalId','displayName','canManage'], drift);
  if (!isUuid(v.principalId) || !label(v.displayName, 120) || typeof v.canManage !== 'boolean') drift();
  return v as unknown as HqMarketingViewer;
}
function snapshot(value: unknown): HqMarketingSnapshot {
  const s = record(value, drift); exactKeys(s, [...PLAN_KEYS, 'status'], drift);
  if (!has(HQ_MARKETING_STATUSES, s.status)) drift();
  plan(s, drift);
  return s as unknown as HqMarketingSnapshot;
}
function campaign(value: unknown): HqMarketingCampaign {
  const c = record(value, drift);
  exactKeys(c, ['campaignId','code', ...PLAN_KEYS, 'status','currency','createdBy','createdAt','updatedAt','version'], drift);
  if (!isUuid(c.campaignId) || typeof c.code !== 'string' || !CODE.test(c.code) || !has(HQ_MARKETING_STATUSES, c.status) || c.currency !== 'USD'
    || !isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt) || Date.parse(c.updatedAt as string) < Date.parse(c.createdAt as string)
    || !isInt(c.version, 1, 999_999_999)) drift();
  plan(c, drift); person(c.createdBy);
  return c as unknown as HqMarketingCampaign;
}
export function validateHqMarketingCampaignList(value: unknown): HqMarketingCampaignList {
  const r = record(value, drift); exactKeys(r, ['campaigns','limit','nextCursor','summary','viewer','asOf'], drift);
  if (!Array.isArray(r.campaigns) || !isInt(r.limit, 1, 100) || r.campaigns.length > (r.limit as number) || !isTimestamp(r.asOf)) drift();
  const campaigns = (r.campaigns as unknown[]).map(campaign);
  for (let i = 1; i < campaigns.length; i++) {
    const a = campaigns[i - 1]!, b = campaigns[i]!;
    if (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.campaignId <= b.campaignId)) drift();
  }
  const s = record(r.summary, drift); exactKeys(s, ['DRAFT','ACTIVE','PAUSED','ARCHIVED','plannedBudgetOpenMinor'], drift);
  if (['DRAFT','ACTIVE','PAUSED','ARCHIVED'].some(k => !isInt(s[k], 0, COUNT_MAX)) || !isInt(s.plannedBudgetOpenMinor, 0, Number.MAX_SAFE_INTEGER)
    || ((s.DRAFT as number) + (s.ACTIVE as number) + (s.PAUSED as number) === 0 && s.plannedBudgetOpenMinor !== 0)) drift();
  viewer(r.viewer);
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['createdAt','campaignId'], drift);
    const last = campaigns.at(-1);
    if (!last || campaigns.length !== r.limit || c.createdAt !== last.createdAt || c.campaignId !== last.campaignId) drift();
  }
  return r as unknown as HqMarketingCampaignList;
}
export function validateHqMarketingCampaignDetail(value: unknown): HqMarketingCampaignDetail {
  const r = record(value, drift); exactKeys(r, ['campaign','versions','viewer','asOf'], drift);
  const c = campaign(r.campaign);
  if (!Array.isArray(r.versions) || r.versions.length !== c.version || !isTimestamp(r.asOf)) drift();
  (r.versions as unknown[]).forEach((value, i) => {
    const v = record(value, drift); exactKeys(v, ['version','kind','actor','snapshot','recordedAt'], drift);
    if (v.version !== i + 1 || !has(['CREATED','UPDATED','STATUS'], v.kind) || (v.kind === 'CREATED') !== (i === 0) || !isTimestamp(v.recordedAt)) drift();
    person(v.actor); snapshot(v.snapshot);
  });
  const last = (r.versions as HqMarketingVersion[]).at(-1)!.snapshot;
  if (PLAN_KEYS.some(k => last[k] !== c[k]) || last.status !== c.status) drift();
  viewer(r.viewer);
  return r as unknown as HqMarketingCampaignDetail;
}
export function validateHqMarketingReceipt(value: unknown): HqMarketingReceipt {
  const r = record(value, drift); exactKeys(r, ['operation','campaign','replayed'], drift);
  if (!has(['CREATE','UPDATE','STATUS'], r.operation) || typeof r.replayed !== 'boolean') drift();
  campaign(r.campaign);
  return r as unknown as HqMarketingReceipt;
}
