'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCHOOL_INVOICE_LIST_STATUSES, validateSchoolInvoiceListQuery, verifySchoolInvoiceList,
  type ListedInvoice, type SchoolInvoiceList, type SchoolInvoiceListStatus,
} from '@hon/contracts';
import { formatMinor } from '../invoice-pickers';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT, reportConfirmedSessionInvalidation } from '../session-invalidation';
import styles from './invoice-list.module.css';

/**
 * The school's invoices (B-TUI-1b, 0280), so a DRAFT that was not issued at once can be found and issued later. Reads are
 * plain same-origin GETs; Issue uses the existing issue command with the listed version and its own key, and the server
 * re-checks billing.invoice.issue, the DRAFT state and the version. An unknown result keeps the exact request for Try again.
 * Nothing here sends, charges or collects.
 */
export type InvoiceListScope = Readonly<{ organizationId: string; schoolId: string }>;
export type ListErrorKind = 'SESSION' | 'DENIED' | 'CHANGED' | 'INVALID' | 'UNKNOWN';
export class InvoiceListError extends Error { constructor(readonly kind: ListErrorKind) { super(kind); } }
type Owned = () => boolean;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const base = (scope: InvoiceListScope) => {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new InvoiceListError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/billing/invoices`;
};
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: { key: string; body: string }): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'billing-invoice' } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted) throw error; throw new InvoiceListError('UNKNOWN'); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new InvoiceListError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  try { return { status: r.status, value: JSON.parse(await r.text()) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown) => v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const dataOf = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? (v as { data?: unknown }).data : undefined;

/** A refusal's meaning; anything not listed is UNKNOWN (only the identical request may be sent again). */
export function listErrorFor(status: number, code: string | null): InvoiceListError {
  if (status === 403) return new InvoiceListError('DENIED');
  if (status === 400 || status === 404 || status === 422) return new InvoiceListError('INVALID');
  if (status === 409 && code !== 'IDEMPOTENCY_IN_PROGRESS') return new InvoiceListError('CHANGED');
  return new InvoiceListError('UNKNOWN');
}

export const invoiceListApi = {
  async list(scope: InvoiceListScope, status: SchoolInvoiceListStatus, after: string | null, signal: AbortSignal, owned: Owned): Promise<SchoolInvoiceList> {
    let query;
    try { query = validateSchoolInvoiceListQuery(after ? { status, after } : { status }); } catch { throw new InvoiceListError('INVALID'); }
    const search = new URLSearchParams({ status: query.status, ...(query.after ? { after: query.after } : {}) });
    const answer = await exchange(`${base(scope)}?${search.toString()}`, signal, owned);
    if (answer.status !== 200) throw listErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolInvoiceList(dataOf(answer.value), query); } catch { throw new InvoiceListError('UNKNOWN'); }
  },
  /** Issue one listed DRAFT at its listed version. The answer must be that invoice, ISSUED, one version later. */
  async issue(scope: InvoiceListScope, invoice: Pick<ListedInvoice, 'invoiceId' | 'version'>, key: string, signal: AbortSignal, owned: Owned): Promise<{ invoiceId: string; version: number }> {
    if (!UUID.test(invoice.invoiceId) || !UUID.test(key) || !Number.isSafeInteger(invoice.version) || invoice.version < 1) throw new InvoiceListError('INVALID');
    const answer = await exchange(`${base(scope)}/${invoice.invoiceId.toLowerCase()}/issue`, signal, owned, { key, body: JSON.stringify({ expectedVersion: invoice.version }) });
    if (answer.status !== 200) throw listErrorFor(answer.status, codeOf(answer.value));
    const data = dataOf(answer.value) as Record<string, unknown> | undefined;
    if (!data || typeof data.id !== 'string' || data.id.toLowerCase() !== invoice.invoiceId.toLowerCase() || data.status !== 'ISSUED' || data.version !== invoice.version + 1) {
      throw new InvoiceListError('UNKNOWN');
    }
    return { invoiceId: invoice.invoiceId.toLowerCase(), version: invoice.version + 1 };
  },
};
export type InvoiceListApi = typeof invoiceListApi;

const STATUS_LABEL: Readonly<Record<SchoolInvoiceListStatus, string>> = { ALL: 'All invoices', DRAFT: 'Drafts (not issued)', ISSUED: 'Issued', PAID: 'Paid', VOID: 'Void', UNCOLLECTIBLE: 'Written off' };
const ROW_STATUS: Readonly<Record<string, string>> = { DRAFT: 'Draft', ISSUED: 'Issued', PAID: 'Paid', VOID: 'Void', UNCOLLECTIBLE: 'Written off' };
const MESSAGE: Readonly<Record<ListErrorKind, string>> = {
  SESSION: 'Your session ended. Sign in again; nothing was changed by this page after that.',
  DENIED: 'Your access does not include invoices at this school. Nothing changed.',
  CHANGED: 'That invoice changed since it was shown (it may already be issued). Nothing changed; the list was read again.',
  INVALID: 'That request was not accepted. Nothing changed.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so the invoice can never be issued twice.',
};
/** A due time shown as the school's calendar day (invoices are due at the end of that day in school time). */
export function schoolDay(instant: string, zone: string): string {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(instant)); }
  catch { return instant.slice(0, 10); }
}

export type ListState = { state: 'LOADING' } | { state: 'FAILED'; kind: ListErrorKind } | { state: 'READY'; read: SchoolInvoiceList; items: readonly ListedInvoice[] };
export type IssueState = null | Readonly<{ invoiceId: string; phase: 'CONFIRM' | 'SENDING' | 'DONE' } | { invoiceId: string; phase: 'FAILED'; kind: ListErrorKind; kept: boolean }>;

export function InvoiceListView({ list, status, issue, busy, onStatus, onMore, onRefresh, onIssue, onConfirm, onCancel, onTryAgain }: {
  list: ListState; status: SchoolInvoiceListStatus; issue: IssueState; busy: boolean;
  onStatus?: (s: SchoolInvoiceListStatus) => void; onMore?: () => void; onRefresh?: () => void; onIssue?: (invoiceId: string) => void;
  onConfirm?: (invoiceId: string) => void; onCancel?: () => void; onTryAgain?: () => void;
}): React.ReactElement {
  const ready = list.state === 'READY' ? list : null;
  return <article className={styles.card} aria-labelledby="invoice-list-title" data-testid="invoice-list">
    <div className={styles.cardHead}><h2 id="invoice-list-title">This school’s invoices</h2>
      <div className={styles.row}>
        <label className={styles.field}>Show<select value={status} disabled={busy} onChange={(e) => onStatus?.(e.target.value as SchoolInvoiceListStatus)}>
          {SCHOOL_INVOICE_LIST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
        <button type="button" disabled={busy} onClick={onRefresh}>Refresh</button>
      </div></div>
    <p className={styles.meta}>Newest first. A draft is not visible to the family and owes nothing until it is issued. Issuing does not send, charge or collect anything.</p>
    {issue?.phase === 'DONE' ? <p className={styles.meta} role="status">The invoice was issued. It now appears under Tuition balances.</p> : null}
    {issue?.phase === 'FAILED' ? <p className={styles.warnText} role="status">{MESSAGE[issue.kind]}</p> : null}
    {issue?.phase === 'FAILED' && issue.kept ? <button type="button" disabled={busy} onClick={onTryAgain}>Try again</button> : null}
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading invoices…</p>
      : list.state === 'FAILED' ? <p className={styles.meta} role="status">{list.kind === 'DENIED' ? MESSAGE.DENIED : 'Invoices could not be read just now. Nothing changed.'}</p>
      : ready && ready.items.length === 0 ? <p className={styles.meta}>{status === 'ALL' ? 'No invoices yet.' : `No ${STATUS_LABEL[status].toLowerCase()} invoices.`}</p>
      : ready ? <ul className={styles.list}>
        {ready.items.map((i) => <li key={i.invoiceId} data-testid={`invoice-${i.invoiceId}`}>
          <strong>{i.payerName ?? 'No payer name recorded'} · {formatMinor(i.totalMinor, i.currency)}</strong>
          <span className={styles.meta}>{ROW_STATUS[i.status]}{i.dueAt ? ` · due ${schoolDay(i.dueAt, ready.read.timezone)}` : ''}{i.overdue ? ' · overdue' : ''}
            {i.status === 'ISSUED' && i.paidMinor > 0 ? ` · ${formatMinor(i.balanceMinor, i.currency)} left to pay` : ''} · created {schoolDay(i.createdAt, ready.read.timezone)}</span>
          {i.status === 'DRAFT' && ready.read.canIssue ? (issue?.invoiceId === i.invoiceId && issue.phase === 'CONFIRM'
            ? <div className={styles.row}><button type="button" disabled={busy} onClick={() => onConfirm?.(i.invoiceId)}>Confirm: issue this invoice</button>
              <button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
            : <div className={styles.row}><button type="button" disabled={busy} onClick={() => onIssue?.(i.invoiceId)}>Issue</button></div>) : null}
        </li>)}
      </ul> : null}
    {ready?.read.nextAfter ? <button type="button" disabled={busy} onClick={onMore}>Show more</button> : null}
  </article>;
}

/** Holds the reads and one issue at a time. Keyed by school by the caller, so another school starts clean. */
export function InvoiceList({ scope: given, api = invoiceListApi, refreshSignal = 0 }: { scope: InvoiceListScope; api?: InvoiceListApi; refreshSignal?: number }): React.ReactElement {
  // A stable scope: the caller may pass a fresh object each render; only the two ids matter.
  const scope = useMemo(() => ({ organizationId: given.organizationId, schoolId: given.schoolId }), [given.organizationId, given.schoolId]);
  const [status, setStatus] = useState<SchoolInvoiceListStatus>('ALL');
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [issue, setIssue] = useState<IssueState>(null);
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), mounted = useRef(true), kept = useRef<{ invoiceId: string; version: number; key: string } | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gen.current++; kept.current = null; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => { gen.current++; kept.current = null; setIssue(null); setList({ state: 'LOADING' }); setRefresh((n) => n + 1); },
    [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const read = useCallback((after: string | null) => {
    const current = ++gen.current, owned = () => mounted.current && current === gen.current;
    if (!after) setList({ state: 'LOADING' });
    api.list(scope, status, after, AbortSignal.timeout(15000), owned).then(
      (next) => { if (owned()) setList((prev) => ({ state: 'READY', read: next, items: after && prev.state === 'READY' ? [...prev.items, ...next.items] : next.items })); },
      (error) => { if (owned()) setList({ state: 'FAILED', kind: error instanceof InvoiceListError ? error.kind : 'UNKNOWN' }); });
  }, [api, scope, status]);
  useEffect(() => { read(null); }, [read, refresh, refreshSignal]);

  const send = useCallback(async () => {
    const request = kept.current;
    if (!request || sending.current) return;
    sending.current = true; setIssue({ invoiceId: request.invoiceId, phase: 'SENDING' });
    try {
      await api.issue(scope, request, request.key, AbortSignal.timeout(30000), () => mounted.current && kept.current === request);
      if (kept.current !== request) return;
      kept.current = null; setIssue({ invoiceId: request.invoiceId, phase: 'DONE' }); setRefresh((n) => n + 1);
    } catch (error) {
      if (kept.current !== request) return;
      const kind = error instanceof InvoiceListError ? error.kind : 'UNKNOWN', stay = kind === 'UNKNOWN';
      if (!stay) { kept.current = null; setRefresh((n) => n + 1); }
      setIssue({ invoiceId: request.invoiceId, phase: 'FAILED', kind, kept: stay });
    } finally { sending.current = false; }
  }, [api, scope]);

  return <InvoiceListView list={list} status={status} issue={issue} busy={issue?.phase === 'SENDING'}
    onStatus={(s) => { if (!kept.current) { setIssue(null); setStatus(s); } }}
    onRefresh={() => { if (!kept.current) { setIssue(null); setRefresh((n) => n + 1); } }}
    onMore={() => { if (list.state === 'READY' && list.read.nextAfter) read(list.read.nextAfter); }}
    onIssue={(invoiceId) => { if (!kept.current && !sending.current) setIssue({ invoiceId, phase: 'CONFIRM' }); }}
    onCancel={() => { if (!sending.current) setIssue(null); }}
    onConfirm={(invoiceId) => {
      if (kept.current || sending.current || list.state !== 'READY') return;
      const row = list.items.find((i) => i.invoiceId === invoiceId && i.status === 'DRAFT');
      if (!row) return;
      kept.current = { invoiceId: row.invoiceId, version: row.version, key: globalThis.crypto.randomUUID() };
      void send();
    }}
    onTryAgain={() => { void send(); }}/>;
}
