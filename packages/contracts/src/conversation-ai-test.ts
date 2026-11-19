/**
 * Conversation AI "Try it" test chat (0563, piece CE2; docs/architecture/CONVERSATION_AI_EASY_SETUP.md section 6). A staff
 * member asks a question a family might send and sees how Chad would answer from the school's training. Nothing is sent to
 * anyone. One test is one CONVERSATION_TEST proposal on the shared AI text caller (0550), metered by S4.
 */
export const CONVERSATION_AI_TEST_LIMITS = { inputTokens: 12000, outputTokens: 600, maxProviderCostMicrounits: 20000, question: 500, reply: 1600, recent: 10 } as const;
export const CONVERSATION_AI_TEST_READ_COMMAND = 'conversation.ai.test.read';
export const CONVERSATION_AI_TEST_ASK_COMMAND = 'conversation.ai.test.ask';
export const CONVERSATION_AI_TEST_STATUSES = ['WORKING', 'ANSWERED', 'NOT_ANSWERED', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'FAILED', 'UNKNOWN'] as const;
export type ConversationAiTestStatus = (typeof CONVERSATION_AI_TEST_STATUSES)[number];
export const CONVERSATION_AI_TEST_REASONS = ['BUDGET_REACHED', 'PAUSED', 'NOT_CONFIGURED', 'OUTCOME_UNKNOWN', 'NOT_ANSWERED'] as const;
export type ConversationAiTestReason = (typeof CONVERSATION_AI_TEST_REASONS)[number];
export const CONVERSATION_AI_TEST_UNAVAILABLE = ['NOT_INCLUDED', 'PAUSED', 'NOT_CONFIGURED', 'BUDGET_REACHED'] as const;
export type ConversationAiTestUnavailable = (typeof CONVERSATION_AI_TEST_UNAVAILABLE)[number];

export interface ConversationAiTestAskInput { question: string }
export interface ConversationAiTestView {
  id: string; status: ConversationAiTestStatus; reason: ConversationAiTestReason | null; question: string;
  reply: string | null; needsStaff: boolean | null; askedAt: string;
}
export interface ConversationAiTestState { mode: 'AI' | 'UNAVAILABLE'; reason: ConversationAiTestUnavailable | null; tests: ConversationAiTestView[] }
/** The closed answer Chad returns. needsStaff means a person should take over (a hand-off word, a complaint, billing). */
export interface ConversationAiTestAnswer { reply: string; needsStaff: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export function validateConversationAiTestAsk(value: unknown): ConversationAiTestAskInput {
  if (!isObject(value) || !keysAre(value, ['question']) || typeof value.question !== 'string') throw new Error('Invalid test question.');
  const question = value.question.trim();
  if (question.length < 1 || question.length > CONVERSATION_AI_TEST_LIMITS.question || CONTROL.test(question)) throw new Error('Invalid test question.');
  return { question };
}

/** The answer shape the database accepts (0563 hon.conversation_ai_test_answer_ok). Anything else is a rejected answer. */
export function validateConversationAiTestAnswer(value: unknown): ConversationAiTestAnswer {
  if (!isObject(value) || !keysAre(value, ['needsStaff', 'reply']) || typeof value.reply !== 'string' || typeof value.needsStaff !== 'boolean') throw new Error('Invalid test answer.');
  const reply = value.reply.trim();
  if (reply.length < 1 || reply.length > CONVERSATION_AI_TEST_LIMITS.reply) throw new Error('Invalid test answer.');
  return { reply, needsStaff: value.needsStaff };
}

export function verifyConversationAiTestView(value: unknown): ConversationAiTestView {
  if (!isObject(value)) throw new Error('Invalid test view.');
  const keys = ['askedAt', 'id', 'needsStaff', 'question', 'reason', 'reply', 'status'];
  const extra = Object.keys(value).filter(k => !keys.includes(k) && k !== 'recorded');
  if (extra.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid test view.');
  const v = value;
  const answered = v.status === 'ANSWERED';
  if (typeof v.id !== 'string' || !UUID.test(v.id) || !(CONVERSATION_AI_TEST_STATUSES as readonly unknown[]).includes(v.status)
    || !(v.reason === null || (CONVERSATION_AI_TEST_REASONS as readonly unknown[]).includes(v.reason))
    || typeof v.question !== 'string' || v.question.length < 1 || v.question.length > CONVERSATION_AI_TEST_LIMITS.question
    || (answered ? typeof v.reply !== 'string' || v.reply.length < 1 || v.reply.length > CONVERSATION_AI_TEST_LIMITS.reply || typeof v.needsStaff !== 'boolean'
      : v.reply !== null || v.needsStaff !== null)
    || typeof v.askedAt !== 'string' || !ISO.test(v.askedAt)) throw new Error('Invalid test view.');
  return { id: v.id, status: v.status as ConversationAiTestStatus, reason: v.reason as ConversationAiTestReason | null, question: v.question,
    reply: v.reply as string | null, needsStaff: v.needsStaff as boolean | null, askedAt: v.askedAt };
}

export function verifyConversationAiTestState(value: unknown): ConversationAiTestState {
  if (!isObject(value) || !keysAre(value, ['mode', 'reason', 'tests'])) throw new Error('Invalid test state.');
  if (!(value.mode === 'AI' || value.mode === 'UNAVAILABLE') || (value.mode === 'AI') !== (value.reason === null)
    || !(value.reason === null || (CONVERSATION_AI_TEST_UNAVAILABLE as readonly unknown[]).includes(value.reason))
    || !Array.isArray(value.tests) || value.tests.length > CONVERSATION_AI_TEST_LIMITS.recent) throw new Error('Invalid test state.');
  return { mode: value.mode, reason: value.reason as ConversationAiTestUnavailable | null, tests: value.tests.map(verifyConversationAiTestView) };
}
