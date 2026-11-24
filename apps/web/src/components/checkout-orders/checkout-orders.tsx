'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SchoolCheckoutOrder, SchoolPublicCheckoutOrder } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { CheckoutOrdersAccessError, loadCheckoutOrders, loadPublicCheckoutOrders, money, ORDER_STATUS_LABEL } from './http';
import s from '../comms-kit/comms.module.css';

function when(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function answerText(value: string | boolean) { return value === true ? 'Yes' : value === false ? 'No' : value; }

/**
 * Checkout pages > Orders (CP3, 0598): what families bought from the school's checkout pages in the HON Family app,
 * newest first (at most 200), with each child's answers. Test mode only; payments go to the school's own processor.
 * 0627: a second list of sign-ups from the page link by people without an account; that list failing never hides the first.
 */
export function CheckoutOrders(): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [items, setItems] = useState<SchoolCheckoutOrder[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [denied, setDenied] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [linkItems, setLinkItems] = useState<SchoolPublicCheckoutOrder[] | null>(null), [linkError, setLinkError] = useState('');
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const [organizationId, schoolId] = scopeKey.split('/');
    if (!organizationId || !schoolId) return;
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const scope = { organizationId, schoolId };
      const [list, link] = await Promise.all([loadCheckoutOrders(scope),
        loadPublicCheckoutOrders(scope).then(v => v.orders, (problem: unknown) => (problem instanceof Error ? problem.message : 'Link sign-ups are unavailable right now.'))]);
      if (generation.current !== token) return;
      setItems(list.orders); setError(''); setHidden(false);
      if (typeof link === 'string') { setLinkItems(null); setLinkError(link); } else { setLinkItems(link); setLinkError(''); }
    } catch (problem) {
      if (generation.current !== token) return;
      setItems(null); setLinkItems(null); setError(problem instanceof Error ? problem.message : 'Checkout orders are unavailable right now.'); setDenied(problem instanceof CheckoutOrdersAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeKey]);
  useEffect(() => { ++generation.current; setItems(null); setLinkItems(null); void refresh(); }, [scopeKey, refresh]);
  useEffect(() => onShellPrivacyEvent(() => { ++generation.current; setItems(null); setLinkItems(null); setError(''); setLinkError(''); setHidden(true); }), []);

  if (!selection) return <p role="status">Choose a school to see checkout orders.</p>;
  return <main className={s.page} data-checkout-orders="">
    <header className={s.head}><div><h1>Checkout orders</h1>
      <p>What families bought from your checkout pages in the HON Family app. Test mode: no real money moves yet.</p></div>
      {items && <button type="button" className={s.ghost} disabled={busy} onClick={() => void refresh()}>Refresh</button>}</header>
    {hidden && !items && <p className={s.actions}><button type="button" className={s.button} onClick={() => void refresh()}>Show orders</button></p>}
    <div aria-live="polite">{busy && !items && <p className={s.muted} role="status">Loading orders…</p>}
      {error && <div className={s.flash} data-tone="bad" role="alert"><strong>{denied ? 'Not available for your role' : 'Checkout orders'}</strong>
        <p>{denied ? 'You need the checkout pages permission at this school.' : error}</p></div>}</div>
    {items && <section className={s.panel} aria-label="Orders">
      {items.length === 0 ? <p className={s.empty}>No orders yet.</p> : <ul className={s.rows}>
        {items.map(order => <li key={order.orderId} data-order={order.status}>
          <div className={s.actions}><strong>{order.title}</strong>
            <span className={s.badge} data-tone={order.status === 'PAID' ? 'ok' : order.status === 'REVIEW' ? 'bad' : undefined}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</span>
            <span>{money(order.amountMinor, order.currency)}</span>
            <span className={s.muted}>{order.familyName ?? 'Family'} · {when(order.createdAt)}</span></div>
          <ul>{order.participants.map((p, i) => <li key={i}>{p.name ?? 'Child'}
            {Object.keys(p.answers).length > 0 && <span className={s.muted}> · {Object.entries(p.answers).map(([k, v]) => `${k}: ${answerText(v)}`).join(' · ')}</span>}</li>)}</ul>
          {(order.addOnKeys.length > 0 || order.waiverAccepted) && <p className={s.muted}>
            {order.addOnKeys.length > 0 ? `Add-ons: ${order.addOnKeys.join(', ')}` : ''}{order.addOnKeys.length > 0 && order.waiverAccepted ? ' · ' : ''}{order.waiverAccepted ? 'Waiver accepted' : ''}</p>}
          {order.status === 'REVIEW' && <p className={s.muted}>The processor reported a payment for an order that had already ended. Check the payment with your processor before refunding or keeping it.</p>}
        </li>)}
      </ul>}
    </section>}
    {items && <section className={s.panel} aria-label="Sign-ups from the page link" data-checkout-link-orders="">
      <h2>From the page link</h2>
      <p className={s.muted}>People without a family account who signed up from a page's link. Their contact details are only what they typed.</p>
      {linkError ? <div className={s.flash} data-tone="bad" role="alert"><p>{linkError}</p></div>
        : linkItems && (linkItems.length === 0 ? <p className={s.empty}>No sign-ups from a link yet.</p> : <ul className={s.rows}>
        {linkItems.map(order => <li key={order.orderId} data-order={order.status}>
          <div className={s.actions}><strong>{order.title}</strong>
            <span className={s.badge} data-tone={order.status === 'PAID' ? 'ok' : order.status === 'REVIEW' ? 'bad' : undefined}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</span>
            <span>{money(order.amountMinor, order.currency)}</span>
            <span className={s.muted}>{order.buyer.name} · {order.buyer.email}{order.buyer.mobile ? ` · ${order.buyer.mobile}` : ''} · {when(order.createdAt)}</span></div>
          <ul>{order.participants.map((p, i) => <li key={i}>{p.name}
            {Object.keys(p.answers).length > 0 && <span className={s.muted}> · {Object.entries(p.answers).map(([k, v]) => `${k}: ${answerText(v)}`).join(' · ')}</span>}</li>)}</ul>
          {(order.addOnKeys.length > 0 || order.waiverAccepted) && <p className={s.muted}>
            {order.addOnKeys.length > 0 ? `Add-ons: ${order.addOnKeys.join(', ')}` : ''}{order.addOnKeys.length > 0 && order.waiverAccepted ? ' · ' : ''}{order.waiverAccepted ? 'Waiver accepted' : ''}</p>}
          {order.status === 'REVIEW' && <p className={s.muted}>The processor reported a payment for a sign-up that had already ended. Check the payment with your processor before refunding or keeping it.</p>}
        </li>)}
      </ul>)}
    </section>}
  </main>;
}
