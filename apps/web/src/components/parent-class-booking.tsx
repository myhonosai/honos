'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentClassBookingChoices, ParentClassSessionChoice } from '@hon/contracts';
import { bookParentClass, bookingAttempt, cancelParentClass, loadParentClassBookingChoices, ParentClassBookingAccessError, ParentClassBookingRefusal } from './parent-class-booking-http';
import s from './testing-registration.module.css';

function when(value: string, zone: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(value));
}
function endTime(value: string, zone: string) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(value)); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Booking is unavailable right now.'; }

/** Parents book their own child into open classes and cancel their own app bookings. Reads never act. */
export function ParentClassBooking(): React.ReactElement {
  const [view, setView] = useState<ParentClassBookingChoices | null>(null), [child, setChild] = useState('');
  const [busy, setBusy] = useState(true), [acting, setActing] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [lost, setLost] = useState(false);
  const generation = useRef(0), attempt = useRef<{ action: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setBusy(true); setError(''); setLost(false);
    try {
      const data = await loadParentClassBookingChoices();
      if (generation.current !== token) return;
      setView(data); setChild(current => data.children.some(c => c.studentProfileId === current) ? current : data.children[0]?.studentProfileId ?? '');
    } catch (problem) {
      if (generation.current !== token) return;
      setView(null); setError(failure(problem)); setLost(problem instanceof ParentClassBookingAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { if (document.visibilityState === 'hidden') { ++generation.current; setView(null); attempt.current = null; } else void load(); };
    document.addEventListener('visibilitychange', hide);
    return () => { ++generation.current; document.removeEventListener('visibilitychange', hide); };
  }, [load]);

  async function act(session: ParentClassSessionChoice, kind: 'book' | 'cancel') {
    if (!view || acting) return;
    const action = kind === 'book' ? `book:${child}:${session.sessionId}` : `cancel:${session.booking!.bookingId}:${session.booking!.version}`;
    attempt.current = bookingAttempt(action, attempt.current, () => crypto.randomUUID());
    setActing(session.sessionId); setError(''); setNotice('');
    try {
      if (kind === 'book') await bookParentClass({ studentProfileId: child, sessionId: session.sessionId }, attempt.current.key);
      else await cancelParentClass(session.booking!.bookingId, session.booking!.version, attempt.current.key);
      attempt.current = null;
      setNotice(kind === 'book' ? `Booked: ${session.name}, ${when(session.startsAt, view.timezone)}.` : `Cancelled: ${session.name}, ${when(session.startsAt, view.timezone)}.`);
      await load();
    } catch (problem) {
      setError(failure(problem));
      // An unknown outcome (5xx or no answer) keeps the key so the same action retries exactly; a definite refusal does not.
      if (problem instanceof ParentClassBookingAccessError) { setLost(true); setView(null); attempt.current = null; } else if (problem instanceof ParentClassBookingRefusal) attempt.current = null;
    } finally { setActing(''); }
  }

  const selected = view?.children.find(c => c.studentProfileId === child) ?? null;
  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent" prefetch={false} className={s.wordmark}>HON <span>Book a class</span></Link><Link href="/parent/journey#schedule" prefetch={false}>Family schedule</Link></nav>
    <header className={s.header}><p>YOUR FAMILY</p><h1>Book a class</h1><p>Classes your child is enrolled in that take bookings, for the next two weeks. Times are in the school’s time zone.</p></header>
    <p className={s.actions}><button type="button" disabled={busy || !!acting} onClick={() => void load()}>{busy ? 'Loading…' : 'Refresh'}</button></p>
    <div aria-live="polite" aria-atomic="true">
      {error && <div className={s.error} role="alert"><strong>{lost ? 'Not available on this account' : 'That did not go through'}</strong><p>{error}</p>{lost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}
    </div>
    {!busy && view && (view.children.length === 0 ? <section className={s.card}><p className={s.empty}>No active child is on your family account at this school.</p></section> : <>
      {!view.canBook && <aside className={s.boundary}><strong>View only</strong><p>Your access to this family lets you see classes but not book them. A guardian on the account can book.</p></aside>}
      {view.children.length > 1 && <section className={s.card}><label>Child<select value={child} onChange={e => { setChild(e.target.value); attempt.current = null; }}>{view.children.map(c => <option key={c.studentProfileId} value={c.studentProfileId}>{c.displayName}</option>)}</select></label></section>}
      {selected && <section className={s.card}><h2>{selected.displayName}</h2>{selected.sessions.length === 0 ? <p className={s.empty}>No bookable classes in the next two weeks.</p> : <ul className={s.list}>{selected.sessions.map(session => {
        const booked = session.booking && session.booking.status !== 'CANCELLED';
        return <li key={session.sessionId}>
          <strong>{session.name}</strong>
          <p>{when(session.startsAt, view.timezone)} – {endTime(session.endsAt, view.timezone)} · {session.programName}{session.roomName ? ` · ${session.roomName}` : ''}</p>
          <p><span className={s.badge}>{booked ? (session.booking!.status === 'CHECKED_IN' ? 'Checked in' : session.booking!.status === 'WAITLISTED' ? 'Waitlisted' : 'Booked') : session.spotsLeft === 0 ? 'Full' : `${session.spotsLeft} ${session.spotsLeft === 1 ? 'spot' : 'spots'} left`}</span></p>
          {view.canBook && !booked && session.spotsLeft > 0 && <button type="button" disabled={!!acting} onClick={() => void act(session, 'book')}>{acting === session.sessionId ? 'Booking…' : 'Book'}</button>}
          {view.canBook && booked && session.booking!.canCancel && <button type="button" disabled={!!acting} onClick={() => void act(session, 'cancel')}>{acting === session.sessionId ? 'Cancelling…' : 'Cancel booking'}</button>}
          {booked && !session.booking!.canCancel && <p className={s.subtle}>{session.booking!.source === 'PARENT_APP' ? 'This booking can no longer be changed here. Contact the school to change it.' : 'Booked by the school. Contact the school to change it.'}</p>}
        </li>; })}</ul>}</section>}
    </>)}
    <footer className={s.footer}>Bookings go straight to your school’s schedule. No payment is taken and no message is sent.</footer>
  </div></main>;
}
