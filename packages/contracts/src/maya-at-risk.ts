/**
 * Maya M1 (0259): the current school's students at risk of quitting, each with the record-derived reasons behind a
 * 0-100 ranking score and one suggested next step. Read-only; no AI is called and nothing is sent or changed.
 */
export const MAYA_RISK_LEVELS = ['HIGH', 'MEDIUM', 'WATCH'] as const;
export type MayaRiskLevel = (typeof MAYA_RISK_LEVELS)[number];
export const MAYA_NEXT_STEPS = ['CALL_TO_CHECK_IN', 'INVITE_BACK_TO_CLASS', 'PLAN_PROGRESS_TALK', 'REVIEW_TUITION_BALANCE', 'DISCUSS_RENEWAL'] as const;
export type MayaNextStep = (typeof MAYA_NEXT_STEPS)[number];
export const MAYA_MEMBERSHIP_STATES = ['ACTIVE', 'FROZEN', 'CANCELLATION_PENDING'] as const;
export type MayaMembershipState = (typeof MAYA_MEMBERSHIP_STATES)[number];

export type MayaRiskFactor =
  | { code: 'LONG_ABSENCE'; points: 30 | 45; daysSinceLastAttendance: number | null; neverAttended: boolean }
  | { code: 'ATTENDANCE_DROP'; points: 25; last28Days: number; previous28Days: number }
  | { code: 'NO_RANK_PROGRESS'; points: 15; daysSinceProgress: number }
  | { code: 'TUITION_OVERDUE'; points: 20; overdueInvoiceCount: number }
  | { code: 'TERM_ENDING'; points: 20; cancellationPending: boolean; termEndsOn: string | null };
export type MayaRiskFactorCode = MayaRiskFactor['code'];

export interface MayaAtRiskStudent {
  membershipId: string; givenName: string; familyName: string; membershipState: MayaMembershipState;
  score: number; level: MayaRiskLevel; factors: MayaRiskFactor[]; suggestedNextStep: MayaNextStep;
}
export interface MayaAtRiskStudents {
  schemaVersion: 'MAYA_AT_RISK_V1'; asOf: string; localToday: string; tuitionChecked: boolean;
  counts: Record<MayaRiskLevel, number>; items: MayaAtRiskStudent[]; nextAfter: string | null;
}
export interface MayaAtRiskQuery { after?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^(100|[1-9][0-9]|[0-9]):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STEP_FOR: Record<MayaRiskFactorCode, MayaNextStep> = {
  LONG_ABSENCE: 'CALL_TO_CHECK_IN', ATTENDANCE_DROP: 'INVITE_BACK_TO_CLASS', NO_RANK_PROGRESS: 'PLAN_PROGRESS_TALK',
  TUITION_OVERDUE: 'REVIEW_TUITION_BALANCE', TERM_ENDING: 'DISCUSS_RENEWAL',
};
/** Tie order after points (0259 header). */
const ORDER: MayaRiskFactorCode[] = ['LONG_ABSENCE', 'TUITION_OVERDUE', 'TERM_ENDING', 'ATTENDANCE_DROP', 'NO_RANK_PROGRESS'];

function invalid(): never { throw new Error('Invalid Maya at-risk data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row);
  if (actual.length !== keys.length || keys.some(key => !actual.includes(key))) invalid();
  return row;
}
function count(value: unknown, maximum = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || CONTROL.test(value)) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

export function validateMayaAtRiskQuery(value: unknown): MayaAtRiskQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'after')) invalid();
  if (row.after === undefined) return {};
  if (typeof row.after !== 'string' || !CURSOR.test(row.after)) invalid();
  return { after: row.after.toLowerCase() };
}

function factor(value: unknown): MayaRiskFactor {
  const code = oneOf((value as { code?: unknown } | null)?.code, ORDER);
  switch (code) {
    case 'LONG_ABSENCE': {
      const row = record(value, ['code', 'points', 'daysSinceLastAttendance', 'neverAttended']);
      const never = bool(row.neverAttended);
      if (never ? row.points !== 30 || row.daysSinceLastAttendance !== null : row.points !== (count(row.daysSinceLastAttendance) >= 30 ? 45 : 30)) invalid();
      if (!never && (row.daysSinceLastAttendance as number) < 14) invalid();
      return { code, points: row.points as 30 | 45, daysSinceLastAttendance: never ? null : row.daysSinceLastAttendance as number, neverAttended: never };
    }
    case 'ATTENDANCE_DROP': {
      const row = record(value, ['code', 'points', 'last28Days', 'previous28Days']);
      const last = count(row.last28Days), previous = count(row.previous28Days);
      if (row.points !== 25 || previous < 4 || last * 2 >= previous) invalid();
      return { code, points: 25, last28Days: last, previous28Days: previous };
    }
    case 'NO_RANK_PROGRESS': {
      const row = record(value, ['code', 'points', 'daysSinceProgress']);
      if (row.points !== 15 || count(row.daysSinceProgress) < 180) invalid();
      return { code, points: 15, daysSinceProgress: row.daysSinceProgress as number };
    }
    case 'TUITION_OVERDUE': {
      const row = record(value, ['code', 'points', 'overdueInvoiceCount']);
      if (row.points !== 20 || count(row.overdueInvoiceCount) < 1) invalid();
      return { code, points: 20, overdueInvoiceCount: row.overdueInvoiceCount as number };
    }
    case 'TERM_ENDING': {
      const row = record(value, ['code', 'points', 'cancellationPending', 'termEndsOn']);
      const pending = bool(row.cancellationPending);
      const ends = row.termEndsOn === null ? null : date(row.termEndsOn);
      if (row.points !== 20 || (!pending && ends === null)) invalid();
      return { code, points: 20, cancellationPending: pending, termEndsOn: ends };
    }
  }
}

function level(score: number): MayaRiskLevel { return score >= 50 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'WATCH'; }

function student(value: unknown, tuitionChecked: boolean): MayaAtRiskStudent {
  const row = record(value, ['membershipId', 'givenName', 'familyName', 'membershipState', 'score', 'level', 'factors', 'suggestedNextStep']);
  if (typeof row.membershipId !== 'string' || !UUID.test(row.membershipId)) invalid();
  if (!Array.isArray(row.factors) || row.factors.length < 1 || row.factors.length > 5) invalid();
  const factors = row.factors.map(factor);
  const state = oneOf(row.membershipState, MAYA_MEMBERSHIP_STATES);
  const codes = factors.map(item => item.code);
  if (new Set(codes).size !== codes.length) invalid();
  if (!tuitionChecked && codes.includes('TUITION_OVERDUE')) invalid();
  if (state === 'FROZEN' && (codes.includes('LONG_ABSENCE') || codes.includes('ATTENDANCE_DROP'))) invalid();
  if (state === 'CANCELLATION_PENDING' && !codes.includes('TERM_ENDING')) invalid();
  // Factors arrive most points first, then in the fixed tie order; the score and step follow from them.
  for (let index = 1; index < factors.length; index += 1) {
    const before = factors[index - 1]!, after = factors[index]!;
    if (before.points < after.points || (before.points === after.points && ORDER.indexOf(before.code) > ORDER.indexOf(after.code))) invalid();
  }
  const score = Math.min(100, factors.reduce((sum, item) => sum + item.points, 0));
  if (row.score !== score || score < 15 || row.level !== level(score) || row.suggestedNextStep !== STEP_FOR[factors[0]!.code]) invalid();
  return {
    membershipId: row.membershipId.toLowerCase(), givenName: name(row.givenName), familyName: name(row.familyName), membershipState: state,
    score, level: level(score), factors, suggestedNextStep: STEP_FOR[factors[0]!.code],
  };
}

export function verifyMayaAtRiskStudents(value: unknown): MayaAtRiskStudents {
  const row = record(value, ['schemaVersion', 'asOf', 'localToday', 'tuitionChecked', 'counts', 'items', 'nextAfter']);
  if (row.schemaVersion !== 'MAYA_AT_RISK_V1') invalid();
  const tuitionChecked = bool(row.tuitionChecked);
  const counts = record(row.counts, MAYA_RISK_LEVELS);
  if (!Array.isArray(row.items) || row.items.length > 50) invalid();
  const items = row.items.map(item => student(item, tuitionChecked));
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1]!, after = items[index]!;
    if (before.score < after.score || (before.score === after.score && before.membershipId >= after.membershipId)) invalid();
  }
  const nextAfter = row.nextAfter === null ? null : (typeof row.nextAfter === 'string' && CURSOR.test(row.nextAfter) ? row.nextAfter : invalid());
  const last = items.at(-1);
  if (nextAfter !== null && (items.length !== 50 || !last || nextAfter.toLowerCase() !== `${last.score}:${last.membershipId}`)) invalid();
  return {
    schemaVersion: 'MAYA_AT_RISK_V1', asOf: instant(row.asOf), localToday: date(row.localToday), tuitionChecked,
    counts: { HIGH: count(counts.HIGH), MEDIUM: count(counts.MEDIUM), WATCH: count(counts.WATCH) }, items, nextAfter,
  };
}
