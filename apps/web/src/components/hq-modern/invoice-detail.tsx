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
const evidenceLabel = { PAYMENT_RECEIVED: 'Payment received — recorded evidence', REFUND: 'Refund — recorded evidence', CHARGEBACK: 'Chargeback — recorded evidence' };
const refusalLabel = {
  SAAS_REFUND_NO_PAID_PURCHASE: 'No recorded paid purchase', SAAS_REFUND_ALREADY_GRANTED: 'Guarantee already granted in records',
  SAAS_REFUND_REQUEST_OPEN: 'A refund request is open', SAAS_REFUND_BEFORE_PAYMENT: 'Request instant precedes first payment',
  SAAS_REFUND_WINDOW_EXPIRED: 'First-purchase window expired', SAAS_REFUND_NOTHING_TO_REFUND: 'No recorded amount remains refundable',
};
const refundStatus = { REQUESTED: 'Requested', APPROVED: 'Approved record · not executed', DENIED: 'Denied', REFUND_EVIDENCED: 'Refund evidence recorded · not executed by HON' };

export function InvoiceDetailResults({ data }: { data: InvoiceAccountReview }): React.ReactElement {
  const { invoice, account, standing } = data;
  return <div className={shared.results} data-invoice-detail={invoice.invoiceId}>
    <section className={base.panel}><div className={base.sectionHeader}><h2>{invoice.invoiceNumber ?? 'Unnumbered draft record'}</h2><span className={base.badge}>{invoiceStatus[invoice.status]}</span></div>
      <p dir="auto"><strong>{invoice.organizationName}</strong></p><p>{invoice.description}</p>
      <dl className={`${shared.facts} ${styles.identity}`}>
        <div><dt>Invoice ID</dt><dd>{invoice.invoiceId}</dd></div><div><dt>Billing organization ID</dt><dd>{invoice.organizationId}</dd></div><div><dt>Invoice subscription ID</dt><dd>{invoice.subscriptionId}</dd></div>
        <div><dt>Recorded commercial terms</dt><dd>{invoice.planCode} · {invoiceOffer[invoice.offerKind]}<small>{invoice.kind === 'LIFETIME_PURCHASE' ? 'One-time paid-lifetime offer. Not monthly recurring revenue or proof of payment.' : `Subscription period ${invoice.periodIndex}. Founder terms remain as recorded.`}</small></dd></div>
        <div><dt>Service period</dt><dd>{invoiceTime(invoice.servicePeriod.startsAt)} – {invoice.kind === 'LIFETIME_PURCHASE' ? 'No recorded service end' : invoiceTime(invoice.servicePeriod.endsAt)}</dd></div>
        <div><dt>Issued / voided</dt><dd>{invoiceTime(invoice.issuedAt)} / {invoiceTime(invoice.voidedAt)}<small>{invoice.voidReason?.replaceAll('_', ' ') ?? 'No void reason recorded'}</small></dd></div>
        <div><dt>Delivery / collection</dt><dd>Not sent / disabled</dd></div><div><dt>Record version / updated</dt><dd>{invoice.version} · {invoiceTime(invoice.updatedAt)}</dd></div>
      </dl>
    </section>
    <section className={base.panel}><h2>Invoice lines &amp; recorded totals</h2><p className={shared.note}>Amounts and totals come from HON's invoice record. A credit adjustment reduces an invoice; it is not a cash payment or refund. No rate, tax, discount or balance is calculated here.</p>
      <ol className={styles.records}>{invoice.lines.map((line) => <li key={line.lineNumber}><h3>{line.lineNumber}. {lineLabel[line.lineKind]}</h3><p>{line.description}</p><p className={styles.amount}>{invoiceAmount(line.amountMinor)}</p>{line.reference && <p className={shared.note}>Reference: {line.reference}</p>}</li>)}</ol>
      <dl className={shared.facts}><div><dt>Recorded subtotal</dt><dd>{invoiceAmount(invoice.subtotalMinor)}</dd></div><div><dt>Tax treatment</dt><dd>{invoice.taxStatus.replaceAll('_', ' ')}<small>{invoice.taxVerificationReference ?? 'No tax verification reference recorded'}</small></dd></div><div><dt>Recorded tax</dt><dd>{invoiceAmount(invoice.taxMinor)}</dd></div><div><dt>Recorded invoice total</dt><dd>{invoiceAmount(invoice.totalMinor)}</dd></div></dl>
    </section>
    <section className={base.panel}><h2>Recorded settlement</h2><p>{settlementLabel[invoice.settlement.state]}</p><p className={shared.note}>HQ attestation is not processor confirmation. Recorded reversals are evidence, not a refund executed by this interface. Provider verification is not configured.</p>
      <dl className={shared.facts}>{([
        ['Payments in recorded evidence', invoice.settlement.receivedMinor], ['Refunds in recorded evidence', invoice.settlement.refundedMinor],
        ['Chargebacks in recorded evidence', invoice.settlement.chargedBackMinor], ['Recorded net', invoice.settlement.netMinor],
        ['Provider-verified net', invoice.settlement.verifiedNetMinor], ['Recorded balance', invoice.settlement.balanceMinor],
      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{invoiceAmount(value)}</dd></div>)}</dl>
    </section>
    <section className={base.panel} data-payment-evidence><h2>Payment-evidence history</h2><p className={shared.note}>Evidence returned for this invoice. Every entry is an HQ attestation, not processor-verified. These records do not collect money, execute refunds or qualify Champions referrals.</p>
      {!invoice.evidence.length && <p>No payment-evidence entries were returned for this invoice. Its settlement state is reported above.</p>}
      <ul className={styles.records}>{invoice.evidence.map((entry) => <li key={entry.evidenceId}><h3>{evidenceLabel[entry.kind]}</h3><p className={styles.amount}>{invoiceAmount(entry.amountMinor)}</p><dl className={`${shared.facts} ${styles.identity}`}><div><dt>Evidence ID</dt><dd>{entry.evidenceId}</dd></div><div><dt>Evidence strength</dt><dd>HQ attestation · not provider-verified</dd></div><div><dt>Occurred / recorded</dt><dd>{invoiceTime(entry.occurredAt)} / {invoiceTime(entry.recordedAt)}</dd></div><div><dt>External reference</dt><dd>{entry.reference}</dd></div>{entry.relatedEvidenceId && <div><dt>Reverses payment evidence</dt><dd>{entry.relatedEvidenceId}</dd></div>}{entry.note && <div><dt>Recorded note</dt><dd>{entry.note}</dd></div>}</dl></li>)}</ul>
    </section>
    <section className={base.panel}><h2>Organization subscription history</h2><p className={shared.note}>Organization records may cover multiple schools. Newest 50 status events at most, across its subscriptions; this is not complete school or plan-change history. Historical invoice terms above are never replaced with today's terms.</p>
      <dl className={`${shared.facts} ${styles.identity}`}><div><dt>Current organization subscription</dt><dd>{account.current ? `${account.current.planCode} · ${subscriptionStatus[account.current.status]}` : 'No current subscription'}<small>{account.current?.subscriptionId ?? 'None returned'}</small></dd></div><div><dt>Invoice and current subscription</dt><dd>{account.current?.subscriptionId === invoice.subscriptionId ? 'Same subscription record' : 'Invoice is not the current subscription record'}</dd></div><div><dt>Current entitlement / alignment</dt><dd>{account.entitlement ? `${account.entitlement.tier} · ${account.entitlement.status}` : 'No entitlement record'} · {account.alignment.replaceAll('_', ' ')}</dd></div><div><dt>Organization recorded / verified paid-invoice counts</dt><dd>{standing.recorded.paidInvoiceCount.toLocaleString('en-US')} / {standing.verified.paidInvoiceCount.toLocaleString('en-US')}<small>Authoritative organization standing, not counts derived from this invoice or the list window.</small></dd></div></dl>
      {!account.history.length && <p>No subscription status-history events were returned.</p>}<ul className={styles.records}>{account.history.map((event, index) => <li key={`${event.subscriptionId}:${event.version}:${index}`}><h3>{subscriptionStatus[event.status]} · {event.statusReason.replaceAll('_', ' ')}</h3><p>{invoiceTime(event.occurredAt)}</p><p className={`${shared.note} ${styles.identity}`}>Subscription {event.subscriptionId} · version {event.version}{event.periodIndex === null ? '' : ` · period ${event.periodIndex}`}</p>{event.periodStartsAt && <p className={shared.note}>{invoiceTime(event.periodStartsAt)} – {event.periodEndsAt ? invoiceTime(event.periodEndsAt) : 'No recorded period end'}</p>}</li>)}</ul>
    </section>
  </div>;
}

export function InvoiceRefundResults({ data, invoiceId }: { data: InvoiceRefundReview; invoiceId: string }): React.ReactElement {
  const eligibility = data.eligibility;
  return <div className={shared.results} data-invoice-refunds>
    <section className={base.panel}><h2>First-purchase refund eligibility</h2><p>{eligibility.eligible ? 'Eligible in the current backend preview · no refund approved or executed here' : refusalLabel[eligibility.refusal!]}</p>
      <p className={shared.note}>This is the organization's first eligible purchase, not a new guarantee for every invoice. The preview does not record a customer request, approve a refund or move money. Request time and window come from the server.</p>
      <dl className={`${shared.facts} ${styles.identity}`}><div><dt>Preview request instant</dt><dd>{invoiceTime(eligibility.requestReceivedAt)}</dd></div><div><dt>First purchase invoice</dt><dd>{eligibility.invoiceNumber ?? 'No recorded paid purchase'}<small>{eligibility.invoiceId === null ? 'No purchase returned' : eligibility.invoiceId === invoiceId ? 'This invoice' : 'A different invoice; this invoice does not restart the window'}</small></dd></div><div><dt>Recorded first payment / window end</dt><dd>{invoiceTime(eligibility.firstPaidAt)} / {invoiceTime(eligibility.windowEndsAt)}</dd></div><div><dt>Backend refundable amount</dt><dd>{invoiceAmount(eligibility.refundableMinor)}<small>{eligibility.evidenceStrength === null ? 'No paid-purchase evidence' : 'HQ-attested evidence · not provider-verified'}</small></dd></div><div><dt>Refund execution</dt><dd>Unavailable</dd></div></dl>
    </section>
    <section className={base.panel}><h2>Matching refund-request records</h2><p className={shared.note}>Matching entries within the newest 200 global refund requests, not complete invoice or school history. No matching entry does not establish that an older request is absent.</p>
      {!data.matchingRequests.length && <p>No matching refund-request records in the returned global window. Complete refund history is unavailable.</p>}
      <ul className={styles.records}>{data.matchingRequests.map((request) => <li key={request.refundRequestId}><h3>{refundStatus[request.status]}</h3><p>{request.statusReason.replaceAll('_', ' ')}</p><dl className={shared.facts}><div><dt>Customer request received / recorded</dt><dd>{invoiceTime(request.requestReceivedAt)} / {invoiceTime(request.createdAt)}</dd></div><div><dt>Requested amount</dt><dd>{invoiceAmount(request.requestedAmountMinor)}</dd></div><div><dt>Approved amount</dt><dd>{request.approvedAmountMinor === null ? 'Not approved' : invoiceAmount(request.approvedAmountMinor)}</dd></div><div><dt>Recorded refund evidence</dt><dd>{invoiceAmount(request.refundEvidencedMinor)}</dd></div><div><dt>Customer reference</dt><dd>{request.customerReference}</dd></div><div><dt>Execution / subscription consequence</dt><dd>Not executed / blocked pending terms</dd></div></dl></li>)}</ul>
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
    <section className={`${base.panel} ${shared.intro}`}><span className={base.badge}>HON invoice review · HQ only</span><h2>Invoice detail &amp; payment history</h2><p>Load this invoice through the independently authorized HON billing service. The URL is a selector, not a verified record or permission.</p><div className={styles.links}><Link className={shared.link} href="/hq/revenue/invoices">← Invoice list</Link><Link className={shared.link} href="/hq/revenue">Subscription account review</Link></div>
      {!valid ? <p role="status">Invalid invoice selector. Choose a record from the authorized invoice list.</p> : <button type="button" disabled={state.kind === 'loading'} onClick={() => setSelection((current) => ({ invoiceId, revision: (current?.revision ?? 0) + 1 }))}>{active ? 'Refresh invoice records' : 'Load invoice and payment history'}</button>}
      {!active && valid && <p className={shared.note}>No invoice or organization facts have been requested yet.</p>}
    </section>
    <div className={shared.results} aria-live="polite" aria-busy={state.kind === 'loading'}><InvoiceReadNotice state={state} area="Invoice records"/>{state.kind === 'ready' && <><h2 className={styles.focusHeading} ref={resultHeading} tabIndex={-1}>Verified invoice records</h2><p className={shared.note} role="status">Retrieved {invoiceTime(state.retrievedAt)} · separate reads, not an atomic snapshot; refresh to recheck.</p><InvoiceDetailResults data={state.data}/></>}</div>
    <div className={shared.results} aria-live="polite" aria-busy={refunds.kind === 'loading'}><InvoiceReadNotice state={refunds} area="Refund review"/>{refunds.kind === 'ready' && <><p className={shared.note} role="status">Refund review retrieved {invoiceTime(refunds.retrievedAt)} · separately authorized current reads.</p><InvoiceRefundResults data={refunds.data} invoiceId={invoiceId}/></>}</div>
    <section className={base.panel}><h2>Read-only financial records</h2><p className={shared.note}>No payment collection, refund execution, financial activation, founder reservation, subscription mutation, reward fulfillment or provider call is available. Invoice records and HQ attestations are not processor receipts. School-to-family billing stays separate.</p></section>
  </div>;
}
