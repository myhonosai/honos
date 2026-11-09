import { saasUuid, validateSaasCreativeHqWallet, validateSaasCreativeHqWalletList, type SaasCreativeHqWallet, type SaasCreativeHqWalletList } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ creative credits (CW1), read only. Every read is a plain same-origin GET that sends only Accept; the database decides
 * who may read (HQ billing readers) on every request. Nothing here grants, debits, resolves or changes the program.
 */
export type CreditsErrorKind = 'SESSION' | 'DENIED' | 'UNKNOWN';
export class CreditsError extends Error { constructor(readonly kind: CreditsErrorKind) { super(kind); } }
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

export const creditsApi = {
  /** The program state, published rates, top-up packages and one row per school wallet (at most 200). */
  wallets(signal: AbortSignal, owned: Owned): Promise<SaasCreativeHqWalletList> {
    return read('/api/v1/hq/saas/creative-credits', validateSaasCreativeHqWalletList, signal, owned);
  },
  /** One school's wallet with HQ-only detail; refused when the answer is for another school. */
  school(schoolId: string, signal: AbortSignal, owned: Owned): Promise<SaasCreativeHqWallet> {
    return Promise.resolve().then(() => {
      let id: string;
      try { id = saasUuid(schoolId); } catch { throw new CreditsError('UNKNOWN'); }
      return read(`/api/v1/hq/saas/creative-credits/schools/${id}`, (v) => {
        const wallet = validateSaasCreativeHqWallet(v);
        if (wallet.schoolId.toLowerCase() !== id) throw new Error('school');
        return wallet;
      }, signal, owned);
    });
  },
};
export type CreditsApi = typeof creditsApi;

/** US dollars from provider-cost microunits (millionths of a dollar). */
export function usd(language: string, micro: number): string {
  const digits = micro === 0 || micro >= 10_000 ? 2 : micro >= 100 ? 4 : 6;
  return new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(micro / 1_000_000);
}
/** US dollars from minor units (cents). */
export const dollars = (language: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(minor / 100);
