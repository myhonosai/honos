import { SAAS_COMMANDS, saasUuid, validateSaasExceptionPolicyDecisionInput, validateSaasExceptionPolicyReceipt, validateSaasExceptionPolicyView,
  type SaasExceptionPolicyDecisionInput, type SaasExceptionPolicyReceipt, type SaasExceptionPolicyView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * D10 exception-only policy (0186, read terms and viewer 0220). The read is advisory; the database decides every decision
 * again (HQ owner only, next revision, current terms version, maximum length, window) and never approves paid access or credits.
 */
export type PolicyErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not an HQ reader (read) or not the HQ owner (decision). */ | 'DENIED'
  /** Another decision was recorded since this one was read. Nothing was recorded by this request. Re-read. */ | 'CHANGED'
  /** A rule refused it (window, terms, length, nothing to withdraw). Nothing was recorded. */ | 'REFUSED'
  /** The request was not accepted as sent. */ | 'INVALID'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class PolicyError extends Error {
  constructor(readonly kind: PolicyErrorKind, readonly code: string | null = null) { super(kind); }
}
/** 0186 rule refusals, raised before the decision is written. */
export const POLICY_RULE_REFUSALS = new Set(['SAAS_EXCEPTION_POLICY_WINDOW_INVALID', 'SAAS_EXCEPTION_POLICY_LIMIT', 'SAAS_EXCEPTION_POLICY_REQUIRED']);
const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const PATH = '/api/v1/hq/saas/access-exception-policy';

/** Whether the caller still stands behind this request. A 401 for a retired request must not end the newer session. */
export type Owned = () => boolean;
async function exchange(signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(PATH, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': SAAS_COMMANDS.decideExceptionPolicy, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new PolicyError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new PolicyError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

/** What a refused decision means. Only these exact answers are definitive; anything else (including 409 SAAS_OUTCOME_UNKNOWN) is UNKNOWN. */
export function policyErrorFor(status: number, code: string | null): PolicyError {
  if (status === 403) return new PolicyError('DENIED', code);
  if (status === 400) return new PolicyError('INVALID', code);
  if (status === 409 && code === 'SAAS_VERSION_CONFLICT') return new PolicyError('CHANGED', code);
  if (status === 422 && code !== null && POLICY_RULE_REFUSALS.has(code)) return new PolicyError('REFUSED', code);
  return new PolicyError('UNKNOWN', code);
}

export const policyApi = {
  async read(signal: AbortSignal, owned: Owned): Promise<SaasExceptionPolicyView> {
    const { status, value } = await exchange(signal, owned);
    if (status === 403) throw new PolicyError('DENIED', codeOf(value));
    if (status !== 200) throw new PolicyError('UNKNOWN', codeOf(value));
    try { return validateSaasExceptionPolicyView(data(value)); } catch { throw new PolicyError('UNKNOWN'); }
  },
  /** One decision attempt. The same key and body replay the saved answer; a second decision from the same read is refused by revision. */
  async decide(input: SaasExceptionPolicyDecisionInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasExceptionPolicyReceipt> {
    const body = validateSaasExceptionPolicyDecisionInput(input), k = saasUuid(key);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(signal, owned, { body: JSON.stringify(body), key: k }); }
    catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('UNKNOWN'); }
    if (answer.status !== 200) throw policyErrorFor(answer.status, codeOf(answer.value));
    try {
      const receipt = validateSaasExceptionPolicyReceipt(data(answer.value)), p = receipt.policy;
      if (p.revision !== body.expectedRevision + 1 || p.status !== body.decision || p.reason !== body.reason) throw new Error('mismatch');
      if ((body.decision === 'PROPOSED' || body.decision === 'APPROVED') && (p.termsVersion !== body.termsVersion || p.maxDays !== body.maxDays
        || Date.parse(p.validFrom) !== Date.parse(body.validFrom) || Date.parse(p.validUntil) !== Date.parse(body.validUntil))) throw new Error('mismatch');
      return receipt;
    } catch { throw new PolicyError('UNKNOWN'); }
  },
};
export type PolicyApi = typeof policyApi;
