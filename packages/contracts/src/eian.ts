/**
 * Eian family AI (E-AI1, 0474). A parent asks Eian a free-text question in the HON Family app and HON answers from that
 * family's own records through the governed AI runtime. Eian answers in text only and may suggest one screen from a
 * closed list; the app opens that screen and the parent acts through its normal guarded command. Nothing Eian says runs.
 */

/** Fixed limits, mirrored from hon.eian_turn_limits() (the database owns them; a mismatch refuses the call). */
export const EIAN_LIMITS = {
  taskClass: 'SUMMARIZE', inputTokens: 9000, outputTokens: 700, maxProviderCostMicrounits: 20000,
  questionCharacters: 500, replyCharacters: 1500, factsBytes: 5000,
} as const;
export const EIAN_SCREENS = ['SCHEDULE', 'BOOK_CLASS', 'REPORT_ABSENCE', 'BILLING', 'TESTING', 'MESSAGES'] as const;
export type EianScreen = (typeof EIAN_SCREENS)[number];
export const EIAN_MODES = ['AI', 'GUIDED'] as const;
export type EianMode = (typeof EIAN_MODES)[number];
/** Why AI is not answering now. Closed, and never a ceiling, spend amount, provider or model name. */
export const EIAN_STATUS_REASONS = ['NOT_INCLUDED', 'PAUSED', 'NOT_CONFIGURED', 'BUDGET_REACHED'] as const;
export type EianStatusReason = (typeof EIAN_STATUS_REASONS)[number];
export const EIAN_TURN_STATUSES = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'RESULT_HELD', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type EianTurnStatus = (typeof EIAN_TURN_STATUSES)[number];
export const EIAN_TURN_REASONS = ['BUDGET_REACHED', 'NOT_INCLUDED', 'NOT_CONFIGURED', 'OUTCOME_UNKNOWN', 'PAUSED', 'NOT_ANSWERED'] as const;
export type EianTurnReason = (typeof EIAN_TURN_REASONS)[number];

export interface EianStatus { mode: EianMode; reason: EianStatusReason | null }
export interface EianTurn {
  id: string; status: EianTurnStatus; question: string;
  /** Present only for a COMPLETED turn the parent may see now. */
  reply: string | null; screen: EianScreen | null;
  reason: EianTurnReason | null; askedAt: string;
}
export interface EianAskInput { question: string }
export interface EianAskResult { turn: EianTurn; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid Eian data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function nullableOneOf<T extends string>(value: unknown, list: readonly T[]): T | null {
  return value === null ? null : oneOf(value, list);
}

export function isEianScreen(value: unknown): value is EianScreen {
  return typeof value === 'string' && (EIAN_SCREENS as readonly string[]).includes(value);
}

/** The question is trimmed, 1 to 500 characters, and plain text (no control characters other than newlines). */
export function validateEianAskInput(value: unknown): EianAskInput {
  const row = record(value, ['question']);
  if (typeof row.question !== 'string') invalid();
  const question = row.question.trim();
  if (question.length < 1 || [...question].length > EIAN_LIMITS.questionCharacters || CONTROL.test(question)) invalid();
  return { question };
}

export function verifyEianStatus(value: unknown): EianStatus {
  const row = record(value, ['mode', 'reason']);
  const mode = oneOf(row.mode, EIAN_MODES);
  const reason = nullableOneOf(row.reason, EIAN_STATUS_REASONS);
  if ((mode === 'AI') !== (reason === null)) invalid();
  return { mode, reason };
}

export function verifyEianTurn(value: unknown): EianTurn {
  const row = record(value, ['id', 'status', 'question', 'reply', 'screen', 'reason', 'askedAt']);
  if (typeof row.id !== 'string' || !UUID.test(row.id)) invalid();
  const status = oneOf(row.status, EIAN_TURN_STATUSES);
  if (typeof row.question !== 'string' || row.question.length < 1 || [...row.question].length > EIAN_LIMITS.questionCharacters) invalid();
  if (row.reply !== null && (typeof row.reply !== 'string' || row.reply.trim().length < 1 || row.reply.length > EIAN_LIMITS.replyCharacters)) invalid();
  const screen = nullableOneOf(row.screen, EIAN_SCREENS);
  const reason = nullableOneOf(row.reason, EIAN_TURN_REASONS);
  if (row.reply === null && screen !== null) invalid();
  if (row.reply !== null && status !== 'COMPLETED') invalid();
  if (reason !== null && !['BLOCKED', 'CONFIGURATION_REQUIRED', 'FAILED', 'UNKNOWN'].includes(status)) invalid();
  if (typeof row.askedAt !== 'string' || !INSTANT.test(row.askedAt)) invalid();
  return { id: row.id, status, question: row.question, reply: row.reply as string | null, screen, reason, askedAt: row.askedAt };
}

export function verifyEianAskResult(value: unknown): EianAskResult {
  const row = record(value, ['turn', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  return { turn: verifyEianTurn(row.turn), replayed: row.replayed };
}
