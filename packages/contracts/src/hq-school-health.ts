// B-HQ-2b HQ school health (migration 0233): read-only activity counts per school and advisory signals derived only from
// those counts. Names no person, shows no money. Readers: HQ owner, HQ operator with hq.billing.manage, or HQ staff with
// hq.support.manage. Signals are hints for a person to look; they never decide or change anything.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const HQ_SCHOOL_HEALTH_SIGNALS = ['NO_ACTIVE_STUDENTS', 'NO_ATTENDANCE_14_DAYS', 'ATTENDANCE_DOWN', 'NO_CLASSES_NEXT_14_DAYS',
  'NO_NEW_LEADS_30_DAYS', 'OPEN_SUPPORT_CASES'] as const;
export type HqSchoolHealthSignal = typeof HQ_SCHOOL_HEALTH_SIGNALS[number];
export const HQ_ATTENTION_LIMIT_MAX = 200;

export interface HqSchoolHealthFacts {
  attendance: { last30Days: number; previous30Days: number; lastRecordedAt: string | null };
  classes: { heldLast30Days: number; scheduledNext14Days: number };
  bookingsLast30Days: number;
  leads: { newLast30Days: number; newPrevious30Days: number; wonLast30Days: number; open: number };
  activeStudents: number;
  openSupportCases: number;
  signals: HqSchoolHealthSignal[];
}
export interface HqSchoolHealth { schoolId: string; health: HqSchoolHealthFacts; asOf: string }
export interface HqSchoolAttentionRow { schoolId: string; schoolDisplayName: string; organizationId: string; organizationDisplayName: string; health: HqSchoolHealthFacts }
export interface HqSchoolsNeedingAttention { schools: HqSchoolAttentionRow[]; checked: number; flagged: number; truncated: boolean; limit: number; asOf: string }

const COUNT_MAX = 100_000_000;
const count = (v: unknown) => isInt(v, 0, COUNT_MAX);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** The facts must be closed, and every signal must follow from the counts beside it (the 0233 rules). */
export function validateHqSchoolHealthFacts(value: unknown): HqSchoolHealthFacts {
  const h = record(value, drift);
  exactKeys(h, ['attendance', 'classes', 'bookingsLast30Days', 'leads', 'activeStudents', 'openSupportCases', 'signals'], drift);
  const a = record(h.attendance, drift); exactKeys(a, ['last30Days', 'previous30Days', 'lastRecordedAt'], drift);
  const c = record(h.classes, drift); exactKeys(c, ['heldLast30Days', 'scheduledNext14Days'], drift);
  const l = record(h.leads, drift); exactKeys(l, ['newLast30Days', 'newPrevious30Days', 'wonLast30Days', 'open'], drift);
  if (![a.last30Days, a.previous30Days, c.heldLast30Days, c.scheduledNext14Days, h.bookingsLast30Days, l.newLast30Days, l.newPrevious30Days,
    l.wonLast30Days, l.open, h.activeStudents, h.openSupportCases].every(count)) drift();
  if (a.lastRecordedAt !== null && !isTimestamp(a.lastRecordedAt)) drift();
  if (!Array.isArray(h.signals) || new Set(h.signals).size !== h.signals.length
    || !h.signals.every(s => (HQ_SCHOOL_HEALTH_SIGNALS as readonly unknown[]).includes(s))) drift();
  const signals = h.signals as string[], has = (s: HqSchoolHealthSignal) => signals.includes(s);
  // Signals the counts alone decide. NO_ATTENDANCE_14_DAYS depends on the read time, so only its precondition is checked.
  if (has('NO_ACTIVE_STUDENTS') !== (h.activeStudents === 0) || has('NO_CLASSES_NEXT_14_DAYS') !== (c.scheduledNext14Days === 0)
    || has('NO_NEW_LEADS_30_DAYS') !== (l.newLast30Days === 0) || has('OPEN_SUPPORT_CASES') !== ((h.openSupportCases as number) > 0)
    || has('ATTENDANCE_DOWN') !== ((a.previous30Days as number) >= 10 && (a.last30Days as number) * 2 < (a.previous30Days as number))
    || (has('NO_ATTENDANCE_14_DAYS') && h.activeStudents === 0)) drift();
  return h as unknown as HqSchoolHealthFacts;
}
export function validateHqSchoolHealth(value: unknown): HqSchoolHealth {
  const r = record(value, drift); exactKeys(r, ['schoolId', 'health', 'asOf'], drift);
  if (!isUuid(r.schoolId) || !isTimestamp(r.asOf)) drift();
  validateHqSchoolHealthFacts(r.health);
  return r as unknown as HqSchoolHealth;
}
export function validateHqSchoolsNeedingAttention(value: unknown): HqSchoolsNeedingAttention {
  const r = record(value, drift); exactKeys(r, ['schools', 'checked', 'flagged', 'truncated', 'limit', 'asOf'], drift);
  if (!Array.isArray(r.schools) || !count(r.checked) || !count(r.flagged) || typeof r.truncated !== 'boolean' || !isInt(r.limit, 1, HQ_ATTENTION_LIMIT_MAX)
    || !isTimestamp(r.asOf)) drift();
  const rows = r.schools as unknown[], flagged = r.flagged as number;
  if (rows.length > (r.limit as number) || rows.length !== Math.min(flagged, r.limit as number) || flagged > (r.checked as number)
    || r.truncated !== (flagged > (r.limit as number))) drift();
  let prior = Infinity;
  for (const value of rows) {
    const s = record(value, drift); exactKeys(s, ['schoolId', 'schoolDisplayName', 'organizationId', 'organizationDisplayName', 'health'], drift);
    if (!isUuid(s.schoolId) || !isUuid(s.organizationId) || !label(s.schoolDisplayName, 300) || !label(s.organizationDisplayName, 300)) drift();
    const n = validateHqSchoolHealthFacts(s.health).signals.length;
    if (n === 0 || n > prior) drift();
    prior = n;
  }
  if (new Set(rows.map(x => (x as { schoolId: string }).schoolId)).size !== rows.length) drift();
  return r as unknown as HqSchoolsNeedingAttention;
}
/** `limit` query: absent means 50; otherwise a whole number 1..200. */
export function validateHqAttentionQuery(value: unknown): { limit: number } {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => k !== 'limit')) invalid();
  if (q.limit === undefined) return { limit: 50 };
  if (typeof q.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(q.limit) || Number(q.limit) > HQ_ATTENTION_LIMIT_MAX) invalid();
  return { limit: Number(q.limit) };
}
