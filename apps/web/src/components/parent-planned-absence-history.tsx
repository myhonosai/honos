'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentPlannedAbsenceHistoryView } from '@hon/contracts';
import { loadParentPlannedAbsenceHistory, ParentPlannedAbsenceHistoryAccessError } from './parent-planned-absence-history-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }

/** A view-only, selector-free current guardian-family absence history surface. */
export function ParentPlannedAbsenceHistory(): React.ReactElement {
  const [view, setView] = useState<ParentPlannedAbsenceHistoryView | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setBusy(true); setError(''); setAccessLost(false);
    try { const data = await loadParentPlannedAbsenceHistory(controller.signal); if (generation.current === token) setView(data); }
    catch (reason) { if (generation.current === token) { setView(null); setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : 'Planned-absence history is unavailable.'); setAccessLost(reason instanceof ParentPlannedAbsenceHistoryAccessError); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Planned-absence history is hidden. Return to reverify current guardian family access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);

  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent" prefetch={false} className={s.wordmark}>HON <span>Planned absences</span></Link><Link href="/parent/journey" prefetch={false}>Student Journey</Link></nav>
    <header className={s.header}><p>YOUR FAMILY · VERIFIED GUARDIAN READ ONLY</p><h1>Recorded planned-absence status</h1><p>Bounded status records for current children in your one verified guardian family. The date range is chosen by the server, not a request parameter.</p></header>
    <aside className={s.boundary}><strong>History only. Nothing changes here.</strong><p>No planned-absence submission, cancellation, staff review or approval, booking or schedule change, attendance correction, makeup, note, roster, message, provider, AI, Action Engine, voice, automation, payment, or external call is available from this page.</p></aside>
    <p className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying guardian access…' : 'Refresh verified absence history'}</button></p>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Loading recorded planned-absence status from your current verified guardian family scope. No previous family content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Guardian family access unavailable' : 'No verified absence history shown'}</strong><p>{error}</p>{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}</div>
    {!busy && view && <><p className={s.notice}><strong>Verified guardian family view</strong> · {label(view.accessLevel)} · Updated {dateTime(view.generatedAt)}</p><section className={s.card}><p className={s.subtle}>Recorded absence starts from {dateTime(view.from)} to {dateTime(view.to)}. Times use your device’s time zone.</p><h2>Recorded requests</h2>{view.requests.items.length === 0 ? <p className={s.empty}>No planned-absence request for a current child is returned in this bounded window. No absence, approval, schedule, attendance, or makeup status is inferred.</p> : <ul className={s.list}>{view.requests.items.map((item, index) => <li key={`${item.child.displayName}-${item.startsAt}-${index}`}><strong>{item.child.displayName}</strong><p>{dateTime(item.startsAt)} – {dateTime(item.endsAt)}</p><p><span className={s.badge}>{label(item.status)}</span> <span className={s.subtle}>Submitted {dateTime(item.submittedAt)}{item.reviewedAt ? ` · Status recorded ${dateTime(item.reviewedAt)}` : ' · No review time recorded'}</span></p><p className={s.subtle}>Recorded request status only; no staff identity, rationale, request reason, private note, booking, attendance, makeup, or schedule detail is shown.</p></li>)}</ul>}{view.requests.limited && <p className={s.subtle}>Only the newest 100 records in this bounded window are shown. Additional records are not counted or inferred.</p>}</section></>}
    <footer className={s.footer}>Read-only guardian family history. A recorded request status is not a schedule change, attendance correction, makeup, message, approval explanation, or promise of any downstream outcome.</footer>
  </div></main>;
}
