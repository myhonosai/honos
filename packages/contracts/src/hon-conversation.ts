// C1 HON conversation delegation. A conversation belongs to one human at one school; each human turn names exactly one
// live specialist and that specialist's own typed target. The specialist's existing service, S4 spend protections and
// the Action Engine CONFIRM proposal do the work; nothing consequential runs without a human approval in Action Center.
// HON writes no text of its own in this slice: a turn without a named specialist is refused, never answered.
import { championsExactKeys as exactKeys, championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { marketingSafeText } from './marketing-assistant.js';
import { FOLLOW_UP_DRAFT_PURPOSES, type FollowUpDraftPurpose } from './chad-follow-up-assistant.js';

export const HON_TURN_STATUSES = ['READY', 'PROCESSING', 'DELEGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type HonTurnStatus = typeof HON_TURN_STATUSES[number];
export const HON_DELEGATE_AGENTS = ['marcus', 'claire', 'chad'] as const;
export type HonDelegateAgentKey = typeof HON_DELEGATE_AGENTS[number];
export const HON_TURN_TEXT_LIMITS: Readonly<Record<HonDelegateAgentKey, number>> = { marcus: 2000, claire: 1200, chad: 2000 };

export type HonDelegation =
  | { agentKey: 'marcus'; campaignId: string }
  | { agentKey: 'claire'; curriculumId: string }
  | { agentKey: 'chad'; leadId: string; expectedLeadVersion: number; purpose: FollowUpDraftPurpose };
export interface HonTurnRequest { text: string; delegation: HonDelegation }
export interface HonConversationCreate { title: string }

export interface HonConversationSummary { id: string; title: string; createdAt: string; updatedAt: string; turnCount: number; status: HonTurnStatus }
export interface HonConversationPage { items: HonConversationSummary[]; nextCursor: string | null }
export interface HonConversationTurn {
  turnId: string; role: 'HUMAN' | HonDelegateAgentKey; text: string | null; createdAt: string; status: HonTurnStatus; reason: string | null;
  references: { workItemId: string | null; actionRequestId: string | null; invocationId: string | null };
}
export interface HonConversationThread extends HonConversationSummary { turns: HonConversationTurn[] }
export interface HonTurnReceipt {
  turnId: string; conversationId: string; status: HonTurnStatus; reason: string | null; delegatedAgentKeys: HonDelegateAgentKey[];
  actionRequestIds: string[]; workItemIds: string[]; invocationId: string | null;
}
/** Server-confirmed composer prerequisites for this requester. The composer offers only availableAgentKeys. */
export interface HonConversationReadiness {
  contract: true; providerRoute: boolean; entitlement: boolean; authorization: boolean; availableAgentKeys: HonDelegateAgentKey[]; asOf: string;
}

const fail = (code: string) => (): never => { throw new Error(code); };
const invalid = fail('INVALID_HON_CONVERSATION_INPUT');
const drift = fail('INVALID_HON_CONVERSATION_RESPONSE');
const isAgent = (v: unknown): v is HonDelegateAgentKey => (HON_DELEGATE_AGENTS as readonly unknown[]).includes(v);
const isStatus = (v: unknown): v is HonTurnStatus => (HON_TURN_STATUSES as readonly unknown[]).includes(v);
const isReason = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(v));
const uuidOrNull = (v: unknown): boolean => v === null || isUuid(v);

export function validateHonConversationCreate(value: unknown): HonConversationCreate {
  const r = record(value, invalid); exactKeys(r, ['title'], invalid);
  if (!marketingSafeText(r.title, 120)) invalid();
  return { title: (r.title as string).trim() };
}

export function validateHonTurnRequest(value: unknown): HonTurnRequest {
  const r = record(value, invalid); exactKeys(r, ['text', 'delegation'], invalid);
  const d = record(r.delegation, invalid);
  if (!isAgent(d.agentKey) || !marketingSafeText(r.text, HON_TURN_TEXT_LIMITS[d.agentKey])) invalid();
  const text = r.text as string;
  if (d.agentKey === 'marcus') { exactKeys(d, ['agentKey', 'campaignId'], invalid); if (!isUuid(d.campaignId)) invalid(); return { text, delegation: { agentKey: 'marcus', campaignId: d.campaignId as string } }; }
  if (d.agentKey === 'claire') { exactKeys(d, ['agentKey', 'curriculumId'], invalid); if (!isUuid(d.curriculumId)) invalid(); return { text, delegation: { agentKey: 'claire', curriculumId: d.curriculumId as string } }; }
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
    const t = record(x, drift); exactKeys(t, ['turnId', 'role', 'text', 'createdAt', 'status', 'reason', 'references'], drift);
    const refs = record(t.references, drift); exactKeys(refs, ['workItemId', 'actionRequestId', 'invocationId'], drift);
    const human = i % 2 === 0;
    if (!isUuid(t.turnId) || !isTimestamp(t.createdAt) || !isStatus(t.status) || !isReason(t.reason) || !uuidOrNull(refs.workItemId) || !uuidOrNull(refs.actionRequestId) || !uuidOrNull(refs.invocationId)) drift();
    if (human ? (t.role !== 'HUMAN' || typeof t.text !== 'string' || t.reason !== null || refs.workItemId !== null || refs.actionRequestId !== null || refs.invocationId !== null)
      : (!isAgent(t.role) || t.text !== null || (r.turns[i - 1] as HonConversationTurn).turnId !== t.turnId)) drift();
  });
  return r;
}

export function validateHonTurnReceipt(value: unknown): HonTurnReceipt {
  const r = record(value, drift);
  exactKeys(r, ['turnId', 'conversationId', 'status', 'reason', 'delegatedAgentKeys', 'actionRequestIds', 'workItemIds', 'invocationId'], drift);
  if (!isUuid(r.turnId) || !isUuid(r.conversationId) || !isStatus(r.status) || r.status === 'READY' || !isReason(r.reason) || !uuidOrNull(r.invocationId)
    || !Array.isArray(r.delegatedAgentKeys) || r.delegatedAgentKeys.length !== 1 || !r.delegatedAgentKeys.every(isAgent)
    || !Array.isArray(r.actionRequestIds) || r.actionRequestIds.length > 1 || !r.actionRequestIds.every(isUuid)
    || !Array.isArray(r.workItemIds) || r.workItemIds.length > 1 || !r.workItemIds.every(isUuid)) drift();
  // An approval is claimed only with its Action Center reference.
  if (r.status === 'AWAITING_APPROVAL' && (r.actionRequestIds as unknown[]).length !== 1) drift();
  return r as unknown as HonTurnReceipt;
}

/** Composer prerequisites from server-evaluated AI team readiness (AI-R1). No provider is called. */
export function composeHonConversationReadiness(team: {
  completeEntitlement: boolean; asOf: string;
  agents: readonly { agentKey: string; authorized: boolean; spendDecision: string; route: string; providerRuntime: string; available: boolean }[];
}): HonConversationReadiness {
  const agents = team.agents.filter((a) => isAgent(a.agentKey));
  return {
    contract: true,
    authorization: agents.some((a) => a.authorized),
    entitlement: team.completeEntitlement && agents.length > 0 && agents.every((a) => a.spendDecision === 'ALLOWED'),
    providerRoute: agents.some((a) => a.route === 'CONFIGURED' && a.providerRuntime === 'READY'),
    availableAgentKeys: agents.filter((a) => a.available).map((a) => a.agentKey as HonDelegateAgentKey),
    asOf: team.asOf,
  };
}
