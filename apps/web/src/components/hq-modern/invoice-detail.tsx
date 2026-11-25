'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { saasUuid } from '@hon/contracts';
import { loadHqInvoiceAccount, loadHqInvoiceRefunds, type InvoiceAccountReview, type InvoiceRefundReview } from './invoice-history-http';
import { useInvoiceRead, InvoiceReadNotice, invoiceAmount, invoiceTime, invoiceOffer, invoiceStatus, settlementLabel } from './invoice-history-shared';
import { subscriptionStatus } from './saas-review';
import base from './hq-modern.module.css';
import shared from './champions-management.module.css';
import styles from './invoice-history.module.css';

const lineLabel = { PLAN_FEE: 'Plan fee', DISCOUNT: 'Discount', CORRECTION: 'Correction', TAX: 'Tax', ACCOUNT_CREDIT: 'Subscription account-credit adjustment' };
const evidenceLabel = { PAYMENT_RECEIVED: 'Payment received (recorded)', REFUND: 'Refund — recorded evidence', CHARGEBACK: 'Chargeback (recorded)' };
const refusalLabel = {
  SAAS_REFUND_NO_PAID_PURCHASE: 'No recorded paid purchase', SAAS_REFUND_ALREADY_GRANTED: 'Guarantee already granted in records',
  SAAS_REFUND_REQUEST_OPEN: 'A refund request is open', SAAS_REFUND_BEFORE_PAYMENT: 'Asked before the first payment',
  SAAS_REFUND_WINDOW_EXPIRED: 'First-purchase window expired', SAAS_REFUND_NOTHING_TO_REFUND: 'No recorded amount remains refundable',
};
const refundStatus = { REQUESTED: 'Requested', APPROVED: 'Approved · not sent yet', DENIED: 'Denied', REFUND_EVIDENCED: 'Refund recorded · HON didn’t send it' };

export function InvoiceDetailResults({ data }: { data: InvoiceAccountReview }): React.ReactElement {
  const { invoice, account, standing } = data;
  return <div className={shared.results} data-invoice-detail={invoice.invoiceId}>
    <section className={base.panel}><div className={base.sectionHeader}><h2>{invoice.invoiceNumber ?? (invoice.status === 'VOID' ? 'Unnumbered void record' : 'Unnumbered draft record')}</h2><span className={base.badge}>{invoiceStatus[invoice.status]}</span></div>
      <p dir="auto"><strong>{invoice.organizationName}</strong></p><p className={styles.amount}>Recorded total: {invoiceAmount(invoice.totalMinor)}</p><p>{invoice.description}</p>
      <dl className={`${shared.facts} ${styles.identity}`}>
        <div><dt>Recorded commercial terms</dt><dd>{invoice.planCode} · {invoiceOffer[invoice.offerKind]}<small>{invoice.kind === 'LIFETIME_PURCHASE' ? 'One-time lifetime purchase, not a monthly payment.' : `Subscription period ${invoice.periodIndex}. Founder terms remain as recorded.`}</small></dd></div>
        <div><dt>Service period</dt><dd>{invoiceTime(invoice.servicePeriod.startsAt)} – {invoice.kind === 'LIFETIME_PURCHASE' ? 'No recorded service end' : invoiceTime(invoice.servicePeriod.endsAt)}</dd></div>
        <div><dt>Issued / voided</dt><dd>{invoiceTime(invoice.issuedAt)} / {invoiceTime(invoice.voidedAt)}<small>{invoice.voidReason?.replaceAll('_', ' ') ?? 'No void reason recorded'}</small></dd></div>
        <div><dt>Delivery / collection</dt><dd>Not sent / disabled</dd></div><div><dt>Record version / updated</dt><dd>{invoice.version} · {invoiceTime(invoice.updatedAt)}</dd></div>
      </dl>
      <details className={styles.identifiers}><summary>Record identifiers</summary><dl className={`${shared.facts} ${styles.identity}`}><div><dt>Invoice ID</dt><dd>{invoice.invoiceId}</dd></div><div><dt>Billing organization ID</dt><dd>{invoice.organizationId}</dd></div><div><dt>Invoice subscription ID</dt><dd>{invoice.subscriptionId}</dd></div></dl></details>
    </section>
    <section className={base.panel}><h2>Invoice lines and totals</h2><p className={shared.note}>A credit lowers the invoice; it isn’t a cash payment or refund. Tax details are below.</p>
      <ol className={styles.records}>{invoice.lines.map((line) => <li key={line.lineNumber}><h3>{line.lineNumber}. {lineLabel[line.lineKind]}</h3><p>{line.description}</p><p className={styles.amount}>{invoiceAmount(line.amountMinor)}</p>{line.reference && <p className={shared.note}>Reference: {line.reference}</p>}</li>)}</ol>
      <dl className={shared.facts}><div><dt>Recorded subtotal</dt><dd>{invoiceAmount(invoice.subtotalMinor)}</dd></div><div><dt>Tax treatment</dt><dd>{invoice.taxStatus.replaceAll('_', ' ')}<small>{invoice.taxVerificationReference ?? 'No tax reference saved'}</small></dd></div><div><dt>Recorded tax</dt><dd>{invoiceAmount(invoice.taxMinor)}</dd></div><div><dt>Recorded invoice total</dt><dd>{invoiceAmount(invoice.totalMinor)}</dd></div></dl>
    </section>
    <section className={base.panel}><h2>Recorded settlement</h2><p>{settlementLabel[invoice.settlement.state]}</p><p className={shared.note}>These are what HQ recorded, not confirmed by the card processor. Nothing here sends a refund.</p>
      <dl className={shared.facts}>{([
        ['Payments in recorded evidence', invoice.settlement.receivedMinor], ['Refunds in recorded evidence', invoice.settlement.refundedMinor],
        ['Chargebacks recorded', invoice.settlement.chargedBackMinor], ['Recorded net', invoice.settlement.netMinor],
        ['Provider-verified net', invoice.settlement.verifiedNetMinor], ['Recorded balance', invoice.settlement.balanceMinor],
      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null ? 'Doesn’t apply to a draft or void invoice' : invoiceAmount(value)}</dd></div>)}</dl>
    </section>
    <section className={base.panel} data-payment-evidence><h2>Payment-evidence history</h2><p className={shared.note}>Payments HQ recorded for this invoice. Not confirmed by the card processor.</p>
      {!invoice.evidence.length && <p>No payments recorded for this invoice yet.</p>}
      <ul className={styles.records}>{invoice.evidence.map((entry) => <li key={entry.evidenceId}><h3>{evidenceLabel[entry.kind]}</h3><p className={styles.amount}>{invoiceAmount(entry.amountMinor)}</p><dl className={`${shared.facts} ${styles.identity}`}><div><dt>Evidence ID</dt><dd>{entry.evidenceId}</dd></div><div><dt>Evidence strength</dt><dd>Recorded by HQ · not confirmed by processor</dd></div><div><dt>Occurred / recorded</dt><dd>{invoiceTime(entry.occurredAt)} / {invoiceTime(entry.recordedAt)}</dd></div><div><dt>External reference</dt><dd>{entry.reference}</dd></div>{entry.relatedEvidenceId && <div><dt>Reverses payment evidence</dt><dd>{entry.relatedEvidenceId}</dd></div>}{entry.note && <div><dt>Recorded note</dt><dd>{entry.note}</dd></div>}</dl></li>)}</ul>
    </section>
    <section className={base.panel}><h2>This business’s subscription history</h2><p className={shared.note}>The latest 50 changes for this business (it can own several schools). The invoice above keeps its original terms.</p>
      <dl className={`${shared.facts} ${styles.identity}`}><div><dt>Current subscription</dt><dd>{account.current ? `${account.current.planCode} · ${subscriptionStatus[account.current.status]}` : 'No current subscription'}<small>{account.current?.subscriptionId ?? 'None returned'}</small></dd></div><div><dt>Invoice and current subscription</dt><dd>{account.current?.subscriptionId === invoice.subscriptionId ? 'Same subscription record' : 'This invoice is for an older subscription'}</dd></div><div><dt>What the business can use now</dt><dd>{account.entitlement ? `${account.entitlement.tier} · ${account.entitlement.status}` : 'No entitlement record'} · {account.alignment.replaceAll('_', ' ')}</dd></div><div><dt>Paid invoices (recorded / confirmed)</dt><dd>{standing.recorded.paidInvoiceCount.toLocaleString('en-US')} / {standing.verified.paidInvoiceCount.toLocaleString('en-US')}<small>For the whole business.</small></dd></div></dl>
      {!account.history.length && <p>No changes yet.</p>}<ul className={styles.records}>{account.history.map((event, index) => <li key={`${event.subscriptionId}:${event.version}:${index}`}><h3>{subscriptionStatus[event.status]} · {event.statusReason.replaceAll('_', ' ')}</h3><p>{invoiceTime(event.occurredAt)}</p><p className={`${shared.note} ${styles.identity}`}>Subscription {event.subscriptionId} · version {event.version}{event.periodIndex === null ? '' : ` · period ${event.periodIndex}`}</p>{event.periodStartsAt && <p className={shared.note}>{invoiceTime(event.periodStartsAt)} – {event.periodEndsAt ? invoiceTime(event.periodEndsAt) : 'No recorded period end'}</p>}</li>)}</ul>
    </section>
  </div>;
}

export function InvoiceRefundResults({ data, invoiceId }: { data: InvoiceRefundReview; invoiceId: string }): React.ReactElement {
  const eligibility = data.eligibility;
  return <div className={shared.results} data-invoice-refunds>
    <section className={base.panel}><h2>30-day refund</h2><p>{eligibility.eligible ? 'Can be refunded · nothing sent from this page' : refusalLabel[eligibility.refusal!]}</p>
      <p className={shared.note}>The 30-day refund applies to a business’s first purchase only. Checking here doesn’t start or send a refund.</p>
      <dl className={`${shared.facts} ${styles.identity}`}><div><dt>Preview request instant</dt><dd>{invoiceTime(eligibility.requestReceivedAt)}</dd></div><div><dt>First purchase invoice</dt><dd>{eligibility.invoiceNumber ?? 'No recorded paid purchase'}<small>{eligibility.invoiceId === null ? 'No purchase returned' : eligibility.invoiceId === invoiceId ? 'This invoice' : 'Another invoice started the 30 days; this one doesn’t restart it'}</small></dd></div><div><dt>First payment / refund window ends</dt><dd>{invoiceTime(eligibility.firstPaidAt)} / {invoiceTime(eligibility.windowEndsAt)}</dd></div><div><dt>Recorded refundable amount</dt><dd>{invoiceAmount(eligibility.refundableMinor)}<small>{eligibility.evidenceStrength === null ? 'No paid-purchase evidence' : 'Recorded by HQ · not confirmed by processor'}</small></dd></div><div><dt>Refund execution</dt><dd>Unavailable</dd></div></dl>
    </section>
    <section className={base.panel}><h2>Refund requests</h2><p className={shared.note}>From the latest 200 refund requests. Older ones may not show.</p>
      {!data.matchingRequests.length && <p>No refund requests found.</p>}
      <ul className={styles.records}>{data.matchingRequests.map((request) => <li key={request.refundRequestId}><h3>{refundStatus[request.status]}</h3><p>{request.statusReason.replaceAll('_', ' ')}</p><dl className={shared.facts}><div><dt>Asked / recorded</dt><dd>{invoiceTime(request.requestReceivedAt)} / {invoiceTime(request.createdAt)}</dd></div><div><dt>Requested amount</dt><dd>{invoiceAmount(request.requestedAmountMinor)}</dd></div><div><dt>Approved amount</dt><dd>{request.approvedAmountMinor === null ? 'Not approved' : invoiceAmount(request.approvedAmountMinor)}</dd></div><div><dt>Recorded refund evidence</dt><dd>{invoiceAmount(request.refundEvidencedMinor)}</dd></div><div><dt>Customer reference</dt><dd>{request.customerReference}</dd></div><div><dt>What happened</dt><dd>Not sent yet</dd></div></dl></li>)}</ul>
    </section>
  </div>;
}

export function HqInvoiceDetail({ invoiceId }: { invoiceId: string }): React.ReactElement {
  let valid = true; try { saasUuid(invoiceId); } catch { valid = false; }
  const [selection, setSelection] = useState<{ invoiceId: string; revision: number } | null>(null);
  const active = valid && selection?.invoiceId === invoiceId;
  const key = `${invoiceId}:${selection?.revision ?? 0}`;
  const load = useCallback((signal: AbortSignal) => loadHqInvoiceAccount(invoiceId, signal), [invoiceId]);
  const state = useInvoiceRead(key, active ? load : null);
  const invoice = state.kind === 'ready' ? state.data.invoice : null;
  const loadRefunds = useCallback((signal: AbortSignal) => loadHqInvoiceRefunds(invoice!, signal), [invoice]);
  const refunds = useInvoiceRead(`${key}:${state.kind}`, invoice ? loadRefunds : null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (state.kind === 'ready') { resultHeading.current?.focus(); resultHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); } }, [state.kind, key]);
  return <div className={shared.management}>
    <section className={`${base.panel} ${shared.intro}`}><span className={base.badge}>Invoices · HQ only</span><h2>Invoice and payments</h2><p>Press the button to load this invoice.</p><div className={styles.links}><Link className={shared.link} href="/hq/revenue/invoices">← Invoice list</Link><Link className={shared.link} href="/hq/revenue">Subscription account review</Link></div>
      {!valid ? <p role="status">This invoice link isn’t valid. Pick one from the invoice list.</p> : <button type="button" disabled={state.kind === 'loading'} onClick={() => setSelection((current) => ({ invoiceId, revision: (current?.revision ?? 0) + 1 }))}>{active ? 'Refresh invoice records' : 'Load invoice'}</button>}
      {!active && valid && <p className={shared.note}>Nothing loaded yet.</p>}
    </section>
    <div className={shared.results} aria-live="polite" aria-busy={state.kind === 'loading'}><InvoiceReadNotice state={state} area="Invoice records"/>{state.kind === 'ready' && <><h2 className={styles.focusHeading} ref={resultHeading} tabIndex={-1}>Verified invoice records</h2><p className={shared.note} role="status">Retrieved {invoiceTime(state.retrievedAt)} · separate reads, not an atomic snapshot; refresh to recheck.</p><InvoiceDetailResults data={state.data}/></>}</div>
    <div className={shared.results} aria-live="polite" aria-busy={refunds.kind === 'loading'}><InvoiceReadNotice state={refunds} area="Refund review"/>{refunds.kind === 'ready' && <><p className={shared.note} role="status">Refund review retrieved {invoiceTime(refunds.retrievedAt)} · separately authorized current reads.</p><InvoiceRefundResults data={refunds.data} invoiceId={invoiceId}/></>}</div>
    <section className={base.panel}><h2>Read-only financial records</h2><p className={shared.note}>View only: nothing here charges, refunds or changes a plan. Family tuition is separate.</p></section>
  </div>;
}
