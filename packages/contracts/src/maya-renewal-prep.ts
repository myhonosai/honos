import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P5 (0646): Maya renewal prep. A staff member with Maya and renewal review access asks Maya to look over the memberships whose
 * term ends in the next 30 or 60 days; Maya answers with a summary and up to ten suggestions (a priority, a talking point and
 * why) on the shared AI text proposals (0550). Nothing changes until the requester ticks suggestions and applies them; each
 * opens a renewal review through the ordinary human renewal path (0080) as that person. Nothing is sent to a family.
 * Spec: docs/architecture/MAYA_RENEWAL_PREP.md.
 */
export const MAYA_RENEWAL_WINDOWS = ['NEXT_30_DAYS', 'NEXT_60_DAYS'] as const;
export type MayaRenewalWindow = typeof MAYA_RENEWAL_WINDOWS[number];
export const MAYA_RENEWAL_PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;
export type MayaRenewalPriority = typeof MAYA_RENEWAL_PRIORITIES[number];
export const MAYA_RENEWAL_LIMITS = { inputTokens: 12000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxSuggestions: 10, maxRefs: 30 } as const;

export interface MayaRenewalBrief { window: MayaRenewalWindow; note: string }
export interface MayaRenewalSuggestion { membership: string; priority: MayaRenewalPriority; talkingPoint: string; reason: string }
export interface MayaRenewalProposal { summary: string; suggestions: MayaRenewalSuggestion[] }
export interface MayaRenewalMembership { ref: string; membershipId: string; name: string; termEndsOn: string }
export interface MayaRenewalApplied { index: number; renewalId: string }
export interface MayaRenewalView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: MayaRenewalBrief;
  summary: string | null; suggestions: MayaRenewalSuggestion[] | null; memberships: MayaRenewalMembership[];
  applied: MayaRenewalApplied[]; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBERSHIP = /^M([1-9]|[12][0-9]|30)$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Maya renewal prep ${what}.`); };

/** The brief, exactly as the database takes it (0646 hon.maya_renewal_brief_ok). An empty note is allowed. */
export function validateMayaRenewalBrief(value: unknown): MayaRenewalBrief {
  if (!isObject(value) || !exactKeys(value, ['window', 'note'])) return fail('brief');
  const { window, note } = value;
  if (typeof window !== 'string' || !(MAYA_RENEWAL_WINDOWS as readonly string[]).includes(window) || typeof note !== 'string' || (note !== '' && !alexPlanLine(note, 300))) return fail('brief');
  return { window: window as MayaRenewalWindow, note };
}

function suggestion(v: unknown): MayaRenewalSuggestion {
  if (!isObject(v) || !exactKeys(v, ['membership', 'priority', 'talkingPoint', 'reason'])) return fail('answer');
  const { membership, priority, talkingPoint, reason } = v;
  if (typeof membership !== 'string' || !MEMBERSHIP.test(membership) || typeof priority !== 'string' || !(MAYA_RENEWAL_PRIORITIES as readonly string[]).includes(priority)
    || !alexPlanLine(talkingPoint, 300) || !alexPlanLine(reason, 300)) return fail('answer');
  return { membership, priority: priority as MayaRenewalPriority, talkingPoint: talkingPoint as string, reason: reason as string };
}
/** The closed shape the database stores (0646 hon.maya_renewal_ok): one suggestion per membership. */
export function validateMayaRenewalProposal(value: unknown): MayaRenewalProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'suggestions']) || !alexPlanLine(value.summary, 300)) return fail('answer');
  if (!Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > MAYA_RENEWAL_LIMITS.maxSuggestions) return fail('answer');
  const suggestions = value.suggestions.map(suggestion);
  if (new Set(suggestions.map(s => s.membership)).size !== suggestions.length || bytes(value) > MAYA_RENEWAL_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, suggestions };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function mayaRenewalProblems(p: MayaRenewalProposal): string[] {
  return [p.summary, ...p.suggestions.flatMap(s => [s.talkingPoint, s.reason])].some(t => LINKISH.test(t)) ? ['The answer holds a link or an email address.'] : [];
}

/** The apply request: 1..10 distinct suggestion indexes. */
export function validateMayaRenewalApply(value: unknown): { suggestions: number[] } {
  if (!isObject(value) || !exactKeys(value, ['suggestions']) || !Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > MAYA_RENEWAL_LIMITS.maxSuggestions
    || value.suggestions.some(x => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 9) || new Set(value.suggestions).size !== value.suggestions.length) return fail('apply');
  return { suggestions: value.suggestions as number[] };
}

export function verifyMayaRenewalView(value: unknown): MayaRenewalView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'summary', 'suggestions', 'memberships', 'applied', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason)))
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  if (!Array.isArray(v.memberships) || v.memberships.length > MAYA_RENEWAL_LIMITS.maxRefs || v.memberships.some(s => !isObject(s) || !exactKeys(s, ['ref', 'membershipId', 'name', 'termEndsOn'])
    || typeof s.ref !== 'string' || !MEMBERSHIP.test(s.ref) || typeof s.membershipId !== 'string' || !UUID.test(s.membershipId)
    || typeof s.name !== 'string' || s.name.length > 120 || typeof s.termEndsOn !== 'string' || !DAY.test(s.termEndsOn))) return fail('view');
  if (!Array.isArray(v.applied) || v.applied.length > MAYA_RENEWAL_LIMITS.maxSuggestions || v.applied.some(c => !isObject(c) || !exactKeys(c, ['index', 'renewalId'])
    || !Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 9 || typeof c.renewalId !== 'string' || !UUID.test(c.renewalId))) return fail('view');
  const brief = validateMayaRenewalBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, suggestions: MayaRenewalSuggestion[] | null = null;
  if (open) ({ summary, suggestions } = validateMayaRenewalProposal({ summary: v.summary, suggestions: v.suggestions }));
  else if (v.summary !== null || v.suggestions !== null) return fail('view');
  if (v.applied.length && v.status !== 'APPLIED') return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, summary, suggestions,
    memberships: v.memberships as MayaRenewalMembership[], applied: v.applied as MayaRenewalApplied[], problems: v.problems as string[],
    createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyMayaRenewalList(value: unknown): MayaRenewalView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyMayaRenewalView);
}
