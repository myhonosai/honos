'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ParentClassPassView } from '@hon/contracts';
import { loadParentClassPass } from './parent-classpass-http';
import s from './parent-billing.module.css';
const label = (v: string) => v.toLowerCase().replaceAll('_', ' ');
export function ParentClassPass() {
  const [view, setView] = useState<ParentClassPassView | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setError(''); setBusy(true);
    try { const result = await loadParentClassPass(controller.signal); if (generation.current === token) setView(result); }
    catch (e) { if (generation.current === token) { setView(null); setError(e instanceof Error ? e.message : 'ClassPass unavailable.'); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('ClassPass content hidden. Reverify guardian access to view it again.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) void load(); }, 60_000);
    return () => { clear(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);
  return <main className={s.page}><Link href="/parent" prefetch={false}>Parent home</Link><h1>Family ClassPass observations</h1>
    <p>Read-only operational allowances for authorized active children. Booking, redemption and recorded attendance are distinct.</p>
    <p><strong>Payment/provider outcome unavailable.</strong> This page does not purchase, charge, refund, issue, admit or change attendance.</p>
    <button type="button" onClick={() => void load()} disabled={busy}>Reverify access</button>
    {busy && <p role="status">Verifying current guardian-family access…</p>}{error && <p role="alert">{error}</p>}
    {view && <><p>Observed {new Date(view.generatedAt).toLocaleString()}</p>{view.children.items.length === 0 && <p>No authorized active children are returned.</p>}
      {view.children.items.map((child, i) => <section key={i}><h2>{child.displayName}</h2>{child.passes.items.length === 0 && <p>No ClassPass allowance is returned. No payment outcome is inferred.</p>}
        {child.passes.items.map((pass, j) => <article key={j}><h3>{pass.productDisplayName}</h3><p>{pass.remainingUses} uses remaining · {label(pass.status)} · expires {new Date(pass.expiresAt).toLocaleString()}</p>
          {pass.bookings.items.length === 0 ? <p>No ClassPass booking outcome is recorded.</p> : <ul>{pass.bookings.items.map((booking, k) => <li key={k}>{new Date(booking.startsAt).toLocaleString()} · booking: {label(booking.bookingStatus)} · redemption: {label(booking.redemptionOutcome)} · attendance: {label(booking.attendanceState)}</li>)}</ul>}
          {pass.bookings.limited && <p>Only the latest ten ClassPass bookings are shown.</p>}</article>)}{child.passes.limited && <p>Only the latest twenty allowances are shown.</p>}</section>)}
      {view.children.limited && <p>Only the first twenty authorized active children are shown.</p>}</>}
  </main>;
}
