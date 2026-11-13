import React from 'react';
import { TUITION_PAYMENT_METHODS, type InvoiceBalance, type InvoicePayments, type ReceivablesFilter, type SchoolReceivables, type TuitionPayment, type TuitionPaymentMethod } from '@hon/contracts';
import { money } from '../membership-changes/http';
import type { TuitionErrorKind } from './http';
import styles from '../membership-changes/membership-changes.module.css';

export const TUITION_FILTERS: readonly ReceivablesFilter[] = ['OPEN', 'OVERDUE'];
export type TuitionForm = null | Readonly<{ kind: 'record' }> | Readonly<{ kind: 'void'; paymentId: string }>;
export type TuitionAction = 'record' | 'void';
export type ReceivablesState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'TIMEZONE' }
  | { state: 'READY'; read: SchoolReceivables; items: readonly InvoiceBalance[]; nextAfter: string | null; more: 'IDLE' | 'LOADING' | 'FAILED' };
export type DetailState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; read: InvoicePayments };
export type TuitionOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | TuitionErrorKind; action: TuitionAction }>;
export type TuitionFields = Readonly<Record<string, string>>;

export type TuitionPaymentsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ReceivablesState; filter: ReceivablesFilter; selected: string | null; detail: DetailState;
  form: TuitionForm; outcome: TuitionOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onFilter?: ((filter: ReceivablesFilter) => void) | undefined; onSelect?: ((invoiceId: string | null) => void) | undefined;
  onMore?: (() => void) | undefined; onOpen?: ((form: TuitionForm) => void) | undefined; onClose?: (() => void) | undefined;
  onSubmit?: ((action: TuitionAction, fields: TuitionFields) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const METHOD_LABEL: Record<TuitionPaymentMethod, string> = { CASH: 'Cash', CHECK: 'Check', CARD_TERMINAL: 'Card terminal', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' };
const FILTER_LABEL: Record<ReceivablesFilter, string> = { OPEN: 'All unpaid', OVERDUE: 'Overdue' };
const OUTCOME_TEXT: Record<NonNullable<TuitionOutcome>['kind'], string> = {
  SENDING: 'Saving. Keep this page open.',
  DONE: 'Saved. The balances below were read again from the server.',
  SESSION: 'Your session ended. Sign in again; nothing was saved by this page after that.',
  DENIED: 'You are not allowed to record tuition payments at this school. Nothing changed.',
  GONE: 'That invoice or payment is not available at this school. Nothing changed.',
  CHANGED: 'The invoice changed since it was shown. Nothing changed; check the fresh balance and try again.',
  NOT_PAYABLE: 'Payments can be recorded only against an issued invoice that still has a balance. Nothing changed.',
  CURRENCY: 'The payment currency must match the invoice currency. Nothing changed.',
  EXCEEDS: 'That is more than what is left to pay on this invoice. Nothing changed.',
  ALREADY_VOIDED: 'This payment was already voided. Nothing changed.',
  TIMEZONE: 'The school time zone is not set correctly, so dates cannot be checked. Nothing changed.',
  INVALID: 'Check the details: a positive amount in the invoice currency, a date that is not in the future, and a short reason for a void.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so it can never be recorded twice.',
};
// School-local calendar dates are shown as dates, never shifted by the viewer's time zone.
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
function fieldsOf(form: HTMLFormElement): TuitionFields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = value;
  return out;
}

function Balances({ p }: { p: TuitionPaymentsViewProps }) {
  const list = p.list;
  return <article className={styles.card} aria-labelledby="receivables-title" data-testid="receivables">
    <div className={styles.cardHead}><h2 id="receivables-title">Unpaid balances</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>Refresh</button></div>
    <div className={styles.tabs} role="group" aria-label="Show">
      {TUITION_FILTERS.map((f) => <button key={f} type="button" className={styles.tab} aria-pressed={p.filter === f} disabled={p.locked} onClick={() => p.onFilter?.(f)}>{FILTER_LABEL[f]}</button>)}
    </div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading unpaid balances…</p>
      : list.state === 'DENIED' ? <p className={styles.meta} role="status">You need a tuition payment, invoice issue or invoice create permission at this school to see balances.</p>
      : list.state === 'TIMEZONE' ? <p className={styles.meta} role="status">The school time zone is not set correctly, so balances cannot be shown.</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="status">Balances are not available right now. Nothing changed.</p>
      : <>
        <p className={styles.meta} data-testid="receivables-totals">{list.read.totals.length === 0 ? (p.filter === 'OVERDUE' ? 'Nothing is overdue.' : 'Nothing is unpaid.')
          : list.read.totals.map((t) => `${money(p.language, t.balanceMinor, t.currency)} across ${t.count} ${t.count === 1 ? 'invoice' : 'invoices'}`).join(' · ')}</p>
        <ul className={styles.list}>
          {list.items.map((i) => <li key={i.invoiceId}>
            <button type="button" className={styles.secondary} aria-pressed={p.selected === i.invoiceId} disabled={p.locked} onClick={() => p.onSelect?.(i.invoiceId)}>
              {i.payerName ?? 'Payer not visible'}: {money(p.language, i.balanceMinor, i.currency)} left of {money(p.language, i.totalMinor, i.currency)}
              {i.dueAt ? ` · due ${instant(p.language, i.dueAt)}` : ' · no due date'}{i.overdue ? ' · overdue' : ''}
            </button>
          </li>)}
        </ul>
        {list.nextAfter ? <button type="button" className={styles.secondary} disabled={p.locked || list.more === 'LOADING'} onClick={p.onMore}>
          {list.more === 'LOADING' ? 'Loading…' : list.more === 'FAILED' ? 'Could not load more. Try again' : 'Show more'}</button> : null}
      </>}
  </article>;
}

function Payment({ p, payment, read }: { p: TuitionPaymentsViewProps; payment: TuitionPayment; read: InvoicePayments }) {
  const voiding = p.form?.kind === 'void' && p.form.paymentId === payment.paymentId;
  return <li data-testid="tuition-payment">
    <p>{money(p.language, payment.amountMinor, payment.currency)} · {METHOD_LABEL[payment.method]} · received {day(p.language, payment.receivedOn)}
      {payment.reference ? ` · ref ${payment.reference}` : ''}{payment.void ? ' · voided' : ''}</p>
    {payment.note ? <p className={styles.meta}>{payment.note}</p> : null}
    {payment.void ? <p className={styles.meta}>Voided {instant(p.language, payment.void.voidedAt)}: {payment.void.reason}</p> : null}
    {!payment.void && read.canRecord && !voiding ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'void', paymentId: payment.paymentId })}>Void this payment</button> : null}
    {voiding ? <form className={`${styles.form} ${styles.danger}`} data-testid="void-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.('void', fieldsOf(e.currentTarget)); }}>
      <label className={styles.field}>Why is it being voided?<textarea name="reason" rows={2} maxLength={1000} required/></label>
      <p className={styles.meta}>The payment stays on record as voided. This does not refund anyone; return money outside HON if needed.</p>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>Void payment</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Close</button></div>
    </form> : null}
  </li>;
}

function Detail({ p }: { p: TuitionPaymentsViewProps }) {
  if (!p.selected) return null;
  const d = p.detail;
  const read = d.state === 'READY' && d.read.invoice.invoiceId === p.selected ? d.read : null;
  const invoice = read?.invoice;
  return <article className={styles.card} aria-labelledby="invoice-title" data-testid="invoice-detail">
    <div className={styles.cardHead}><h2 id="invoice-title">{invoice ? `${invoice.payerName ?? 'Payer not visible'}: invoice` : 'Invoice'}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onSelect?.(null)}>Close</button></div>
    {d.state === 'LOADING' ? <p className={styles.meta} role="status">Reading the invoice…</p>
      : d.state === 'DENIED' ? <p className={styles.meta} role="status">You are not allowed to see this invoice.</p>
      : d.state === 'GONE' ? <p className={styles.meta} role="status">This invoice is not available at this school.</p>
      : !read || !invoice ? <p className={styles.meta} role="status">The invoice is not available right now.</p>
      : <>
        <p data-testid="invoice-balance">{invoice.status === 'PAID' ? 'Paid in full' : `${money(p.language, invoice.balanceMinor, invoice.currency)} left to pay`} · total {money(p.language, invoice.totalMinor, invoice.currency)}
          · paid {money(p.language, invoice.paidMinor, invoice.currency)}{invoice.overdue ? ' · overdue' : ''}</p>
        {read.canRecord && invoice.status === 'ISSUED' && invoice.balanceMinor > 0 && p.form?.kind !== 'record'
          ? <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'record' })}>Record a payment</button> : null}
        {!read.canRecord ? <p className={styles.meta}>You can see balances. Recording a payment needs the tuition payment permission.</p> : null}
        {p.form?.kind === 'record' ? <form className={styles.form} data-testid="record-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.('record', fieldsOf(e.currentTarget)); }}>
          <div className={styles.grid}>
            <label className={styles.field}>Amount ({invoice.currency})<input type="text" inputMode="decimal" name="amount" autoComplete="off" required/></label>
            <label className={styles.field}>Received on<input type="date" name="receivedOn" max={read.localToday} defaultValue={read.localToday} required/></label>
            <label className={styles.field}>Method<select name="method" defaultValue="CASH">{TUITION_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></label>
            <label className={styles.field}>Reference (optional)<input type="text" name="reference" maxLength={120} autoComplete="off"/></label>
          </div>
          <label className={styles.field}>Note (optional)<textarea name="note" rows={2} maxLength={1000}/></label>
          <p className={styles.meta}>Record money the school already received outside HON. HON does not charge the card or move money. Partial payments are fine; more than the balance is refused.</p>
          <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>Save payment</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Close</button></div>
        </form> : null}
        <h3>Recorded payments</h3>
        {read.payments.length === 0 ? <p className={styles.meta}>No payments recorded in HON for this invoice.</p>
          : <ul className={styles.list}>{read.payments.map((payment) => <Payment key={payment.paymentId} p={p} payment={payment} read={read}/>)}</ul>}
      </>}
  </article>;
}

/** The tuition payments page body: pure, every state comes from props. */
export function TuitionPaymentsView(p: TuitionPaymentsViewProps): React.ReactElement {
  return <section className={styles.page} aria-labelledby="tuition-title">
    <header className={styles.head}><div>
      <h1 id="tuition-title">Tuition balances</h1>
      <p className={styles.intro}>See what families still owe on issued invoices and record payments the school received in person, by check, card terminal or bank transfer. HON moves no money.</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">Hidden while this tab was in the background. Return to the page to show it again.</p>
      : p.waiting ? <p className={styles.notice} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">Choose a school to see its tuition balances.</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${p.outcome.kind === 'DONE' || p.outcome.kind === 'SENDING' ? '' : styles.warn}`} role="status" data-testid="tuition-outcome">
          <p>{OUTCOME_TEXT[p.outcome.kind]}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        <Balances p={p}/>
        <Detail p={p}/>
      </>}
  </section>;
}
