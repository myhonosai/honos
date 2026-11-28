// HQ email and text blasts HB1 (migration 0712). The HQ owner writes one email or text, picks schools with filters and
// sends it to each school's current owners. The database resolves the audience, fills the merge tags and queues one HQ
// message per school; nothing here sees an address or talks to a provider. Mirrors hon.hq_blast_audience_ok and the
// save/send/cancel checks in 0712.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { HON_OS_PLAN_CAPABILITIES } from './saas-offers.js';

export const HQ_BLAST_CHANNELS = ['EMAIL', 'SMS'] as const;
export const HQ_BLAST_PURPOSES = ['ANNOUNCEMENT', 'SUPPORT', 'ONBOARDING'] as const;
export const HQ_BLAST_STATUSES = ['DRAFT', 'QUEUED', 'CANCELLED'] as const;
export const HQ_BLAST_MERGE_TAGS = ['first_name', 'school_name', 'hq_name'] as const;
export const HQ_BLAST_SCHOOL_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export const HQ_BLAST_BILLING_INTERVALS = ['MONTHLY', 'ANNUAL', 'ONE_TIME'] as const;
export const HQ_BLAST_TRIAL_STATES = ['ON_TRIAL', 'TRIAL_ENDED', 'NEVER'] as const;
export const HQ_BLAST_TRIAL_ENDS_DAYS = [7, 14, 30] as const;
export const HQ_BLAST_JOINED_DAYS = [7, 30, 90] as const;
export const HQ_BLAST_SCHOOL_OUTCOMES = ['QUEUED', 'NO_OWNERS', 'NOT_REACHABLE', 'RECENTLY_SENT'] as const;
/** Body limits leave room for filled-in tags so a queued message still fits the HQ limits (SMS 1,600, email 4,000). */
export const HQ_BLAST_EMAIL_BODY_MAX = 3500;
export const HQ_BLAST_SMS_BODY_MAX = 1400;
export const HQ_BLAST_SUBJECT_MAX = 150;
export const HQ_BLAST_NAME_MAX = 100;
export const HQ_BLAST_PICK_MAX = 200;
export const HQ_BLAST_SCHOOL_LIMIT = 2000;
export const HQ_BLAST_DAILY_LIMIT = 10;
/** Human-command header values, one per HQ blast command route. */
export const HQ_BLAST_COMMANDS = { save: 'hq-blast-save', send: 'hq-blast-send', cancel: 'hq-blast-cancel' } as const;

export type HqBlastChannel = typeof HQ_BLAST_CHANNELS[number];
export type HqBlastPurpose = typeof HQ_BLAST_PURPOSES[number];
export type HqBlastStatus = typeof HQ_BLAST_STATUSES[number];
export type HqBlastSchoolOutcome = typeof HQ_BLAST_SCHOOL_OUTCOMES[number];

export interface HqBlastAudience {
  statuses?: Array<typeof HQ_BLAST_SCHOOL_STATUSES[number]>;
  planNames?: string[]; noPlan?: true; founder?: boolean; billingIntervals?: Array<typeof HQ_BLAST_BILLING_INTERVALS[number]>; freePlan?: boolean;
  trial?: typeof HQ_BLAST_TRIAL_STATES[number]; trialEndsWithinDays?: typeof HQ_BLAST_TRIAL_ENDS_DAYS[number];
  joinedWithinDays?: typeof HQ_BLAST_JOINED_DAYS[number]; joinedFrom?: string; joinedTo?: string;
  countries?: string[]; regions?: string[]; cities?: string[];
  featuresIncluded?: string[]; featuresMissing?: string[];
  canGetTexts?: true;
  /** Picked schools, reached as well as the filter matches. */
  schools?: string[];
  /** Left-out schools, removed last. */
  excludeSchools?: string[];
}
export const HQ_BLAST_AUDIENCE_KEYS = ['statuses', 'planNames', 'noPlan', 'founder', 'billingIntervals', 'freePlan', 'trial', 'trialEndsWithinDays',
  'joinedWithinDays', 'joinedFrom', 'joinedTo', 'countries', 'regions', 'cities', 'featuresIncluded', 'featuresMissing', 'canGetTexts',
  'schools', 'excludeSchools'] as const;

export interface HqBlastSaveInput {
  blastId: string | null; expectedVersion: number; name: string; channel: HqBlastChannel; purpose: HqBlastPurpose;
  subject: string | null; body: string; audience: HqBlastAudience;
}
export interface HqBlastSendInput { blastId: string; expectedVersion: number; sendAt: string | null }
export interface HqBlastCancelInput { blastId: string; expectedVersion: number }

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const DB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TAG = /\{\{(first_name|school_name|hq_name)\}\}/g;
const SPACE_EDGE = /^[ \t\n\r]|[ \t\n\r]$/;

/** Plain text as 0712 checks it: trimmed, min..max characters, no control characters except tab and line breaks, closed tags. */
export function hqBlastTextOk(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && !SPACE_EDGE.test(value) && value.length >= min && value.length <= max && !CONTROL.test(value)
    && !/(\{\{|\}\})/.test(value.replace(TAG, ''));
}
export function hqBlastLineOk(value: unknown, max: number): value is string { return hqBlastTextOk(value, 1, max) && !/[\t\n\r]/.test(value as string); }
export function hqBlastBodyMax(channel: HqBlastChannel): number { return channel === 'EMAIL' ? HQ_BLAST_EMAIL_BODY_MAX : HQ_BLAST_SMS_BODY_MAX; }

function dayOk(value: unknown): value is string {
  if (typeof value !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function stringsOk(value: unknown, max: number, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= max && value.every((v) => typeof v === 'string' && pattern.test(v))
    && new Set(value.map((v) => (v as string).toLowerCase())).size === value.length;
}
const PLAN = /^\S(?:.{0,78}\S)?$/s;
const CITY = /^\S(?:[^\u0000-\u001F\u007F]{0,98}\S)?$/;

/** True when the audience has the closed 0712 shape. Every key is optional; {} is every active and paused school. */
export function hqBlastAudienceOk(value: unknown): value is HqBlastAudience {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  if (Object.keys(a).some((k) => !has(HQ_BLAST_AUDIENCE_KEYS, k))) return false;
  const features = (v: unknown) => stringsOk(v, 20, /^[a-z]+\.[a-z_]+$/) && v.every((f) => HON_OS_PLAN_CAPABILITIES.includes(f));
  const ids = (v: unknown) => stringsOk(v, HQ_BLAST_PICK_MAX, DB_UUID);
  return (!('statuses' in a) || stringsOk(a.statuses, 2, /^(ACTIVE|PAUSED)$/))
    && (!('planNames' in a) || (stringsOk(a.planNames, 20, PLAN) && a.planNames.every((p) => p.length <= 80)))
    && (!('noPlan' in a) || a.noPlan === true)
    && (!('founder' in a) || typeof a.founder === 'boolean')
    && (!('billingIntervals' in a) || stringsOk(a.billingIntervals, 3, /^(MONTHLY|ANNUAL|ONE_TIME)$/))
    && (!('freePlan' in a) || typeof a.freePlan === 'boolean')
    && (!('trial' in a) || has(HQ_BLAST_TRIAL_STATES, a.trial))
    && (!('trialEndsWithinDays' in a) || (has(HQ_BLAST_TRIAL_ENDS_DAYS, a.trialEndsWithinDays) && (a.trial ?? 'ON_TRIAL') === 'ON_TRIAL'))
    && (!('joinedWithinDays' in a) || (has(HQ_BLAST_JOINED_DAYS, a.joinedWithinDays) && !('joinedFrom' in a) && !('joinedTo' in a)))
    && (!('joinedFrom' in a) || dayOk(a.joinedFrom))
    && (!('joinedTo' in a) || dayOk(a.joinedTo))
    && (!('joinedFrom' in a && 'joinedTo' in a) || (a.joinedFrom as string) <= (a.joinedTo as string))
    && (!('countries' in a) || stringsOk(a.countries, 10, /^[A-Z]{2}$/))
    && (!('regions' in a) || stringsOk(a.regions, 20, /^[A-Z0-9]{1,3}$/))
    && (!('cities' in a) || stringsOk(a.cities, 20, CITY))
    && (!('featuresIncluded' in a) || features(a.featuresIncluded))
    && (!('featuresMissing' in a) || features(a.featuresMissing))
    && (!('canGetTexts' in a) || a.canGetTexts === true)
    && (!('schools' in a) || ids(a.schools))
    && (!('excludeSchools' in a) || ids(a.excludeSchools));
}

const uuid = (v: unknown): string => (typeof v === 'string' && DB_UUID.test(v.toLowerCase()) ? v.toLowerCase() : invalid());
const positive = (v: unknown): number => (isInt(v, 1, 999_999_999) ? v as number : invalid());

export function validateHqBlastSaveInput(value: unknown): HqBlastSaveInput {
  const r = record(value, invalid); exactKeys(r, ['blastId', 'expectedVersion', 'name', 'channel', 'purpose', 'subject', 'body', 'audience'], invalid);
  const blastId = r.blastId === null ? null : uuid(r.blastId);
  if (!isInt(r.expectedVersion, 0, 999_999_999) || (r.expectedVersion === 0) !== (blastId === null)) invalid();
  if (!has(HQ_BLAST_CHANNELS, r.channel) || !has(HQ_BLAST_PURPOSES, r.purpose) || !hqBlastLineOk(r.name, HQ_BLAST_NAME_MAX)) invalid();
  const channel = r.channel as HqBlastChannel;
  if (channel === 'EMAIL' ? !hqBlastLineOk(r.subject, HQ_BLAST_SUBJECT_MAX) : r.subject !== null) invalid();
  if (!hqBlastTextOk(r.body, 1, hqBlastBodyMax(channel)) || !hqBlastAudienceOk(r.audience)) invalid();
  return { blastId, expectedVersion: r.expectedVersion as number, name: r.name as string, channel, purpose: r.purpose as HqBlastPurpose,
    subject: r.subject as string | null, body: r.body as string, audience: r.audience as HqBlastAudience };
}
export function validateHqBlastSendInput(value: unknown): HqBlastSendInput {
  const r = record(value, invalid); exactKeys(r, ['blastId', 'expectedVersion', 'sendAt'], invalid);
  if (r.sendAt !== null && !isTimestamp(r.sendAt)) invalid();
  return { blastId: uuid(r.blastId), expectedVersion: positive(r.expectedVersion), sendAt: r.sendAt as string | null };
}
export function validateHqBlastCancelInput(value: unknown): HqBlastCancelInput {
  const r = record(value, invalid); exactKeys(r, ['blastId', 'expectedVersion'], invalid);
  return { blastId: uuid(r.blastId), expectedVersion: positive(r.expectedVersion) };
}

// ---------- responses ----------
export interface HqBlastPerson { principalId: string; displayName: string }
export interface HqBlastSchoolCounts { queued: number; noOwners: number; notReachable: number; recentlySent: number }
export interface HqBlastDeliveryCounts {
  waiting: number; pending: number; sending: number; accepted: number; delivered: number; bounced: number; failed: number; suppressed: number; unknown: number;
}
export interface HqBlastResults { schools: HqBlastSchoolCounts; deliveries: HqBlastDeliveryCounts }
export interface HqBlast {
  blastId: string; name: string; channel: HqBlastChannel; purpose: HqBlastPurpose; subject: string | null; body: string; audience: HqBlastAudience;
  status: HqBlastStatus; sendAt: string | null; queuedAt: string | null; cancelledAt: string | null; schoolCount: number | null;
  recipientCount: number | null; createdBy: HqBlastPerson; createdAt: string; updatedAt: string; version: number;
}
export interface HqBlastSummary extends HqBlast { results: HqBlastResults }
export interface HqBlastList { blasts: HqBlastSummary[]; sentToday: number; dailyLimit: number; asOf: string }
export interface HqBlastSchoolRow { schoolId: string; schoolDisplayName: string; outcome: HqBlastSchoolOutcome; ownerCount: number; reachableCount: number }
export interface HqBlastDetail { blast: HqBlast; results: HqBlastResults; schools: Array<HqBlastSchoolRow & { messageId: string | null }>; asOf: string }
export interface HqBlastAudiencePreview {
  blastId: string; channel: HqBlastChannel; schoolsMatched: number; schoolsReached: number; ownersTotal: number; ownersReached: number;
  skipped: { noOwners: number; notReachable: number; recentlySent: number; ownersNotReachable: number }; tooLarge: boolean;
  schools: HqBlastSchoolRow[]; sample: { schoolDisplayName: string; subject: string | null; body: string } | null; asOf: string;
}
export interface HqBlastOptions {
  planNames: string[]; features: string[]; countries: string[]; regions: Array<{ country: string; region: string }>;
  schools: Array<{ schoolId: string; schoolDisplayName: string; organizationDisplayName: string; status: 'ACTIVE' | 'PAUSED' }>; asOf: string;
}
export interface HqBlastReceipt { operation: 'SAVE' | 'SEND' | 'CANCEL'; blast: HqBlast; results?: HqBlastResults; replayed: boolean }

const BIG = 2_000_000;
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
function person(value: unknown): HqBlastPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return p as unknown as HqBlastPerson;
}
function counts<T>(value: unknown, keys: readonly string[]): T {
  const c = record(value, drift); exactKeys(c, keys, drift);
  if (Object.values(c).some((n) => !isInt(n, 0, BIG))) drift();
  return c as T;
}
function results(value: unknown): HqBlastResults {
  const r = record(value, drift); exactKeys(r, ['schools', 'deliveries'], drift);
  return { schools: counts(r.schools, ['queued', 'noOwners', 'notReachable', 'recentlySent']),
    deliveries: counts(r.deliveries, ['waiting', 'pending', 'sending', 'accepted', 'delivered', 'bounced', 'failed', 'suppressed', 'unknown']) };
}
function blast(value: unknown): HqBlast {
  const b = record(value, drift);
  exactKeys(b, ['blastId', 'name', 'channel', 'purpose', 'subject', 'body', 'audience', 'status', 'sendAt', 'queuedAt', 'cancelledAt',
    'schoolCount', 'recipientCount', 'createdBy', 'createdAt', 'updatedAt', 'version'], drift);
  if (!isUuid(b.blastId) || !hqBlastLineOk(b.name, HQ_BLAST_NAME_MAX) || !has(HQ_BLAST_CHANNELS, b.channel) || !has(HQ_BLAST_PURPOSES, b.purpose)
    || (b.channel === 'EMAIL' ? !hqBlastLineOk(b.subject, HQ_BLAST_SUBJECT_MAX) : b.subject !== null)
    || !hqBlastTextOk(b.body, 1, hqBlastBodyMax(b.channel as HqBlastChannel)) || !hqBlastAudienceOk(b.audience) || !has(HQ_BLAST_STATUSES, b.status)
    || !nullable(b.sendAt, isTimestamp) || !nullable(b.queuedAt, isTimestamp) || !nullable(b.cancelledAt, isTimestamp)
    || !nullable(b.schoolCount, (n: unknown): n is number => isInt(n, 1, HQ_BLAST_SCHOOL_LIMIT))
    || !nullable(b.recipientCount, (n: unknown): n is number => isInt(n, 1, 200_000))
    || !isTimestamp(b.createdAt) || !isTimestamp(b.updatedAt) || !isInt(b.version, 1, 999_999_999)
    || (b.status === 'DRAFT') !== (b.queuedAt === null) || (b.status === 'DRAFT') !== (b.sendAt === null)
    || (b.status === 'CANCELLED') !== (b.cancelledAt !== null)) drift();
  person(b.createdBy);
  return b as unknown as HqBlast;
}
function schoolRow(value: unknown, withMessage: boolean): HqBlastSchoolRow & { messageId?: string | null } {
  const s = record(value, drift);
  exactKeys(s, withMessage ? ['schoolId', 'schoolDisplayName', 'outcome', 'ownerCount', 'reachableCount', 'messageId']
    : ['schoolId', 'schoolDisplayName', 'outcome', 'ownerCount', 'reachableCount'], drift);
  if (!isUuid(s.schoolId) || !label(s.schoolDisplayName, 300) || !has(HQ_BLAST_SCHOOL_OUTCOMES, s.outcome) || !isInt(s.ownerCount, 0, 100)
    || !isInt(s.reachableCount, 0, s.ownerCount as number) || (withMessage && ((s.outcome === 'QUEUED') !== (s.messageId !== null)
      || !nullable(s.messageId, isUuid)))) drift();
  return s as unknown as HqBlastSchoolRow;
}

export function verifyHqBlastList(value: unknown): HqBlastList {
  const r = record(value, drift); exactKeys(r, ['blasts', 'sentToday', 'dailyLimit', 'asOf'], drift);
  if (!Array.isArray(r.blasts) || r.blasts.length > 200 || !isInt(r.sentToday, 0, BIG) || r.dailyLimit !== HQ_BLAST_DAILY_LIMIT || !isTimestamp(r.asOf)) drift();
  const blasts = (r.blasts as unknown[]).map((x) => {
    const o = record(x, drift); const { results: res, ...rest } = o;
    return { ...blast(rest), results: results(res) };
  });
  return { blasts, sentToday: r.sentToday as number, dailyLimit: HQ_BLAST_DAILY_LIMIT, asOf: r.asOf as string };
}
export function verifyHqBlastDetail(value: unknown, expected?: { blastId: string }): HqBlastDetail {
  const r = record(value, drift); exactKeys(r, ['blast', 'results', 'schools', 'asOf'], drift);
  const b = blast(r.blast);
  if (expected && b.blastId !== expected.blastId.toLowerCase()) drift();
  if (!Array.isArray(r.schools) || r.schools.length > HQ_BLAST_SCHOOL_LIMIT * 2 || !isTimestamp(r.asOf)) drift();
  return { blast: b, results: results(r.results), schools: (r.schools as unknown[]).map((s) => schoolRow(s, true) as HqBlastSchoolRow & { messageId: string | null }),
    asOf: r.asOf as string };
}
export function verifyHqBlastAudience(value: unknown, expected: { blastId: string }): HqBlastAudiencePreview {
  const r = record(value, drift);
  exactKeys(r, ['blastId', 'channel', 'schoolsMatched', 'schoolsReached', 'ownersTotal', 'ownersReached', 'skipped', 'tooLarge', 'schools', 'sample', 'asOf'], drift);
  if (r.blastId !== expected.blastId.toLowerCase() || !has(HQ_BLAST_CHANNELS, r.channel) || !isInt(r.schoolsMatched, 0, BIG)
    || !isInt(r.schoolsReached, 0, r.schoolsMatched as number) || !isInt(r.ownersTotal, 0, BIG) || !isInt(r.ownersReached, 0, r.ownersTotal as number)
    || typeof r.tooLarge !== 'boolean' || r.tooLarge !== ((r.schoolsReached as number) > HQ_BLAST_SCHOOL_LIMIT)
    || !Array.isArray(r.schools) || r.schools.length > 50 || !isTimestamp(r.asOf)) drift();
  counts(r.skipped, ['noOwners', 'notReachable', 'recentlySent', 'ownersNotReachable']);
  (r.schools as unknown[]).forEach((s) => schoolRow(s, false));
  if (r.sample !== null) {
    const s = record(r.sample, drift); exactKeys(s, ['schoolDisplayName', 'subject', 'body'], drift);
    if (!label(s.schoolDisplayName, 300) || (s.subject !== null && !label(s.subject, 1000)) || !label(s.body, 8000)
      || (r.channel === 'SMS') !== (s.subject === null)) drift();
  }
  if ((r.sample === null) !== (r.schoolsReached === 0)) drift();
  return r as unknown as HqBlastAudiencePreview;
}
export function verifyHqBlastOptions(value: unknown): HqBlastOptions {
  const r = record(value, drift); exactKeys(r, ['planNames', 'features', 'countries', 'regions', 'schools', 'asOf'], drift);
  if (!Array.isArray(r.planNames) || r.planNames.length > 500 || r.planNames.some((p) => !label(p, 80))
    || !Array.isArray(r.features) || r.features.some((f) => !HON_OS_PLAN_CAPABILITIES.includes(f as string))
    || !Array.isArray(r.countries) || r.countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))
    || !Array.isArray(r.regions) || !Array.isArray(r.schools) || r.schools.length > 20 || !isTimestamp(r.asOf)) drift();
  for (const g of r.regions as unknown[]) {
    const o = record(g, drift); exactKeys(o, ['country', 'region'], drift);
    if (typeof o.country !== 'string' || !/^[A-Z]{2}$/.test(o.country) || typeof o.region !== 'string' || !/^[A-Z0-9]{1,3}$/.test(o.region)) drift();
  }
  for (const s of r.schools as unknown[]) {
    const o = record(s, drift); exactKeys(o, ['schoolId', 'schoolDisplayName', 'organizationDisplayName', 'status'], drift);
    if (!isUuid(o.schoolId) || !label(o.schoolDisplayName, 300) || !label(o.organizationDisplayName, 300) || !has(HQ_BLAST_SCHOOL_STATUSES, o.status)) drift();
  }
  return r as unknown as HqBlastOptions;
}
export function verifyHqBlastReceipt(value: unknown, expected: { operation: 'SAVE' | 'SEND' | 'CANCEL'; blastId?: string | null; status: HqBlastStatus }): HqBlastReceipt {
  const r = record(value, drift);
  exactKeys(r, expected.operation === 'SAVE' ? ['operation', 'blast', 'replayed'] : ['operation', 'blast', 'results', 'replayed'], drift);
  if (r.operation !== expected.operation || typeof r.replayed !== 'boolean') drift();
  const b = blast(r.blast);
  if (b.status !== expected.status || (expected.blastId && b.blastId !== expected.blastId.toLowerCase())) drift();
  return { operation: expected.operation, blast: b, ...(r.results !== undefined ? { results: results(r.results) } : {}), replayed: r.replayed as boolean };
}

/** The merge tags written in a text, in order of first use. */
export function hqBlastTagsIn(text: string): string[] {
  return [...new Set([...text.matchAll(TAG)].map((m) => m[1] as string))];
}
