'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ParentTestingRegistrationView } from '@hon/contracts';
import { loadParentTestingRegistrations, submitParentTestingInterest, TestingRegistrationAccessError } from './testing-registration-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
export function ParentTestingRegistration(): React.ReactElement {
  const [view, setView] = useState<ParentTestingRegistrationView | null>(null), [child, setChild] = useState(''), [event, setEvent] = useState(''), [note, setNote] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const clear = useCallback(() => { ++generation.current; setView(null); setChild(''); setEvent(''); setNote(''); retry.current = null; setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; setBusy(true); setError(''); setNotice(''); setView(null); setChild(''); setEvent('');
    try { const next = await loadParentTestingRegistrations(); if (generation.current === token) setView(next); }
    catch (e) { if (generation.current === token) { setView(null); setError(e instanceof Error ? e.message : 'Testing registration is unavailable.'); } }
    finally { if (generation.current === token) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Family content is hidden. Return to reverify current family access.'); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!child || !event || busy) return; const input = { studentProfileId: child, testingEventId: event, ...(note.trim() ? { note: note.trim() } : {}) }, fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError(''); setNotice('');
    try { const receipt = await submitParentTestingInterest(input, retry.current.key); retry.current = null; setNote(''); await load(); setNotice(`Interest submitted ${dateTime(receipt.submittedAt)}. It is awaiting an exact human staff review; no testing place, eligibility, payment, promotion, message, or roster entry is created.`); }
    catch (e) { if (e instanceof TestingRegistrationAccessError) clear(); setError(e instanceof Error ? e.message : 'No interest is assumed.'); }
    finally { setBusy(false); }
  }
  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav}><Link href="/parent/journey" className={s.wordmark}>HON <span>Family testing</span></Link><Link href="/parent/journey" prefetch={false}>Student Journey</Link></nav>
    <header className={s.header}><p>FAMILY TESTING · HUMAN REVIEW REQUIRED</p><h1>Share interest. Your instructors decide.</h1><p>Choose a child already returned by your verified family view and an existing open testing event. This is a bounded interest request only.</p></header>
    <aside className={s.boundary}><strong>No automatic decision or payment.</strong><p>HON does not calculate eligibility, create a candidate, reserve a roster place, promote a student, charge a payment, send a message, contact staff, invoke AI, or run an Action Engine task from this page.</p></aside>
    <div aria-live="polite">{busy && <p className={s.state} role="status">Verifying current family access and current event availability. No previous family content is retained.</p>}{error && <p className={s.error} role="alert">{error}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {!busy && view && <><section className={s.card}><h2>Submit one testing interest</h2>{view.children.length === 0 || view.events.length === 0 ? <p className={s.empty}>{view.children.length === 0 ? 'No active authorized child is returned. No child is selected automatically.' : 'No existing open testing event is returned right now. Event availability is not inferred.'}</p> : <form onSubmit={submit} className={s.form}><label>Authorized child<select required value={child} onChange={e => setChild(e.target.value)}><option value="">Choose a child</option>{view.children.map(c => <option key={c.studentProfileId} value={c.studentProfileId}>{c.displayName}</option>)}</select></label><label>Existing open testing event<select required value={event} onChange={e => setEvent(e.target.value)}><option value="">Choose an event</option>{view.events.map(t => <option key={t.testingEventId} value={t.testingEventId}>{t.name} · {dateTime(t.startsAt)}</option>)}</select></label><label>Optional note for staff (500 characters maximum)<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label><button disabled={busy || !child || !event} type="submit">Submit interest for human review</button></form>}<p className={s.subtle}>The returned child and event IDs are server-verified selectors, not authority. The server confirms your family access, child relationship, and current open event at submission time.</p></section>
    <section className={s.card}><h2>Your testing interest status</h2>{view.registrations.length === 0 ? <p className={s.empty}>No submitted testing interests are returned for your currently verified family.</p> : <ul className={s.list}>{view.registrations.map((r, index) => <li key={`${r.eventName}-${r.childName}-${index}`}><div><strong>{r.eventName}</strong><span className={s.badge}>{label(r.status)}</span></div><p>{r.childName} · {dateTime(r.startsAt)}</p><p className={s.subtle}>Submitted {dateTime(r.submittedAt)}{r.reviewedAt ? ` · Reviewed ${dateTime(r.reviewedAt)}` : ' · Awaiting staff review'}</p></li>)}</ul>}<p className={s.subtle}>Only your family’s status is shown. Reviewer identity, staff rationale, other family records, curriculum/rank/eligibility, candidate outcomes, payment and roster facts are not shared.</p></section></>}
    <footer className={s.footer}>Family testing interest foundation · direct human request and direct human review only.</footer>
  </div></main>;
}
