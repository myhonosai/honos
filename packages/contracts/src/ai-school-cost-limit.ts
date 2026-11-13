// R2 (0288) per-school internal AI cost ceiling and single-school pause. HQ only. This is HON's internal provider cost
// for the included AI team, never a customer balance, credits or a charge. The database decides authority: a human HQ
// owner may change a school's ceiling or pause it; HQ billing staff may read.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const AI_SCHOOL_COST_LEVELS = ['NO_CEILING', 'NORMAL', 'WARNING_75', 'WARNING_90', 'CEILING_REACHED'] as const;
export type AiSchoolCostLevel = typeof AI_SCHOOL_COST_LEVELS[number];
/** Owner 2026-11-12: $15 in micro-USD, the default while the school's free trial owns its access. A paying school has no
 *  default ceiling: conversations are not capped, and creative and heavier work spends its monthly creative credits. */
export const AI_SCHOOL_TRIAL_DEFAULT_CEILING_MICROS = 15_000_000;
export const AI_SCHOOL_MAX_CEILING_MICROS = 1_000_000_000;

/** expectedVersion 0 = the school has no record yet (default ceiling, not paused). */
export interface AiSchoolCostLimitInput { schoolId: string; ceilingMicros: number; paused: boolean; reason: string; expectedVersion: number }
export interface AiSchoolCostLimitReceipt { schoolId: string; organizationId: string; ceilingMicros: number; paused: boolean; version: number; replayed: boolean }
export interface AiSchoolCostStatus {
  schoolId: string; organizationId: string; schoolName: string; ceilingMicros: number | null; defaultCeiling: boolean; trial: boolean; paused: boolean;
  reason: string | null; version: number; recordedCostMicros: number; committedCostMicros: number; usedBasisPoints: number | null;
  level: AiSchoolCostLevel; windowStart: string; windowEnd: string;
}
/** At most 500 schools, highest use first. */
export interface AiSchoolCostStatusList { schools: AiSchoolCostStatus[]; trialDefaultCeilingMicros: number; asOf: string }

const isReason = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isCeiling = (v: unknown): v is number => isCount(v, AI_SCHOOL_MAX_CEILING_MICROS);

export function validateAiSchoolCostLimitInput(value: unknown): AiSchoolCostLimitInput {
  const r = record(value, invalid); exactKeys(r, ['schoolId', 'ceilingMicros', 'paused', 'reason', 'expectedVersion'], invalid);
  if (!isUuid(r.schoolId) || !isCeiling(r.ceilingMicros) || typeof r.paused !== 'boolean' || !isReason(r.reason) || !isCount(r.expectedVersion, 999_999_999)) invalid();
  return { schoolId: r.schoolId, ceilingMicros: r.ceilingMicros, paused: r.paused, reason: r.reason, expectedVersion: r.expectedVersion };
}

export function validateAiSchoolCostLimitReceipt(value: unknown): AiSchoolCostLimitReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'organizationId', 'ceilingMicros', 'paused', 'version', 'replayed'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || !isCeiling(r.ceilingMicros) || typeof r.paused !== 'boolean'
    || !Number.isSafeInteger(r.version) || (r.version as number) < 1 || typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiSchoolCostLimitReceipt;
}

function validateStatus(value: unknown): AiSchoolCostStatus {
  const r = record(value, drift);
  exactKeys(r, ['schoolId', 'organizationId', 'schoolName', 'ceilingMicros', 'defaultCeiling', 'trial', 'paused', 'reason', 'version', 'recordedCostMicros',
    'committedCostMicros', 'usedBasisPoints', 'level', 'windowStart', 'windowEnd'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || typeof r.schoolName !== 'string' || r.schoolName.length < 1 || r.schoolName.length > 300
    || !(r.ceilingMicros === null || isCeiling(r.ceilingMicros)) || typeof r.defaultCeiling !== 'boolean' || typeof r.trial !== 'boolean' || typeof r.paused !== 'boolean' || !isCount(r.version)
    || !isCount(r.recordedCostMicros) || !isCount(r.committedCostMicros) || r.recordedCostMicros > r.committedCostMicros
    || !(r.usedBasisPoints === null ? r.ceilingMicros === null : r.ceilingMicros !== null && isCount(r.usedBasisPoints, 1_000_000)) || !(AI_SCHOOL_COST_LEVELS as readonly unknown[]).includes(r.level)
    || !isTimestamp(r.windowStart) || !isTimestamp(r.windowEnd) || Date.parse(r.windowStart) >= Date.parse(r.windowEnd)) drift();
  // No record: $15 on a live trial, no ceiling when paying; not paused, no reason. A record always carries its reason.
  const kindDefault = r.trial ? AI_SCHOOL_TRIAL_DEFAULT_CEILING_MICROS : null;
  if (r.defaultCeiling ? !(r.version === 0 && r.ceilingMicros === kindDefault && r.paused === false && r.reason === null)
    : !((r.version as number) >= 1 && isReason(r.reason))) drift();
  if (r.level !== aiSchoolCostLevel(r.committedCostMicros as number, r.ceilingMicros as number | null)) drift();
  return r as unknown as AiSchoolCostStatus;
}

/** The same thresholds as the database (hon.ai_school_cost_level): 75%, 90% and 100% of the ceiling. */
export function aiSchoolCostLevel(committed: number, ceiling: number | null): AiSchoolCostLevel {
  if (ceiling === null) return 'NO_CEILING';
  if (committed >= ceiling) return 'CEILING_REACHED';
  if (committed * 10 >= ceiling * 9) return 'WARNING_90';
  if (committed * 4 >= ceiling * 3) return 'WARNING_75';
  return 'NORMAL';
}

export function validateAiSchoolCostStatusList(value: unknown): AiSchoolCostStatusList {
  const r = record(value, drift); exactKeys(r, ['schools', 'trialDefaultCeilingMicros', 'asOf'], drift);
  if (!Array.isArray(r.schools) || r.schools.length > 500 || r.trialDefaultCeilingMicros !== AI_SCHOOL_TRIAL_DEFAULT_CEILING_MICROS || !isTimestamp(r.asOf)) drift();
  const schools = r.schools.map(validateStatus);
  if (new Set(schools.map((s) => s.schoolId)).size !== schools.length) drift();
  return { schools, trialDefaultCeilingMicros: AI_SCHOOL_TRIAL_DEFAULT_CEILING_MICROS, asOf: r.asOf };
}

// ---------- 0343: HQ alerts at 75%, 90% and 100% of a school's ceiling, and HQ-owner acknowledgement ----------
export const AI_SCHOOL_COST_ALERT_LEVELS = ['WARNING_75', 'WARNING_90', 'CEILING_REACHED'] as const;
export type AiSchoolCostAlertLevel = typeof AI_SCHOOL_COST_ALERT_LEVELS[number];
const alertRank = (level: AiSchoolCostLevel): number => ({ NO_CEILING: 0, NORMAL: 0, WARNING_75: 1, WARNING_90: 2, CEILING_REACHED: 3 })[level];
/** One reached level of one school in its current budget window. crossedAt is null while only in-flight holds reach it. */
export interface AiSchoolCostAlert {
  schoolId: string; organizationId: string; schoolName: string; trial: boolean; level: AiSchoolCostAlertLevel; ceilingMicros: number;
  committedCostMicros: number; usedBasisPoints: number; crossedAt: string | null; windowStart: string;
  acknowledgement: { acknowledgedAt: string; reason: string } | null;
}
/** Open alerts first; at most 500. openCount counts every open alert, including any beyond the list. */
export interface AiSchoolCostAlertList { alerts: AiSchoolCostAlert[]; openCount: number; asOf: string }
export interface AiSchoolCostAlertAckInput { schoolId: string; level: AiSchoolCostAlertLevel; windowStart: string; reason: string }
export interface AiSchoolCostAlertAckReceipt { schoolId: string; organizationId: string; level: AiSchoolCostAlertLevel; windowStart: string; acknowledgedAt: string; replayed: boolean }

const isAlertLevel = (v: unknown): v is AiSchoolCostAlertLevel => (AI_SCHOOL_COST_ALERT_LEVELS as readonly unknown[]).includes(v);

export function validateAiSchoolCostAlertAckInput(value: unknown): AiSchoolCostAlertAckInput {
  const r = record(value, invalid); exactKeys(r, ['schoolId', 'level', 'windowStart', 'reason'], invalid);
  if (!isUuid(r.schoolId) || !isAlertLevel(r.level) || !isTimestamp(r.windowStart) || !isReason(r.reason)) invalid();
  return { schoolId: r.schoolId, level: r.level, windowStart: r.windowStart, reason: r.reason };
}

export function validateAiSchoolCostAlertAckReceipt(value: unknown): AiSchoolCostAlertAckReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'organizationId', 'level', 'windowStart', 'acknowledgedAt', 'replayed'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || !isAlertLevel(r.level) || !isTimestamp(r.windowStart) || !isTimestamp(r.acknowledgedAt)
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiSchoolCostAlertAckReceipt;
}

function validateAlert(value: unknown): AiSchoolCostAlert {
  const r = record(value, drift);
  exactKeys(r, ['schoolId', 'organizationId', 'schoolName', 'trial', 'level', 'ceilingMicros', 'committedCostMicros', 'usedBasisPoints', 'crossedAt',
    'windowStart', 'acknowledgement'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || typeof r.schoolName !== 'string' || r.schoolName.length < 1 || r.schoolName.length > 300
    || typeof r.trial !== 'boolean' || !isAlertLevel(r.level) || !isCeiling(r.ceilingMicros) || (r.ceilingMicros as number) < 1
    || !isCount(r.committedCostMicros) || !isCount(r.usedBasisPoints, 1_000_000)
    || !(r.crossedAt === null || isTimestamp(r.crossedAt)) || !isTimestamp(r.windowStart)) drift();
  // The level must actually be reached by the committed cost, with the database's thresholds.
  if (alertRank(aiSchoolCostLevel(r.committedCostMicros as number, r.ceilingMicros as number)) < alertRank(r.level as AiSchoolCostLevel)) drift();
  if (r.usedBasisPoints !== Math.min(Math.floor((r.committedCostMicros as number) * 10000 / (r.ceilingMicros as number)), 1_000_000)) drift();
  if (r.crossedAt !== null && Date.parse(r.crossedAt as string) < Date.parse(r.windowStart as string)) drift();
  if (r.acknowledgement !== null) {
    const k = record(r.acknowledgement, drift); exactKeys(k, ['acknowledgedAt', 'reason'], drift);
    if (!isTimestamp(k.acknowledgedAt) || !isReason(k.reason)) drift();
  }
  return r as unknown as AiSchoolCostAlert;
}

export function validateAiSchoolCostAlertList(value: unknown): AiSchoolCostAlertList {
  const r = record(value, drift); exactKeys(r, ['alerts', 'openCount', 'asOf'], drift);
  if (!Array.isArray(r.alerts) || r.alerts.length > 500 || !isCount(r.openCount) || !isTimestamp(r.asOf)) drift();
  const alerts = r.alerts.map(validateAlert);
  if (new Set(alerts.map((a) => `${a.schoolId}:${a.level}`)).size !== alerts.length) drift();
  const open = alerts.filter((a) => a.acknowledgement === null).length;
  // Open alerts come first; openCount covers at least the open ones listed (exactly, when the list is not cut at 500).
  if (alerts.some((a, i) => i > 0 && a.acknowledgement === null && alerts[i - 1]?.acknowledgement !== null)) drift();
  if ((r.openCount as number) < open || (alerts.length < 500 && r.openCount !== open)) drift();
  return { alerts, openCount: r.openCount as number, asOf: r.asOf as string };
}
