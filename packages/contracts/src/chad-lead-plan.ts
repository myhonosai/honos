import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P9 (0650): Chad lead next steps. A staff member with Chad's follow-up assistant authority asks Chad to look over this school's
 * open leads; Chad answers with a summary and up to ten suggestions, one per lead: move it to another open stage of its own
 * pipeline, or book a trial in one of the school's next classes. Nothing changes from a suggestion. The person presses one, the
 * web runs the ordinary human command (crm.lead.stage.move or crm.trial.schedule) as that person, and HON records which record
 * it produced. Spec: docs/architecture/CHAD_LEAD_PLAN.md.
 */
export const CHAD_LEAD_PLAN_FOCUS = ['ALL_OPEN', 'NO_TRIAL_YET'] as const;
export type ChadLeadPlanFocus = typeof CHAD_LEAD_PLAN_FOCUS[number];
export const CHAD_LEAD_PLAN_ACTIONS = ['MOVE_STAGE', 'BOOK_TRIAL'] as const;
export type ChadLeadPlanAction = typeof CHAD_LEAD_PLAN_ACTIONS[number];
export const CHAD_LEAD_PLAN_LIMITS = { inputTokens: 10000, outputTokens: 2500, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxSuggestions: 10, maxLeads: 15, maxStages: 40, maxClasses: 20 } as const;

export interface ChadLeadPlanBrief { focus: ChadLeadPlanFocus; note: string }
export interface ChadLeadPlanSuggestion { lead: string; action: ChadLeadPlanAction; stage: string | null; slot: string | null; reason: string }
export interface ChadLeadPlanProposal { summary: string; suggestions: ChadLeadPlanSuggestion[] }
export interface ChadLeadPlanLead { ref: string; leadId: string; leadVersion: number; name: string }
export interface ChadLeadPlanStage { ref: string; stageId: string; name: string }
export interface ChadLeadPlanClass { ref: string; classSessionId: string; name: string; startsAt: string; endsAt: string }
export interface ChadLeadPlanApplied { index: number; action: ChadLeadPlanAction; leadId: string; appointmentId: string | null }
export interface ChadLeadPlanView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: ChadLeadPlanBrief;
  summary: string | null; suggestions: ChadLeadPlanSuggestion[] | null; leads: ChadLeadPlanLead[]; stages: ChadLeadPlanStage[]; classes: ChadLeadPlanClass[];
  applied: ChadLeadPlanApplied[]; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEAD = /^L([1-9]|1[0-5])$/;
const STAGE = /^S([1-9]|[1-3][0-9]|40)$/;
const SLOT = /^C([1-9]|1[0-9]|20)$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Chad lead plan ${what}.`); };

/** The brief, exactly as the database takes it (0650 hon.chad_lead_plan_brief_ok). An empty note is allowed. */
export function validateChadLeadPlanBrief(value: unknown): ChadLeadPlanBrief {
  if (!isObject(value) || !exactKeys(value, ['focus', 'note'])) return fail('brief');
  const { focus, note } = value;
  if (typeof focus !== 'string' || !(CHAD_LEAD_PLAN_FOCUS as readonly string[]).includes(focus) || typeof note !== 'string' || (note !== '' && !alexPlanLine(note, 300))) return fail('brief');
  return { focus: focus as ChadLeadPlanFocus, note };
}

function suggestion(v: unknown): ChadLeadPlanSuggestion {
  if (!isObject(v) || !exactKeys(v, ['lead', 'action', 'stage', 'slot', 'reason'])) return fail('answer');
  const { lead, action, stage, slot, reason } = v;
  if (typeof lead !== 'string' || !LEAD.test(lead) || !alexPlanLine(reason, 300)) return fail('answer');
  if (action === 'MOVE_STAGE' ? !(typeof stage === 'string' && STAGE.test(stage) && slot === null)
    : action === 'BOOK_TRIAL' ? !(typeof slot === 'string' && SLOT.test(slot) && stage === null) : true) return fail('answer');
  return { lead, action: action as ChadLeadPlanAction, stage: stage as string | null, slot: slot as string | null, reason: reason as string };
}
/** The closed shape the database stores (0650 hon.chad_lead_plan_ok): one suggestion per lead. */
export function validateChadLeadPlanProposal(value: unknown): ChadLeadPlanProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'suggestions']) || !alexPlanLine(value.summary, 300)) return fail('answer');
  if (!Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > CHAD_LEAD_PLAN_LIMITS.maxSuggestions) return fail('answer');
  const suggestions = value.suggestions.map(suggestion);
  if (new Set(suggestions.map(s => s.lead)).size !== suggestions.length || bytes(value) > CHAD_LEAD_PLAN_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, suggestions };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function chadLeadPlanProblems(p: ChadLeadPlanProposal): string[] {
  return [p.summary, ...p.suggestions.map(s => s.reason)].some(t => LINKISH.test(t)) ? ['The answer holds a link or an email address.'] : [];
}

/** The record-a-step request: the trial appointment the person's own command made, or null for a stage move. */
export function validateChadLeadPlanStep(value: unknown): { appointmentId: string | null } {
  if (!isObject(value) || !exactKeys(value, ['appointmentId']) || !(value.appointmentId === null || (typeof value.appointmentId === 'string' && UUID.test(value.appointmentId)))) return fail('step');
  return { appointmentId: value.appointmentId as string | null };
}

const list = <T,>(v: unknown, max: number, keys: readonly string[], ok: (x: Record<string, unknown>) => boolean): T[] => {
  if (!Array.isArray(v) || v.length > max || v.some(x => !isObject(x) || !exactKeys(x, keys) || !ok(x))) return fail('view');
  return v as T[];
};
export function verifyChadLeadPlanView(value: unknown): ChadLeadPlanView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'summary', 'suggestions', 'leads', 'stages', 'classes', 'applied', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason)))
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const leads = list<ChadLeadPlanLead>(v.leads, CHAD_LEAD_PLAN_LIMITS.maxLeads, ['ref', 'leadId', 'leadVersion', 'name'], x => typeof x.ref === 'string' && LEAD.test(x.ref)
    && typeof x.leadId === 'string' && UUID.test(x.leadId) && Number.isSafeInteger(x.leadVersion) && (x.leadVersion as number) >= 1 && typeof x.name === 'string' && x.name.length <= 120);
  const stages = list<ChadLeadPlanStage>(v.stages, CHAD_LEAD_PLAN_LIMITS.maxStages, ['ref', 'stageId', 'name'], x => typeof x.ref === 'string' && STAGE.test(x.ref)
    && typeof x.stageId === 'string' && UUID.test(x.stageId) && typeof x.name === 'string' && x.name.length <= 60);
  const classes = list<ChadLeadPlanClass>(v.classes, CHAD_LEAD_PLAN_LIMITS.maxClasses, ['ref', 'classSessionId', 'name', 'startsAt', 'endsAt'], x => typeof x.ref === 'string' && SLOT.test(x.ref)
    && typeof x.classSessionId === 'string' && UUID.test(x.classSessionId) && typeof x.name === 'string' && x.name.length <= 80
    && typeof x.startsAt === 'string' && ISO.test(x.startsAt) && typeof x.endsAt === 'string' && ISO.test(x.endsAt) && x.endsAt > x.startsAt);
  const applied = list<ChadLeadPlanApplied>(v.applied, CHAD_LEAD_PLAN_LIMITS.maxSuggestions, ['index', 'action', 'leadId', 'appointmentId'], x => Number.isInteger(x.index)
    && (x.index as number) >= 0 && (x.index as number) <= 9 && (x.action === 'MOVE_STAGE' ? x.appointmentId === null : x.action === 'BOOK_TRIAL' && typeof x.appointmentId === 'string' && UUID.test(x.appointmentId))
    && typeof x.leadId === 'string' && UUID.test(x.leadId));
  const brief = validateChadLeadPlanBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, suggestions: ChadLeadPlanSuggestion[] | null = null;
  if (open) ({ summary, suggestions } = validateChadLeadPlanProposal({ summary: v.summary, suggestions: v.suggestions }));
  else if (v.summary !== null || v.suggestions !== null) return fail('view');
  if (applied.length && !['RESULT_RECORDED', 'APPLIED', 'DISMISSED'].includes(v.status)) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, summary, suggestions, leads, stages, classes, applied,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyChadLeadPlanList(value: unknown): ChadLeadPlanView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyChadLeadPlanView);
}
