'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentBillingInvoice, ParentBillingList, ParentBillingMembership, ParentBillingView } from '@hon/contracts';
import { loadParentBilling, ParentBillingAccessError } from './parent-billing-http';
import s from './parent-billing.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
function money(amountMinor: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 100); }
  catch { return `${currency} ${amountMinor} minor units`; }
}
function Unavailable({ children }: { children: React.ReactNode }) { return <div className={s.unavailable}><strong>Unavailable</strong><p>{children}</p></div>; }
function ReadList<T>({ list, empty, unavailable, render }: { list: ParentBillingList<T>; empty: string; unavailable: string; render: (item: T, index: number) => React.ReactNode }) {
  if (list.status === 'UNAVAILABLE') return <Unavailable>{unavailable}</Unavailable>;
  return <>{list.items.length === 0 ? <p className={s.empty}>{empty}</p> : <ul className={s.list}>{list.items.map((item, index) => <li key={index}>{render(item, index)}</li>)}</ul>}{list.limited && <p className={s.subtle}>This is a limited first page. More verified records may exist, but are not counted or inferred.</p>}</>;
}
function MembershipCard({ membership }: { membership: ParentBillingMembership }) {
  const term = membership.termStartedAt || membership.termEndsAt
    ? <>{membership.termStartedAt ? `Starts ${dateTime(membership.termStartedAt)}` : 'Start date not recorded'}{membership.termStartedAt && membership.termEndsAt ? ' · ' : ''}{membership.termEndsAt ? `Ends ${dateTime(membership.termEndsAt)}` : 'End date not recorded'}</>
    : 'No current term dates are recorded.';
  return <><div className={s.row}><strong>{membership.participant.displayName}</strong><span className={s.badge}>{label(membership.state)}</span></div><p>{term}</p><p className={s.subtle}>Participant is a current-family student. A current-family designated billing contact is verified; payer identity is not shown.</p></>;
}
function InvoiceCard({ invoice }: { invoice: ParentBillingInvoice }) {
  return <><div className={s.row}><strong>{invoice.participant.displayName}</strong><span className={s.badge}>{label(invoice.status)}</span></div><p>{money(invoice.totalMinor, invoice.currency)}{invoice.dueAt ? ` · Due ${dateTime(invoice.dueAt)}` : ' · No due date recorded'}</p><section className={s.attempts} aria-label={`Redacted payment observations for ${invoice.participant.displayName}`}><h3>Payment observations</h3>{invoice.paymentAttempts.items.length === 0 ? <p className={s.subtle}>No payment attempt is returned. This does not mean paid, unpaid, charged, or scheduled.</p> : <ul>{invoice.paymentAttempts.items.map((attempt, index) => <li key={index}><strong>{label(attempt.state)}</strong> · {money(attempt.amountMinor, attempt.currency)} · Initiated {dateTime(attempt.initiatedAt)}{attempt.reconciledAt && <> · Reconciled {dateTime(attempt.reconciledAt)}</>}</li>)}</ul>}{invoice.paymentAttempts.limited && <p className={s.subtle}>Only the first verified payment observations are shown. No outcome is inferred.</p>}</section></>;
}

export function ParentBilling() {
  const [view, setView] = useState<ParentBillingView | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setBusy(true); setError(''); setAccessLost(false);
    try { const data = await loadParentBilling(controller.signal); if (generation.current === token) setView(data); }
    catch (error) { if (generation.current === token) { setView(null); setError(error instanceof Error && error.name !== 'AbortError' ? error.message : 'Family billing observations are unavailable.'); setAccessLost(error instanceof ParentBillingAccessError); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Family billing content is hidden. Return to this page to reverify guardian access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) void load(); }, 60_000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);

  return <main className={s.page}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent/journey" prefetch={false} className={s.wordmark}>HON <span>Family Journey</span></Link><Link href="/parent/billing" aria-current="page">Billing observations</Link><Link href="/parent/documents" prefetch={false}>Document desk</Link></nav>
    <header className={s.header}><p className={s.eyebrow}>YOUR FAMILY · VERIFIED READS ONLY</p><h1>Family billing observations</h1><p>Current child membership terms and redacted invoice/payment facts from your current verified guardian family. No payment methods, provider details, payer identity, actions, or outcomes are assumed.</p></header>
    <section className={s.controls}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying guardian access…' : 'Refresh verified billing view'}</button></section>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Loading billing observations from your current verified guardian family. No previous billing content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Guardian billing access unavailable' : 'No verified billing result shown'}</strong><p>{error}</p>{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}</div>
    {!busy && view && <><div className={s.verified}><strong>Verified guardian view</strong><span>{label(view.accessLevel)} · Updated {dateTime(view.generatedAt)}</span></div><div className={s.sections}>
      <section className={s.card} aria-labelledby="membership-heading"><p className={s.eyebrow}>CURRENT FAMILY MEMBERSHIP</p><h2 id="membership-heading">Membership status & term</h2><ReadList list={view.memberships} empty="No current-family child membership record with a verified payer link is returned." unavailable="A current-family payer-to-child link cannot be verified. Membership and billing facts are withheld rather than guessed." render={membership => <MembershipCard membership={membership}/>} /><p className={s.notice}>Plan, payment schedule, automatic renewal, discounts, credits, cancellations, changes and payer identity are not shown or editable here.</p></section>
      <section className={s.card} aria-labelledby="invoice-heading"><p className={s.eyebrow}>REDACTED INVOICE & PAYMENT OBSERVATIONS</p><h2 id="invoice-heading">Invoices & reported payment states</h2><ReadList list={view.invoices} empty="No linked invoice observations are returned for current-family child memberships." unavailable="Invoice and payment observations are withheld until the current-family payer-to-child link is verified." render={invoice => <InvoiceCard invoice={invoice}/>} /><p className={s.notice}>A reported payment state is an observation only. This page does not collect, retry, schedule, refund, credit, discount, cancel, or otherwise change any invoice, membership, or payment.</p></section>
    </div></>}
    <footer className={s.footer}>Read-only family space. No AI, Action Engine, voice, messages, payment provider, payment method, collection, or automated billing outcome is used here.</footer>
  </div></main>;
}
