import {
  SAAS_COMMANDS, saasUuid, validateSaasCreativeAdjustmentReceipt, validateSaasCreativeCostInput, validateSaasCreativeCostReceipt, validateSaasCreativeDebitInput,
  validateSaasCreativeGrantInput, validateSaasCreativeHqWallet, validateSaasCreativeHqWalletList, validateSaasCreativeResolveInput, validateSaasCreativeResolveReceipt,
  type SaasCreativeAdjustmentReceipt, type SaasCreativeCostInput, type SaasCreativeCostReceipt, type SaasCreativeDebitInput, type SaasCreativeGrantInput,
  type SaasCreativeHqWallet, type SaasCreativeHqWalletList, type SaasCreativeResolveInput, type SaasCreativeResolveReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ creative credits (CW1). Every read is a plain same-origin GET that sends only Accept; the database decides who may
 * read (HQ billing readers) on every request. The HQ owner's corrections (grant, remove, settle a generation, record a
 * provider cost) each send their own X-HON-Human-Command and an Idempotency-Key, and the database decides again that
 * the caller is the HQ owner. Nothing here changes the program, the rates, a purchase or a payment.
 */
export type CreditsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (not an HQ billing reader, or not the HQ owner for a correction). Nothing changed. */ | 'DENIED'
  /** The wallet, lot or generation changed since it was read, or is gone. Nothing changed. */ | 'CHANGED'
  /** A credit rule refused it (more than is available, a purchased lot, more units than held). Nothing changed. */ | 'REFUSED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class CreditsError extends Error { constructor(readonly kind: CreditsErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; throw new CreditsError('UNKNOWN'); }
  // A retired read never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CreditsError('SESSION'); }
  if (r.status === 403) throw new CreditsError('DENIED');
  if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new CreditsError('UNKNOWN');
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new CreditsError('UNKNOWN');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
    return verify((value as { data: unknown }).data);
  } catch { throw new CreditsError('UNKNOWN'); }
}

/** Definite answers raised before any write. Anything else (busy, 5xx, an unknown code, drift) is UNKNOWN. */
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'SAAS_TRANSITION_NOT_ALLOWED', 'SAAS_CREATIVE_OUTCOME_PENDING']);
const REFUSED = new Set(['SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE', 'SAAS_CREATIVE_PURCHASED_LOT_PROTECTED', 'SAAS_FINAL_EXCEEDS_RESERVATION']);
export function creditsErrorFor(status: number, code: string | null): CreditsError {
  if (status === 403) return new CreditsError('DENIED', code);
  if (status === 400) return new CreditsError('INVALID', code);
  if (status === 429) return new CreditsError('RATE', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new CreditsError('CHANGED', code);
  if (status === 409 && code !== null && CHANGED.has(code)) return new CreditsError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new CreditsError('INVALID', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new CreditsError('REFUSED', code);
  return new CreditsError('UNKNOWN', code);
}
/** Only an unknown outcome or a rate limit keeps the request for an identical retry; every other answer is final. */
export const keepForRetry = (error: unknown) => !(error instanceof CreditsError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
async function command<T>(path: string, marker: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  } catch { throw new CreditsError('UNKNOWN'); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CreditsError('SESSION'); }
  let value: unknown = null;
  if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) {
    try { const text = await r.text(); if (text.length <= RESPONSE_MAX) value = JSON.parse(text) as unknown; } catch { value = null; }
  }
  if (r.status !== 200) throw creditsErrorFor(r.status, codeOf(value));
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
    return verify((value as { data: unknown }).data);
  } catch { throw new CreditsError('UNKNOWN'); }
}
function checked<T>(work: () => T): T { try { return work(); } catch { throw new CreditsError('INVALID'); } }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const BASE = '/api/v1/hq/saas/creative-credits';

export const creditsApi = {
  /** The program state, published rates, top-up packages and one row per school wallet (at most 200). */
  wallets(signal: AbortSignal, owned: Owned): Promise<SaasCreativeHqWalletList> {
    return read(BASE, validateSaasCreativeHqWalletList, signal, owned);
  },
  /** One school's wallet with HQ-only detail; refused when the answer is for another school. */
  school(schoolId: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeHqWallet> {
    return Promise.resolve().then(() => {
      let id: string;
      try { id = saasUuid(schoolId); } catch { throw new CreditsError('UNKNOWN'); }
      return read(`${BASE}/schools/${id}`, (v) => {
        const wallet = validateSaasCreativeHqWallet(v);
        if (wallet.schoolId.toLowerCase() !== id) throw new Error('school');
        return wallet;
      }, signal, owned);
    });
  },
  /** HQ owner: add a promotional or adjustment lot to one school. The receipt must name that school, kind and amount. */
  grant(schoolId: string, input: SaasCreativeGrantInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeAdjustmentReceipt> {
    return Promise.resolve().then(() => {
      const [school, body, k] = checked(() => [saasUuid(schoolId), validateSaasCreativeGrantInput(input), saasUuid(key)] as const);
      return command(`${BASE}/schools/${school}/grants`, SAAS_COMMANDS.grantCreativeCredits, body, k, (v) => {
        const r = validateSaasCreativeAdjustmentReceipt(v), a = r.adjustment;
        if (!same(a.schoolId, school) || Object.hasOwn(a, 'credits') || a.lot.kind !== body.kind || a.lot.credits !== body.credits || a.reasonCode !== body.reasonCode || a.note !== body.note) throw new Error('mismatch');
        return r;
      }, signal, owned);
    });
  },
  /** HQ owner: remove unused credits from one included, promotional or adjustment lot of the named school. */
  debit(schoolId: string, lotId: string, input: SaasCreativeDebitInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeAdjustmentReceipt> {
    return Promise.resolve().then(() => {
      const [school, lot, body, k] = checked(() => [saasUuid(schoolId), saasUuid(lotId), validateSaasCreativeDebitInput(input), saasUuid(key)] as const);
      return command(`${BASE}/lots/${lot}/debits`, SAAS_COMMANDS.debitCreativeLot, body, k, (v) => {
        const r = validateSaasCreativeAdjustmentReceipt(v), a = r.adjustment;
        if (!same(a.schoolId, school) || !same(a.lot.lotId, lot) || a.credits !== body.credits || a.reasonCode !== body.reasonCode || a.note !== body.note) throw new Error('mismatch');
        return r;
      }, signal, owned);
    });
  },
  /** HQ owner: settle a generation whose outcome is unknown (or still held) with provider evidence. */
  resolve(schoolId: string, reservationId: string, input: SaasCreativeResolveInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeResolveReceipt> {
    return Promise.resolve().then(() => {
      const [school, id, body, k] = checked(() => [saasUuid(schoolId), saasUuid(reservationId), validateSaasCreativeResolveInput(input), saasUuid(key)] as const);
      return command(`${BASE}/reservations/${id}/resolve`, SAAS_COMMANDS.resolveCreativeReservation, body, k, (v) => {
        const r = validateSaasCreativeResolveReceipt(v), x = r.reservation;
        const succeeded = body.resolution === 'SUCCEEDED';
        if (!same(x.reservationId, id) || !same(x.schoolId, school) || x.status !== (succeeded ? 'FINALIZED' : 'RELEASED') || x.finalUnits !== body.finalUnits
          || x.providerCostMicrounits !== body.providerCostMicrounits || x.costStatus !== (body.providerCostMicrounits === null ? 'UNKNOWN' : 'RECORDED')) throw new Error('mismatch');
        return r;
      }, signal, owned);
    });
  },
  /** HQ owner: record, once, the provider cost of a released generation whose cost is unknown. */
  cost(schoolId: string, reservationId: string, input: SaasCreativeCostInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeCostReceipt> {
    return Promise.resolve().then(() => {
      const [school, id, body, k] = checked(() => [saasUuid(schoolId), saasUuid(reservationId), validateSaasCreativeCostInput(input), saasUuid(key)] as const);
      return command(`${BASE}/reservations/${id}/provider-cost`, SAAS_COMMANDS.recordCreativeCost, body, k, (v) => {
        const r = validateSaasCreativeCostReceipt(v), x = r.reservation;
        if (!same(x.reservationId, id) || !same(x.schoolId, school) || x.providerCostMicrounits !== body.providerCostMicrounits) throw new Error('mismatch');
        return r;
      }, signal, owned);
    });
  },
};
export type CreditsApi = typeof creditsApi;
/** Dollar text ("0.08" or "12") to provider-cost microunits; null when it is not an amount with at most six decimals. */
export function toMicro(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  return match ? Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0')) : null;
}

/** US dollars from provider-cost microunits (millionths of a dollar). */
export function usd(language: string, micro: number): string {
  const digits = micro === 0 || micro >= 10_000 ? 2 : micro >= 100 ? 4 : 6;
  return new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(micro / 1_000_000);
}
/** US dollars from minor units (cents). */
export const dollars = (language: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(minor / 100);
