'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentTestingCertificateStatus, ParentTestingStatusList, ParentTestingStatusView } from '@hon/contracts';
import { loadParentTestingStatus, ParentTestingStatusAccessError } from './parent-testing-status-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
function timing(event: { label: string; startsAt: string; endsAt: string | null }) { return <>{event.label} · {dateTime(event.startsAt)}{event.endsAt ? `–${dateTime(event.endsAt)}` : ''}</>; }
function Certificate({ value }: { value: ParentTestingCertificateStatus }) {
  if (value.status === 'UNAVAILABLE') return <p className={s.subtle}>Certificate status unavailable: {value.reason === 'GUARDIAN_SCOPE_REQUIRED' ? 'a current guardian scope is required' : 'a current-family payer link cannot be verified'}. No certificate existence is assumed.</p>;
  return <p><span className={s.badge}>{label(value.status)}</span> <span className={s.subtle}>Certificate details, issuance, and downloads are not available here.</span></p>;
}
function ReadList<T>({ list, empty, render }: { list: ParentTestingStatusList<T>; empty: string; render: (item: T, index: number) => React.ReactNode }) {
  return <>{list.items.length === 0 ? <p className={s.empty}>{empty}</p> : <ul className={s.list}>{list.items.map(render)}</ul>}{list.limited && <p className={s.subtle}>Only a bounded current list is shown. Additional records are not counted or inferred.</p>}</>;
}

export function ParentTestingStatus(): React.ReactElement {
  const [view, setView] = useState<ParentTestingStatusView | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setBusy(true); setError(''); setAccessLost(false);
    try { const data = await loadParentTestingStatus(controller.signal); if (generation.current === token) setView(data); }
    catch (reason) { if (generation.current === token) { setView(null); setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : 'Family testing status is unavailable.'); setAccessLost(reason instanceof ParentTestingStatusAccessError); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Family testing status is hidden. Return to reverify current family access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);

  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent/journey" prefetch={false} className={s.wordmark}>HON <span>Family testing status</span></Link><Link href="/parent/journey" prefetch={false}>Student Journey</Link></nav>
    <header className={s.header}><p>YOUR FAMILY · VERIFIED READS ONLY</p><h1>Current testing status</h1><p>Redacted observations for children in your one current verified family. This page reports only existing records; it does not predict readiness or eligibility.</p></header>
    <aside className={s.boundary}><strong>Status only. Nothing changes here.</strong><p>No registration interest, payment, candidate, scorecard, grade, pass/fail outcome, promotion, rank, belt, certificate issue/download, message, provider, AI, Action Engine, voice, automation, or external call is available from this page.</p></aside>
    <p className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying family access…' : 'Refresh verified testing status'}</button></p>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Loading current family testing status. No previous family content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Family testing access unavailable' : 'No verified testing status shown'}</strong><p>{error}</p>{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}</div>
    {!busy && view && <><p className={s.notice}><strong>Verified family view</strong> · {label(view.accessLevel)} · Updated {dateTime(view.generatedAt)}</p>{view.children.items.length === 0 ? <section className={s.card}><h2>No current child testing status</h2><p className={s.empty}>No active current-family child profile is returned. No child, event, candidate, certificate, or eligibility status is assumed.</p></section> : <>{view.children.items.map((child, index) => <section key={`${child.displayName}-${index}`} className={s.card}><h2>{child.displayName}</h2><p>{child.upcomingEvent ? <>Current linked future event: {timing(child.upcomingEvent)}.</> : 'No linked future testing event is returned. No invitation, place, readiness, or eligibility is inferred.'}</p><h3>Recorded candidate status</h3><ReadList list={child.candidates} empty="No testing candidate record is returned for this current child." render={(candidate, itemIndex) => <li key={itemIndex}><strong>{timing(candidate.event)}</strong><p><span className={s.badge}>{label(candidate.overallStatus)}</span> <span className={s.subtle}>Recorded overall candidate status only; no criteria, evaluator, comment, grade, promotion, rank, or recommendation is shown.</span></p></li>} /><h3>Your registration-interest status</h3><ReadList list={child.registrationInterests} empty="No registration-interest record you submitted is returned for this current child." render={(interest, itemIndex) => <li key={itemIndex}><strong>{timing(interest.event)}</strong><p><span className={s.badge}>{label(interest.status)}</span> · Submitted {dateTime(interest.submittedAt)}{interest.reviewedAt ? ` · Reviewed ${dateTime(interest.reviewedAt)}` : ' · Review time not recorded'}</p><p className={s.subtle}>This is a recorded interest state, not a testing place, admission, payment, candidate creation, or eligibility decision.</p></li>} /><h3>Certificate status</h3><Certificate value={child.certificate}/></section>)}</>}{view.children.limited && <p className={s.subtle}>Only a bounded current child list is shown. Additional children are not counted or inferred.</p>}<section className={s.card}><h2>Share testing interest</h2><p>Use the separate family request route only to submit interest for a returned child and an existing open event. That route rechecks access and does not create a testing place, candidate, payment, or approval.</p><Link href="/parent/testing/interest" prefetch={false}>Share interest for human review</Link></section></>}
    <footer className={s.footer}>Read-only family testing status. Any unavailable value remains unavailable rather than becoming a readiness, eligibility, grading, payment, or certificate claim.</footer>
  </div></main>;
}
