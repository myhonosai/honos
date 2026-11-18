/**
 * G1 (0491): monthly goal plan. A monthly revenue goal broken down into renewals, upgrades, new enrollments, shows,
 * appointments and leads from the school's own records, with the rates used and how many records each is based on, and
 * pace through the month. Counts and money totals only; nothing is written. Doc: docs/architecture/MONTHLY_GOAL_PLANNER.md.
 */
export const MONTHLY_GOAL_RATE_KEYS = ['bookRate', 'showRate', 'closeRate', 'renewalRate'] as const;
export type MonthlyGoalRateKey = typeof MONTHLY_GOAL_RATE_KEYS[number];

export interface MonthlyGoalPlanQuery {
  month?: string; goalMinor?: number; currency?: string; historyMonths?: number;
  bookRate?: number; showRate?: number; closeRate?: number; renewalRate?: number;
  avgNewMinor?: number; plannedUpgrades?: number; upgradeValueMinor?: number;
}
export type MonthlyGoalSource = 'RECORDS' | 'OWNER' | 'INSUFFICIENT';
export interface MonthlyGoalRate {
  numerator: number; denominator: number; minimumRecords: number; recordValue: number | null; value: number | null; source: MonthlyGoalSource;
}
export type MonthlyGoalPaceStatus = 'MET' | 'ON_PACE' | 'BEHIND' | 'UNKNOWN';
export interface MonthlyGoalPaceLine {
  actual: number; needed: number | null; expectedByNow: number | null; remaining: number | null; perWeek: number | null; status: MonthlyGoalPaceStatus;
}
export const MONTHLY_GOAL_PACE_KEYS = ['collected', 'renewals', 'newEnrollments', 'shows', 'appointments', 'leads'] as const;
export type MonthlyGoalPaceKey = typeof MONTHLY_GOAL_PACE_KEYS[number];
export interface MonthlyGoalPlan {
  schemaVersion: 'MONTHLY_GOAL_PLAN_V1'; schoolId: string; timezone: string; month: string; currentMonth: string;
  from: string; to: string; generatedAt: string; elapsedShare: number; weeksLeft: number;
  history: { months: number; from: string; to: string };
  /** Average monthly collected over the last 3 complete months, per currency, rounded to whole units. A suggestion only. */
  suggestedGoals: { currency: string; monthlyMinor: number; months: number }[];
  goal: { currency: string; goalMinor: number } | null;
  rates: { renewal: MonthlyGoalRate; book: MonthlyGoalRate; show: MonthlyGoalRate; close: MonthlyGoalRate };
  renewals: { due: number; renewed: number; cancelled: number; lapsed: number; open: number; openPriced: number;
    openValueMinor: number | null; expectedRenewals: number | null; expectedValueMinor: number | null };
  averageNewMembership: { records: number; minimumRecords: number; recordValueMinor: number | null; valueMinor: number | null; source: MonthlyGoalSource } | null;
  sources: { collectedMinor: number; scheduled: { schedules: number; valueMinor: number }; renewalsMinor: number | null;
    upgrades: { planned: number; valueEachMinor: number | null; valueMinor: number }; gapMinor: number | null } | null;
  needed: { renewals: number | null; upgrades: number; newEnrollments: number | null; shows: number | null; appointments: number | null; leads: number | null } | null;
  pace: Record<MonthlyGoalPaceKey, MonthlyGoalPaceLine> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;
const RATE = /^(1|0\.\d{1,4}|1\.0{1,4})$/;
const QUERY_KEYS = ['month', 'goalMinor', 'currency', 'historyMonths', ...MONTHLY_GOAL_RATE_KEYS, 'avgNewMinor', 'plannedUpgrades', 'upgradeValueMinor'] as const;

function invalid(): never { throw new Error('VALIDATION_FAILED'); }
function fail(): never { throw new Error('Unverified monthly goal plan.'); }

function intText(raw: unknown, pattern: RegExp, min: number, max: number): number {
  if (typeof raw !== 'string' || !pattern.test(raw)) invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

/** Query string to input. Every key optional; goalMinor needs currency and plannedUpgrades needs upgradeValueMinor. */
export function validateMonthlyGoalPlanQuery(value: unknown): MonthlyGoalPlanQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !(QUERY_KEYS as readonly string[]).includes(key))) invalid();
  const out: MonthlyGoalPlanQuery = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw === undefined) continue;
    if (typeof raw !== 'string') invalid();
    if (key === 'month') { if (!MONTH.test(raw)) invalid(); out.month = raw; }
    else if (key === 'currency') { if (!CURRENCY.test(raw)) invalid(); out.currency = raw; }
    else if (key === 'historyMonths') out.historyMonths = intText(raw, /^(3|4|5|6|7|8|9|10|11|12)$/, 3, 12);
    else if (key === 'goalMinor') out.goalMinor = intText(raw, /^(0|[1-9]\d{0,10})$/, 0, 10_000_000_000);
    else if (key === 'avgNewMinor' || key === 'upgradeValueMinor') out[key] = intText(raw, /^[1-9]\d{0,10}$/, 1, 10_000_000_000);
    else if (key === 'plannedUpgrades') out.plannedUpgrades = intText(raw, /^(0|[1-9]\d{0,3})$/, 0, 9999);
    else { if (!RATE.test(raw) || Number(raw) <= 0) invalid(); out[key as MonthlyGoalRateKey] = Number(raw); }
  }
  if ((out.goalMinor === undefined) !== (out.currency === undefined)) invalid();
  if ((out.plannedUpgrades === undefined) !== (out.upgradeValueMinor === undefined)) invalid();
  return out;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) fail();
  return source;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function maybeCount(value: unknown): number | null { return value === null ? null : count(value); }
function share(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value;
}
function maybeShare(value: unknown): number | null { return value === null ? null : share(value); }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !UTC.test(value) || new Date(value).toISOString() !== value) fail();
  return value;
}
function month(value: unknown): string { if (typeof value !== 'string' || !MONTH.test(value)) fail(); return value; }
function source(value: unknown): MonthlyGoalSource {
  if (value !== 'RECORDS' && value !== 'OWNER' && value !== 'INSUFFICIENT') fail();
  return value;
}
function rate(value: unknown, owner: number | undefined): MonthlyGoalRate {
  const r = exact(value, ['numerator', 'denominator', 'minimumRecords', 'recordValue', 'value', 'source']);
  const out = { numerator: count(r.numerator), denominator: count(r.denominator), minimumRecords: count(r.minimumRecords),
    recordValue: maybeShare(r.recordValue), value: maybeShare(r.value), source: source(r.source) };
  if (out.numerator > out.denominator) fail();
  if ((owner !== undefined) !== (out.source === 'OWNER') || (owner !== undefined && out.value !== owner)) fail();
  if ((out.source === 'INSUFFICIENT') !== (out.value === null)) fail();
  return out;
}
function pace(value: unknown): MonthlyGoalPaceLine {
  const p = exact(value, ['actual', 'needed', 'expectedByNow', 'remaining', 'perWeek', 'status']);
  if (p.status !== 'MET' && p.status !== 'ON_PACE' && p.status !== 'BEHIND' && p.status !== 'UNKNOWN') fail();
  const out = { actual: count(p.actual), needed: maybeCount(p.needed), expectedByNow: maybeCount(p.expectedByNow),
    remaining: maybeCount(p.remaining), perWeek: maybeCount(p.perWeek), status: p.status as MonthlyGoalPaceStatus };
  if ((out.needed === null) !== (out.status === 'UNKNOWN')) fail();
  return out;
}

export function verifyMonthlyGoalPlan(value: unknown, expectedSchoolId: string, query: MonthlyGoalPlanQuery): MonthlyGoalPlan {
  const s = exact(value, ['schemaVersion', 'schoolId', 'timezone', 'month', 'currentMonth', 'from', 'to', 'generatedAt', 'elapsedShare', 'weeksLeft',
    'history', 'suggestedGoals', 'goal', 'rates', 'renewals', 'averageNewMembership', 'sources', 'needed', 'pace']);
  if (s.schemaVersion !== 'MONTHLY_GOAL_PLAN_V1') fail();
  if (typeof s.schoolId !== 'string' || !UUID.test(s.schoolId) || s.schoolId.toLowerCase() !== expectedSchoolId.toLowerCase()) fail();
  if (typeof s.timezone !== 'string' || !s.timezone || s.timezone.length > 64) fail();
  const planMonth = month(s.month), currentMonth = month(s.currentMonth);
  if (query.month !== undefined && planMonth !== query.month) fail();
  if (query.month === undefined && planMonth !== currentMonth) fail();
  const from = instant(s.from), to = instant(s.to);
  if (Date.parse(to) <= Date.parse(from)) fail();
  const h = exact(s.history, ['months', 'from', 'to']);
  const history = { months: count(h.months), from: instant(h.from), to: instant(h.to) };
  if (history.months !== (query.historyMonths ?? 6)) fail();
  if (!Array.isArray(s.suggestedGoals) || s.suggestedGoals.length > 10) fail();
  const suggestedGoals = s.suggestedGoals.map(item => {
    const g = exact(item, ['currency', 'monthlyMinor', 'months']);
    if (typeof g.currency !== 'string' || !CURRENCY.test(g.currency)) fail();
    const monthlyMinor = g.monthlyMinor as number;
    if (typeof monthlyMinor !== 'number' || !Number.isSafeInteger(monthlyMinor)) fail();
    return { currency: g.currency, monthlyMinor, months: count(g.months) };
  });
  const hasGoal = query.goalMinor !== undefined;
  let goal: MonthlyGoalPlan['goal'] = null;
  if (hasGoal) {
    const g = exact(s.goal, ['currency', 'goalMinor']);
    if (g.currency !== query.currency || g.goalMinor !== query.goalMinor) fail();
    goal = { currency: query.currency!, goalMinor: query.goalMinor! };
  } else if (s.goal !== null) fail();
  const r = exact(s.rates, ['renewal', 'book', 'show', 'close']);
  const rates = { renewal: rate(r.renewal, query.renewalRate), book: rate(r.book, query.bookRate), show: rate(r.show, query.showRate), close: rate(r.close, query.closeRate) };
  const n = exact(s.renewals, ['due', 'renewed', 'cancelled', 'lapsed', 'open', 'openPriced', 'openValueMinor', 'expectedRenewals', 'expectedValueMinor']);
  const renewals = { due: count(n.due), renewed: count(n.renewed), cancelled: count(n.cancelled), lapsed: count(n.lapsed), open: count(n.open),
    openPriced: count(n.openPriced), openValueMinor: maybeCount(n.openValueMinor), expectedRenewals: maybeCount(n.expectedRenewals),
    expectedValueMinor: maybeCount(n.expectedValueMinor) };
  if (renewals.renewed + renewals.cancelled + renewals.lapsed + renewals.open !== renewals.due || renewals.openPriced > renewals.open) fail();
  if (renewals.expectedRenewals !== null && renewals.expectedRenewals > renewals.open) fail();
  const withCurrency = query.currency !== undefined;
  let averageNewMembership: MonthlyGoalPlan['averageNewMembership'] = null;
  let sources: MonthlyGoalPlan['sources'] = null;
  if (withCurrency) {
    const a = exact(s.averageNewMembership, ['records', 'minimumRecords', 'recordValueMinor', 'valueMinor', 'source']);
    averageNewMembership = { records: count(a.records), minimumRecords: count(a.minimumRecords), recordValueMinor: maybeCount(a.recordValueMinor),
      valueMinor: maybeCount(a.valueMinor), source: source(a.source) };
    if ((query.avgNewMinor !== undefined) !== (averageNewMembership.source === 'OWNER')) fail();
    const o = exact(s.sources, ['collectedMinor', 'scheduled', 'renewalsMinor', 'upgrades', 'gapMinor']);
    const sc = exact(o.scheduled, ['schedules', 'valueMinor']);
    const up = exact(o.upgrades, ['planned', 'valueEachMinor', 'valueMinor']);
    const collectedMinor = o.collectedMinor as number;
    if (typeof collectedMinor !== 'number' || !Number.isSafeInteger(collectedMinor)) fail();
    sources = { collectedMinor, scheduled: { schedules: count(sc.schedules), valueMinor: count(sc.valueMinor) }, renewalsMinor: maybeCount(o.renewalsMinor),
      upgrades: { planned: count(up.planned), valueEachMinor: maybeCount(up.valueEachMinor), valueMinor: count(up.valueMinor) }, gapMinor: maybeCount(o.gapMinor) };
    if (sources.upgrades.planned !== (query.plannedUpgrades ?? 0)) fail();
  } else if (s.averageNewMembership !== null || s.sources !== null || renewals.openValueMinor !== null || renewals.expectedValueMinor !== null) fail();
  let needed: MonthlyGoalPlan['needed'] = null;
  if (hasGoal) {
    const d = exact(s.needed, ['renewals', 'upgrades', 'newEnrollments', 'shows', 'appointments', 'leads']);
    needed = { renewals: maybeCount(d.renewals), upgrades: count(d.upgrades), newEnrollments: maybeCount(d.newEnrollments), shows: maybeCount(d.shows),
      appointments: maybeCount(d.appointments), leads: maybeCount(d.leads) };
  } else if (s.needed !== null) fail();
  let paceLines: MonthlyGoalPlan['pace'] = null;
  if (s.pace !== null) {
    if (!hasGoal) fail();
    const p = exact(s.pace, MONTHLY_GOAL_PACE_KEYS);
    paceLines = Object.fromEntries(MONTHLY_GOAL_PACE_KEYS.map(key => [key, pace(p[key])])) as Record<MonthlyGoalPaceKey, MonthlyGoalPaceLine>;
  }
  return { schemaVersion: 'MONTHLY_GOAL_PLAN_V1', schoolId: s.schoolId.toLowerCase(), timezone: s.timezone, month: planMonth, currentMonth, from, to,
    generatedAt: instant(s.generatedAt), elapsedShare: share(s.elapsedShare), weeksLeft: count(s.weeksLeft), history, suggestedGoals, goal, rates,
    renewals, averageNewMembership, sources, needed, pace: paceLines };
}
