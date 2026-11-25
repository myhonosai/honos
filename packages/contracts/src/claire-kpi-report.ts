import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P4 (0643): Claire KPI report. A reporting user asks Claire for a KPI report on the last 7 or 30 days, with an optional focus.
 * The database counts nine fixed KPIs for that window and the one before it and keeps those exact numbers with the report;
 * Claire adds a summary, a note per KPI, things to watch and next actions on the shared AI text proposals (0550). Text only:
 * nothing is created, sent or changed. Spec: docs/architecture/CLAIRE_KPI_REPORT.md.
 */
export const CLAIRE_KPI_PERIODS = ['LAST_7_DAYS', 'LAST_30_DAYS'] as const;
export type ClaireKpiPeriod = typeof CLAIRE_KPI_PERIODS[number];
export const CLAIRE_KPI_CODES = ['NEW_LEADS', 'WON_LEADS', 'LOST_LEADS', 'REGISTRATIONS', 'NEW_MEMBERSHIPS', 'ENDED_MEMBERSHIPS', 'CLASSES_ATTENDED', 'STUDENTS_ATTENDING', 'ACTIVE_MEMBERSHIPS'] as const;
export type ClaireKpiCode = typeof CLAIRE_KPI_CODES[number];
export const CLAIRE_KPI_LIMITS = { inputTokens: 12000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxWatch: 4, maxActions: 4 } as const;

export interface ClaireKpiBrief { period: ClaireKpiPeriod; focus: string }
export interface ClaireKpiNumber { kpi: ClaireKpiCode; current: number; previous: number | null }
export interface ClaireKpiNote { kpi: ClaireKpiCode; note: string }
export interface ClaireKpiItem { title: string; detail: string }
export interface ClaireKpiProposal { summary: string; notes: ClaireKpiNote[]; watch: ClaireKpiItem[]; actions: ClaireKpiItem[] }
export interface ClaireKpiView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: ClaireKpiBrief; kpis: ClaireKpiNumber[];
  summary: string | null; notes: ClaireKpiNote[] | null; watch: ClaireKpiItem[] | null; actions: ClaireKpiItem[] | null;
  problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isCode = (v: unknown): v is ClaireKpiCode => typeof v === 'string' && (CLAIRE_KPI_CODES as readonly string[]).includes(v);
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Claire KPI report ${what}.`); };

/** The brief, exactly as the database takes it (0643 hon.claire_kpi_brief_ok). An empty focus is allowed. */
export function validateClaireKpiBrief(value: unknown): ClaireKpiBrief {
  if (!isObject(value) || !exactKeys(value, ['period', 'focus'])) return fail('brief');
  const { period, focus } = value;
  if (typeof period !== 'string' || !(CLAIRE_KPI_PERIODS as readonly string[]).includes(period) || typeof focus !== 'string' || (focus !== '' && !alexPlanLine(focus, 300))) return fail('brief');
  return { period: period as ClaireKpiPeriod, focus };
}

function item(v: unknown): ClaireKpiItem {
  if (!isObject(v) || !exactKeys(v, ['title', 'detail']) || !alexPlanLine(v.title, 120) || !alexPlanLine(v.detail, 300)) return fail('answer');
  return { title: v.title, detail: v.detail };
}
function note(v: unknown): ClaireKpiNote {
  if (!isObject(v) || !exactKeys(v, ['kpi', 'note']) || !isCode(v.kpi) || !alexPlanLine(v.note, 200)) return fail('answer');
  return { kpi: v.kpi, note: v.note };
}
/** The closed shape the database stores (0643 hon.claire_kpi_ok): at most one note per KPI. */
export function validateClaireKpiProposal(value: unknown): ClaireKpiProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'notes', 'watch', 'actions']) || !alexPlanLine(value.summary, 400)) return fail('answer');
  const { notes, watch, actions } = value;
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > CLAIRE_KPI_CODES.length) return fail('answer');
  if (!Array.isArray(watch) || watch.length > CLAIRE_KPI_LIMITS.maxWatch) return fail('answer');
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > CLAIRE_KPI_LIMITS.maxActions) return fail('answer');
  const n = notes.map(note);
  if (new Set(n.map(x => x.kpi)).size !== n.length || bytes(value) > CLAIRE_KPI_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, notes: n, watch: watch.map(item), actions: actions.map(item) };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function claireKpiProblems(p: ClaireKpiProposal): string[] {
  const texts = [p.summary, ...p.notes.map(x => x.note), ...[...p.watch, ...p.actions].flatMap(x => [x.title, x.detail])];
  return texts.some(t => LINKISH.test(t)) ? ['The answer holds a link or an email address.'] : [];
}

/** The nine counted KPIs, in report order; only ACTIVE_MEMBERSHIPS has no previous window. Empty before they are counted. */
export function verifyClaireKpiNumbers(value: unknown): ClaireKpiNumber[] {
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== CLAIRE_KPI_CODES.length)) return fail('numbers');
  return value.map((v, i) => {
    if (!isObject(v) || !exactKeys(v, ['kpi', 'current', 'previous']) || v.kpi !== CLAIRE_KPI_CODES[i] || !count(v.current)
      || !(v.kpi === 'ACTIVE_MEMBERSHIPS' ? v.previous === null : count(v.previous))) return fail('numbers');
    return { kpi: v.kpi as ClaireKpiCode, current: v.current as number, previous: v.previous as number | null };
  });
}

export function verifyClaireKpiView(value: unknown): ClaireKpiView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'kpis', 'summary', 'notes', 'watch', 'actions', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason)))
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateClaireKpiBrief(v.brief), kpis = verifyClaireKpiNumbers(v.kpis);
  let p: Pick<ClaireKpiView, 'summary' | 'notes' | 'watch' | 'actions'> = { summary: null, notes: null, watch: null, actions: null };
  if (v.status === 'RESULT_RECORDED') {
    if (!kpis.length) return fail('view');
    p = validateClaireKpiProposal({ summary: v.summary, notes: v.notes, watch: v.watch, actions: v.actions });
  } else if (v.summary !== null || v.notes !== null || v.watch !== null || v.actions !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, kpis, ...p,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyClaireKpiList(value: unknown): ClaireKpiView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyClaireKpiView);
}
