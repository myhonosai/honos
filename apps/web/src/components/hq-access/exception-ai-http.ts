import { SAAS_COMMANDS, saasUuid, validateAiExceptionAllowanceInput, validateAiExceptionAllowanceList, validateAiExceptionAllowanceReceipt,
  type AiExceptionAllowanceInput, type AiExceptionAllowanceList, type AiExceptionAllowanceReceipt } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import type { Owned } from './http';

/**
 * 0353: AI on a free access exception under an HQ-owner monthly limit. The read is advisory; the database decides every
 * command again (HQ owner only, live exception for this school, version).
 */
export type ExceptionAiErrorKind = 'SESSION' | 'DENIED' | 'CHANGED' | 'INVALID' | 'UNKNOWN';
export class ExceptionAiError extends Error {
  constructor(readonly kind: ExceptionAiErrorKind, readonly code: string | null = null) { super(kind); }
}
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const RESPONSE_MAX = 2_000_000;
/** The row is no longer what was read (version, the exception ended, nothing to clear). Nothing was changed. */
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'AI_EXCEPTION_NOT_LIVE', 'AI_EXCEPTION_ALLOWANCE_NOT_SET']);
const PATH = '/api/v1/hq/ai/exception-allowances';

export function exceptionAiErrorFor(status: number, code: string | null): ExceptionAiError {
  if (status === 403) return new ExceptionAiError('DENIED', code);
  if (status === 400) return new ExceptionAiError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new ExceptionAiError('CHANGED', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new ExceptionAiError('CHANGED', code);
  return new ExceptionAiError('UNKNOWN', code);
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
async function exchange(signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(PATH, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': SAAS_COMMANDS.aiExceptionAllowance, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ExceptionAiError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ExceptionAiError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

export const exceptionAiApi = {
  async list(signal: AbortSignal, owned: Owned): Promise<AiExceptionAllowanceList> {
    const { status, value } = await exchange(signal, owned);
    if (status === 403) throw new ExceptionAiError('DENIED', codeOf(value));
    if (status !== 200) throw new ExceptionAiError('UNKNOWN', codeOf(value));
    try { return validateAiExceptionAllowanceList(data(value)); } catch { throw new ExceptionAiError('UNKNOWN'); }
  },
  /** One set or clear. The same key and body replay the saved answer. */
  async command(input: AiExceptionAllowanceInput, key: string, signal: AbortSignal, owned: Owned): Promise<AiExceptionAllowanceReceipt> {
    const body = validateAiExceptionAllowanceInput(input), k = saasUuid(key);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(signal, owned, { body: JSON.stringify(body), key: k }); }
    catch (error) { if (error instanceof ExceptionAiError) throw error; throw new ExceptionAiError('UNKNOWN'); }
    if (answer.status !== 200) throw exceptionAiErrorFor(answer.status, codeOf(answer.value));
    try {
      const receipt = validateAiExceptionAllowanceReceipt(data(answer.value));
      if (receipt.schoolId.toLowerCase() !== body.schoolId.toLowerCase() || receipt.ceilingMicros !== body.ceilingMicros) throw new Error('mismatch');
      return receipt;
    } catch { throw new ExceptionAiError('UNKNOWN'); }
  },
};
export type ExceptionAiApi = typeof exceptionAiApi;

/** Whole dollars and cents from the form ("25", "25.50"), $1 to $1,000, as micro-USD; null when it cannot be sent. */
export function dollarsToMicros(text: string): number | null {
  const m = /^\s*\$?\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(2, '0')) * 10_000;
  return micros >= 1_000_000 && micros <= 1_000_000_000 ? micros : null;
}
export function allowanceInput(schoolId: string, version: number, dollars: string | null, reason: string): AiExceptionAllowanceInput | null {
  const ceilingMicros = dollars === null ? null : dollarsToMicros(dollars);
  if (dollars !== null && ceilingMicros === null) return null;
  try { return validateAiExceptionAllowanceInput({ schoolId, ceilingMicros, reason: reason.trim(), expectedVersion: version }); } catch { return null; }
}
