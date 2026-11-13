import {
  SAAS_COMMANDS, saasUuid, validateAiLateProviderExpenseInput, validateAiLateProviderExpenseReceipt, validateAiSchoolUsageRange, validateAiSchoolUsageReport,
  validateAiSpendPauseInput, validateAiSpendPauseList, validateAiSpendPauseReceipt, validateAiUnknownAgent, validateAiUnknownQueue,
  validateAiUnknownResolutionInput, validateAiUnknownResolutionReceipt, validateAiSchoolCostAlertAckInput, validateAiSchoolCostAlertAckReceipt, validateAiSchoolCostAlertList,
  type AiSchoolCostAlertAckInput, type AiSchoolCostAlertAckReceipt, type AiSchoolCostAlertList,
  type AiLateProviderExpenseInput, type AiLateProviderExpenseReceipt, type AiSchoolUsageReport, type AiSpendPauseInput, type AiSpendPauseList,
  type AiSpendPauseReceipt, type AiUnknownAgent, type AiUnknownQueue, type AiUnknownResolutionInput, type AiUnknownResolutionReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ AI costs and safety (S4-c, S4-d, S4-e). Reads send only Accept (the usage read adds its from/to range, the only
 * query it accepts); each command sends its own X-HON-Human-Command and an Idempotency-Key. The database decides every
 * authority again: HQ billing readers may read, only a human HQ owner may pause, resume or resolve. Nothing here calls an
 * AI provider or moves money: provider evidence is typed in by the HQ owner from the provider's own usage record.
 */
export type AiControlErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (not an HQ billing reader, or not the HQ owner for a command). Nothing changed. */ | 'DENIED'
  /** The pause or call is no longer in the state that was read. Nothing changed. */ | 'CHANGED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class AiControlError extends Error { constructor(readonly kind: AiControlErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
/** Definite refusals raised before any write: the pause or call is not what was read. */
const CHANGED = new Set(['AI_SPEND_PAUSE_ALREADY_ACTIVE', 'AI_SPEND_PAUSE_NOT_ACTIVE', 'AI_UNKNOWN_NOT_RESOLVABLE', 'AI_UNKNOWN_ORIGIN_UNAVAILABLE',
  'AI_LATE_EXPENSE_NOT_WRITTEN_OFF', 'AI_LATE_EXPENSE_ALREADY_RECORDED', 'AI_LATE_EXPENSE_DUPLICATE_GENERATION', 'SAAS_VERSION_CONFLICT', 'SAAS_TRANSITION_NOT_ALLOWED']);

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AiControlError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new AiControlError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function aiControlErrorFor(status: number, code: string | null): AiControlError {
  if (status === 403) return new AiControlError('DENIED', code);
  if (status === 400) return new AiControlError('INVALID', code);
  if (status === 429) return new AiControlError('RATE', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new AiControlError('CHANGED', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new AiControlError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new AiControlError('INVALID', code);
  return new AiControlError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof AiControlError || signal.aborted) throw error; throw new AiControlError('UNKNOWN'); }
  if (answer.status === 403) throw new AiControlError('DENIED', codeOf(answer.value));
  if (answer.status !== 200) throw new AiControlError('UNKNOWN', codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new AiControlError('UNKNOWN'); }
}
async function command<T>(path: string, marker: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof AiControlError) throw error; throw new AiControlError('UNKNOWN'); }
  if (answer.status !== 200) throw aiControlErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new AiControlError('UNKNOWN'); }
}
function checked<T>(work: () => T): T { try { return work(); } catch { throw new AiControlError('INVALID'); } }

export const aiControlApi = {
  /** Per-school AI usage and provider cost in [from, to) (at most 92 days). */
  usage(from: string, to: string, signal: AbortSignal, owned: Owned): Promise<AiSchoolUsageReport> {
    return Promise.resolve().then(() => {
      const range = checked(() => validateAiSchoolUsageRange(from, to));
      return read(`/api/v1/hq/ai/school-usage?${new URLSearchParams({ from: range.from, to: range.to })}`, (v) => {
        const report = validateAiSchoolUsageReport(v);
        if (Date.parse(report.from) !== Date.parse(range.from) || Date.parse(report.to) !== Date.parse(range.to)) throw new Error('range');
        return report;
      }, signal, owned);
    });
  },
  pauses(signal: AbortSignal, owned: Owned): Promise<AiSpendPauseList> {
    return read('/api/v1/hq/ai/spend-pauses', validateAiSpendPauseList, signal, owned);
  },
  unknown(signal: AbortSignal, owned: Owned): Promise<AiUnknownQueue> {
    return read('/api/v1/hq/ai/unknown-invocations', validateAiUnknownQueue, signal, owned);
  },
  /** Pause or resume AI spend for one organization or the whole platform (organizationId null). */
  async pause(input: AiSpendPauseInput, key: string, signal: AbortSignal, owned: Owned): Promise<AiSpendPauseReceipt> {
    const [body, k] = checked(() => [validateAiSpendPauseInput(input), saasUuid(key)] as const);
    return command('/api/v1/hq/ai/spend-pauses', SAAS_COMMANDS.aiSpendPause, body, k, (v) => {
      const receipt = validateAiSpendPauseReceipt(v);
      if (receipt.spendClass !== body.spendClass || (receipt.organizationId ?? '').toLowerCase() !== (body.organizationId ?? '').toLowerCase()
        || receipt.status !== (body.action === 'PAUSE' ? 'ACTIVE' : 'ENDED')) throw new Error('mismatch');
      return receipt;
    }, signal, owned);
  },
  /** Resolve one lost provider outcome, once, with the provider's own evidence. */
  async resolve(agent: AiUnknownAgent, invocationId: string, input: AiUnknownResolutionInput, key: string, signal: AbortSignal, owned: Owned): Promise<AiUnknownResolutionReceipt> {
    const [a, id, body, k] = checked(() => [validateAiUnknownAgent(agent), saasUuid(invocationId), validateAiUnknownResolutionInput(input), saasUuid(key)] as const);
    return command(`/api/v1/hq/ai/unknown-invocations/${a}/${id.toLowerCase()}/resolve`, SAAS_COMMANDS.aiUnknownResolve, body, k, (v) => {
      const receipt = validateAiUnknownResolutionReceipt(v);
      if (receipt.agent !== a || receipt.invocationId.toLowerCase() !== id.toLowerCase() || receipt.decision !== body.decision) throw new Error('mismatch');
      return receipt;
    }, signal, owned);
  },
  /** A verified provider charge found after a write-off: recorded once, no customer credits. */
  async lateExpense(agent: AiUnknownAgent, invocationId: string, input: AiLateProviderExpenseInput, key: string, signal: AbortSignal, owned: Owned): Promise<AiLateProviderExpenseReceipt> {
    const [a, id, body, k] = checked(() => [validateAiUnknownAgent(agent), saasUuid(invocationId), validateAiLateProviderExpenseInput(input), saasUuid(key)] as const);
    return command(`/api/v1/hq/ai/unknown-invocations/${a}/${id.toLowerCase()}/late-provider-expense`, SAAS_COMMANDS.aiLateProviderExpense, body, k, (v) => {
      const receipt = validateAiLateProviderExpenseReceipt(v);
      if (receipt.agent !== a || receipt.invocationId.toLowerCase() !== id.toLowerCase() || receipt.providerCostMicrounits !== body.evidence.providerCostMicrounits) throw new Error('mismatch');
      return receipt;
    }, signal, owned);
  },
  /** 0343: schools at 75%, 90% or 100% of their internal AI cost limit. */
  costAlerts(signal: AbortSignal, owned: Owned): Promise<AiSchoolCostAlertList> {
    return read('/api/v1/hq/ai/school-cost-alerts', validateAiSchoolCostAlertList, signal, owned);
  },
  /** The HQ owner acknowledges one current alert, once. Informational: it changes no limit, pause or spend decision. */
  async acknowledgeCostAlert(input: AiSchoolCostAlertAckInput, key: string, signal: AbortSignal, owned: Owned): Promise<AiSchoolCostAlertAckReceipt> {
    const [body, k] = checked(() => [validateAiSchoolCostAlertAckInput(input), saasUuid(key)] as const);
    return command('/api/v1/hq/ai/school-cost-alerts/acknowledgements', SAAS_COMMANDS.aiSchoolCostAlertAck, body, k, (v) => {
      const receipt = validateAiSchoolCostAlertAckReceipt(v);
      if (receipt.schoolId.toLowerCase() !== body.schoolId.toLowerCase() || receipt.level !== body.level || Date.parse(receipt.windowStart) !== Date.parse(body.windowStart)) throw new Error('mismatch');
      return receipt;
    }, signal, owned);
  },
};
export type AiControlApi = typeof aiControlApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof AiControlError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';

/** Micro-USD shown as dollars; small amounts keep enough decimals to stay non-zero. */
export function usd(language: string, micro: number): string {
  const dollars = micro / 1_000_000;
  const digits = micro === 0 || micro >= 10_000 ? 2 : micro >= 100 ? 4 : 6;
  return new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}
/** Dollar text ("0.0123") to micro-USD; null when it is not a non-negative amount with at most six decimals. */
export function toMicro(text: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micro) ? micro : null;
}
/** The last N whole days ending now, as a usage range. */
export function lastDays(days: number, now = Date.now()): { from: string; to: string } {
  const to = new Date(now); to.setUTCMilliseconds(0);
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
}
