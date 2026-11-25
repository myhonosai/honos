import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P2 (0640): Jordan follow-through. A team manager asks Jordan to look over the school's open (or overdue) human tasks; Jordan
 * answers with a summary and up to ten suggestions on the shared AI text proposals (0550): move a due date, hand a task to
 * someone else, change its priority, or add a follow-up task. Nothing changes until the requester ticks suggestions and applies
 * them; each runs through the ordinary human work path (0084) as that person. Spec: docs/architecture/JORDAN_FOLLOW_THROUGH.md.
 */
export const JORDAN_FOLLOW_UP_FOCUSES = ['OVERDUE', 'OPEN'] as const;
export type JordanFollowUpFocus = typeof JORDAN_FOLLOW_UP_FOCUSES[number];
export const JORDAN_FOLLOW_UP_ACTIONS = ['RESCHEDULE', 'REASSIGN', 'REPRIORITIZE', 'FOLLOW_UP'] as const;
export type JordanFollowUpAction = typeof JORDAN_FOLLOW_UP_ACTIONS[number];
export const JORDAN_FOLLOW_UP_LIMITS = { inputTokens: 12000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxSuggestions: 10, maxRefs: 30 } as const;

export interface JordanFollowUpBrief { focus: JordanFollowUpFocus; note: string }
export interface JordanFollowUpSuggestion {
  item: string; action: JordanFollowUpAction; reason: string;
  dueInDays: number | null; assignee: string | null; priority: 'LOW' | 'NORMAL' | 'HIGH' | null;
}
export interface JordanFollowUpProposal { summary: string; suggestions: JordanFollowUpSuggestion[] }
export interface JordanFollowUpStaff { ref: string; principalId: string; name: string }
export interface JordanFollowUpItem { ref: string; workItemId: string; title: string }
export interface JordanFollowUpApplied { index: number; workItemId: string }
export interface JordanFollowUpView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: JordanFollowUpBrief; mine: boolean;
  summary: string | null; suggestions: JordanFollowUpSuggestion[] | null; staff: JordanFollowUpStaff[]; items: JordanFollowUpItem[];
  applied: JordanFollowUpApplied[]; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAFF = /^S([1-9]|[12][0-9]|30)$/;
const TASK = /^W([1-9]|[12][0-9]|30)$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'];
const days = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 31;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Jordan follow-up ${what}.`); };

/** The brief, exactly as the database takes it (0640 hon.jordan_follow_up_brief_ok). An empty note is allowed. */
export function validateJordanFollowUpBrief(value: unknown): JordanFollowUpBrief {
  if (!isObject(value) || !exactKeys(value, ['focus', 'note'])) return fail('brief');
  const { focus, note } = value;
  if (typeof focus !== 'string' || !(JORDAN_FOLLOW_UP_FOCUSES as readonly string[]).includes(focus) || typeof note !== 'string' || (note !== '' && !alexPlanLine(note, 300))) return fail('brief');
  return { focus: focus as JordanFollowUpFocus, note };
}

function suggestion(v: unknown): JordanFollowUpSuggestion {
  if (!isObject(v) || !exactKeys(v, ['item', 'action', 'reason', 'dueInDays', 'assignee', 'priority'])) return fail('answer');
  const { item, action, reason, dueInDays, assignee, priority } = v;
  if (typeof item !== 'string' || !TASK.test(item) || !alexPlanLine(reason, 300)) return fail('answer');
  const ok = action === 'RESCHEDULE' ? days(dueInDays) && assignee === null && priority === null
    : action === 'REASSIGN' ? typeof assignee === 'string' && STAFF.test(assignee) && dueInDays === null && priority === null
    : action === 'REPRIORITIZE' ? typeof priority === 'string' && PRIORITIES.includes(priority) && dueInDays === null && assignee === null
    : action === 'FOLLOW_UP' ? (dueInDays === null || days(dueInDays)) && assignee === null && priority === null
    : false;
  if (!ok) return fail('answer');
  return { item, action: action as JordanFollowUpAction, reason: reason as string, dueInDays: dueInDays as number | null, assignee: assignee as string | null,
    priority: priority as JordanFollowUpSuggestion['priority'] };
}
/** The closed shape the database stores (0640 hon.jordan_follow_up_ok): one suggestion per task. */
export function validateJordanFollowUpProposal(value: unknown): JordanFollowUpProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'suggestions']) || !alexPlanLine(value.summary, 300)) return fail('answer');
  if (!Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > JORDAN_FOLLOW_UP_LIMITS.maxSuggestions) return fail('answer');
  const suggestions = value.suggestions.map(suggestion);
  if (new Set(suggestions.map(s => s.item)).size !== suggestions.length || bytes(value) > JORDAN_FOLLOW_UP_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, suggestions };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function jordanFollowUpProblems(p: JordanFollowUpProposal): string[] {
  return [p.summary, ...p.suggestions.map(s => s.reason)].some(t => LINKISH.test(t)) ? ['The answer holds a link or an email address.'] : [];
}

/** The apply request: 1..10 distinct suggestion indexes. */
export function validateJordanFollowUpApply(value: unknown): { suggestions: number[] } {
  if (!isObject(value) || !exactKeys(value, ['suggestions']) || !Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > JORDAN_FOLLOW_UP_LIMITS.maxSuggestions
    || value.suggestions.some(x => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 9) || new Set(value.suggestions).size !== value.suggestions.length) return fail('apply');
  return { suggestions: value.suggestions as number[] };
}

export function verifyJordanFollowUpView(value: unknown): JordanFollowUpView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'summary', 'suggestions', 'staff', 'items', 'applied', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  if (!Array.isArray(v.staff) || v.staff.length > JORDAN_FOLLOW_UP_LIMITS.maxRefs || v.staff.some(s => !isObject(s) || !exactKeys(s, ['ref', 'principalId', 'name'])
    || typeof s.ref !== 'string' || !STAFF.test(s.ref) || typeof s.principalId !== 'string' || !UUID.test(s.principalId) || typeof s.name !== 'string' || s.name.length > 120)) return fail('view');
  if (!Array.isArray(v.items) || v.items.length > JORDAN_FOLLOW_UP_LIMITS.maxRefs || v.items.some(s => !isObject(s) || !exactKeys(s, ['ref', 'workItemId', 'title'])
    || typeof s.ref !== 'string' || !TASK.test(s.ref) || typeof s.workItemId !== 'string' || !UUID.test(s.workItemId) || typeof s.title !== 'string' || s.title.length < 1 || s.title.length > 120)) return fail('view');
  if (!Array.isArray(v.applied) || v.applied.length > JORDAN_FOLLOW_UP_LIMITS.maxSuggestions || v.applied.some(c => !isObject(c) || !exactKeys(c, ['index', 'workItemId'])
    || !Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 9 || typeof c.workItemId !== 'string' || !UUID.test(c.workItemId))) return fail('view');
  const brief = validateJordanFollowUpBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, suggestions: JordanFollowUpSuggestion[] | null = null;
  if (open) ({ summary, suggestions } = validateJordanFollowUpProposal({ summary: v.summary, suggestions: v.suggestions }));
  else if (v.summary !== null || v.suggestions !== null) return fail('view');
  if (v.applied.length && v.status !== 'APPLIED') return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, summary, suggestions,
    staff: v.staff as JordanFollowUpStaff[], items: v.items as JordanFollowUpItem[], applied: v.applied as JordanFollowUpApplied[], problems: v.problems as string[],
    createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyJordanFollowUpList(value: unknown): JordanFollowUpView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyJordanFollowUpView);
}
