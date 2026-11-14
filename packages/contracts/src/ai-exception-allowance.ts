// 0353: AI for a school on a free HQ access exception, only under a monthly dollar limit the HQ owner sets (owner
// decision 2026-11-14). HQ only. The limit is HON's internal provider cost for the included AI team (HON and the AI
// team's text answers), never a customer balance, credits or a charge. Image and video stay off on an exception.
// The database decides authority: only a human HQ owner may set or clear a limit; HQ readers may read.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { AI_SCHOOL_COST_LEVELS, aiSchoolCostLevel, type AiSchoolCostLevel } from './ai-school-cost-limit.js';

/** Suggested default in the HQ screen: $25 a month, in micro-USD. Never applied automatically. */
export const AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS = 25_000_000;
/** $1 to $1,000 a month. */
export const AI_EXCEPTION_MIN_ALLOWANCE_MICROS = 1_000_000;
export const AI_EXCEPTION_MAX_ALLOWANCE_MICROS = 1_000_000_000;

/** ceilingMicros null clears the limit (the school returns to no AI). expectedVersion 0 = never set. */
export interface AiExceptionAllowanceInput { schoolId: string; ceilingMicros: number | null; reason: string; expectedVersion: number }
export interface AiExceptionAllowanceReceipt { schoolId: string; organizationId: string; exceptionId: string; ceilingMicros: number | null; version: number; replayed: boolean }
export interface AiExceptionAllowanceStatus {
  organizationId: string; schoolId: string; exceptionId: string; schoolName: string; exceptionStartsAt: string; exceptionExpiresAt: string;
  exceptionLive: boolean;
  /** The limit set for this exact exception, or null (never set for it, or cleared). */
  ceilingMicros: number | null;
  /** Whether AI is allowed right now (limit set, exception started, live and still owning the entitlement). */
  aiAllowed: boolean;
  version: number; reason: string | null; updatedAt: string | null; committedCostMicros: number; level: AiSchoolCostLevel; windowStart: string; windowEnd: string;
}
/** Every granted, unexpired exception (at most 500), soonest to end first. */
export interface AiExceptionAllowanceList { schools: AiExceptionAllowanceStatus[]; defaultCeilingMicros: number; asOf: string }

const isReason = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
export const isAiExceptionAllowance = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= AI_EXCEPTION_MIN_ALLOWANCE_MICROS && (v as number) <= AI_EXCEPTION_MAX_ALLOWANCE_MICROS;

export function validateAiExceptionAllowanceInput(value: unknown): AiExceptionAllowanceInput {
  const r = record(value, invalid); exactKeys(r, ['schoolId', 'ceilingMicros', 'reason', 'expectedVersion'], invalid);
  if (!isUuid(r.schoolId) || !(r.ceilingMicros === null || isAiExceptionAllowance(r.ceilingMicros)) || !isReason(r.reason) || !isCount(r.expectedVersion, 999_999_999)) invalid();
  return { schoolId: r.schoolId, ceilingMicros: r.ceilingMicros as number | null, reason: r.reason, expectedVersion: r.expectedVersion };
}

export function validateAiExceptionAllowanceReceipt(value: unknown): AiExceptionAllowanceReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'organizationId', 'exceptionId', 'ceilingMicros', 'version', 'replayed'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || !isUuid(r.exceptionId) || !(r.ceilingMicros === null || isAiExceptionAllowance(r.ceilingMicros))
    || !Number.isSafeInteger(r.version) || (r.version as number) < 1 || typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiExceptionAllowanceReceipt;
}

function validateStatus(value: unknown): AiExceptionAllowanceStatus {
  const r = record(value, drift);
  exactKeys(r, ['organizationId', 'schoolId', 'exceptionId', 'schoolName', 'exceptionStartsAt', 'exceptionExpiresAt', 'exceptionLive', 'ceilingMicros', 'aiAllowed',
    'version', 'reason', 'updatedAt', 'committedCostMicros', 'level', 'windowStart', 'windowEnd'], drift);
  if (!isUuid(r.organizationId) || !isUuid(r.schoolId) || !isUuid(r.exceptionId) || typeof r.schoolName !== 'string' || r.schoolName.length < 1 || r.schoolName.length > 300
    || !isTimestamp(r.exceptionStartsAt) || !isTimestamp(r.exceptionExpiresAt) || Date.parse(r.exceptionStartsAt) >= Date.parse(r.exceptionExpiresAt)
    || typeof r.exceptionLive !== 'boolean' || !(r.ceilingMicros === null || isAiExceptionAllowance(r.ceilingMicros)) || typeof r.aiAllowed !== 'boolean'
    || !isCount(r.version) || !isCount(r.committedCostMicros) || !(AI_SCHOOL_COST_LEVELS as readonly unknown[]).includes(r.level)
    || !isTimestamp(r.windowStart) || !isTimestamp(r.windowEnd) || Date.parse(r.windowStart) >= Date.parse(r.windowEnd)) drift();
  // Never set: no reason or time. Set at least once: both. AI is allowed only with a limit; the level is against the live limit.
  if (r.version === 0 ? !(r.reason === null && r.updatedAt === null && r.ceilingMicros === null) : !(isReason(r.reason) && isTimestamp(r.updatedAt))) drift();
  if (r.aiAllowed && r.ceilingMicros === null) drift();
  if (r.level !== aiSchoolCostLevel(r.committedCostMicros as number, r.aiAllowed ? r.ceilingMicros as number : null)) drift();
  return r as unknown as AiExceptionAllowanceStatus;
}

export function validateAiExceptionAllowanceList(value: unknown): AiExceptionAllowanceList {
  const r = record(value, drift); exactKeys(r, ['schools', 'defaultCeilingMicros', 'asOf'], drift);
  if (!Array.isArray(r.schools) || r.schools.length > 500 || r.defaultCeilingMicros !== AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS || !isTimestamp(r.asOf)) drift();
  const schools = r.schools.map(validateStatus);
  if (new Set(schools.map((s) => s.exceptionId)).size !== schools.length) drift();
  return { schools, defaultCeilingMicros: AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS, asOf: r.asOf };
}
