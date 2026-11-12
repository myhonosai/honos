import {
  validateReceivablesQuery, validateRecordTuitionPaymentInput, validateVoidTuitionPaymentInput, verifyInvoicePayments, verifySchoolReceivables, verifyTuitionPaymentReceipt,
  type InvoicePayments, type ReceivablesFilter, type RecordTuitionPaymentInput, type SchoolReceivables, type TuitionPaymentReceipt, type VoidTuitionPaymentInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Tuition payments (B-TUI-1, 0240). Reads send no Idempotency-Key; each command sends its own X-HON-Human-Command and an
 * Idempotency-Key, so a record can never be replayed as a void. The server decides every permission, version, currency
 * and balance again. HON moves no money: a record is evidence of a payment the school received outside HON, and a void is
 * a correction, never a refund.
 */
export type TuitionErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The invoice or payment is not available at this school. */ | 'GONE'
  /** The invoice changed since it was read. Nothing changed. */ | 'CHANGED'
  /** The invoice is not issued (draft, void, written off or already paid). Nothing changed. */ | 'NOT_PAYABLE'
  /** The payment currency is not the invoice currency. */ | 'CURRENCY'
  /** The payment is more than what is left to pay. */ | 'EXCEEDS'
  /** This payment was already voided. */ | 'ALREADY_VOIDED'
  /** The school's time zone is not usable. */ | 'TIMEZONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class TuitionError extends Error { constructor(readonly kind: TuitionErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type TuitionScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TUITION_COMMANDS = { record: 'billing.invoice.payment.record', void: 'billing.invoice.payment.void' } as const;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new TuitionError('INVALID'); return value.toLowerCase(); }
function base(scope: TuitionScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/billing`; }

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new TuitionError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new TuitionError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function tuitionErrorFor(status: number, code: string | null): TuitionError {
  if (status === 403) return new TuitionError('DENIED', code);
  if (status === 404) return new TuitionError('GONE', code);
  if (status === 400) return new TuitionError('INVALID', code);
  if (status === 429) return new TuitionError('RATE', code);
  if (status === 422 && code === 'INVOICE_CURRENCY_MISMATCH') return new TuitionError('CURRENCY', code);
  if (status === 422 && code === 'INVOICE_PAYMENT_EXCEEDS_BALANCE') return new TuitionError('EXCEEDS', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new TuitionError('CHANGED', code);
    if (code === 'INVOICE_NOT_PAYABLE') return new TuitionError('NOT_PAYABLE', code);
    if (code === 'INVOICE_PAYMENT_ALREADY_VOIDED') return new TuitionError('ALREADY_VOIDED', code);
    if (code === 'SCHOOL_TIMEZONE_INVALID') return new TuitionError('TIMEZONE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new TuitionError('INVALID', code);
  }
  // TUITION_PAYMENT_CONFLICT (a lock or serialization wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new TuitionError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof TuitionError || signal.aborted) throw error; throw new TuitionError('UNKNOWN'); }
  if (answer.status !== 200) throw tuitionErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new TuitionError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new TuitionError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof TuitionError) throw error; throw new TuitionError('UNKNOWN'); }
  if (answer.status !== 200) throw tuitionErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new TuitionError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new TuitionError('INVALID'); } }

export const tuitionApi = {
  /** The school's unpaid balances: issued invoices with something left to pay, 50 per page by invoice id. */
  receivables(scope: TuitionScope, filter: ReceivablesFilter, after: string | null, signal: AbortSignal, owned: Owned): Promise<SchoolReceivables> {
    return Promise.resolve().then(() => {
      const query = checked(() => validateReceivablesQuery({ filter, ...(after === null ? {} : { after }) }));
      const search = new URLSearchParams({ filter: query.filter, ...(query.after ? { after: query.after } : {}) });
      return read(`${base(scope)}/receivables?${search.toString()}`, (v) => verifySchoolReceivables(v, query), signal, owned);
    });
  },
  /** One invoice's balance and its recorded payments, newest first. */
  payments(scope: TuitionScope, invoiceId: string, signal: AbortSignal, owned: Owned): Promise<InvoicePayments> {
    return Promise.resolve().then(() => read(`${base(scope)}/invoices/${id(invoiceId)}/payments`, (v) => verifyInvoicePayments(v, invoiceId), signal, owned));
  },
  /** A record of a payment the school received outside HON. Nothing is charged through HON. */
  async record(scope: TuitionScope, invoiceId: string, input: RecordTuitionPaymentInput, key: string, signal: AbortSignal, owned: Owned): Promise<TuitionPaymentReceipt> {
    const path = `${base(scope)}/invoices/${id(invoiceId)}/payments`, body = checked(() => validateRecordTuitionPaymentInput(input));
    return command(path, TUITION_COMMANDS.record, body, key, (v) => verifyTuitionPaymentReceipt(v, { invoiceId, voided: false }), signal, owned);
  },
  /** Void a payment recorded by mistake, with a reason. It is kept, shown as voided, and is not a refund. */
  async voidPayment(scope: TuitionScope, paymentId: string, input: VoidTuitionPaymentInput, key: string, signal: AbortSignal, owned: Owned): Promise<TuitionPaymentReceipt> {
    const path = `${base(scope)}/invoice-payments/${id(paymentId)}/void`, body = checked(() => validateVoidTuitionPaymentInput(input));
    return command(path, TUITION_COMMANDS.void, body, key, (v) => verifyTuitionPaymentReceipt(v, { paymentId, voided: true }), signal, owned);
  },
};
export type TuitionApi = typeof tuitionApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof TuitionError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
