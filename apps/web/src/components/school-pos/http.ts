import {
  POS_HUMAN_COMMAND, accountClosed, accountUuid, validatePosDateRange, validatePosItemInput, validatePosItemResult, validatePosRead, validatePosRefundInput,
  validatePosSale, validatePosSaleInput, validatePosSaleResult, validatePosSales, validatePosSettingsInput, validatePosSettingsResult, validatePosStockInput,
  type PosItemInput, type PosItemResult, type PosRead, type PosRefundInput, type PosSale, type PosSaleInput, type PosSaleResult, type PosSales,
  type PosSettingsInput, type PosSettingsResult, type PosStockInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Front-desk Point of Sale (0403). The server decides authority from the verified session and prices every sale; the
 * browser names the school and sends one closed body per command with the POS human-command marker and an idempotency key.
 */
export type PosErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed. Nothing changed. */ | 'DENIED'
  /** Not at this school. */ | 'MISSING'
  /** The total, an item, stock or a version changed. Nothing changed; read again. */ | 'CHANGED'
  /** Not accepted. Nothing changed. */ | 'INVALID'
  /** Still being saved; the same request may be sent again. */ | 'BUSY'
  /** Outcome not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class PosError extends Error { constructor(readonly kind: PosErrorKind, readonly code: string | null = null, readonly detail: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const field = (v: unknown, k: string): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>)[k] === 'string' ? (v as Record<string, string>)[k] ?? null : null;

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function posErrorFor(status: number, body: unknown): PosError {
  const code = field(body, 'code'), detail = field(body, 'detail');
  if (status === 403) return new PosError('DENIED', code, detail);
  if (status === 404 && code === 'POS_NOT_FOUND') return new PosError('MISSING', code, detail);
  if (status === 400) return new PosError('INVALID', code, detail);
  if (status === 409 && code === 'POS_KEY_REUSED') return new PosError('INVALID', code, detail);
  if (status === 409 && code && code.startsWith('POS_')) return new PosError('CHANGED', code, detail);
  if (status === 503 && code === 'POS_BUSY') return new PosError('BUSY', code, detail);
  return new PosError('UNKNOWN', code, detail);
}
/** Only an unknown outcome or a request still in progress keeps the exact request for Try again. */
export const keepPosForRetry = (error: unknown) => !(error instanceof PosError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': POS_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new PosError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new PosError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new PosError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new PosError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
function data<T>(status: number, value: unknown, validate: (v: unknown) => T): T {
  if (status !== 200) throw posErrorFor(status, value);
  try { return validate(accountClosed(value, ['data']).data); } catch { throw new PosError('UNKNOWN'); }
}
const school = (id: string) => { try { return accountUuid(id).toLowerCase(); } catch { throw new PosError('INVALID'); } };

export type PosCommand =
  | { op: 'settings'; input: PosSettingsInput } | { op: 'item'; input: PosItemInput } | { op: 'stock'; input: PosStockInput }
  | { op: 'sale'; input: PosSaleInput } | { op: 'refund'; input: PosRefundInput };
const PATH = { settings: 'settings', item: 'items', stock: 'stock', sale: 'sales', refund: 'refunds' } as const;
const CHECK = { settings: validatePosSettingsInput, item: validatePosItemInput, stock: validatePosStockInput, sale: validatePosSaleInput, refund: validatePosRefundInput } as const;

export const posApi = {
  async read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<PosRead> {
    const s = school(schoolId);
    const { status, value } = await exchange(`/api/v1/school/schools/${s}/pos`, signal, owned);
    const read = data(status, value, validatePosRead);
    if (read.schoolId !== s) throw new PosError('UNKNOWN');
    return read;
  },
  async sales(schoolId: string, from: string, to: string, signal: AbortSignal, owned: Owned): Promise<PosSales> {
    const s = school(schoolId);
    try { validatePosDateRange(from, to); } catch { throw new PosError('INVALID'); }
    const { status, value } = await exchange(`/api/v1/school/schools/${s}/pos/sales/${from}/${to}`, signal, owned);
    return data(status, value, validatePosSales);
  },
  async sale(schoolId: string, saleId: string, signal: AbortSignal, owned: Owned): Promise<PosSale> {
    const s = school(schoolId), id = school(saleId);
    const { status, value } = await exchange(`/api/v1/school/schools/${s}/pos/sale/${id}`, signal, owned);
    const sale = data(status, value, validatePosSale);
    if (sale.saleId !== id) throw new PosError('UNKNOWN');
    return sale;
  },
  /** One command. The same key and body replay the saved answer. */
  async command(command: PosCommand, key: string, signal: AbortSignal, owned: Owned): Promise<PosSettingsResult | PosItemResult | PosSaleResult> {
    let body: string, k: string;
    try { body = JSON.stringify((CHECK[command.op] as (v: unknown) => unknown)(command.input)); k = accountUuid(key); } catch { throw new PosError('INVALID'); }
    const { status, value } = await exchange(`/api/v1/school/pos/${PATH[command.op]}`, signal, owned, { body, key: k });
    if (command.op === 'settings') return data(status, value, validatePosSettingsResult);
    if (command.op === 'item' || command.op === 'stock') return data(status, value, validatePosItemResult);
    return data(status, value, validatePosSaleResult);
  },
};
export type PosApi = typeof posApi;
