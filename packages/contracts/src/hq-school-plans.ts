// HQ school plan assignments (migration 0676). An HQ owner records which HON OS plan a school's organization is on: one
// offer of the published offer set (frozen when assigned) or a custom plan for that organization only (name, monthly or
// annual, price; a free custom plan may carry an optional end date). Changing appends a revision; removing appends a REMOVE revision.
// This only RECORDS the plan: nothing is charged, no checkout opens and no subscription, entitlement or access changes.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

/** Human-command header values, one per command route. */
export const HQ_SCHOOL_PLAN_COMMANDS = { assign: 'hq-school-plan-assign', remove: 'hq-school-plan-remove' } as const;
export const HQ_SCHOOL_PLAN_LIMITS = { name: 80, note: 300, priceMinor: 10_000_000, revision: 999_999, freeYears: 3 } as const;
export const HQ_SCHOOL_PLAN_CUSTOM_INTERVALS = ['MONTHLY','ANNUAL'] as const;
export const HQ_SCHOOL_PLAN_ON_NOW = ['TRIAL','MONTHLY','ANNUAL','ONE_TIME','NONE'] as const;
export type HqSchoolPlanCustomInterval = typeof HQ_SCHOOL_PLAN_CUSTOM_INTERVALS[number];
export type HqSchoolPlanInterval = HqSchoolPlanCustomInterval | 'ONE_TIME';
export type HqSchoolPlanOnNow = typeof HQ_SCHOOL_PLAN_ON_NOW[number];
const STATUSES = ['ACTIVE','SUSPENDED','ARCHIVED'] as const;
const OFFER_KINDS = ['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME'] as const;
const INTERVALS = ['MONTHLY','ANNUAL','ONE_TIME'] as const;

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const CONTROL = /[\u0000-\u001F\u007F]/;
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const DATE = /^(20[2-9]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// ---------- inputs ----------
export type HqSchoolPlanChoice =
  | { source: 'OFFER'; offerId: string }
  | { source: 'CUSTOM'; name: string; billingInterval: HqSchoolPlanCustomInterval; priceMinor: number; freeUntil: string | null };
export interface HqSchoolPlanAssignInput { expectedRevision: number; plan: HqSchoolPlanChoice; note: string | null }
export interface HqSchoolPlanRemoveInput { expectedRevision: number; note: string | null }

const revision = (v: unknown): number => (isInt(v, 0, HQ_SCHOOL_PLAN_LIMITS.revision) ? v as number : invalid());
const note = (v: unknown): string | null => (v === null ? null : text(v, 1, HQ_SCHOOL_PLAN_LIMITS.note) ? v : invalid());

/** Validates the plan choice. Dates are checked for shape only; the server decides "after today, within three years". */
export function validateHqSchoolPlanChoice(value: unknown): HqSchoolPlanChoice {
  const p = record(value, invalid);
  if (p.source === 'OFFER') {
    exactKeys(p, ['source','offerId'], invalid);
    if (!isUuid(p.offerId)) invalid();
    return { source: 'OFFER', offerId: (p.offerId as string).toLowerCase() };
  }
  if (p.source !== 'CUSTOM') invalid();
  exactKeys(p, ['source','name','billingInterval','priceMinor','freeUntil'], invalid);
  if (!text(p.name, 3, HQ_SCHOOL_PLAN_LIMITS.name) || !has(HQ_SCHOOL_PLAN_CUSTOM_INTERVALS, p.billingInterval)
    || !isInt(p.priceMinor, 0, HQ_SCHOOL_PLAN_LIMITS.priceMinor) || !(p.freeUntil === null || isDate(p.freeUntil))
    || ((p.priceMinor as number) > 0 && p.freeUntil !== null)) invalid();
  return { source: 'CUSTOM', name: p.name as string, billingInterval: p.billingInterval as HqSchoolPlanCustomInterval,
    priceMinor: p.priceMinor as number, freeUntil: p.freeUntil as string | null };
}
export function validateHqSchoolPlanAssignInput(value: unknown): HqSchoolPlanAssignInput {
  const r = record(value, invalid); exactKeys(r, ['expectedRevision','plan','note'], invalid);
  return { expectedRevision: revision(r.expectedRevision), plan: validateHqSchoolPlanChoice(r.plan), note: note(r.note) };
}
export function validateHqSchoolPlanRemoveInput(value: unknown): HqSchoolPlanRemoveInput {
  const r = record(value, invalid); exactKeys(r, ['expectedRevision','note'], invalid);
  return { expectedRevision: revision(r.expectedRevision), note: note(r.note) };
}

// ---------- responses ----------
export interface HqSchoolPlanPerson { principalId: string; displayName: string }
export interface HqSchoolPlanViewer extends HqSchoolPlanPerson { canManage: boolean }
export interface HqSchoolPlanOffer {
  offerId: string; offerCode: string; offerKind: typeof OFFER_KINDS[number]; billingInterval: HqSchoolPlanInterval; founder: boolean;
  displayName: string; priceMinor: number; currency: 'USD'; offerSetVersion: number;
}
export interface HqSchoolPlanRecord {
  revision: number; action: 'ASSIGN' | 'REMOVE'; source: 'OFFER' | 'CUSTOM' | null; offerId: string | null;
  offerKind: typeof OFFER_KINDS[number] | null; offerSetVersion: number | null; planName: string | null;
  billingInterval: HqSchoolPlanInterval | null; priceMinor: number | null; currency: 'USD' | null; founder: boolean | null;
  freeUntil: string | null; note: string | null; schoolId: string; recordedBy: HqSchoolPlanPerson; recordedAt: string;
}
export interface HqSchoolPlanView {
  schoolId: string; organizationId: string; schoolName: string; schoolStatus: typeof STATUSES[number];
  organizationStatus: typeof STATUSES[number]; revision: number; current: HqSchoolPlanRecord | null; history: HqSchoolPlanRecord[];
  onNow: HqSchoolPlanOnNow; offers: HqSchoolPlanOffer[]; viewer: HqSchoolPlanViewer; effect: 'RECORD_ONLY'; charging: 'OFF'; asOf: string;
}
export interface HqSchoolPlanReceipt {
  operation: 'ASSIGN' | 'REMOVE'; schoolId: string; organizationId: string; assignment: HqSchoolPlanRecord;
  effect: 'RECORD_ONLY'; charging: 'OFF'; replayed: boolean;
}

function person(value: unknown): HqSchoolPlanPerson {
  const p = record(value, drift); exactKeys(p, ['principalId','displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return p as unknown as HqSchoolPlanPerson;
}
function offer(value: unknown): HqSchoolPlanOffer {
  const o = record(value, drift);
  exactKeys(o, ['offerId','offerCode','offerKind','billingInterval','founder','displayName','priceMinor','currency','offerSetVersion'], drift);
  if (!isUuid(o.offerId) || !label(o.offerCode, 48) || !has(OFFER_KINDS, o.offerKind) || !has(INTERVALS, o.billingInterval)
    || typeof o.founder !== 'boolean' || !label(o.displayName, 80) || !isInt(o.priceMinor, 100, 10_000_000) || o.currency !== 'USD'
    || !isInt(o.offerSetVersion, 1, 999_999_999)) drift();
  return o as unknown as HqSchoolPlanOffer;
}
const PLAN_FIELDS = ['source','offerId','offerKind','offerSetVersion','planName','billingInterval','priceMinor','currency','founder','freeUntil'] as const;
function planRecord(value: unknown): HqSchoolPlanRecord {
  const a = record(value, drift);
  exactKeys(a, ['revision','action', ...PLAN_FIELDS, 'note','schoolId','recordedBy','recordedAt'], drift);
  if (!isInt(a.revision, 1, HQ_SCHOOL_PLAN_LIMITS.revision) || !has(['ASSIGN','REMOVE'], a.action) || !isUuid(a.schoolId)
    || !(a.note === null || text(a.note, 1, HQ_SCHOOL_PLAN_LIMITS.note)) || !isTimestamp(a.recordedAt)) drift();
  person(a.recordedBy);
  if (a.action === 'REMOVE') {
    if (PLAN_FIELDS.some(k => a[k] !== null)) drift();
    return a as unknown as HqSchoolPlanRecord;
  }
  if (!has(['OFFER','CUSTOM'], a.source) || !label(a.planName, HQ_SCHOOL_PLAN_LIMITS.name) || !has(INTERVALS, a.billingInterval)
    || !isInt(a.priceMinor, 0, HQ_SCHOOL_PLAN_LIMITS.priceMinor) || a.currency !== 'USD' || typeof a.founder !== 'boolean'
    || !(a.freeUntil === null || isDate(a.freeUntil))) drift();
  if (a.source === 'OFFER') {
    if (!isUuid(a.offerId) || !has(OFFER_KINDS, a.offerKind) || !isInt(a.offerSetVersion, 1, 999_999_999) || a.freeUntil !== null) drift();
  } else if (a.offerId !== null || a.offerKind !== null || a.offerSetVersion !== null || a.founder || a.billingInterval === 'ONE_TIME'
    || ((a.priceMinor as number) > 0 && a.freeUntil !== null)) drift();
  return a as unknown as HqSchoolPlanRecord;
}
export function validateHqSchoolPlanView(value: unknown): HqSchoolPlanView {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','organizationId','schoolName','schoolStatus','organizationStatus','revision','current','history','onNow',
    'offers','viewer','effect','charging','asOf'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || !label(r.schoolName, 300) || !has(STATUSES, r.schoolStatus)
    || !has(STATUSES, r.organizationStatus) || !isInt(r.revision, 0, HQ_SCHOOL_PLAN_LIMITS.revision) || !Array.isArray(r.history)
    || r.history.length > 50 || !has(HQ_SCHOOL_PLAN_ON_NOW, r.onNow) || !Array.isArray(r.offers) || r.effect !== 'RECORD_ONLY'
    || r.charging !== 'OFF' || !isTimestamp(r.asOf)) drift();
  const history = (r.history as unknown[]).map(planRecord);
  for (let i = 1; i < history.length; i++) if (history[i - 1]!.revision !== history[i]!.revision + 1) drift();
  if ((history[0]?.revision ?? 0) !== r.revision) drift();
  if (r.current === null) { if (history[0]?.action === 'ASSIGN') drift(); }
  else {
    const cur = planRecord(r.current);
    if (cur.action !== 'ASSIGN' || cur.revision !== r.revision) drift();
  }
  (r.offers as unknown[]).forEach(offer);
  const v = record(r.viewer, drift); exactKeys(v, ['principalId','displayName','canManage'], drift);
  if (!isUuid(v.principalId) || !label(v.displayName, 120) || typeof v.canManage !== 'boolean') drift();
  return r as unknown as HqSchoolPlanView;
}
export function validateHqSchoolPlanReceipt(value: unknown): HqSchoolPlanReceipt {
  const r = record(value, drift);
  exactKeys(r, ['operation','schoolId','organizationId','assignment','effect','charging','replayed'], drift);
  if (!has(['ASSIGN','REMOVE'], r.operation) || !isUuid(r.schoolId) || !isUuid(r.organizationId) || r.effect !== 'RECORD_ONLY'
    || r.charging !== 'OFF' || typeof r.replayed !== 'boolean') drift();
  const a = planRecord(r.assignment);
  if (a.action !== r.operation || a.schoolId !== r.schoolId) drift();
  return r as unknown as HqSchoolPlanReceipt;
}
