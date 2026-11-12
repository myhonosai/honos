import {
  ADMISSION_LIMITS_COMMAND, accountUuid, validateAdmissionLimitsInput, validateAdmissionLimitsReceipt, validateAdmissionStatus,
  type AdmissionLimitsInput, type AdmissionLimitsReceipt, type AdmissionStatus,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ sign-up and trial limits (0274). The read sends only Accept; the change sends its own X-HON-Human-Command and an
 * Idempotency-Key, and the database decides authority again (HQ billing readers read, only the HQ owner changes).
 */
export type AdmissionErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed. Nothing changed. */ | 'DENIED'
  /** The limits changed since they were read. Nothing changed. */ | 'CHANGED'
  /** Not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class AdmissionError extends Error { constructor(readonly kind: AdmissionErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const PATH = '/api/v1/hq/admission';

const unwrap = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
};
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** Definite answers given before any write. Anything else (busy, 5xx, an unknown code) is UNKNOWN. */
export function admissionErrorFor(status: number, code: string | null): AdmissionError {
  if (status === 403) return new AdmissionError('DENIED', code);
  if (status === 400) return new AdmissionError('INVALID', code);
  if (status === 409 && code === 'ADMISSION_LIMITS_CHANGED') return new AdmissionError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new AdmissionError('INVALID', code);
  return new AdmissionError('UNKNOWN', code);
}

export const admissionApi = {
  /** Limits in force, history, usage now and cap hits for 7 days. Reading changes nothing. */
  async status(signal: AbortSignal, owned: Owned): Promise<AdmissionStatus> {
    let r: Response;
    try {
      r = await fetch(PATH, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
        headers: { Accept: 'application/json' } });
    } catch (error) { if (signal.aborted) throw error; throw new AdmissionError('UNKNOWN'); }
    signal.throwIfAborted();
    if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AdmissionError('SESSION'); }
    if (r.status === 403) throw new AdmissionError('DENIED');
    if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new AdmissionError('UNKNOWN');
    const text = await r.text();
    if (text.length > RESPONSE_MAX) throw new AdmissionError('UNKNOWN');
    try { return validateAdmissionStatus(unwrap(JSON.parse(text))); } catch { throw new AdmissionError('UNKNOWN'); }
  },
  /** Record new limits after the version that was read. The receipt must be exactly the next version with these numbers. */
  async set(input: AdmissionLimitsInput, key: string, signal: AbortSignal, owned: Owned): Promise<AdmissionLimitsReceipt> {
    let body: AdmissionLimitsInput;
    try { body = validateAdmissionLimitsInput(input); accountUuid(key); } catch { throw new AdmissionError('INVALID'); }
    let r: Response;
    try {
      r = await fetch(`${PATH}/limits`, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': ADMISSION_LIMITS_COMMAND, 'Idempotency-Key': key },
        body: JSON.stringify(body) });
    } catch { throw new AdmissionError('UNKNOWN'); }
    if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AdmissionError('SESSION'); }
    let value: unknown = null;
    if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) {
      try { const text = await r.text(); if (text.length <= RESPONSE_MAX) value = JSON.parse(text) as unknown; } catch { value = null; }
    }
    if (r.status !== 200) throw admissionErrorFor(r.status, codeOf(value));
    try {
      const receipt = validateAdmissionLimitsReceipt(unwrap(value));
      const l = receipt.limits;
      if (l.version !== body.expectedVersion + 1 || l.signupsPerHour !== body.signupsPerHour || l.signupsPerDay !== body.signupsPerDay
        || l.trialsPerHour !== body.trialsPerHour || l.trialsPerDay !== body.trialsPerDay || l.reason !== body.reason) throw new Error('mismatch');
      return receipt;
    } catch { throw new AdmissionError('UNKNOWN'); }
  },
};
export type AdmissionApi = typeof admissionApi;

/** Whether a failed change may be sent again with the same key: only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof AdmissionError) || error.kind === 'UNKNOWN';
