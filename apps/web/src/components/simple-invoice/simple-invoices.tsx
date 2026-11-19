'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SCHOOL_INVOICE_LIST_STATUSES, SIMPLE_INVOICE_MAX_ITEMS, type CreateSimpleInvoiceInput, type InvoiceDetail, type ListedInvoice, type SchoolInvoiceList, type SchoolInvoiceListStatus } from '@hon/contracts';
import { formatMinor } from '../invoice-pickers';
import { invoiceListApi, schoolDay, type InvoiceListApi } from '../invoice-list/invoice-list';
import { ComposeRefusal, createDraft, queueDraft, type ComposeChannel } from '../family-messages/compose-http';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import {
  FORM_PROBLEM_TEXT, addDays, addItemRow, buildCreateInput, emptyForm, formTotal, invoiceLines, invoiceMessage, lineTotal, removeItemRow, updateItemRow,
  type InvoiceForm, type InvoiceLine,
} from './simple-invoice-model';
import { SimpleInvoiceError, simpleInvoiceApi, type PayerChoice, type SimpleInvoiceApi, type SimpleInvoiceErrorKind, type SimpleInvoiceScope } from './simple-invoice-http';
import styles from './simple-invoices.module.css';

/**
 * SI1 (0558) staff invoices, laid out like a familiar invoicing tool: a list, a builder with a live preview, and a clean
 * invoice with Print, Email and Text. Creating an invoice moves no money. Email and text go through the existing
 * message commands, so the server checks the permission and the payer's consent, and HON's delivery worker sends only
 * where delivery is switched on.
 */
const STATUS_LABEL: Readonly<Record<SchoolInvoiceListStatus, string>> = { ALL: 'All', DRAFT: 'Drafts', ISSUED: 'Sent / due', PAID: 'Paid', VOID: 'Void', UNCOLLECTIBLE: 'Written off' };
const ROW_STATUS: Readonly<Record<string, string>> = { DRAFT: 'Draft', ISSUED: 'Due', PAID: 'Paid', VOID: 'Void', UNCOLLECTIBLE: 'Written off' };
/** Common martial arts school items: one tap fills the description; staff type the price. */
export const QUICK_ITEMS = ['Monthly tuition', 'Registration fee', 'Uniform (gi)', 'Belt test fee', 'Sparring gear', 'Private lesson', 'Tournament entry', 'Camp / clinic'] as const;
export const ERROR_TEXT: Readonly<Record<SimpleInvoiceErrorKind, string>> = {
  SESSION: 'Your session ended. Sign in again.',
  DENIED: 'Your access does not include this at this school. Nothing was changed.',
  INVALID: 'That was not accepted. Check the invoice and try again. Nothing was saved.',
  NOT_FOUND: 'That invoice or person was not found at this school.',
  KEY_REUSED: 'That save was already used for a different invoice. Nothing new was saved. Start the invoice again.',
  UNKNOWN: 'We could not confirm the result. Try again sends the exact same request, so the invoice is never made twice.',
};
const errorKind = (e: unknown): SimpleInvoiceErrorKind => (e instanceof SimpleInvoiceError ? e.kind : 'UNKNOWN');
const short = (invoiceId: string) => invoiceId.slice(0, 8).toUpperCase();

export type InvoiceMode = { kind: 'LIST' } | { kind: 'NEW' } | { kind: 'VIEW'; invoiceId: string; flash?: string | undefined };

// ---------- List ----------
export type ListRead = { state: 'LOADING' } | { state: 'FAILED'; denied: boolean } | { state: 'READY'; read: SchoolInvoiceList; items: readonly ListedInvoice[] };
export function InvoicesListView({ list, status, onStatus, onNew, onOpen, onMore }: {
  list: ListRead; status: SchoolInvoiceListStatus; onStatus?: (s: SchoolInvoiceListStatus) => void; onNew?: () => void; onOpen?: (id: string) => void; onMore?: () => void;
}): React.ReactElement {
  const ready = list.state === 'READY' ? list : null;
  return <section className={styles.page} aria-labelledby="invoices-title" data-testid="simple-invoices-list">
    <header className={styles.head}>
      <div><p className={styles.eyebrow}>Payments</p><h1 id="invoices-title">Invoices</h1>
        <p className={styles.summary}>Bill a family for tuition, gear or fees. They can pay in the HON parent app when your school takes card payments.</p></div>
      <button type="button" className={styles.primary} onClick={onNew}>+ New invoice</button>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="Show invoices">
      {SCHOOL_INVOICE_LIST_STATUSES.map((s) => <button key={s} type="button" role="tab" aria-selected={s === status} className={styles.tab} onClick={() => onStatus?.(s)}>{STATUS_LABEL[s]}</button>)}
    </div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">Loading invoices…</p>
      : list.state === 'FAILED' ? <p className={styles.error} role="status">{list.denied ? ERROR_TEXT.DENIED : 'Invoices could not be loaded just now.'}</p>
      : ready && ready.items.length === 0 ? <div className={styles.empty}><p>No invoices here yet.</p><button type="button" className={styles.secondary} onClick={onNew}>Create your first invoice</button></div>
      : ready ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th scope="col">Invoice</th><th scope="col">Bill to</th><th scope="col">Status</th><th scope="col">Due</th><th scope="col" className={styles.num}>Total</th><th scope="col" className={styles.num}>Balance</th></tr></thead>
        <tbody>{ready.items.map((i) => <tr key={i.invoiceId} data-testid={`invoice-row-${i.invoiceId}`}>
          <td><button type="button" className={styles.link} onClick={() => onOpen?.(i.invoiceId)}>#{short(i.invoiceId)}</button></td>
          <td>{i.payerName ?? '—'}</td>
          <td><span className={styles.chip} data-status={i.overdue ? 'OVERDUE' : i.status}>{i.overdue ? 'Overdue' : ROW_STATUS[i.status]}</span></td>
          <td>{i.dueAt ? schoolDay(i.dueAt, ready.read.timezone) : '—'}</td>
          <td className={styles.num}>{formatMinor(i.totalMinor, i.currency)}</td>
          <td className={styles.num}>{formatMinor(i.balanceMinor, i.currency)}</td>
        </tr>)}</tbody></table></div> : null}
    {ready?.read.nextAfter ? <button type="button" className={styles.secondary} onClick={onMore}>Show more</button> : null}
  </section>;
}

// ---------- The invoice paper (preview, view and print) ----------
export type PaperData = Readonly<{
  number: string | null; status: string | null; issuedOn: string | null; dueOn: string | null; currency: string;
  billTo: { name: string | null; email: string | null; phone: string | null };
  from: { schoolName: string | null; addressLines: readonly string[]; phone: string | null; email: string | null };
  lines: readonly (InvoiceLine | { description: string; quantity: number | null; unitAmountMinor: number | null; amountMinor: number | null })[];
  totalMinor: number | null; paidMinor: number; balanceMinor: number | null;
  inApp: boolean | null; otherWays: string | null; note: string | null;
}>;
export function detailPaper(detail: InvoiceDetail): PaperData {
  const { invoice } = detail;
  return { number: detail.number, status: invoice.overdue ? 'Overdue' : ROW_STATUS[invoice.status] ?? invoice.status, issuedOn: schoolDay(invoice.createdAt, detail.timezone),
    dueOn: invoice.dueAt ? schoolDay(invoice.dueAt, detail.timezone) : null, currency: invoice.currency,
    billTo: { name: detail.billTo.name ?? invoice.payerName, email: detail.billTo.email, phone: detail.billTo.phone }, from: detail.from,
    lines: invoiceLines(detail), totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor, balanceMinor: invoice.balanceMinor,
    inApp: detail.howToPay.inApp, otherWays: detail.howToPay.otherWays, note: detail.note };
}
export function InvoicePaper({ data, preview = false }: { data: PaperData; preview?: boolean }): React.ReactElement {
  const money = (minor: number | null) => (minor === null ? '—' : formatMinor(minor, data.currency));
  return <article className={styles.paper} data-invoice-paper="" data-testid={preview ? 'invoice-preview' : 'invoice-paper'} aria-label={preview ? 'Invoice preview' : 'Invoice'}>
    <div className={styles.paperHead}>
      <div><h2 className={styles.paperSchool}>{data.from.schoolName ?? 'Your school'}</h2>
        {data.from.addressLines.map((line, n) => <p key={n} className={styles.paperMuted}>{line}</p>)}
        {data.from.phone ? <p className={styles.paperMuted}>{data.from.phone}</p> : null}
        {data.from.email ? <p className={styles.paperMuted}>{data.from.email}</p> : null}</div>
      <div className={styles.paperTitle}><p className={styles.paperWord}>INVOICE</p>
        <dl className={styles.paperFacts}>
          <dt>Number</dt><dd>{data.number ? `#${data.number}` : 'Given when saved'}</dd>
          {data.issuedOn ? <><dt>Date</dt><dd>{data.issuedOn}</dd></> : null}
          <dt>Due</dt><dd>{data.dueOn ?? '—'}</dd>
          {data.status ? <><dt>Status</dt><dd>{data.status}</dd></> : null}
        </dl></div>
    </div>
    <div className={styles.paperBill}><p className={styles.paperLabel}>Bill to</p>
      <p className={styles.paperStrong}>{data.billTo.name ?? 'Choose who pays'}</p>
      {data.billTo.email ? <p className={styles.paperMuted}>{data.billTo.email}</p> : null}
      {data.billTo.phone ? <p className={styles.paperMuted}>{data.billTo.phone}</p> : null}</div>
    <table className={styles.paperTable}>
      <thead><tr><th scope="col">Item</th><th scope="col" className={styles.num}>Qty</th><th scope="col" className={styles.num}>Price</th><th scope="col" className={styles.num}>Amount</th></tr></thead>
      <tbody>{data.lines.map((l, n) => <tr key={n}><td>{l.description || <span className={styles.paperMuted}>Item {n + 1}</span>}</td>
        <td className={styles.num}>{l.quantity ?? '—'}</td><td className={styles.num}>{money(l.unitAmountMinor)}</td><td className={styles.num}>{money(l.amountMinor)}</td></tr>)}</tbody>
    </table>
    <dl className={styles.paperTotals}>
      <dt>Total</dt><dd>{money(data.totalMinor)}</dd>
      {data.paidMinor > 0 ? <><dt>Paid</dt><dd>−{money(data.paidMinor)}</dd></> : null}
      <dt className={styles.paperDue}>Balance due</dt><dd className={styles.paperDue} data-testid="balance-due">{money(data.balanceMinor)}</dd>
    </dl>
    {data.inApp || data.otherWays ? <div className={styles.paperPay}><p className={styles.paperLabel}>How to pay</p>
      {data.inApp ? <p>Pay online by card in the HON parent app.</p> : null}
      {data.otherWays ? <p className={styles.preLine}>{data.otherWays}</p> : null}</div>
      : preview && data.inApp === null ? <div className={styles.paperPay}><p className={styles.paperLabel}>How to pay</p><p className={styles.paperMuted}>Online card payment in the HON parent app is added automatically when your school takes card payments.</p></div> : null}
    {data.note ? <div className={styles.paperPay}><p className={styles.paperLabel}>Note</p><p className={styles.preLine}>{data.note}</p></div> : null}
    <p className={styles.paperThanks}>Thank you!</p>
  </article>;
}

// ---------- Builder ----------
export type PayerState = { personId: string; name: string } | null;
export function formPaper(form: InvoiceForm, payer: PayerState, currency: string, schoolName: string | null): PaperData {
  const total = formTotal(form, currency);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(form.dueDate) ? schoolDay(`${form.dueDate}T12:00:00.000Z`, 'UTC') : null;
  return { number: null, status: null, issuedOn: null, dueOn: due, currency,
    billTo: { name: payer?.name ?? null, email: null, phone: null },
    from: { schoolName, addressLines: [], phone: form.payToPhone.trim() || null, email: form.payToEmail.trim() || null },
    lines: form.items.map((row) => { const amount = lineTotal(row, currency); const q = Number(row.quantity);
      return { description: row.description.trim(), quantity: Number.isInteger(q) && q > 0 ? q : null, unitAmountMinor: amount !== null && q > 0 ? amount / q : null, amountMinor: amount }; }),
    totalMinor: total, paidMinor: 0, balanceMinor: total, inApp: null, otherWays: form.otherWaysToPay.trim() || null, note: form.note.trim() || null };
}

export function InvoiceBuilderView({ form, payer, payerQuery, payerResults, currency, schoolName, busy, problem, onForm, onPayerQuery, onPayerSearch, onPayer, onSave, onCancel, onRetry }: {
  form: InvoiceForm; payer: PayerState; payerQuery: string; payerResults: { state: 'IDLE' | 'SEARCHING' } | { state: 'DONE'; items: readonly PayerChoice[] } | { state: 'FAILED'; text: string };
  currency: string; schoolName: string | null; busy: boolean; problem: { text: string; retry: boolean } | null;
  onForm?: (f: InvoiceForm) => void; onPayerQuery?: (q: string) => void; onPayerSearch?: () => void; onPayer?: (p: PayerState) => void;
  onSave?: (issue: boolean) => void; onCancel?: () => void; onRetry?: () => void;
}): React.ReactElement {
  const total = formTotal(form, currency);
  return <section className={styles.page} aria-labelledby="new-invoice-title" data-testid="simple-invoice-builder">
    <header className={styles.head}>
      <div><p className={styles.eyebrow}>Invoices</p><h1 id="new-invoice-title">New invoice</h1></div>
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => onSave?.(false)}>Save draft</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => onSave?.(true)}>{busy ? 'Saving…' : 'Create invoice'}</button>
      </div>
    </header>
    {problem ? <div className={styles.notice} role="alert"><p className={styles.error}>{problem.text}</p>
      {problem.retry ? <button type="button" className={styles.secondary} disabled={busy} onClick={onRetry}>Try again</button> : null}</div> : null}
    <div className={styles.builder}>
      <div className={styles.formCol}>
        <fieldset className={styles.panel} disabled={busy}><legend>Bill to</legend>
          {payer ? <div className={styles.picked}><span className={styles.avatar} aria-hidden="true">{payer.name.slice(0, 1).toUpperCase()}</span>
            <strong data-testid="picked-payer">{payer.name}</strong><button type="button" className={styles.ghost} onClick={() => onPayer?.(null)}>Change</button></div>
            : <>
              <form className={styles.inline} role="search" onSubmit={(e) => { e.preventDefault(); onPayerSearch?.(); }}>
                <label className={styles.field}><span>Search a student or parent by name</span>
                  <input value={payerQuery} maxLength={20} placeholder="e.g. Rivera" onChange={(e) => onPayerQuery?.(e.target.value)}/></label>
                <button type="submit" className={styles.secondary} disabled={payerQuery.trim().length < 2}>Search</button>
              </form>
              {payerResults.state === 'SEARCHING' ? <p className={styles.meta} role="status">Searching…</p> : null}
              {payerResults.state === 'FAILED' ? <p className={styles.error} role="status">{payerResults.text}</p> : null}
              {payerResults.state === 'DONE' ? (payerResults.items.length === 0 ? <p className={styles.meta} role="status">No one at this school matches that name.</p>
                : <ul className={styles.results}>{payerResults.items.map((p) => <li key={p.id}>
                  <button type="button" className={styles.result} onClick={() => onPayer?.({ personId: p.id, name: p.displayName })}>
                    <span className={styles.avatar} aria-hidden="true">{p.displayName.slice(0, 1).toUpperCase()}</span>{p.displayName}</button></li>)}</ul>) : null}
            </>}
        </fieldset>

        <fieldset className={styles.panel} disabled={busy}><legend>Items</legend>
          <div className={styles.itemsHead} aria-hidden="true"><span>Description</span><span>Qty</span><span>Price</span><span className={styles.num}>Amount</span><span/></div>
          {form.items.map((row, n) => { const amount = lineTotal(row, currency); return <div className={styles.itemRow} key={row.rowId} data-testid={`item-${n + 1}`}>
            <input aria-label={`Item ${n + 1} description`} value={row.description} maxLength={200} placeholder="What is it for?" onChange={(e) => onForm?.(updateItemRow(form, row.rowId, { description: e.target.value }))}/>
            <input aria-label={`Item ${n + 1} quantity`} value={row.quantity} inputMode="numeric" onChange={(e) => onForm?.(updateItemRow(form, row.rowId, { quantity: e.target.value }))}/>
            <input aria-label={`Item ${n + 1} price`} value={row.price} inputMode="decimal" placeholder="0.00" onChange={(e) => onForm?.(updateItemRow(form, row.rowId, { price: e.target.value }))}/>
            <span className={styles.num} data-testid={`item-${n + 1}-amount`}>{amount === null ? '—' : formatMinor(amount, currency)}</span>
            <button type="button" className={styles.ghost} aria-label={`Remove item ${n + 1}`} disabled={form.items.length <= 1} onClick={() => onForm?.(removeItemRow(form, row.rowId))}>✕</button>
          </div>; })}
          <div className={styles.inline}>
            <button type="button" className={styles.secondary} disabled={form.items.length >= SIMPLE_INVOICE_MAX_ITEMS} onClick={() => onForm?.(addItemRow(form))}>+ Add item</button>
          </div>
          <div className={styles.quick}><span className={styles.meta}>Quick add:</span>
            {QUICK_ITEMS.map((label) => <button key={label} type="button" className={styles.chipButton} disabled={form.items.length >= SIMPLE_INVOICE_MAX_ITEMS && !form.items.some((r) => !r.description.trim())}
              onClick={() => { const blank = form.items.find((r) => !r.description.trim());
                if (blank) onForm?.(updateItemRow(form, blank.rowId, { description: label }));
                else { const next = addItemRow(form); onForm?.(updateItemRow(next, next.items[next.items.length - 1]!.rowId, { description: label })); } }}>{label}</button>)}
          </div>
          <p className={styles.totalLine}>Total <strong data-testid="form-total">{total === null ? '—' : formatMinor(total, currency)}</strong></p>
        </fieldset>

        <fieldset className={styles.panel} disabled={busy}><legend>Details</legend>
          <div className={styles.grid2}>
            <label className={styles.field}><span>Due date</span><input type="date" value={form.dueDate} onChange={(e) => onForm?.({ ...form, dueDate: e.target.value })}/></label>
            <span/>
            <label className={styles.field}><span>Your phone on the invoice (optional)</span><input value={form.payToPhone} maxLength={40} inputMode="tel" onChange={(e) => onForm?.({ ...form, payToPhone: e.target.value })}/></label>
            <label className={styles.field}><span>Your email on the invoice (optional)</span><input value={form.payToEmail} maxLength={200} inputMode="email" onChange={(e) => onForm?.({ ...form, payToEmail: e.target.value })}/></label>
          </div>
          <label className={styles.field}><span>Other ways to pay (optional)</span>
            <textarea rows={2} maxLength={500} value={form.otherWaysToPay} placeholder="e.g. Cash or check at the front desk" onChange={(e) => onForm?.({ ...form, otherWaysToPay: e.target.value })}/></label>
          <p className={styles.meta}>Online card payment in the HON parent app is listed automatically when your school takes card payments.</p>
          <label className={styles.field}><span>Note to the family (optional)</span>
            <textarea rows={2} maxLength={1000} value={form.note} onChange={(e) => onForm?.({ ...form, note: e.target.value })}/></label>
        </fieldset>
        <p className={styles.meta}><strong>Create invoice</strong> saves it and makes it visible to the family to pay. <strong>Save draft</strong> keeps it for later. Neither one charges a card or sends a message.</p>
      </div>
      <aside className={styles.previewCol} aria-label="Live preview"><p className={styles.eyebrow}>Preview</p>
        <InvoicePaper data={formPaper(form, payer, currency, schoolName)} preview/></aside>
    </div>
  </section>;
}

// ---------- View ----------
export type SendState = null | { channel: ComposeChannel; phase: 'EDIT' | 'SENDING'; text: string }
  | { channel: ComposeChannel; phase: 'DONE' } | { channel: ComposeChannel; phase: 'FAILED'; text: string; reason: string; retry: boolean };
export function InvoiceDetailView({ detail, flash, send, busy, onBack, onPrint, onSend, onSendText, onSendConfirm, onSendCancel, onIssue, issueProblem }: {
  detail: InvoiceDetail; flash?: string | undefined; send: SendState; busy: boolean; issueProblem?: string | null;
  onBack?: () => void; onPrint?: () => void; onSend?: (c: ComposeChannel) => void; onSendText?: (t: string) => void; onSendConfirm?: () => void; onSendCancel?: () => void; onIssue?: () => void;
}): React.ReactElement {
  const word = (c: ComposeChannel) => (c === 'EMAIL' ? 'email' : 'text');
  const noPerson = !detail.billTo.personId;
  return <section className={styles.page} aria-labelledby="invoice-title" data-testid="simple-invoice-view">
    <header className={`${styles.head} ${styles.noPrint}`}>
      <div><button type="button" className={styles.ghost} onClick={onBack}>← Invoices</button><h1 id="invoice-title">Invoice #{detail.number}</h1></div>
      <div className={styles.actions}>
        {detail.invoice.status === 'DRAFT' && detail.canIssue ? <button type="button" className={styles.primary} disabled={busy} onClick={onIssue}>Issue invoice</button> : null}
        <button type="button" className={styles.secondary} onClick={onPrint}>Print</button>
        <button type="button" className={styles.secondary} disabled={busy || noPerson} onClick={() => onSend?.('EMAIL')}>Email</button>
        <button type="button" className={styles.secondary} disabled={busy || noPerson} onClick={() => onSend?.('SMS')}>Text</button>
      </div>
    </header>
    {flash ? <p className={`${styles.flash} ${styles.noPrint}`} role="status">{flash}</p> : null}
    {issueProblem ? <p className={`${styles.error} ${styles.noPrint}`} role="alert">{issueProblem}</p> : null}
    {detail.invoice.status === 'DRAFT' ? <p className={`${styles.meta} ${styles.noPrint}`}>This is a draft: the family cannot see or pay it until it is issued.</p> : null}
    {send ? <div className={`${styles.panel} ${styles.noPrint}`} data-testid="send-panel">
      {send.phase === 'EDIT' || send.phase === 'SENDING' ? <>
        <label className={styles.field}><span>{send.channel === 'EMAIL' ? 'Email' : 'Text message'} to {detail.billTo.name ?? 'the payer'}{send.channel === 'EMAIL' ? (detail.billTo.email ? ` (${detail.billTo.email})` : '') : (detail.billTo.phone ? ` (${detail.billTo.phone})` : '')}</span>
          <textarea rows={send.channel === 'EMAIL' ? 12 : 4} value={send.text} maxLength={send.channel === 'EMAIL' ? 4000 : 1000} disabled={send.phase === 'SENDING'} onChange={(e) => onSendText?.(e.target.value)}/></label>
        <div className={styles.inline}><button type="button" className={styles.primary} disabled={send.phase === 'SENDING' || !send.text.trim()} onClick={onSendConfirm}>{send.phase === 'SENDING' ? 'Sending…' : `Send ${word(send.channel)}`}</button>
          <button type="button" className={styles.ghost} disabled={send.phase === 'SENDING'} onClick={onSendCancel}>Cancel</button></div>
        <p className={styles.meta}>The message goes out only if {detail.billTo.name ?? 'the payer'} agreed to receive {send.channel === 'EMAIL' ? 'emails' : 'texts'} from your school.</p>
      </> : send.phase === 'DONE' ? <><p className={styles.flash} role="status">The {word(send.channel)} is queued to {detail.billTo.name ?? 'the payer'}. It is sent where message delivery is switched on for your school.</p>
        <button type="button" className={styles.ghost} onClick={onSendCancel}>Close</button></>
      : send.phase === 'FAILED' ? <><p className={styles.error} role="alert">{send.reason}</p>
        <div className={styles.inline}>{send.retry ? <button type="button" className={styles.secondary} onClick={onSendConfirm}>Try again</button> : null}
          <button type="button" className={styles.ghost} onClick={onSendCancel}>Close</button></div></> : null}
    </div> : null}
    {noPerson ? <p className={`${styles.meta} ${styles.noPrint}`}>This invoice has no payer contact on file, so it can be printed but not emailed or texted.</p> : null}
    <InvoicePaper data={detailPaper(detail)}/>
  </section>;
}

export function sendFailureText(error: unknown, channel: ComposeChannel, name: string | null): { reason: string; retry: boolean } {
  const who = name ?? 'This payer';
  if (error instanceof ComposeRefusal) {
    if (error.reason === 'CONSENT') return { reason: `${who} has not agreed to receive ${channel === 'EMAIL' ? 'emails' : 'texts'} from your school, or has no ${channel === 'EMAIL' ? 'email address' : 'phone number'} on file. Nothing was sent.`, retry: false };
    if (error.reason === 'ACCESS') return { reason: 'Your access does not include sending messages at this school. Nothing was sent.', retry: false };
    if (error.reason === 'NOT_DRAFT') return { reason: 'This message was already queued. It will not be sent twice.', retry: false };
    return { reason: 'The message was not accepted. Nothing was sent.', retry: false };
  }
  return { reason: 'We could not confirm the message was queued. Try again repeats the same request, so it is never sent twice.', retry: true };
}

// ---------- Container ----------
export type MessageApi = { createDraft: typeof createDraft; queueDraft: typeof queueDraft };
export function SimpleInvoices({ scope: given, api = simpleInvoiceApi, listApi = invoiceListApi, messages = { createDraft, queueDraft }, schoolName = null }: {
  scope: SimpleInvoiceScope; api?: SimpleInvoiceApi; listApi?: InvoiceListApi; messages?: MessageApi; schoolName?: string | null;
}): React.ReactElement {
  const scope = useMemo(() => ({ organizationId: given.organizationId, schoolId: given.schoolId }), [given.organizationId, given.schoolId]);
  const [mode, setMode] = useState<InvoiceMode>({ kind: 'LIST' });
  const [status, setStatus] = useState<SchoolInvoiceListStatus>('ALL');
  const [list, setList] = useState<ListRead>({ state: 'LOADING' });
  const [listGen, setListGen] = useState(0);
  const gen = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gen.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => { gen.current++; setMode({ kind: 'LIST' }); setList({ state: 'LOADING' }); setListGen((n) => n + 1); },
    [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);
  const readList = useCallback((after: string | null) => {
    const current = ++gen.current, owned = () => mounted.current && current === gen.current;
    if (!after) setList({ state: 'LOADING' });
    listApi.list(scope, status, after, AbortSignal.timeout(15000), owned).then(
      (next) => { if (owned()) setList((prev) => ({ state: 'READY', read: next, items: after && prev.state === 'READY' ? [...prev.items, ...next.items] : next.items })); },
      (error) => { if (owned()) setList({ state: 'FAILED', denied: (error as { kind?: string })?.kind === 'DENIED' }); });
  }, [listApi, scope, status]);
  useEffect(() => { if (mode.kind === 'LIST') readList(null); }, [readList, mode.kind, listGen]);
  const today = list.state === 'READY' ? list.read.localToday : null;

  if (mode.kind === 'NEW') return <Builder scope={scope} api={api} schoolName={schoolName} today={today}
    onCancel={() => setMode({ kind: 'LIST' })} onDone={(detail, issued) => setMode({ kind: 'VIEW', invoiceId: detail.invoice.invoiceId,
      flash: issued ? 'Invoice created. The family can now see and pay it in the parent app. Use Email or Text to let them know.' : 'Draft saved. Issue it when it is ready.' })}/>;
  if (mode.kind === 'VIEW') return <Viewer key={mode.invoiceId} scope={scope} api={api} listApi={listApi} messages={messages} invoiceId={mode.invoiceId} flash={mode.flash}
    onBack={() => setMode({ kind: 'LIST' })}/>;
  return <InvoicesListView list={list} status={status} onStatus={setStatus} onNew={() => setMode({ kind: 'NEW' })}
    onOpen={(invoiceId) => setMode({ kind: 'VIEW', invoiceId })} onMore={() => list.state === 'READY' && list.read.nextAfter ? readList(list.read.nextAfter) : undefined}/>;
}

function Builder({ scope, api, schoolName, today, onCancel, onDone }: {
  scope: SimpleInvoiceScope; api: SimpleInvoiceApi; schoolName: string | null; today: string | null;
  onCancel: () => void; onDone: (detail: InvoiceDetail, issued: boolean) => void;
}): React.ReactElement {
  const [form, setForm] = useState<InvoiceForm>(() => emptyForm(today ? addDays(today, 14) : ''));
  const [payer, setPayer] = useState<PayerState>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<React.ComponentProps<typeof InvoiceBuilderView>['payerResults']>({ state: 'IDLE' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const [currency, setCurrency] = useState('USD');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // One key per payer for the account step and one kept request for the create step, so Try again never makes a second invoice.
  const accountKey = useRef<{ personId: string; key: string; account?: { billingAccountId: string; currency: string } } | null>(null);
  const pending = useRef<{ input: CreateSimpleInvoiceInput; key: string } | null>(null);

  const search = () => {
    setResults({ state: 'SEARCHING' });
    api.findPayers(scope, query).then((items) => { if (mounted.current) setResults({ state: 'DONE', items }); },
      (e) => { if (mounted.current) setResults({ state: 'FAILED', text: errorKind(e) === 'DENIED' ? ERROR_TEXT.DENIED : 'Search did not work just now. Try again.' }); });
  };
  const changeForm = (next: InvoiceForm) => { pending.current = null; setProblem(null); setForm(next); };
  const changePayer = (next: PayerState) => { pending.current = null; setProblem(null); setPayer(next); if (!next) { setResults({ state: 'IDLE' }); } };

  const submit = async (request: { input: CreateSimpleInvoiceInput; key: string }) => {
    setBusy(true); setProblem(null);
    try {
      const { detail } = await api.create(scope, request.input, request.key);
      pending.current = null;
      if (mounted.current) onDone(detail, request.input.issue);
    } catch (e) {
      const kind = errorKind(e);
      if (kind !== 'UNKNOWN') pending.current = null;
      if (mounted.current) setProblem({ text: ERROR_TEXT[kind], retry: kind === 'UNKNOWN' });
    } finally { if (mounted.current) setBusy(false); }
  };
  const save = async (issue: boolean) => {
    if (!payer) { setProblem({ text: 'Choose who pays (Bill to) first.', retry: false }); return; }
    setBusy(true); setProblem(null);
    try {
      if (accountKey.current?.personId !== payer.personId) accountKey.current = { personId: payer.personId, key: crypto.randomUUID() };
      const held = accountKey.current;
      const account = held.account ?? await api.payerAccount(scope, payer.personId, held.key);
      held.account = account;
      if (mounted.current) setCurrency(account.currency);
      const built = buildCreateInput(form, account.billingAccountId, account.currency, issue);
      if (!built.ok) { if (mounted.current) { setProblem({ text: FORM_PROBLEM_TEXT[built.problem], retry: false }); setBusy(false); } return; }
      pending.current = { input: built.input, key: crypto.randomUUID() };
    } catch (e) {
      if (mounted.current) { setProblem({ text: errorKind(e) === 'UNKNOWN' ? 'We could not confirm the payer’s billing account. Try saving again.' : ERROR_TEXT[errorKind(e)], retry: false }); setBusy(false); }
      return;
    }
    await submit(pending.current);
  };
  return <InvoiceBuilderView form={form} payer={payer} payerQuery={query} payerResults={results} currency={currency} schoolName={schoolName} busy={busy} problem={problem}
    onForm={changeForm} onPayerQuery={setQuery} onPayerSearch={search} onPayer={changePayer} onSave={(issue) => void save(issue)} onCancel={onCancel}
    onRetry={() => { if (pending.current) void submit(pending.current); }}/>;
}

function Viewer({ scope, api, listApi, messages, invoiceId, flash, onBack }: {
  scope: SimpleInvoiceScope; api: SimpleInvoiceApi; listApi: InvoiceListApi; messages: MessageApi; invoiceId: string; flash?: string | undefined; onBack: () => void;
}): React.ReactElement {
  const [read, setRead] = useState<{ state: 'LOADING' } | { state: 'FAILED'; kind: SimpleInvoiceErrorKind } | { state: 'READY'; detail: InvoiceDetail }>({ state: 'LOADING' });
  const [note, setNote] = useState<string | undefined>(flash);
  const [send, setSend] = useState<SendState>(null);
  const [busy, setBusy] = useState(false);
  const [issueProblem, setIssueProblem] = useState<string | null>(null);
  const mounted = useRef(true), sendKeys = useRef<{ draftKey: string; queueKey: string; draft?: { messageId: string; version: number } } | null>(null);
  const issueKey = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(() => {
    api.detail(scope, invoiceId).then((detail) => { if (mounted.current) setRead({ state: 'READY', detail }); },
      (e) => { if (mounted.current) setRead({ state: 'FAILED', kind: errorKind(e) }); });
  }, [api, scope, invoiceId]);
  useEffect(() => { load(); }, [load]);
  if (read.state !== 'READY') return <section className={styles.page}><button type="button" className={styles.ghost} onClick={onBack}>← Invoices</button>
    <p className={read.state === 'FAILED' ? styles.error : styles.meta} role="status">{read.state === 'LOADING' ? 'Loading invoice…' : ERROR_TEXT[read.kind]}</p></section>;
  const detail = read.detail;
  const parentUrl = typeof window !== 'undefined' && window.location?.origin ? `${window.location.origin}/parent/billing` : null;
  const startSend = (channel: ComposeChannel) => { sendKeys.current = { draftKey: crypto.randomUUID(), queueKey: crypto.randomUUID() }; setSend({ channel, phase: 'EDIT', text: invoiceMessage(detail, channel, parentUrl) }); };
  const confirmSend = async () => {
    if (!send || !detail.billTo.personId || !sendKeys.current) return;
    const channel = send.channel, text = 'text' in send ? send.text : '', keys = sendKeys.current;
    setSend({ channel, phase: 'SENDING', text });
    try {
      keys.draft ??= await messages.createDraft(scope, detail.billTo.personId, channel, text, keys.draftKey);
      await messages.queueDraft(scope, keys.draft, keys.queueKey);
      sendKeys.current = null;
      if (mounted.current) setSend({ channel, phase: 'DONE' });
    } catch (e) {
      const failure = sendFailureText(e, channel, detail.billTo.name);
      if (!failure.retry) sendKeys.current = null;
      if (mounted.current) setSend({ channel, phase: 'FAILED', text, ...failure });
    }
  };
  const issue = async () => {
    setBusy(true); setIssueProblem(null);
    issueKey.current ??= crypto.randomUUID();
    try {
      await listApi.issue(scope, { invoiceId: detail.invoice.invoiceId, version: detail.invoice.version }, issueKey.current, AbortSignal.timeout(15000), () => mounted.current);
      issueKey.current = null;
      if (mounted.current) { setNote('Invoice issued. The family can now see and pay it in the parent app.'); load(); }
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      if (kind !== 'UNKNOWN') issueKey.current = null;
      if (mounted.current) { setIssueProblem(kind === 'CHANGED' ? 'This invoice changed since it was shown (it may already be issued). It was read again.' : kind === 'DENIED' ? ERROR_TEXT.DENIED
        : kind === 'UNKNOWN' ? 'We could not confirm the invoice was issued. Press Issue again; it repeats the same request.' : ERROR_TEXT.INVALID); if (kind === 'CHANGED') load(); }
    } finally { if (mounted.current) setBusy(false); }
  };
  return <>
    <style>{'@media print { body * { visibility: hidden !important; } [data-invoice-paper], [data-invoice-paper] * { visibility: visible !important; } [data-invoice-paper] { position: absolute; inset: 0 auto auto 0; width: 100%; box-shadow: none !important; border: 0 !important; } }'}</style>
    <InvoiceDetailView detail={detail} flash={note} send={send} busy={busy} issueProblem={issueProblem} onBack={onBack} onPrint={() => window.print()}
      onSend={startSend} onSendText={(text) => setSend((s) => (s && s.phase === 'EDIT' ? { ...s, text } : s))} onSendConfirm={() => void confirmSend()}
      onSendCancel={() => { sendKeys.current = null; setSend(null); }} onIssue={() => void issue()}/>
  </>;
}
