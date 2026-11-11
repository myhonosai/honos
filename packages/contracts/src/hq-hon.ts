// B1 HQ Ask HON + HQ AI text budget (migration 0263): an HQ person asks HON about HON OS itself; HON answers from the HQ
// platform overview. Paid from a separate monthly HQ AI text budget the human HQ owner sets (credits: an internal planning
// limit, never a charge or a provider budget). No organization or school is ever part of an HQ turn. Views carry no
// provider identity, model or provider cost.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { HON_REPLY_LIMITS, HON_REPLY_MODES, HON_REPLY_MODE_KEYS, type HonReplyMode } from './hon-conversation.js';
import { isHqMarketingDate, type HqMarketingPerson } from './hq-marketing.js';
import type { HqCreativeBudget, HqCreativeBudgetChange, HqCreativeProviderState } from './hq-creative.js';

/** B1: HON only. B2 (0264) adds the six HQ executives. */
export const HQ_HON_AGENTS = ['hon'] as const;
export type HqHonAgentKey = typeof HQ_HON_AGENTS[number];
export const HQ_HON_STATUSES = ['ANSWERING', 'ANSWERED', 'FAILED', 'UNDER_REVIEW', 'RESOLVED_CHARGED', 'RESOLVED_NOT_CHARGED'] as const;
export type HqHonStatus = typeof HQ_HON_STATUSES[number];
export const HQ_HON_FAILED_REASONS = ['PROVIDER_REJECTED', 'CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST'] as const;
export const HQ_HON_REVIEW_REASONS = ['PROVIDER_UNKNOWN', 'UNVERIFIED_RESULT', 'INTERRUPTED'] as const;
export type HqHonFailureReason = typeof HQ_HON_FAILED_REASONS[number] | typeof HQ_HON_REVIEW_REASONS[number];
export const HQ_HON_LIMITS = { maxCap: 10_000_000, maxInProgress: 3, listLimit: 50, historyLimit: 12, reason: 300, evidence: 200, interruptedAfterSeconds: 120 } as const;
/** The credits one HQ turn reserves: the school HON numbers (0263 hq_hon_mode_limits). */
export const HQ_HON_MODE_CREDITS: Readonly<Record<HonReplyMode, number>> = { STANDARD: HON_REPLY_MODES.STANDARD.reservedCredits, DETAILED: HON_REPLY_MODES.DETAILED.reservedCredits };

const CONTROL = /[\u0000-\u001f\u007f]/;
const QUESTION_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const has = (list: readonly unknown[], v: unknown) => list.includes(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max && !CONTROL.test(v);
const isMonth = (v: unknown): v is string => isHqMarketingDate(v) && (v as string).endsWith('-01');
export const isHqHonQuestion = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= HON_REPLY_LIMITS.questionCharacters && !QUESTION_CONTROL.test(v);
export const isHqHonAgent = (v: unknown): v is HqHonAgentKey => has(HQ_HON_AGENTS, v);

// ---------- inputs ----------
export interface HqHonAskInput { question: string; replyMode: HonReplyMode; agentKey: HqHonAgentKey }
export interface HqHonBudgetInput { periodStart: string; creditCap: number; expectedVersion: number | null; reason: string }
export type HqHonResolveInput =
  | { expectedVersion: number; resolution: 'CHARGED'; chargedCredits: number; providerCostMicrounits: number | null; evidenceReference: string }
  | { expectedVersion: number; resolution: 'NOT_CHARGED'; chargedCredits: null; providerCostMicrounits: number | null; evidenceReference: string };

export function validateHqHonAskInput(value: unknown): HqHonAskInput {
  const r = record(value, invalid); exactKeys(r, ['question', 'replyMode', 'agentKey'], invalid);
  if (!isHqHonQuestion(r.question) || !has(HON_REPLY_MODE_KEYS, r.replyMode) || !isHqHonAgent(r.agentKey)) invalid();
  return { question: r.question as string, replyMode: r.replyMode as HonReplyMode, agentKey: r.agentKey as HqHonAgentKey };
}
export function validateHqHonBudgetInput(value: unknown): HqHonBudgetInput {
  const r = record(value, invalid); exactKeys(r, ['periodStart', 'creditCap', 'expectedVersion', 'reason'], invalid);
  if (!isMonth(r.periodStart) || !isInt(r.creditCap, 0, HQ_HON_LIMITS.maxCap) || !(r.expectedVersion === null || isInt(r.expectedVersion, 1, 999_999_999))
    || !text(r.reason, 3, HQ_HON_LIMITS.reason)) invalid();
  return { periodStart: r.periodStart as string, creditCap: r.creditCap as number, expectedVersion: r.expectedVersion as number | null, reason: r.reason as string };
}
export function validateHqHonResolveInput(value: unknown): HqHonResolveInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion', 'resolution', 'chargedCredits', 'providerCostMicrounits', 'evidenceReference'], invalid);
  if (!isInt(r.expectedVersion, 1, 999_999_999) || !has(['CHARGED', 'NOT_CHARGED'], r.resolution)
    || !(r.resolution === 'CHARGED' ? isInt(r.chargedCredits, 0, 1000) : r.chargedCredits === null)
    || !(r.providerCostMicrounits === null || isInt(r.providerCostMicrounits, 0, 1_000_000_000)) || !text(r.evidenceReference, 1, HQ_HON_LIMITS.evidence)) invalid();
  return r as unknown as HqHonResolveInput;
}

// ---------- views ----------
export type HqHonBudget = HqCreativeBudget;
export type HqHonBudgetChange = HqCreativeBudgetChange;
export interface HqHonViewer extends HqMarketingPerson { isOwner: boolean }
export interface HqHonTurn {
  turnId: string; agentKey: HqHonAgentKey; replyMode: HonReplyMode; question: string; status: HqHonStatus; failureReason: HqHonFailureReason | null;
  /** Null unless ANSWERED and the reader still holds every permission the answer's facts used (then concealed is false). */
  reply: string | null; truncated: boolean | null; concealed: boolean; reservedCredits: number; chargedCredits: number | null;
  askedBy: HqMarketingPerson; version: number; createdAt: string; completedAt: string | null;
}
export interface HqHonConversationRecords {
  budget: HqHonBudget; turns: HqHonTurn[]; budgetHistory: HqHonBudgetChange[]; underReview: HqHonTurn[]; limit: 50; viewer: HqHonViewer; asOf: string;
}
export interface HqHonConversation extends HqHonConversationRecords { provider: HqCreativeProviderState }
/** What the database hands the API once, from the call that created the turn: the server-built facts and fixed budgets. */
export interface HqHonInvocation {
  turnId: string; agentKey: HqHonAgentKey; providerId: string; modelId: string; providerRequestId: string; replyMode: HonReplyMode; question: string;
  facts: string; inputBudget: number; outputBudget: number; maxCostMicrounits: number;
}
export interface HqHonAskRecords { turn: HqHonTurn; invocation: HqHonInvocation | null; budget: HqHonBudget; replayed: boolean }
export interface HqHonTurnReceipt { turn: HqHonTurn; budget: HqHonBudget; replayed: boolean }
export interface HqHonBudgetReceipt { budget: HqHonBudget; replayed: boolean }

const CREDITS = Number.MAX_SAFE_INTEGER;
function person(value: unknown): HqMarketingPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || !text(p.displayName, 1, 120)) drift();
  return p as unknown as HqMarketingPerson;
}
function budget(value: unknown): HqHonBudget {
  const b = record(value, drift);
  exactKeys(b, ['periodStart', 'creditCap', 'usedCredits', 'heldCredits', 'availableCredits', 'inProgress', 'version', 'setBy', 'setAt'], drift);
  if (!isMonth(b.periodStart) || !isInt(b.usedCredits, 0, CREDITS) || !isInt(b.heldCredits, 0, CREDITS) || !isInt(b.availableCredits, 0, CREDITS)
    || !isInt(b.inProgress, 0, 1_000_000)) drift();
  if (b.creditCap === null) {
    if (b.version !== null || b.setBy !== null || b.setAt !== null || b.availableCredits !== 0) drift();
  } else {
    if (!isInt(b.creditCap, 0, HQ_HON_LIMITS.maxCap) || !isInt(b.version, 1, 999_999_999) || !isTimestamp(b.setAt)) drift();
    person(b.setBy);
    if ((b.availableCredits as number) !== Math.max((b.creditCap as number) - (b.usedCredits as number) - (b.heldCredits as number), 0)) drift();
  }
  return b as unknown as HqHonBudget;
}
export function validateHqHonTurn(value: unknown): HqHonTurn {
  const t = record(value, drift);
  exactKeys(t, ['turnId', 'agentKey', 'replyMode', 'question', 'status', 'failureReason', 'reply', 'truncated', 'concealed', 'reservedCredits',
    'chargedCredits', 'askedBy', 'version', 'createdAt', 'completedAt'], drift);
  if (!isUuid(t.turnId) || !isHqHonAgent(t.agentKey) || !has(HON_REPLY_MODE_KEYS, t.replyMode) || !isHqHonQuestion(t.question)
    || !has(HQ_HON_STATUSES, t.status) || typeof t.concealed !== 'boolean' || !isInt(t.version, 1, 999_999_999) || !isTimestamp(t.createdAt)
    || !(t.completedAt === null || isTimestamp(t.completedAt))) drift();
  person(t.askedBy);
  const status = t.status as HqHonStatus, mode = t.replyMode as HonReplyMode;
  if (t.reservedCredits !== HQ_HON_MODE_CREDITS[mode]) drift();
  if ((status === 'ANSWERING') !== (t.completedAt === null)) drift();
  if (t.completedAt !== null && Date.parse(t.completedAt as string) < Date.parse(t.createdAt as string)) drift();
  if (status === 'ANSWERED') {
    if (typeof t.truncated !== 'boolean' || t.failureReason !== null || !isInt(t.chargedCredits, 0, t.reservedCredits as number)) drift();
    if (t.concealed ? t.reply !== null : !(typeof t.reply === 'string' && t.reply.trim() === t.reply && t.reply.length >= 1
      && t.reply.length <= HON_REPLY_LIMITS.replyCharacters)) drift();
  } else {
    if (t.reply !== null || t.truncated !== null || t.concealed) drift();
    if (status === 'RESOLVED_CHARGED' ? !isInt(t.chargedCredits, 0, t.reservedCredits as number) : t.chargedCredits !== null) drift();
    if (status === 'ANSWERING' && t.failureReason !== null) drift();
    if (status === 'FAILED' && !has(HQ_HON_FAILED_REASONS, t.failureReason)) drift();
    if (status === 'UNDER_REVIEW' && !has(HQ_HON_REVIEW_REASONS, t.failureReason)) drift();
    if (status.startsWith('RESOLVED') && !(t.failureReason === null || has(HQ_HON_REVIEW_REASONS, t.failureReason))) drift();
  }
  return t as unknown as HqHonTurn;
}
function turns(value: unknown): HqHonTurn[] {
  if (!Array.isArray(value) || value.length > HQ_HON_LIMITS.listLimit) drift();
  const list = (value as unknown[]).map(validateHqHonTurn);
  if (new Set(list.map(t => t.turnId)).size !== list.length) drift();
  for (let i = 1; i < list.length; i++) if (Date.parse(list[i - 1]!.createdAt) < Date.parse(list[i]!.createdAt)) drift();
  return list;
}
function records(r: Record<string, unknown>): void {
  if (r.limit !== HQ_HON_LIMITS.listLimit || !isTimestamp(r.asOf) || !Array.isArray(r.budgetHistory) || r.budgetHistory.length > HQ_HON_LIMITS.historyLimit) drift();
  budget(r.budget);
  const v = record(r.viewer, drift); exactKeys(v, ['principalId', 'displayName', 'isOwner'], drift);
  if (!isUuid(v.principalId) || !text(v.displayName, 1, 120) || typeof v.isOwner !== 'boolean') drift();
  const mine = turns(r.turns), held = turns(r.underReview);
  if (mine.some(t => t.askedBy.principalId.toLowerCase() !== (v.principalId as string).toLowerCase())) drift();
  if (!v.isOwner && (held.length > 0 || (r.budgetHistory as unknown[]).length > 0)) drift();
  if (held.some(t => t.status !== 'UNDER_REVIEW' && t.status !== 'ANSWERING')) drift();
  (r.budgetHistory as unknown[]).forEach(value => {
    const h = record(value, drift); exactKeys(h, ['periodStart', 'version', 'creditCap', 'previousCap', 'reason', 'actor', 'recordedAt'], drift);
    if (!isMonth(h.periodStart) || !isInt(h.version, 1, 999_999_999) || !isInt(h.creditCap, 0, HQ_HON_LIMITS.maxCap)
      || ((h.version === 1) !== (h.previousCap === null)) || !(h.previousCap === null || isInt(h.previousCap, 0, HQ_HON_LIMITS.maxCap))
      || !text(h.reason, 3, HQ_HON_LIMITS.reason) || !isTimestamp(h.recordedAt)) drift();
    person(h.actor);
  });
}
/** The database read (0263). */
export function validateHqHonConversationRecords(value: unknown): HqHonConversationRecords {
  const r = record(value, drift); exactKeys(r, ['budget', 'turns', 'budgetHistory', 'underReview', 'limit', 'viewer', 'asOf'], drift);
  records(r); return r as unknown as HqHonConversationRecords;
}
/** The API view: the records plus whether the text provider runtime is connected (server runtime, never a client choice). */
export function validateHqHonConversation(value: unknown): HqHonConversation {
  const r = record(value, drift); exactKeys(r, ['provider', 'budget', 'turns', 'budgetHistory', 'underReview', 'limit', 'viewer', 'asOf'], drift);
  if (!has(['CONNECTED', 'NOT_CONNECTED'], r.provider)) drift();
  records(r); return r as unknown as HqHonConversation;
}
function invocation(value: unknown, turn: HqHonTurn): HqHonInvocation {
  const i = record(value, drift);
  exactKeys(i, ['turnId', 'agentKey', 'providerId', 'modelId', 'providerRequestId', 'replyMode', 'question', 'facts', 'inputBudget', 'outputBudget', 'maxCostMicrounits'], drift);
  const fixed = HON_REPLY_MODES[turn.replyMode];
  if (i.turnId !== turn.turnId || i.providerRequestId !== turn.turnId || i.agentKey !== turn.agentKey || i.replyMode !== turn.replyMode
    || i.question !== turn.question || i.providerId !== 'OPENROUTER' || !text(i.modelId, 1, 200) || typeof i.facts !== 'string'
    || i.facts.length < 2 || i.facts.length > 200_000 || i.inputBudget !== fixed.inputTokens || i.outputBudget !== fixed.outputTokens
    || i.maxCostMicrounits !== fixed.maxProviderCostMicrounits) drift();
  return i as unknown as HqHonInvocation;
}
/** The database ask receipt: an invocation only on the call that created an ANSWERING turn, never on a replay. */
export function validateHqHonAskRecords(value: unknown): HqHonAskRecords {
  const r = record(value, drift); exactKeys(r, ['turn', 'invocation', 'budget', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  const t = validateHqHonTurn(r.turn); budget(r.budget);
  if (r.replayed || t.status !== 'ANSWERING' ? r.invocation !== null : r.invocation === null) drift();
  if (r.invocation !== null) invocation(r.invocation, t);
  return r as unknown as HqHonAskRecords;
}
export function validateHqHonTurnReceipt(value: unknown): HqHonTurnReceipt {
  const r = record(value, drift); exactKeys(r, ['turn', 'budget', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  validateHqHonTurn(r.turn); budget(r.budget);
  return r as unknown as HqHonTurnReceipt;
}
export function validateHqHonBudgetReceipt(value: unknown): HqHonBudgetReceipt {
  const r = record(value, drift); exactKeys(r, ['budget', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  if (budget(r.budget).creditCap === null) drift();
  return r as unknown as HqHonBudgetReceipt;
}
