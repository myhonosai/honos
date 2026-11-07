// C1 HON conversation delegation. A conversation belongs to one human at one school; each human turn names exactly one
// live specialist and that specialist's own typed target. The specialist's existing service, S4 spend protections and
// the Action Engine CONFIRM proposal do the work; nothing consequential runs without a human approval in Action Center.
// C2 "Ask HON": a turn may instead be a question for HON ({ text, delegation: null }). HON answers in text from the
// school's authorized aggregate facts and this conversation only; it can recommend but never act. Its reply is shown
// only once the reply is COMPLETED (usage recorded first); a held, failed or unknown reply shows no text.
import { championsExactKeys as exactKeys, championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { marketingSafeText } from './marketing-assistant.js';
import { FOLLOW_UP_DRAFT_PURPOSES, type FollowUpDraftPurpose } from './chad-follow-up-assistant.js';

export const HON_TURN_STATUSES = ['READY', 'PROCESSING', 'DELEGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type HonTurnStatus = typeof HON_TURN_STATUSES[number];
/** Delegate specialists as clients see them. Kai is the Teaching & Curriculum assistant (owner blueprint 2026-11-06). */
export const HON_DELEGATE_AGENTS = ['marcus', 'kai', 'chad'] as const;
/** @deprecated Accepted for one release as an alias of 'kai' (legacy teaching key); responses always say 'kai'. */
export const HON_LEGACY_TEACHING_AGENT = 'claire' as const;
export type HonDelegateAgentKey = typeof HON_DELEGATE_AGENTS[number];
/** At most this many specialists HON may suggest for one answer. A suggestion is never run without the human confirming it. */
export const HON_REPLY_MAX_SUGGESTIONS = 3;
export const HON_TURN_TEXT_LIMITS: Readonly<Record<HonDelegateAgentKey, number>> = { marcus: 2000, kai: 1200, chad: 2000 };

export type HonDelegation =
  | { agentKey: 'marcus'; campaignId: string }
  | { agentKey: 'kai'; curriculumId: string }
  /** @deprecated use 'kai'. Passed through unchanged so a resend of an earlier turn still matches its fingerprint. */
  | { agentKey: typeof HON_LEGACY_TEACHING_AGENT; curriculumId: string }
  | { agentKey: 'chad'; leadId: string; expectedLeadVersion: number; purpose: FollowUpDraftPurpose };
/**
 * HON reply modes (owner decision 2026-11-06 16:10Z). The human chooses the mode; the server never upgrades one. Both
 * share the owner's hard $0.08 provider-cost ceiling per call. The planner reserves the worst case
 * (reservedCredits = ceil((input+output)/1000)) and the result settles to the measured tokens, releasing the rest.
 */
export const HON_REPLY_MODES = {
  STANDARD: { taskClass: 'SUMMARIZE', inputTokens: 8000, outputTokens: 1500, maxProviderCostMicrounits: 80000, reservedCredits: 10 },
  DETAILED: { taskClass: 'ANALYZE', inputTokens: 11000, outputTokens: 4000, maxProviderCostMicrounits: 80000, reservedCredits: 15 },
} as const;
export type HonReplyMode = keyof typeof HON_REPLY_MODES;
export const HON_REPLY_MODE_KEYS = ['STANDARD', 'DETAILED'] as const satisfies readonly HonReplyMode[];
/** An answer cut off at its output limit may be continued by the human, at most this many steps per answer in total. */
export const HON_REPLY_MAX_STEPS = 3;
export const HON_REPLY_LIMITS = { questionCharacters: 2000, replyCharacters: 24000 } as const;
export interface HonTurnRequest {
  text: string; delegation: HonDelegation | null;
  /** Question turns only. Defaults to STANDARD. A continuation keeps the mode of the answer it continues. */
  replyMode?: HonReplyMode;
  /** Question turns only: continue this turn's cut-off answer (replyDetail.canContinue). */
  continueTurnId?: string;
}
/** The conversational responder of a question turn (not one of the delegate specialists). */
export const HON_REPLY_ROLE = 'hon' as const;
/** How a HON reply was produced. truncated: cut off at the output limit (shown as incomplete, never as complete). */
export interface HonReplyDetail { mode: HonReplyMode; step: number; maxSteps: number; truncated: boolean; canContinue: boolean; continuesTurnId: string | null;
  /** Specialists HON suggests for this answer: only READY delegates this reader may use, never for a cut-off or concealed answer. Suggestions do nothing until confirmed as a delegation turn. */
  suggestions: HonDelegateAgentKey[] }
export interface HonConversationCreate { title: string }

export interface HonConversationSummary { id: string; title: string; createdAt: string; updatedAt: string; turnCount: number; status: HonTurnStatus }
export interface HonConversationPage { items: HonConversationSummary[]; nextCursor: string | null }
export interface HonConversationTurn {
  turnId: string; role: 'HUMAN' | HonDelegateAgentKey | typeof HON_REPLY_ROLE; text: string | null; createdAt: string; status: HonTurnStatus; reason: string | null;
  references: { workItemId: string | null; actionRequestId: string | null; invocationId: string | null };
  /** HON question turns only (role 'hon'); null for the human's turn and for specialists. */
  replyDetail: HonReplyDetail | null;
}
export interface HonConversationThread extends HonConversationSummary { turns: HonConversationTurn[] }
export interface HonTurnReceipt {
  turnId: string; conversationId: string; status: HonTurnStatus; reason: string | null; delegatedAgentKeys: HonDelegateAgentKey[];
  actionRequestIds: string[]; workItemIds: string[]; invocationId: string | null;
  /** HON's reply text for a COMPLETED question turn; null otherwise (and always null for a delegation). */
  reply: string | null;
  /** HON question turns only; null for a delegation. */
  replyDetail: HonReplyDetail | null;
}
/** Server-confirmed composer prerequisites for this requester. The composer offers only availableAgentKeys. */
export interface HonConversationReadiness {
  contract: true; providerRoute: boolean; entitlement: boolean; authorization: boolean; availableAgentKeys: HonDelegateAgentKey[];
  /** True when a question to HON would be admitted now (authorized, spend allowed, routed, runtime ready, budget left). */
  honReply: boolean; asOf: string;
}

const fail = (code: string) => (): never => { throw new Error(code); };
const invalid = fail('INVALID_HON_CONVERSATION_INPUT');
const drift = fail('INVALID_HON_CONVERSATION_RESPONSE');
const isAgent = (v: unknown): v is HonDelegateAgentKey => (HON_DELEGATE_AGENTS as readonly unknown[]).includes(v);
const isReply = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= HON_REPLY_LIMITS.replyCharacters;
const isReplyDetail = (v: unknown, completed: boolean): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  const keys = Object.keys(d).sort().join(',');
  const sug = d.suggestions;
  return keys === 'canContinue,continuesTurnId,maxSteps,mode,step,suggestions,truncated'
    && Array.isArray(sug) && sug.length <= HON_REPLY_MAX_SUGGESTIONS && sug.every(isAgent) && new Set(sug).size === sug.length
    // Only a completed, whole answer can carry suggestions.
    && (sug.length === 0 || (completed && d.truncated === false))
    && (HON_REPLY_MODE_KEYS as readonly unknown[]).includes(d.mode) && d.maxSteps === HON_REPLY_MAX_STEPS
    && Number.isSafeInteger(d.step) && (d.step as number) >= 1 && (d.step as number) <= HON_REPLY_MAX_STEPS
    && ((d.step === 1) === (d.continuesTurnId === null)) && (d.continuesTurnId === null || isUuid(d.continuesTurnId))
    && typeof d.truncated === 'boolean' && typeof d.canContinue === 'boolean'
    // Only a completed answer can be cut off or continued; the last step can never be continued.
    && (completed || (!d.truncated && !d.canContinue)) && (!d.canContinue || (d.truncated && (d.step as number) < HON_REPLY_MAX_STEPS));
};
/** A COMPLETED reply whose source authority or AI access no longer holds for this reader: no text, never continued. */
export const HON_REPLY_CONCEALED_REASON = 'RESULT_CONCEALED';
const CONCEALED = HON_REPLY_CONCEALED_REASON;
const completedText = (text: unknown, reason: unknown): boolean => (reason === CONCEALED ? text === null : reason === null && isReply(text));
const isStatus = (v: unknown): v is HonTurnStatus => (HON_TURN_STATUSES as readonly unknown[]).includes(v);
const isReason = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(v));
const uuidOrNull = (v: unknown): boolean => v === null || isUuid(v);

export function validateHonConversationCreate(value: unknown): HonConversationCreate {
  const r = record(value, invalid); exactKeys(r, ['title'], invalid);
  if (!marketingSafeText(r.title, 120)) invalid();
  return { title: (r.title as string).trim() };
}

export function validateHonTurnRequest(value: unknown): HonTurnRequest {
  const r = record(value, invalid);
  if (r.delegation === null) {
    exactKeys(r, ['text', 'delegation', ...('replyMode' in r ? ['replyMode'] : []), ...('continueTurnId' in r ? ['continueTurnId'] : [])], invalid);
    if (!marketingSafeText(r.text, HON_REPLY_LIMITS.questionCharacters) || (r.text as string).trim().length === 0) invalid();
    if ('replyMode' in r && !(HON_REPLY_MODE_KEYS as readonly unknown[]).includes(r.replyMode)) invalid();
    if ('continueTurnId' in r && !isUuid(r.continueTurnId)) invalid();
    return { text: r.text as string, delegation: null,
      ...('replyMode' in r ? { replyMode: r.replyMode as HonReplyMode } : {}), ...('continueTurnId' in r ? { continueTurnId: r.continueTurnId as string } : {}) };
  }
  exactKeys(r, ['text', 'delegation'], invalid);
  const d = record(r.delegation, invalid);
  const teaching = d.agentKey === 'kai' || d.agentKey === HON_LEGACY_TEACHING_AGENT;
  if (!(isAgent(d.agentKey) || teaching) || !marketingSafeText(r.text, HON_TURN_TEXT_LIMITS[teaching ? 'kai' : d.agentKey as HonDelegateAgentKey])) invalid();
  const text = r.text as string;
  if (d.agentKey === 'marcus') { exactKeys(d, ['agentKey', 'campaignId'], invalid); if (!isUuid(d.campaignId)) invalid(); return { text, delegation: { agentKey: 'marcus', campaignId: d.campaignId as string } }; }
  if (teaching) { exactKeys(d, ['agentKey', 'curriculumId'], invalid); if (!isUuid(d.curriculumId)) invalid(); return { text, delegation: { agentKey: d.agentKey as 'kai' | typeof HON_LEGACY_TEACHING_AGENT, curriculumId: d.curriculumId as string } }; }
  exactKeys(d, ['agentKey', 'leadId', 'expectedLeadVersion', 'purpose'], invalid);
  if (!isUuid(d.leadId) || !Number.isSafeInteger(d.expectedLeadVersion) || (d.expectedLeadVersion as number) < 1 || (d.expectedLeadVersion as number) > 999_999_999
    || !(FOLLOW_UP_DRAFT_PURPOSES as readonly unknown[]).includes(d.purpose)) invalid();
  return { text, delegation: { agentKey: 'chad', leadId: d.leadId as string, expectedLeadVersion: d.expectedLeadVersion as number, purpose: d.purpose as FollowUpDraftPurpose } };
}

export function validateHonConversationSummary(value: unknown, extra: readonly string[] = []): HonConversationSummary {
  const r = record(value, drift); exactKeys(r, ['id', 'title', 'createdAt', 'updatedAt', 'turnCount', 'status', ...extra], drift);
  if (!isUuid(r.id) || typeof r.title !== 'string' || !isTimestamp(r.createdAt) || !isTimestamp(r.updatedAt) || !Number.isSafeInteger(r.turnCount)
    || (r.turnCount as number) < 0 || (r.turnCount as number) > 200 || !isStatus(r.status)) drift();
  return r as unknown as HonConversationSummary;
}

export function validateHonConversationThread(value: unknown): HonConversationThread {
  const r = validateHonConversationSummary(value, ['turns']) as HonConversationThread;
  if (!Array.isArray(r.turns) || r.turns.length !== r.turnCount * 2) drift();
  r.turns.forEach((x, i) => {
    const t = record(x, drift); exactKeys(t, ['turnId', 'role', 'text', 'createdAt', 'status', 'reason', 'references', 'replyDetail'], drift);
    const refs = record(t.references, drift); exactKeys(refs, ['workItemId', 'actionRequestId', 'invocationId'], drift);
    const human = i % 2 === 0;
    if (!isUuid(t.turnId) || !isTimestamp(t.createdAt) || !isStatus(t.status) || !isReason(t.reason) || !uuidOrNull(refs.workItemId) || !uuidOrNull(refs.actionRequestId) || !uuidOrNull(refs.invocationId)) drift();
    if (human ? (t.role !== 'HUMAN' || typeof t.text !== 'string' || t.reason !== null || refs.workItemId !== null || refs.actionRequestId !== null || refs.invocationId !== null)
      : ((r.turns[i - 1] as HonConversationTurn).turnId !== t.turnId
        // A specialist's draft never appears here; HON's own reply appears only when COMPLETED, with no Action Center link.
        || (t.role === HON_REPLY_ROLE ? (refs.actionRequestId !== null || (t.status === 'COMPLETED' ? !completedText(t.text, t.reason) : t.text !== null)
            || !isReplyDetail(t.replyDetail, t.status === 'COMPLETED') || (t.reason === CONCEALED && ((t.replyDetail as HonReplyDetail).canContinue || (t.replyDetail as HonReplyDetail).suggestions.length > 0)))
          : (!isAgent(t.role) || t.text !== null || t.replyDetail !== null)))) drift();
    if (human && t.replyDetail !== null) drift();
  });
  return r;
}

export function validateHonTurnReceipt(value: unknown): HonTurnReceipt {
  const r = record(value, drift);
  exactKeys(r, ['turnId', 'conversationId', 'status', 'reason', 'delegatedAgentKeys', 'actionRequestIds', 'workItemIds', 'invocationId', 'reply', 'replyDetail'], drift);
  if (!isUuid(r.turnId) || !isUuid(r.conversationId) || !isStatus(r.status) || r.status === 'READY' || !isReason(r.reason) || !uuidOrNull(r.invocationId)
    || !Array.isArray(r.delegatedAgentKeys) || r.delegatedAgentKeys.length > 1 || !r.delegatedAgentKeys.every(isAgent)
    || !Array.isArray(r.actionRequestIds) || r.actionRequestIds.length > 1 || !r.actionRequestIds.every(isUuid)
    || !Array.isArray(r.workItemIds) || r.workItemIds.length > 1 || !r.workItemIds.every(isUuid)) drift();
  // An approval is claimed only with its Action Center reference.
  if (r.status === 'AWAITING_APPROVAL' && (r.actionRequestIds as unknown[]).length !== 1) drift();
  // A question turn (no delegate) has no approval; its reply is present exactly when COMPLETED. A delegation has no reply.
  if ((r.delegatedAgentKeys as unknown[]).length === 0
    ? ((r.actionRequestIds as unknown[]).length !== 0 || r.status === 'AWAITING_APPROVAL' || (r.status === 'COMPLETED' ? !completedText(r.reply, r.reason) : r.reply !== null)
      || !isReplyDetail(r.replyDetail, r.status === 'COMPLETED') || (r.reason === CONCEALED && ((r.replyDetail as HonReplyDetail).canContinue || (r.replyDetail as HonReplyDetail).suggestions.length > 0)))
    : (r.reply !== null || r.replyDetail !== null)) drift();
  return r as unknown as HonTurnReceipt;
}

/** Composer prerequisites from server-evaluated AI team readiness (AI-R1). No provider is called. */
export function composeHonConversationReadiness(team: {
  completeEntitlement: boolean; asOf: string;
  agents: readonly { agentKey: string; authorized: boolean; spendDecision: string; route: string; providerRuntime: string; available: boolean }[];
}): HonConversationReadiness {
  const agents = team.agents.filter((a) => isAgent(a.agentKey));
  const hon = team.agents.find((a) => a.agentKey === HON_REPLY_ROLE);
  return {
    contract: true,
    authorization: agents.some((a) => a.authorized),
    entitlement: team.completeEntitlement && agents.length > 0 && agents.every((a) => a.spendDecision === 'ALLOWED'),
    providerRoute: agents.some((a) => a.route === 'CONFIGURED' && a.providerRuntime === 'READY'),
    availableAgentKeys: agents.filter((a) => a.available).map((a) => a.agentKey as HonDelegateAgentKey),
    honReply: hon?.available === true,
    asOf: team.asOf,
  };
}
