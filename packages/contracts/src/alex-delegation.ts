import { MERCH_AI_REASONS, MERCH_AI_STATUSES, merchSafeText, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';

/**
 * P1 (0639): Alex delegation plans. The owner gives Alex a goal for the week or month; Alex answers with a summary and up to
 * eight tasks on the shared AI text proposals (0550). A plan is text: nothing changes until the requester ticks tasks and
 * creates them, and each one becomes an ordinary human work item (0084) created by that person.
 * Spec: docs/architecture/ALEX_DELEGATION_PLANS.md.
 */
export const ALEX_PLAN_HORIZONS = ['WEEK', 'MONTH'] as const;
export type AlexPlanHorizon = typeof ALEX_PLAN_HORIZONS[number];
export const ALEX_PLAN_AREAS = ['chad', 'maya', 'marcus', 'jordan', 'claire', 'lena'] as const;
export type AlexPlanArea = typeof ALEX_PLAN_AREAS[number];
export const ALEX_PLAN_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type AlexPlanPriority = typeof ALEX_PLAN_PRIORITIES[number];
export const ALEX_PLAN_LIMITS = { inputTokens: 12000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxTasks: 8, maxStaff: 30 } as const;

export interface AlexPlanBrief { goal: string; horizon: AlexPlanHorizon }
export interface AlexPlanTask { title: string; description: string; priority: AlexPlanPriority; assignee: string | null; dueInDays: number | null; area: AlexPlanArea | null }
export interface AlexPlanProposal { summary: string; tasks: AlexPlanTask[] }
export interface AlexPlanStaff { ref: string; principalId: string; name: string }
export interface AlexPlanCreated { index: number; workItemId: string }
export interface AlexPlanView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: AlexPlanBrief; mine: boolean;
  summary: string | null; tasks: AlexPlanTask[] | null; staff: AlexPlanStaff[]; created: AlexPlanCreated[];
  problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^S([1-9]|[12][0-9]|30)$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
// What the database refuses in a plan line: control characters (a line break too) and invisible formatting marks.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Alex plan ${what}.`); };
/** One trimmed line of safe text, as the database's hon.alex_plan_line_ok takes it. */
export function alexPlanLine(v: unknown, max: number): v is string {
  return merchSafeText(v, max) && v === v.trim() && !INVISIBLE.test(v);
}

/** The brief, exactly as the database takes it (0639 hon.alex_plan_brief_ok). */
export function validateAlexPlanBrief(value: unknown): AlexPlanBrief {
  if (!isObject(value) || !exactKeys(value, ['goal', 'horizon'])) return fail('brief');
  const { goal, horizon } = value;
  if (!alexPlanLine(goal, 500) || typeof horizon !== 'string' || !(ALEX_PLAN_HORIZONS as readonly string[]).includes(horizon)) return fail('brief');
  return { goal, horizon: horizon as AlexPlanHorizon };
}

function task(v: unknown): AlexPlanTask {
  if (!isObject(v) || !exactKeys(v, ['title', 'description', 'priority', 'assignee', 'dueInDays', 'area'])) return fail('answer');
  const { title, description, priority, assignee, dueInDays, area } = v;
  if (!alexPlanLine(title, 120) || !alexPlanLine(description, 600)
    || typeof priority !== 'string' || !(ALEX_PLAN_PRIORITIES as readonly string[]).includes(priority)
    || !(assignee === null || (typeof assignee === 'string' && REF.test(assignee)))
    || !(dueInDays === null || (Number.isInteger(dueInDays) && (dueInDays as number) >= 0 && (dueInDays as number) <= 31))
    || !(area === null || (typeof area === 'string' && (ALEX_PLAN_AREAS as readonly string[]).includes(area)))) return fail('answer');
  return { title, description, priority: priority as AlexPlanPriority, assignee: assignee as string | null, dueInDays: dueInDays as number | null, area: area as AlexPlanArea | null };
}
/** The closed shape the database stores (0639 hon.alex_plan_ok). */
export function validateAlexPlanProposal(value: unknown): AlexPlanProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'tasks']) || !alexPlanLine(value.summary, 300)) return fail('answer');
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > ALEX_PLAN_LIMITS.maxTasks) return fail('answer');
  const tasks = value.tasks.map(task);
  if (bytes(value) > ALEX_PLAN_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, tasks };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function alexPlanProblems(p: AlexPlanProposal): string[] {
  const out: string[] = [];
  if ([p.summary, ...p.tasks.flatMap(t => [t.title, t.description])].some(t => LINKISH.test(t))) out.push('The answer holds a link or an email address.');
  return out;
}

/** The create request: 1..8 distinct task indexes of the plan. */
export function validateAlexPlanCreate(value: unknown): { tasks: number[] } {
  if (!isObject(value) || !exactKeys(value, ['tasks']) || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > ALEX_PLAN_LIMITS.maxTasks
    || value.tasks.some(x => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 7) || new Set(value.tasks).size !== value.tasks.length) return fail('create');
  return { tasks: value.tasks as number[] };
}

export function verifyAlexPlanView(value: unknown): AlexPlanView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'summary', 'tasks', 'staff', 'created', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  if (!Array.isArray(v.staff) || v.staff.length > ALEX_PLAN_LIMITS.maxStaff || v.staff.some(s => !isObject(s) || !exactKeys(s, ['ref', 'principalId', 'name'])
    || typeof s.ref !== 'string' || !REF.test(s.ref) || typeof s.principalId !== 'string' || !UUID.test(s.principalId) || typeof s.name !== 'string' || s.name.length > 120)) return fail('view');
  if (!Array.isArray(v.created) || v.created.length > ALEX_PLAN_LIMITS.maxTasks || v.created.some(c => !isObject(c) || !exactKeys(c, ['index', 'workItemId'])
    || !Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 7 || typeof c.workItemId !== 'string' || !UUID.test(c.workItemId))) return fail('view');
  const brief = validateAlexPlanBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, tasks: AlexPlanTask[] | null = null;
  if (open) ({ summary, tasks } = validateAlexPlanProposal({ summary: v.summary, tasks: v.tasks }));
  else if (v.summary !== null || v.tasks !== null) return fail('view');
  if (v.created.length && v.status !== 'APPLIED') return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, summary, tasks,
    staff: v.staff as AlexPlanStaff[], created: v.created as AlexPlanCreated[], problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyAlexPlanList(value: unknown): AlexPlanView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyAlexPlanView);
}
