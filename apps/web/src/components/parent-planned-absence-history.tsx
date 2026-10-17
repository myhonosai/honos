'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ParentPlannedAbsenceHistoryView, ParentPlannedAbsenceRequestContext } from '@hon/contracts';
import { loadParentPlannedAbsenceHistory, ParentPlannedAbsenceHistoryAccessError } from './parent-planned-absence-history-http';
import { loadParentPlannedAbsenceRequestContext, submitParentPlannedAbsence, plannedAbsenceAttempt, ParentPlannedAbsenceRequestAccessError } from './parent-planned-absence-request-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
function message(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : 'Planned absences are unavailable. No submission is assumed.'; }
function denied(error: unknown) { return error instanceof ParentPlannedAbsenceHistoryAccessError || error instanceof ParentPlannedAbsenceRequestAccessError; }

/** Only explicit form submission writes a canonical SUBMITTED request. Reads never act. */
export function ParentPlannedAbsenceHistory(): React.ReactElement {
  const [context, setContext] = useState<ParentPlannedAbsenceRequestContext | null>(null), [view, setView] = useState<ParentPlannedAbsenceHistoryView | null>(null);
  const [child, setChild] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState(''), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [historyError, setHistoryError] = useState(''), [notice, setNotice] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null), retry = useRef<ReturnType<typeof plannedAbsenceAttempt> | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setContext(null); setView(null); setChild(''); setStart(''); setEnd(''); setReason(''); retry.current = null; setNotice(''); setHistoryError(''); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setContext(null); setView(null); setChild(''); setStart(''); setEnd(''); setReason(''); retry.current = null; setBusy(true); setError(''); setHistoryError(''); setNotice(''); setAccessLost(false);
    try {
      // Always begin with the selector-free context, never session IDs or history choices.
      const choices = await loadParentPlannedAbsenceRequestContext(controller.signal);
      if (generation.current !== token) return;
      setContext(choices);
      try { const data = await loadParentPlannedAbsenceHistory(controller.signal); if (generation.current === token) setView(data); }
      catch (failure) { if (generation.current === token) { if (denied(failure)) throw failure; setHistoryError(message(failure)); } }
    } catch (failure) { if (generation.current === token) { setContext(null); setView(null); setError(message(failure)); setAccessLost(denied(failure)); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('Family content and unsaved form are hidden. Return to reverify current guardian family access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); retry.current = null; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !context?.children.some(c => c.studentProfileId === child) || !start || !end) return;
    const token = generation.current;
    try {
      const input = { studentProfileId: child, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) };
      retry.current = plannedAbsenceAttempt(input, retry.current, () => crypto.randomUUID());
      setBusy(true); setError(''); setNotice('');
      const receipt = await submitParentPlannedAbsence(retry.current.input, retry.current.key);
      if (generation.current !== token) return;
      retry.current = null; setChild(''); setStart(''); setEnd(''); setReason('');
      setNotice(`Request SUBMITTED ${dateTime(receipt.submittedAt)} for human review. This is not approval or a schedule, attendance, booking, makeup, message, or payment outcome.`);
      // Only a verified receipt triggers this bounded read. Its edge may omit the
      // request; never append a fabricated history row or presume inclusion.
      setView(null); setHistoryError('');
      try { const history = await loadParentPlannedAbsenceHistory(); if (generation.current === token) setView(history); }
      catch (failure) { if (generation.current === token) { if (denied(failure)) { clear(); setAccessLost(true); setError(message(failure)); } else setHistoryError('Submission was verified, but bounded history could not be refreshed. No inclusion is assumed.'); } }
    } catch (failure) { if (generation.current === token) { if (denied(failure)) { clear(); setAccessLost(true); } setError(message(failure)); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent" prefetch={false} className={s.wordmark}>HON <span>Planned absences</span></Link><Link href="/parent/journey" prefetch={false}>Student Journey</Link></nav>
    <header className={s.header}><p>YOUR FAMILY · HUMAN REQUEST AND REVIEW</p><h1>Request a planned absence</h1><p>Choose only an active child returned for your one verified guardian family. Your school reviews the request separately.</p></header>
    <aside className={s.boundary}><strong>Submission only. No automatic outcome.</strong><p>This page cannot approve, cancel a booking, change a schedule, correct attendance, arrange makeup, send a message, make a payment, call a provider, invoke AI or Action Engine, or automate a task.</p></aside>
    <p className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying guardian access…' : 'Refresh verified choices and history'}</button></p>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Verifying planned-absence context or request and loading recorded planned-absence status. No previous family content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Guardian family access unavailable' : 'No verified request result'}</strong><p>{error}</p>{retry.current && <p>Keep the same child, times and reason to retry with the retained key. No submission is assumed from an uncertain response. Refreshing or leaving clears this in-memory attempt.</p>}{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}{notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {!busy && context && <section className={s.card}><h2>Submit one absence request</h2>{context.children.length === 0 ? <p className={s.empty}>No active authorized child is returned. No child is selected automatically and no absence can be submitted.</p> : <form className={s.form} onSubmit={submit}>
      <label>Authorized child<select required value={child} onChange={e => setChild(e.target.value)}><option value="">Choose a child</option>{context.children.map(c => <option key={c.studentProfileId} value={c.studentProfileId}>{c.displayName}</option>)}</select></label>
      <label>Absence starts (your device time zone)<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)}/></label>
      <label>Absence ends (your device time zone)<input type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)}/></label>
      <label>Optional reason for review (1000 characters maximum)<textarea maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}/></label>
      <p className={s.subtle}>Start must be in the future, end strictly after start, and both within the next 90 days. Your child and family access are reverified on every submission, including retry. No reason or staff note is shown in history.</p>
      <button type="submit" disabled={busy || !child || !start || !end}>Submit request for human review</button>
    </form>}</section>}
    {historyError && <div role="alert" className={s.error}><strong>No verified absence history shown</strong><p>{historyError}</p></div>}
    {!busy && view && <><p className={s.notice}><strong>Verified guardian family view</strong> · {label(view.accessLevel)} · Updated {dateTime(view.generatedAt)}</p><section className={s.card}><p className={s.subtle}>Recorded absence starts from {dateTime(view.from)} to {dateTime(view.to)}. Times use your device’s time zone.</p><h2>Recorded requests</h2>{view.requests.items.length === 0 ? <p className={s.empty}>No planned-absence request for a current child is returned in this bounded window. A verified submission is not guaranteed to appear at this window’s edge. No absence, approval, schedule, attendance, or makeup status is inferred.</p> : <ul className={s.list}>{view.requests.items.map((item, index) => <li key={`${item.child.displayName}-${item.startsAt}-${index}`}><strong>{item.child.displayName}</strong><p>{dateTime(item.startsAt)} – {dateTime(item.endsAt)}</p><p><span className={s.badge}>{label(item.status)}</span> <span className={s.subtle}>Submitted {dateTime(item.submittedAt)}{item.reviewedAt ? ` · Status recorded ${dateTime(item.reviewedAt)}` : ' · No review time recorded'}</span></p><p className={s.subtle}>Recorded request status only; no staff identity, rationale, request reason, private note, booking, attendance, makeup, or schedule detail is shown.</p></li>)}</ul>}{view.requests.limited && <p className={s.subtle}>Only the newest 100 records in this bounded window are shown. Additional records are not counted or inferred.</p>}</section></>}
    <footer className={s.footer}>Direct human request · separate human review · bounded redacted history. No downstream outcome is promised.</footer>
  </div></main>;
}
