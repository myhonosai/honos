// C1 HON conversation delegation. A conversation belongs to one human at one school; each human turn names exactly one
// live specialist and that specialist's own typed target. The specialist's existing service, S4 spend protections and
// the Action Engine CONFIRM proposal do the work; nothing consequential runs without a human approval in Action Center.
// C2 "Ask HON": a turn may instead be a question for HON ({ text, delegation: null }). HON answers in text from the
// school's authorized aggregate facts and this conversation only; it can recommend but never act. Its reply is shown
// only once the reply is COMPLETED (usage recorded first); a held, failed or unknown reply shows no text.
// K2: a turn may instead be a question for Claire, Business Performance ({ text, delegation: { agentKey: 'claire' } }).
// Claire answers in text from the school's aggregate Command Center metrics only (reporting.view required); she drafts
// and changes nothing. Her answer is shown like HON's: only when COMPLETED and while the reader may still see it.
import { championsExactKeys as exactKeys, championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { marketingSafeText } from './marketing-assistant.js';
import { FOLLOW_UP_DRAFT_PURPOSES, type FollowUpDraftPurpose } from './chad-follow-up-assistant.js';

export const HON_TURN_STATUSES = ['READY', 'PROCESSING', 'DELEGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type HonTurnStatus = typeof HON_TURN_STATUSES[number];
/** Delegate specialists as clients see them. Kai is the Teaching & Curriculum assistant (owner blueprint 2026-11-06). */
export const HON_DELEGATE_AGENTS = ['marcus', 'kai', 'chad'] as const;
export type HonDelegateAgentKey = typeof HON_DELEGATE_AGENTS[number];
/**
 * K2: Claire, Business Performance. A read-only analyst: her turn is answered in text (like HON's), never a draft. The
 * K1 legacy 'claire' teaching alias is retired: { agentKey: 'claire', curriculumId } is refused; teaching is 'kai' only.
 */
export const HON_ANALYST_AGENT = 'claire' as const;
/**
 * 0260: the read-only analysis specialists. Claire (Business Performance), Alex (general management), Jordan (operations)
 * and Lena (creative & commerce) all answer in text from the school's own aggregate facts; none drafts or changes anything.
 */
export const HON_ANALYST_AGENTS = ['claire', 'alex', 'jordan', 'lena', 'maya'] as const;
export type HonAnalystAgentKey = typeof HON_ANALYST_AGENTS[number];
export const isHonAnalystAgent = (v: unknown): v is HonAnalystAgentKey => (HON_ANALYST_AGENTS as readonly unknown[]).includes(v);
/** K2c: who a HON answer may suggest (closed set; capability-filtered by the server): the delegates, and Claire. */
export const HON_SUGGESTED_AGENTS = ['marcus', 'kai', 'chad', HON_ANALYST_AGENT] as const;
export type HonSuggestedAgentKey = typeof HON_SUGGESTED_AGENTS[number];
/** At most this many specialists HON may suggest for one answer. A suggestion is never run without the human confirming it. */
export const HON_REPLY_MAX_SUGGESTIONS = 3;
/**
 * 0254: "Based on" sources. The closed fact areas an answer may name: the Command Center metric keys, the earlier
 * conversation and the recorded specialist results. The database keeps only areas actually sent with that answer.
 */
export const HON_REPLY_SOURCE_KEYS = ['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems',
  'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue', 'conversation', 'specialistResults', 'schoolNotes'] as const;
export type HonReplySourceKey = typeof HON_REPLY_SOURCE_KEYS[number];
export const HON_REPLY_SOURCE_LABELS: Readonly<Record<HonReplySourceKey, string>> = {
  newLeads24h: 'New leads (24h)', upcomingTrials24h: 'Trials in the next 24h', upcomingTestingEvents30d: 'Testing events (30 days)',
  pendingActionApprovals: 'Pending approvals', outstandingWorkItems: 'Open work items', membershipTermsEnding30d: 'Memberships ending (30 days)',
  paidInvoicesCreated30d: 'Paid invoices (30 days)', unansweredInquiries: 'Unanswered inquiries', attendanceDecline: 'Attendance decline',
  trialConversion: 'Trial conversion', revenue: 'Revenue', conversation: 'Earlier conversation', specialistResults: 'Specialist results',
  schoolNotes: 'School notes',
};
export const HON_REPLY_MAX_SOURCES = 5;
/** 0254: "Ask next" follow-up questions. Plain text only; tapping one fills the composer and runs nothing. */
export const HON_REPLY_MAX_FOLLOW_UPS = 3;
export const HON_REPLY_FOLLOW_UP_LIMITS = { minCharacters: 3, maxCharacters: 150 } as const;
/**
 * One follow-up question: trimmed, 3-150 characters counted as code points (as PostgreSQL length() does), no control
 * characters (C0, DEL or C1), markup or links. The database applies the same rule and drops, never raises, on a mismatch.
 */
export function isHonReplyFollowUp(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const points = [...value].length;
  return points >= HON_REPLY_FOLLOW_UP_LIMITS.minCharacters && points <= HON_REPLY_FOLLOW_UP_LIMITS.maxCharacters
    && !/[\u0000-\u001f\u007f-\u009f<>]|https?|www\.|:\/\//i.test(value);
}
export const isHonReplySourceKey = (value: unknown): value is HonReplySourceKey => (HON_REPLY_SOURCE_KEYS as readonly unknown[]).includes(value);
const distinctFollowUps = (v: unknown[]): boolean => new Set(v.map((x) => String(x).toLowerCase())).size === v.length;
export const HON_TURN_TEXT_LIMITS: Readonly<Record<HonDelegateAgentKey, number>> = { marcus: 2000, kai: 1200, chad: 2000 };

export type HonDelegation =
  | { agentKey: 'marcus'; campaignId: string }
  | { agentKey: 'kai'; curriculumId: string }
  /** An analysis specialist's question is the turn's text (at most HON_REPLY_LIMITS.questionCharacters); no target. */
  | { agentKey: Exclude<HonAnalystAgentKey, 'maya'> }
  /** 0284: Maya answers about one at-risk membership of this school (the 0259 list); no other target. */
  | { agentKey: 'maya'; membershipId: string }
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
  /**
   * Delegation turns only (C3a): the human confirms a specialist HON suggested in this HON answer (its replyDetail.suggestions
   * names the delegated agent). The turn is an ordinary delegation; it is also grouped with the answer's other confirmations.
   */
  fromSuggestionTurnId?: string;
  /**
   * Question turns only (C3b), never with continueTurnId: ask HON to summarize the recorded outcomes of the confirmed group
   * of this HON answer (HonOrchestration.sourceTurnId) once it is finished (COMPLETED, FAILED or PARTIAL).
   */
  summarizeTurnId?: string;
}
/** The conversational responder of a question turn (not one of the delegate specialists). */
export const HON_REPLY_ROLE = 'hon' as const;
/** How a HON reply was produced. truncated: cut off at the output limit (shown as incomplete, never as complete). */
export interface HonReplyDetail { mode: HonReplyMode; step: number; maxSteps: number; truncated: boolean; canContinue: boolean; continuesTurnId: string | null;
  /** Specialists HON suggests for this answer: only READY delegates this reader may use, never for a cut-off or concealed answer. Suggestions do nothing until confirmed as a delegation turn. */
  suggestions: HonSuggestedAgentKey[];
  /** 0254: up to three follow-up questions for a whole, shown, completed answer (else empty). Tapping one runs nothing. */
  followUps: string[];
  /** 0254: up to five fact areas this answer was based on, only areas the server sent with it (else empty). */
  sources: HonReplySourceKey[] }
export interface HonConversationCreate { title: string }

export interface HonConversationSummary { id: string; title: string; createdAt: string; updatedAt: string; turnCount: number; status: HonTurnStatus }
export interface HonConversationPage { items: HonConversationSummary[]; nextCursor: string | null }
export interface HonConversationTurn {
  turnId: string; role: 'HUMAN' | HonDelegateAgentKey | typeof HON_REPLY_ROLE | HonAnalystAgentKey; text: string | null; createdAt: string; status: HonTurnStatus; reason: string | null;
  references: { workItemId: string | null; actionRequestId: string | null; invocationId: string | null };
  /** Answered turns only (role 'hon', or 'claire': always DETAILED, step 1, never continued, no suggestions); null otherwise. */
  replyDetail: HonReplyDetail | null;
}
export interface HonConversationThread extends HonConversationSummary { turns: HonConversationTurn[] }
export interface HonTurnReceipt {
  turnId: string; conversationId: string; status: HonTurnStatus; reason: string | null; delegatedAgentKeys: (HonDelegateAgentKey | HonAnalystAgentKey)[];
  actionRequestIds: string[]; workItemIds: string[]; invocationId: string | null;
  /** The answer text for a COMPLETED question to HON or Claire; null otherwise (and always null for a draft delegation). */
  reply: string | null;
  /** Questions to HON or Claire only; null for a draft delegation. */
  replyDetail: HonReplyDetail | null;
}
/** Server-confirmed composer prerequisites for this requester. The composer offers only availableAgentKeys. */
export interface HonConversationReadiness {
  contract: true; providerRoute: boolean; entitlement: boolean; authorization: boolean; availableAgentKeys: HonDelegateAgentKey[];
  /** True when a question to HON would be admitted now (authorized, spend allowed, routed, runtime ready, budget left). */
  honReply: boolean;
  /** K2: true when a question to Claire (Business Performance) would be admitted now (reporting.view and the same gates). */
  businessPerformance: boolean;
  /** 0260: the analysis specialists a question would be admitted for now (each needs its own capability and the same gates). */
  availableAnalystKeys: HonAnalystAgentKey[]; asOf: string;
}

const fail = (code: string) => (): never => { throw new Error(code); };
const invalid = fail('INVALID_HON_CONVERSATION_INPUT');
const drift = fail('INVALID_HON_CONVERSATION_RESPONSE');
const isAgent = (v: unknown): v is HonDelegateAgentKey => (HON_DELEGATE_AGENTS as readonly unknown[]).includes(v);
const isSuggested = (v: unknown): v is HonSuggestedAgentKey => (HON_SUGGESTED_AGENTS as readonly unknown[]).includes(v);
const isReply = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= HON_REPLY_LIMITS.replyCharacters;
const isReplyDetail = (v: unknown, completed: boolean): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  const keys = Object.keys(d).sort().join(',');
  const sug = d.suggestions, ask = d.followUps, src = d.sources;
  return keys === 'canContinue,continuesTurnId,followUps,maxSteps,mode,sources,step,suggestions,truncated'
    && Array.isArray(sug) && sug.length <= HON_REPLY_MAX_SUGGESTIONS && sug.every(isSuggested) && new Set(sug).size === sug.length
    && Array.isArray(ask) && ask.length <= HON_REPLY_MAX_FOLLOW_UPS && ask.every(isHonReplyFollowUp) && distinctFollowUps(ask)
    && Array.isArray(src) && src.length <= HON_REPLY_MAX_SOURCES && src.every(isHonReplySourceKey) && new Set(src).size === src.length
    // Only a completed, whole answer can carry suggestions, follow-ups or sources.
    && (sug.length + ask.length + src.length === 0 || (completed && d.truncated === false))
    && (HON_REPLY_MODE_KEYS as readonly unknown[]).includes(d.mode) && d.maxSteps === HON_REPLY_MAX_STEPS
    && Number.isSafeInteger(d.step) && (d.step as number) >= 1 && (d.step as number) <= HON_REPLY_MAX_STEPS
    && ((d.step === 1) === (d.continuesTurnId === null)) && (d.continuesTurnId === null || isUuid(d.continuesTurnId))
    && typeof d.truncated === 'boolean' && typeof d.canContinue === 'boolean'
    // Only a completed answer can be cut off or continued; the last step can never be continued.
    && (completed || (!d.truncated && !d.canContinue)) && (!d.canContinue || (d.truncated && (d.step as number) < HON_REPLY_MAX_STEPS));
};
/** Claire's answer detail: one fixed DETAILED analysis, never continued, never with suggestions. */
const isAnalystDetail = (v: unknown, completed: boolean): boolean => isReplyDetail(v, completed)
  && (v as HonReplyDetail).mode === 'DETAILED' && (v as HonReplyDetail).step === 1 && !(v as HonReplyDetail).canContinue && (v as HonReplyDetail).suggestions.length === 0;
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
    exactKeys(r, ['text', 'delegation', ...('replyMode' in r ? ['replyMode'] : []), ...('continueTurnId' in r ? ['continueTurnId'] : []),
      ...('summarizeTurnId' in r ? ['summarizeTurnId'] : [])], invalid);
    if (!marketingSafeText(r.text, HON_REPLY_LIMITS.questionCharacters) || (r.text as string).trim().length === 0) invalid();
    if ('replyMode' in r && !(HON_REPLY_MODE_KEYS as readonly unknown[]).includes(r.replyMode)) invalid();
    if ('continueTurnId' in r && !isUuid(r.continueTurnId)) invalid();
    if ('summarizeTurnId' in r && (!isUuid(r.summarizeTurnId) || 'continueTurnId' in r)) invalid();
    return { text: r.text as string, delegation: null,
      ...('replyMode' in r ? { replyMode: r.replyMode as HonReplyMode } : {}), ...('continueTurnId' in r ? { continueTurnId: r.continueTurnId as string } : {}),
      ...('summarizeTurnId' in r ? { summarizeTurnId: r.summarizeTurnId as string } : {}) };
  }
  exactKeys(r, ['text', 'delegation', ...('fromSuggestionTurnId' in r ? ['fromSuggestionTurnId'] : [])], invalid);
  if ('fromSuggestionTurnId' in r && !isUuid(r.fromSuggestionTurnId)) invalid();
  const from = 'fromSuggestionTurnId' in r ? { fromSuggestionTurnId: r.fromSuggestionTurnId as string } : {};
  const d = record(r.delegation, invalid);
  if (isHonAnalystAgent(d.agentKey)) {
    // An analysis specialist's question needs text. K2c: only Claire may confirm HON's suggestion (fromSuggestionTurnId);
    // the other specialists are not in HON's suggestion set. 0284: Maya names one membership.
    exactKeys(d, d.agentKey === 'maya' ? ['agentKey', 'membershipId'] : ['agentKey'], invalid);
    if ((d.agentKey !== HON_ANALYST_AGENT && 'fromSuggestionTurnId' in r) || !marketingSafeText(r.text, HON_REPLY_LIMITS.questionCharacters) || (r.text as string).trim().length === 0) invalid();
    if (d.agentKey === 'maya') {
      if (!isUuid(d.membershipId)) invalid();
      return { text: r.text as string, delegation: { agentKey: 'maya', membershipId: (d.membershipId as string).toLowerCase() } };
    }
    return { text: r.text as string, delegation: { agentKey: d.agentKey }, ...(d.agentKey === HON_ANALYST_AGENT ? from : {}) };
  }
  if (!isAgent(d.agentKey) || !marketingSafeText(r.text, HON_TURN_TEXT_LIMITS[d.agentKey])) invalid();
  const text = r.text as string;
  if (d.agentKey === 'marcus') { exactKeys(d, ['agentKey', 'campaignId'], invalid); if (!isUuid(d.campaignId)) invalid(); return { text, delegation: { agentKey: 'marcus', campaignId: d.campaignId as string }, ...from }; }
  if (d.agentKey === 'kai') { exactKeys(d, ['agentKey', 'curriculumId'], invalid); if (!isUuid(d.curriculumId)) invalid(); return { text, delegation: { agentKey: 'kai', curriculumId: d.curriculumId as string }, ...from }; }
  exactKeys(d, ['agentKey', 'leadId', 'expectedLeadVersion', 'purpose'], invalid);
  if (!isUuid(d.leadId) || !Number.isSafeInteger(d.expectedLeadVersion) || (d.expectedLeadVersion as number) < 1 || (d.expectedLeadVersion as number) > 999_999_999
    || !(FOLLOW_UP_DRAFT_PURPOSES as readonly unknown[]).includes(d.purpose)) invalid();
  return { text, delegation: { agentKey: 'chad', leadId: d.leadId as string, expectedLeadVersion: d.expectedLeadVersion as number, purpose: d.purpose as FollowUpDraftPurpose }, ...from };
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
        || (t.role === HON_REPLY_ROLE || isHonAnalystAgent(t.role) ? (refs.actionRequestId !== null || (t.status === 'COMPLETED' ? !completedText(t.text, t.reason) : t.text !== null)
            || !(isHonAnalystAgent(t.role) ? isAnalystDetail : isReplyDetail)(t.replyDetail, t.status === 'COMPLETED')
            || (t.reason === CONCEALED && ((t.replyDetail as HonReplyDetail).canContinue || (t.replyDetail as HonReplyDetail).suggestions.length > 0
              || (t.replyDetail as HonReplyDetail).followUps.length > 0 || (t.replyDetail as HonReplyDetail).sources.length > 0)))
          : (!isAgent(t.role) || t.text !== null || t.replyDetail !== null)))) drift();
    if (human && t.replyDetail !== null) drift();
  });
  return r;
}

export function validateHonTurnReceipt(value: unknown): HonTurnReceipt {
  const r = record(value, drift);
  exactKeys(r, ['turnId', 'conversationId', 'status', 'reason', 'delegatedAgentKeys', 'actionRequestIds', 'workItemIds', 'invocationId', 'reply', 'replyDetail'], drift);
  if (!isUuid(r.turnId) || !isUuid(r.conversationId) || !isStatus(r.status) || r.status === 'READY' || !isReason(r.reason) || !uuidOrNull(r.invocationId)
    || !Array.isArray(r.delegatedAgentKeys) || r.delegatedAgentKeys.length > 1 || !r.delegatedAgentKeys.every((k) => isAgent(k) || isHonAnalystAgent(k))
    || !Array.isArray(r.actionRequestIds) || r.actionRequestIds.length > 1 || !r.actionRequestIds.every(isUuid)
    || !Array.isArray(r.workItemIds) || r.workItemIds.length > 1 || !r.workItemIds.every(isUuid)) drift();
  // An approval is claimed only with its Action Center reference.
  if (r.status === 'AWAITING_APPROVAL' && (r.actionRequestIds as unknown[]).length !== 1) drift();
  // A question to HON (no delegate) or to Claire has no approval; its reply is present exactly when COMPLETED. A draft
  // delegation has no reply.
  const analyst = isHonAnalystAgent((r.delegatedAgentKeys as unknown[])[0]);
  if ((r.delegatedAgentKeys as unknown[]).length === 0 || analyst
    ? ((r.actionRequestIds as unknown[]).length !== 0 || r.status === 'AWAITING_APPROVAL' || (r.status === 'COMPLETED' ? !completedText(r.reply, r.reason) : r.reply !== null)
      || !(analyst ? isAnalystDetail : isReplyDetail)(r.replyDetail, r.status === 'COMPLETED')
      || (r.reason === CONCEALED && ((r.replyDetail as HonReplyDetail).canContinue || (r.replyDetail as HonReplyDetail).suggestions.length > 0
              || (r.replyDetail as HonReplyDetail).followUps.length > 0 || (r.replyDetail as HonReplyDetail).sources.length > 0)))
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
  const claire = team.agents.find((a) => a.agentKey === HON_ANALYST_AGENT);
  return {
    contract: true,
    authorization: agents.some((a) => a.authorized),
    entitlement: team.completeEntitlement && agents.length > 0 && agents.every((a) => a.spendDecision === 'ALLOWED'),
    providerRoute: agents.some((a) => a.route === 'CONFIGURED' && a.providerRuntime === 'READY'),
    availableAgentKeys: agents.filter((a) => a.available).map((a) => a.agentKey as HonDelegateAgentKey),
    honReply: hon?.available === true,
    businessPerformance: claire?.available === true,
    availableAnalystKeys: HON_ANALYST_AGENTS.filter((k) => team.agents.some((a) => a.agentKey === k && a.available)),
    asOf: team.asOf,
  };
}

/**
 * C3a grouped confirmation: the specialists a human confirmed from one HON answer's suggestions. The status is derived
 * from the member turns' own recorded statuses, never set by the model:
 * any UNKNOWN -> UNKNOWN; any still running -> PENDING; any awaiting approval -> NEEDS_REVIEW; all completed -> COMPLETED;
 * all failed -> FAILED; otherwise (some completed, some failed) -> PARTIAL.
 */
export const HON_ORCHESTRATION_STATUSES = ['PENDING', 'PARTIAL', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'UNKNOWN'] as const;
export type HonOrchestrationStatus = typeof HON_ORCHESTRATION_STATUSES[number];
export interface HonOrchestrationMember { agentKey: HonSuggestedAgentKey; turnId: string; status: HonTurnStatus }
export interface HonOrchestration { sourceTurnId: string; status: HonOrchestrationStatus; members: HonOrchestrationMember[] }
export interface HonOrchestrationList { items: HonOrchestration[] }

export function deriveHonOrchestrationStatus(statuses: readonly HonTurnStatus[]): HonOrchestrationStatus {
  if (statuses.length === 0 || statuses.includes('UNKNOWN')) return 'UNKNOWN';
  if (statuses.some((x) => x === 'READY' || x === 'PROCESSING' || x === 'DELEGATING')) return 'PENDING';
  if (statuses.includes('AWAITING_APPROVAL')) return 'NEEDS_REVIEW';
  if (statuses.every((x) => x === 'COMPLETED')) return 'COMPLETED';
  if (statuses.every((x) => x === 'FAILED')) return 'FAILED';
  return 'PARTIAL';
}

export function validateHonOrchestrationList(value: unknown): HonOrchestrationList {
  const r = record(value, drift); exactKeys(r, ['items'], drift);
  if (!Array.isArray(r.items) || r.items.length > 200) drift();
  const sources = new Set<unknown>(); const turns = new Set<unknown>();
  for (const x of r.items as unknown[]) {
    const o = record(x, drift); exactKeys(o, ['sourceTurnId', 'status', 'members'], drift);
    if (!isUuid(o.sourceTurnId) || sources.has(o.sourceTurnId) || !Array.isArray(o.members) || o.members.length < 1 || o.members.length > HON_REPLY_MAX_SUGGESTIONS) drift();
    sources.add(o.sourceTurnId);
    const agents = new Set<unknown>();
    for (const m of o.members as unknown[]) {
      const k = record(m, drift); exactKeys(k, ['agentKey', 'turnId', 'status'], drift);
      if (!isSuggested(k.agentKey) || agents.has(k.agentKey) || !isUuid(k.turnId) || turns.has(k.turnId) || k.turnId === o.sourceTurnId || !isStatus(k.status)) drift();
      agents.add(k.agentKey); turns.add(k.turnId);
    }
    // The server's derived status must match the members it reports.
    if (o.status !== deriveHonOrchestrationStatus((o.members as HonOrchestrationMember[]).map((m) => m.status))) drift();
  }
  return r as unknown as HonOrchestrationList;
}

/**
 * 0255: What HON remembers. Notes a person with ai.school_notes.manage saves on purpose; every HON user at the school sees
 * them; HON's answers use them. Never about a student, family or staff member (contacts, links and markup are refused).
 */
export const HON_SCHOOL_NOTE_LIMITS = { maxNotes: 20, maxCharacters: 2000, noteCharacters: 200, minCharacters: 3 } as const;
export interface HonSchoolNote { id: string; text: string; createdAt: string }
export interface HonSchoolNotes { notes: HonSchoolNote[]; canManage: boolean; limits: { maxNotes: number; maxCharacters: number; noteCharacters: number } }
export interface HonSchoolNoteReceipt { record: { note: HonSchoolNote } | { noteId: string; deleted: true }; replayed: boolean }
/** Same rule as the database's hon_school_note_ok. */
/** Spaces as the database spells them out (no locale classes), so both sides refuse exactly the same text. */
const NOTE_SPACE = ' \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const NOTE_EDGE = new RegExp(`^[${NOTE_SPACE}]|[${NOTE_SPACE}]$`);
const NOTE_EMAIL = new RegExp(`[^${NOTE_SPACE}@]+@[^${NOTE_SPACE}@]+`);
const NOTE_PHONE_STRIP = new RegExp(`[${NOTE_SPACE}().+-]`, 'g');
export function isHonSchoolNoteText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= HON_SCHOOL_NOTE_LIMITS.minCharacters && length <= HON_SCHOOL_NOTE_LIMITS.noteCharacters && !NOTE_EDGE.test(value)
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]|https?|www\.|:\/\//i.test(value) && !NOTE_EMAIL.test(value) && !/[0-9]{7,}/.test(value.replace(NOTE_PHONE_STRIP, ''));
}
export function validateHonSchoolNoteInput(value: unknown): { text: string } {
  const r = record(value, invalid); exactKeys(r, ['text'], invalid);
  if (!isHonSchoolNoteText(r.text)) invalid();
  return { text: r.text as string };
}
const isNote = (v: unknown): v is HonSchoolNote => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const n = v as Record<string, unknown>;
  return Object.keys(n).sort().join(',') === 'createdAt,id,text' && isUuid(n.id) && isHonSchoolNoteText(n.text) && isTimestamp(n.createdAt);
};
export function validateHonSchoolNotes(value: unknown): HonSchoolNotes {
  const r = record(value, drift); exactKeys(r, ['canManage', 'limits', 'notes'], drift);
  const l = record(r.limits, drift); exactKeys(l, ['maxCharacters', 'maxNotes', 'noteCharacters'], drift);
  if (typeof r.canManage !== 'boolean' || !Array.isArray(r.notes) || !r.notes.every(isNote) || r.notes.length > HON_SCHOOL_NOTE_LIMITS.maxNotes
    || new Set((r.notes as HonSchoolNote[]).map((n) => n.id)).size !== r.notes.length
    || l.maxNotes !== HON_SCHOOL_NOTE_LIMITS.maxNotes || l.maxCharacters !== HON_SCHOOL_NOTE_LIMITS.maxCharacters || l.noteCharacters !== HON_SCHOOL_NOTE_LIMITS.noteCharacters) drift();
  return { notes: (r.notes as HonSchoolNote[]).map((n) => ({ ...n })), canManage: r.canManage as boolean, limits: { maxNotes: 20, maxCharacters: 2000, noteCharacters: 200 } };
}
export function validateHonSchoolNoteReceipt(value: unknown): HonSchoolNoteReceipt {
  const r = record(value, drift); exactKeys(r, ['record', 'replayed'], drift);
  const rec = record(r.record, drift);
  if (typeof r.replayed !== 'boolean') drift();
  if ('note' in rec) { exactKeys(rec, ['note'], drift); if (!isNote(rec.note)) drift(); return { record: { note: { ...(rec.note as HonSchoolNote) } }, replayed: r.replayed as boolean }; }
  exactKeys(rec, ['deleted', 'noteId'], drift);
  if (rec.deleted !== true || !isUuid(rec.noteId)) drift();
  return { record: { noteId: rec.noteId as string, deleted: true }, replayed: r.replayed as boolean };
}

/**
 * 0256 HON tone per school. A closed key picks one fixed prompt sentence in the API; STANDARD adds nothing (today's
 * wording). The owner picks it; HON and Kai use it; Claire keeps her own voice. Tone never changes the facts rules.
 */
export const HON_AI_TONES = ['STANDARD', 'FRIENDLY_COACH', 'STRAIGHT_TO_THE_POINT', 'FORMAL'] as const;
export type HonAiTone = (typeof HON_AI_TONES)[number];
export const HON_AI_TONE_LABELS: Readonly<Record<HonAiTone, string>> = {
  STANDARD: 'Standard', FRIENDLY_COACH: 'Friendly coach', STRAIGHT_TO_THE_POINT: 'Straight to the point', FORMAL: 'Formal',
};
export const isHonAiTone = (value: unknown): value is HonAiTone => typeof value === 'string' && (HON_AI_TONES as readonly string[]).includes(value);
export interface HonSchoolTone { tone: HonAiTone; canManage: boolean; updatedAt: string | null }
export interface HonSchoolToneReceipt { tone: HonAiTone; previousTone: HonAiTone; replayed: boolean }
export function validateHonSchoolToneInput(value: unknown): { tone: HonAiTone } {
  const r = record(value, invalid); exactKeys(r, ['tone'], invalid);
  if (!isHonAiTone(r.tone)) invalid();
  return { tone: r.tone as HonAiTone };
}
export function validateHonSchoolTone(value: unknown): HonSchoolTone {
  const r = record(value, drift); exactKeys(r, ['canManage', 'tone', 'updatedAt'], drift);
  if (!isHonAiTone(r.tone) || typeof r.canManage !== 'boolean' || !(r.updatedAt === null || isTimestamp(r.updatedAt))) drift();
  return { tone: r.tone as HonAiTone, canManage: r.canManage as boolean, updatedAt: r.updatedAt as string | null };
}
export function validateHonSchoolToneReceipt(value: unknown): HonSchoolToneReceipt {
  const r = record(value, drift); exactKeys(r, ['previousTone', 'replayed', 'tone'], drift);
  if (!isHonAiTone(r.tone) || !isHonAiTone(r.previousTone) || typeof r.replayed !== 'boolean') drift();
  return { tone: r.tone as HonAiTone, previousTone: r.previousTone as HonAiTone, replayed: r.replayed as boolean };
}

/**
 * 0257 weekly briefing, part 1. The owner turns it on for the school and picks the Monday hour (school time); each staff
 * member with the Command Center permission chooses "email me" for themselves. Built from the Command Center facts with
 * no AI call. SMS and sending arrive in 0258; nothing is sent by this part.
 */
export const SCHOOL_BRIEFING_HOURS = { min: 6, max: 11, default: 8 } as const;
export interface SchoolBriefing { enabled: boolean; sendHour: number; canManage: boolean; me: { email: boolean; canSubscribe: boolean } }
export interface SchoolBriefingReceipt { record: SchoolBriefing; replayed: boolean }
export interface SchoolBriefingPreview { subject: string; text: string }
const isBriefingHour = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= SCHOOL_BRIEFING_HOURS.min && (v as number) <= SCHOOL_BRIEFING_HOURS.max;
export function validateSchoolBriefingSettingsInput(value: unknown): { enabled: boolean; sendHour: number } {
  const r = record(value, invalid); exactKeys(r, ['enabled', 'sendHour'], invalid);
  if (typeof r.enabled !== 'boolean' || !isBriefingHour(r.sendHour)) invalid();
  return { enabled: r.enabled as boolean, sendHour: r.sendHour as number };
}
export function validateMySchoolBriefingInput(value: unknown): { email: boolean } {
  const r = record(value, invalid); exactKeys(r, ['email'], invalid);
  if (typeof r.email !== 'boolean') invalid();
  return { email: r.email as boolean };
}
export function validateSchoolBriefing(value: unknown): SchoolBriefing {
  const r = record(value, drift); exactKeys(r, ['canManage', 'enabled', 'me', 'sendHour'], drift);
  const me = record(r.me, drift); exactKeys(me, ['canSubscribe', 'email'], drift);
  if (typeof r.enabled !== 'boolean' || !isBriefingHour(r.sendHour) || typeof r.canManage !== 'boolean' || typeof me.email !== 'boolean' || typeof me.canSubscribe !== 'boolean') drift();
  return { enabled: r.enabled as boolean, sendHour: r.sendHour as number, canManage: r.canManage as boolean, me: { email: me.email as boolean, canSubscribe: me.canSubscribe as boolean } };
}
export function validateSchoolBriefingReceipt(value: unknown): SchoolBriefingReceipt {
  const r = record(value, drift); exactKeys(r, ['record', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  return { record: validateSchoolBriefing(r.record), replayed: r.replayed as boolean };
}
export function validateSchoolBriefingPreview(value: unknown): SchoolBriefingPreview {
  const r = record(value, drift); exactKeys(r, ['subject', 'text'], drift);
  if (typeof r.subject !== 'string' || r.subject.length < 1 || r.subject.length > 200 || typeof r.text !== 'string' || r.text.length < 1 || r.text.length > 4000) drift();
  return { subject: r.subject as string, text: r.text as string };
}
