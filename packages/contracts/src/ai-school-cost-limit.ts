// R2 (0244) per-school internal AI cost ceiling and single-school pause. HQ only. This is HON's internal provider cost
// for the included AI team, never a customer balance, credits or a charge. The database decides authority: a human HQ
// owner may change a school's ceiling or pause it; HQ billing staff may read.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const AI_SCHOOL_COST_LEVELS = ['NORMAL', 'WARNING_75', 'WARNING_90', 'CEILING_REACHED'] as const;
export type AiSchoolCostLevel = typeof AI_SCHOOL_COST_LEVELS[number];
/** $15 in micro-USD: the default monthly ceiling when HQ has not set one. */
export const AI_SCHOOL_DEFAULT_CEILING_MICROS = 15_000_000;
export const AI_SCHOOL_MAX_CEILING_MICROS = 1_000_000_000;

/** expectedVersion 0 = the school has no record yet (default ceiling, not paused). */
export interface AiSchoolCostLimitInput { schoolId: string; ceilingMicros: number; paused: boolean; reason: string; expectedVersion: number }
export interface AiSchoolCostLimitReceipt { schoolId: string; organizationId: string; ceilingMicros: number; paused: boolean; version: number; replayed: boolean }
export interface AiSchoolCostStatus {
  schoolId: string; organizationId: string; schoolName: string; ceilingMicros: number; defaultCeiling: boolean; paused: boolean;
  reason: string | null; version: number; recordedCostMicros: number; committedCostMicros: number; usedBasisPoints: number;
  level: AiSchoolCostLevel; windowStart: string; windowEnd: string;
}
/** At most 500 schools, highest use first. */
export interface AiSchoolCostStatusList { schools: AiSchoolCostStatus[]; defaultCeilingMicros: number; asOf: string }

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
  exactKeys(r, ['schoolId', 'organizationId', 'schoolName', 'ceilingMicros', 'defaultCeiling', 'paused', 'reason', 'version', 'recordedCostMicros',
    'committedCostMicros', 'usedBasisPoints', 'level', 'windowStart', 'windowEnd'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || typeof r.schoolName !== 'string' || r.schoolName.length < 1 || r.schoolName.length > 300
    || !isCeiling(r.ceilingMicros) || typeof r.defaultCeiling !== 'boolean' || typeof r.paused !== 'boolean' || !isCount(r.version)
    || !isCount(r.recordedCostMicros) || !isCount(r.committedCostMicros) || r.recordedCostMicros > r.committedCostMicros
    || !isCount(r.usedBasisPoints, 1_000_000) || !(AI_SCHOOL_COST_LEVELS as readonly unknown[]).includes(r.level)
    || !isTimestamp(r.windowStart) || !isTimestamp(r.windowEnd) || Date.parse(r.windowStart) >= Date.parse(r.windowEnd)) drift();
  // No record: the default ceiling, not paused, no reason. A record always carries its reason.
  if (r.defaultCeiling ? !(r.version === 0 && r.ceilingMicros === AI_SCHOOL_DEFAULT_CEILING_MICROS && r.paused === false && r.reason === null)
    : !((r.version as number) >= 1 && isReason(r.reason))) drift();
  if (r.level !== aiSchoolCostLevel(r.committedCostMicros as number, r.ceilingMicros as number)) drift();
  return r as unknown as AiSchoolCostStatus;
}

/** The same thresholds as the database (hon.ai_school_cost_level): 75%, 90% and 100% of the ceiling. */
export function aiSchoolCostLevel(committed: number, ceiling: number): AiSchoolCostLevel {
  if (committed >= ceiling) return 'CEILING_REACHED';
  if (committed * 10 >= ceiling * 9) return 'WARNING_90';
  if (committed * 4 >= ceiling * 3) return 'WARNING_75';
  return 'NORMAL';
}

export function validateAiSchoolCostStatusList(value: unknown): AiSchoolCostStatusList {
  const r = record(value, drift); exactKeys(r, ['schools', 'defaultCeilingMicros', 'asOf'], drift);
  if (!Array.isArray(r.schools) || r.schools.length > 500 || r.defaultCeilingMicros !== AI_SCHOOL_DEFAULT_CEILING_MICROS || !isTimestamp(r.asOf)) drift();
  const schools = r.schools.map(validateStatus);
  if (new Set(schools.map((s) => s.schoolId)).size !== schools.length) drift();
  return { schools, defaultCeilingMicros: AI_SCHOOL_DEFAULT_CEILING_MICROS, asOf: r.asOf };
}
