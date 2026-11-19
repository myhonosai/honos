/**
 * SI1 (0558) browser calls for the simple staff invoice. Same-origin only; the server decides the school, the
 * permission and the payer's account. Nothing here charges or sends: create saves (and, when asked, issues) one invoice.
 */
import {
  validateCreateSimpleInvoiceInput, verifyInvoiceDetail, verifySimpleInvoiceReceipt,
  type CreateSimpleInvoiceInput, type InvoiceDetail,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type SimpleInvoiceScope = Readonly<{ organizationId: string; schoolId: string }>;
export type SimpleInvoiceErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'NOT_FOUND' | 'KEY_REUSED' | 'UNKNOWN';
export class SimpleInvoiceError extends Error { constructor(readonly kind: SimpleInvoiceErrorKind) { super(kind); } }
export type PayerChoice = Readonly<{ id: string; displayName: string }>;
export type PayerAccount = Readonly<{ billingAccountId: string; currency: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
function root(scope: SimpleInvoiceScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new SimpleInvoiceError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/billing`;
}
type Answer = { status: number; value: unknown };
async function call(path: string, command?: { marker: string; key?: string; body: unknown }): Promise<Answer> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, ...(command.key ? { 'Idempotency-Key': command.key } : {}) } : {}) },
      ...(command ? { body: JSON.stringify(command.body) } : {}) });
  } catch { throw new SimpleInvoiceError('UNKNOWN'); }
  if (r.status === 401) { reportConfirmedSessionInvalidation(); throw new SimpleInvoiceError('SESSION'); }
  if (!JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  try { return { status: r.status, value: JSON.parse(await r.text()) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown) => (v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null);
const dataOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as { data?: unknown }).data : undefined);
const metaOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as { meta?: { replayed?: unknown } }).meta : undefined);

/** A refusal's meaning. A 409 that is not "in progress" means the key was used for something else; the rest is UNKNOWN. */
export function simpleInvoiceErrorFor(status: number, code: string | null): SimpleInvoiceError {
  if (status === 403) return new SimpleInvoiceError('DENIED');
  if (status === 404) return new SimpleInvoiceError('NOT_FOUND');
  if (status === 400 || status === 422) return new SimpleInvoiceError('INVALID');
  if (status === 409 && code !== 'IDEMPOTENCY_IN_PROGRESS') return new SimpleInvoiceError('KEY_REUSED');
  return new SimpleInvoiceError('UNKNOWN');
}

export const simpleInvoiceApi = {
  /** People at this school whose name starts with the query (2 to 20 characters). A protected read: no key. */
  async findPayers(scope: SimpleInvoiceScope, query: string): Promise<readonly PayerChoice[]> {
    const q = query.trim();
    if (q.length < 2 || q.length > 20) throw new SimpleInvoiceError('INVALID');
    const answer = await call(`${root(scope)}/accounts/payer-lookup`, { marker: 'billing.account.create', body: { query: q } });
    if (answer.status !== 200) throw simpleInvoiceErrorFor(answer.status, codeOf(answer.value));
    const data = dataOf(answer.value);
    if (!Array.isArray(data) || data.length > 10) throw new SimpleInvoiceError('UNKNOWN');
    return data.map((row) => {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.displayName !== 'string') throw new SimpleInvoiceError('UNKNOWN');
      return { id: row.id.toLowerCase(), displayName: row.displayName };
    });
  },
  /** The payer's current billing account (reused), or a new one. The answer must be for this person. */
  async payerAccount(scope: SimpleInvoiceScope, personId: string, key: string): Promise<PayerAccount> {
    if (!UUID.test(personId) || !UUID.test(key)) throw new SimpleInvoiceError('INVALID');
    const answer = await call(`${root(scope)}/accounts`, { marker: 'billing.account.create', key, body: { responsiblePersonId: personId.toLowerCase() } });
    if (answer.status !== 200 && answer.status !== 201) throw simpleInvoiceErrorFor(answer.status, codeOf(answer.value));
    const data = dataOf(answer.value) as Record<string, unknown> | undefined;
    if (!data || typeof data.id !== 'string' || !UUID.test(data.id) || typeof data.responsiblePersonId !== 'string'
      || data.responsiblePersonId.toLowerCase() !== personId.toLowerCase() || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) {
      throw new SimpleInvoiceError('UNKNOWN');
    }
    return { billingAccountId: data.id.toLowerCase(), currency: data.currency };
  },
  /** Create (and, when asked, issue) one invoice. An unknown result may be retried only with the same key and input. */
  async create(scope: SimpleInvoiceScope, input: CreateSimpleInvoiceInput, key: string): Promise<{ detail: InvoiceDetail; replayed: boolean }> {
    let checked: CreateSimpleInvoiceInput;
    try { checked = validateCreateSimpleInvoiceInput(input); } catch { throw new SimpleInvoiceError('INVALID'); }
    if (!UUID.test(key)) throw new SimpleInvoiceError('INVALID');
    const answer = await call(`${root(scope)}/invoices/simple`, { marker: 'billing.invoice.simple.create', key, body: checked });
    if (answer.status !== 200 && answer.status !== 201) throw simpleInvoiceErrorFor(answer.status, codeOf(answer.value));
    const replayed = answer.status === 200;
    if (metaOf(answer.value)?.replayed !== replayed) throw new SimpleInvoiceError('UNKNOWN');
    try {
      // A replay shows the invoice as it is now (it may have been issued or paid since), so only its shape is checked.
      const detail = replayed ? verifyInvoiceDetail(dataOf(answer.value)) : verifySimpleInvoiceReceipt(dataOf(answer.value), checked);
      if (detail.invoice.billingAccountId.toLowerCase() !== checked.billingAccountId) throw new Error('other account');
      return { detail, replayed };
    } catch { throw new SimpleInvoiceError('UNKNOWN'); }
  },
  /** The printable invoice. Another school's invoice reads as NOT_FOUND. */
  async detail(scope: SimpleInvoiceScope, invoiceId: string): Promise<InvoiceDetail> {
    if (!UUID.test(invoiceId)) throw new SimpleInvoiceError('INVALID');
    const answer = await call(`${root(scope)}/invoices/${invoiceId.toLowerCase()}/detail`);
    if (answer.status !== 200) throw simpleInvoiceErrorFor(answer.status, codeOf(answer.value));
    try { return verifyInvoiceDetail(dataOf(answer.value), invoiceId); } catch { throw new SimpleInvoiceError('UNKNOWN'); }
  },
};
export type SimpleInvoiceApi = typeof simpleInvoiceApi;
