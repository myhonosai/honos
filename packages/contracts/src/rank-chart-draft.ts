import { MERCH_AI_REASONS, MERCH_AI_STATUSES, merchSafeText, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { RANK_SETUP_LIMITS, isRankSetupColor, isValidRankSetupName, type RankSetupRankInput } from './rank-setup.js';

/**
 * Rank chart AI draft (0636). In Rank setup > Quick setup a school describes its martial art in its own words and Kai drafts
 * the belt list on the shared AI text proposals (0550). A draft is exactly the 0622 quick setup input plus a one-line
 * summary: it changes nothing until a person checks it and saves it with the ordinary quick setup command.
 */
export const RANK_CHART_COMMAND = 'rank-chart-draft';
export const RANK_CHART_LIMITS = { inputTokens: 16000, outputTokens: 5000, maxProviderCostMicrounits: 150000, maxResultBytes: 12288, description: 600, summary: 300, currentBytes: 8000, draftBytes: 11600 } as const;

/** The list on the person's screen, sent when they ask Kai to change it. */
export interface RankChartCurrent { name: string; ranks: RankSetupRankInput[] }
export interface RankChartBrief { description: string; current: RankChartCurrent | null }
export interface RankChartDraft { name: string; summary: string; ranks: RankSetupRankInput[] }
export interface RankChartView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: RankChartBrief; mine: boolean;
  draft: RankChartDraft | null; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const fail = (what: string): never => { throw new Error(`Invalid rank chart ${what}.`); };

/** The brief, exactly as the database takes it (0636 hon.rank_chart_brief_ok). */
export function validateRankChartBrief(value: unknown): RankChartBrief {
  if (!isObject(value) || !(exactKeys(value, ['description']) || exactKeys(value, ['description', 'current']))) return fail('brief');
  const { description } = value;
  if (typeof description !== 'string' || description !== description.trim() || !merchSafeText(description, RANK_CHART_LIMITS.description)) return fail('brief');
  if (value.current === undefined || value.current === null) return { description, current: null };
  if (!isObject(value.current) || !exactKeys(value.current, ['name', 'ranks']) || bytes(value.current) > RANK_CHART_LIMITS.currentBytes) return fail('brief');
  let chart: RankChartDraft;
  try { chart = validateRankChartDraft({ ...value.current, summary: 'x' }); } catch { return fail('brief'); }
  return { description, current: { name: chart.name, ranks: chart.ranks } };
}

/** The closed shape the database stores (0636 hon.rank_chart_ok). */
export function validateRankChartDraft(value: unknown): RankChartDraft {
  if (!isObject(value) || !exactKeys(value, ['name', 'summary', 'ranks']) || !isValidRankSetupName(value.name)
    || !merchSafeText(value.summary, RANK_CHART_LIMITS.summary) || /[<>]/.test(value.summary)) return fail('draft');
  if (!Array.isArray(value.ranks) || value.ranks.length < 1 || value.ranks.length > RANK_SETUP_LIMITS.ranks) return fail('draft');
  const seen = new Set<string>();
  const ranks = value.ranks.map((r: unknown): RankSetupRankInput => {
    if (!isObject(r) || !exactKeys(r, ['name', 'color', 'classes', 'days']) || !isValidRankSetupName(r.name) || !isRankSetupColor(r.color)
      || (typeof r.color === 'string' && r.color !== r.color.toUpperCase()) || !whole(r.classes, RANK_SETUP_LIMITS.classes) || !whole(r.days, RANK_SETUP_LIMITS.days)) return fail('draft');
    const key = r.name.toLowerCase();
    if (seen.has(key)) return fail('draft');
    seen.add(key);
    return { name: r.name, color: r.color, classes: r.classes, days: r.days };
  });
  // The database measures jsonb text (a space after each colon and comma, about 9 bytes a rank), so compact JSON stays under its 12,288.
  if (bytes(value) > RANK_CHART_LIMITS.draftBytes) return fail('draft');
  return { name: value.name, summary: value.summary as string, ranks };
}

/** Tidies what a model commonly gets slightly wrong before validation: lower-case colors and padded names. Nothing else is repaired. */
export function normalizeRankChartAnswer(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.ranks)) return value;
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : v;
  return { ...value, name: text(value.name), summary: text(value.summary), ranks: value.ranks.map((r: unknown) => isObject(r)
    ? { ...r, name: text(r.name), color: typeof r.color === 'string' ? r.color.trim().toUpperCase() : r.color } : r) };
}

/** What makes a draft unusable, in plain words (stored with a rejected answer). */
export function rankChartProblems(d: RankChartDraft): string[] {
  const out: string[] = [];
  if ([d.name, d.summary, ...d.ranks.map(r => r.name)].some(t => LINKISH.test(t))) out.push('The answer holds a link or an email address.');
  return out;
}

export function verifyRankChartView(value: unknown): RankChartView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'draft', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateRankChartBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  if (!open && v.draft !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, draft: open ? validateRankChartDraft(v.draft) : null,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyRankChartList(value: unknown): RankChartView[] {
  if (!Array.isArray(value) || value.length > 5) return fail('list');
  return value.map(verifyRankChartView);
}
