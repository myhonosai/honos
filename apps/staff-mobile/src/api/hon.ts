import { validateHonConversationSummary, validateHonTurnReceipt, type HonConversationSummary, type HonTurnReceipt } from '@hon/contracts/hon-conversation';

/**
 * S2 HON tab response checks (docs/architecture/STAFF_MOBILE_HON.md). Closed like the web Ask HON panel: an answer
 * with a missing, extra or ill-typed field is refused and nothing is shown. Conversations and turn receipts use the
 * shared contract validators. Which agents the person may use is the server's readiness answer (0635 switches + the
 * agent's own permission); the app never decides it.
 */

/** Agents the app can ask with a plain question. Kai, Marcus and Chad draft for a named class, campaign or lead, and
 * Maya answers about one named student, so those stay on the web for now. */
export const ASKABLE = ['hon', 'claire', 'alex', 'jordan', 'lena'] as const;
export type AskableAgent = (typeof ASKABLE)[number];
export const WEB_ONLY = ['kai', 'marcus', 'chad', 'maya'] as const;
export type WebOnlyAgent = (typeof WEB_ONLY)[number];
export const AGENT_NAMES: Record<AskableAgent | WebOnlyAgent, { name: string; role: string }> = {
  hon: { name: 'HON', role: 'Your school assistant' },
  claire: { name: 'Claire', role: 'Business performance' },
  alex: { name: 'Alex', role: 'Management' },
  jordan: { name: 'Jordan', role: 'Classes and operations' },
  lena: { name: 'Lena', role: 'Creative and commerce' },
  kai: { name: 'Kai', role: 'Teaching' },
  marcus: { name: 'Marcus', role: 'Marketing' },
  chad: { name: 'Chad', role: 'Lead follow-ups' },
  maya: { name: 'Maya', role: 'At-risk students' },
};
/** Same limit as the server (HON_REPLY_LIMITS.questionCharacters). */
export const QUESTION_MAX = 2000;

export interface MyAgents {
  /** Agents that would answer a question now, in display order (HON first). */
  askable: AskableAgent[];
  /** Agents the person has that work on the web for now. */
  webOnly: WebOnlyAgent[];
  /** False when the school's AI team is not set up or not included right now (nothing would answer). */
  ready: boolean;
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DELEGATES = ['marcus', 'kai', 'chad'];
const ANALYSTS = ['claire', 'alex', 'jordan', 'lena', 'maya'];
const fail = (): never => { throw new Error('The HON answer could not be verified.'); };
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some(k => !own.includes(k))) fail();
  return value as Record<string, unknown>;
}
const uniqueOf = (v: unknown, allowed: readonly string[]): string[] => {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !allowed.includes(x)) || new Set(v).size !== v.length) return fail();
  return v as string[];
};

/** GET .../hon/readiness: { data: HonConversationReadiness, meta }. */
export function verifyMyAgents(body: unknown): MyAgents {
  const r = closed(closed(body, ['data', 'meta']).data,
    ['contract', 'providerRoute', 'entitlement', 'authorization', 'availableAgentKeys', 'honReply', 'businessPerformance', 'availableAnalystKeys', 'asOf']);
  if (r.contract !== true || typeof r.providerRoute !== 'boolean' || typeof r.entitlement !== 'boolean' || typeof r.authorization !== 'boolean'
    || typeof r.honReply !== 'boolean' || typeof r.businessPerformance !== 'boolean' || typeof r.asOf !== 'string' || !TIME.test(r.asOf)) fail();
  const delegates = uniqueOf(r.availableAgentKeys, DELEGATES);
  const analysts = uniqueOf(r.availableAnalystKeys, ANALYSTS);
  if (analysts.includes('claire') !== r.businessPerformance) fail();
  const on = new Set<string>([...(r.honReply ? ['hon'] : []), ...delegates, ...analysts]);
  return {
    askable: ASKABLE.filter(a => on.has(a)),
    webOnly: WEB_ONLY.filter(a => on.has(a)),
    ready: r.entitlement === true && r.providerRoute === true,
  };
}

/** POST .../hon/conversations: { data: HonConversationSummary }. */
export function verifyConversation(body: unknown): HonConversationSummary {
  return validateHonConversationSummary(closed(body, ['data']).data);
}

/** POST .../hon/conversations/:id/turns: { data: HonTurnReceipt } for this exact conversation and agent. */
export function verifyTurnReceipt(body: unknown, conversationId: string, agent: AskableAgent): HonTurnReceipt {
  const receipt = validateHonTurnReceipt(closed(body, ['data']).data);
  if (receipt.conversationId.toLowerCase() !== conversationId.toLowerCase()) fail();
  const named = receipt.delegatedAgentKeys;
  if (agent === 'hon' ? named.length !== 0 : named.length !== 1 || named[0] !== agent) fail();
  return receipt;
}

/** What the person sees for a turn that did not finish with an answer. */
export function turnNote(receipt: HonTurnReceipt): string | null {
  if (receipt.status === 'COMPLETED') return receipt.reply === null ? 'This answer is hidden because your access changed.' : null;
  if (receipt.status === 'UNKNOWN') return 'HON is not sure this answer finished. It will not be sent again. Ask again if you need it.';
  if (receipt.status === 'FAILED') {
    if (receipt.reason === 'AI_ACCESS_REFUSED' || receipt.reason === 'SOURCE_ACCESS_REFUSED') return 'Not available for your role at this school right now.';
    if (receipt.reason === 'CONFIGURATION_REQUIRED') return 'The AI team is not set up for this school yet.';
    return 'No answer this time. Try again in a moment.';
  }
  return 'Still working on it. Check again in a moment.';
}
