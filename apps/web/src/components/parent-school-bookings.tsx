'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BookingTypeAnswer, ParentSchoolBooking, ParentSchoolBookings as View, ParentSchoolBookingTypeChoice, ParentSchoolEventChoice } from '@hon/contracts';
import {
  bookParentBookingType, bookParentEventSlot, cancelParentSchoolBooking, loadParentSchoolBookings, ParentSchoolBookingAccessError, ParentSchoolBookingRefusal,
  schoolBookingAttempt,
} from './parent-school-bookings-http';
import s from './testing-registration.module.css';

/** School-local calendar dates are shown as dates, never shifted by the viewer's time zone. */
function day(value: string) { return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Booking is unavailable right now.'; }
type Draft = Readonly<{ startsAt: string; answers: readonly BookingTypeAnswer[]; waiverAccepted: boolean }>;

export type ParentSchoolBookingsViewProps = Readonly<{
  view: View | null; busy: boolean; acting: string; error: string; notice: string; lost: boolean; drafts: Readonly<Record<string, Draft>>;
  onRefresh?: (() => void) | undefined; onBookSlot?: ((event: ParentSchoolEventChoice, slotId: string) => void) | undefined;
  onDraft?: ((typeId: string, draft: Draft) => void) | undefined; onBookType?: ((type: ParentSchoolBookingTypeChoice) => void) | undefined;
  onCancel?: ((booking: ParentSchoolBooking) => void) | undefined;
}>;

function draftOf(p: ParentSchoolBookingsViewProps, t: ParentSchoolBookingTypeChoice): Draft {
  return p.drafts[t.typeId] ?? { startsAt: '', answers: t.questions.map(() => null), waiverAccepted: false };
}

function TypeForm({ t, p }: { t: ParentSchoolBookingTypeChoice; p: ParentSchoolBookingsViewProps }) {
  const d = draftOf(p, t), set = (patch: Partial<Draft>) => p.onDraft?.(t.typeId, { ...d, ...patch });
  const answer = (i: number, value: BookingTypeAnswer) => set({ answers: d.answers.map((a, j) => (j === i ? value : a)) });
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onBookType?.(t); };
  const open = t.times.filter((x) => x.spotsLeft > 0);
  if (!open.length) return <p className={s.empty}>No times are open right now.</p>;
  return <form onSubmit={submit} data-testid="parent-type-form"><fieldset disabled={!!p.acting}>
    <label>Time<select required value={d.startsAt} onChange={(e) => set({ startsAt: e.target.value })}>
      <option value="">Pick a time</option>
      {open.map((x) => <option key={x.startsAt} value={x.startsAt}>{day(x.localDate)}, {x.localStart}–{x.localEnd} ({x.spotsLeft} left)</option>)}
    </select></label>
    {t.questions.map((q, i) => q.kind === 'TEXT'
      ? <label key={i}>{q.label}{q.required ? '' : ' (optional)'}<input required={q.required} maxLength={300} value={typeof d.answers[i] === 'string' ? d.answers[i] as string : ''} onChange={(e) => answer(i, e.target.value)}/></label>
      : <fieldset key={i}><legend>{q.label}{q.required ? '' : ' (optional)'}</legend>
        <label><input type="radio" name={`${t.typeId}-q${i}`} required={q.required} checked={d.answers[i] === true} onChange={() => answer(i, true)}/>Yes</label>
        <label><input type="radio" name={`${t.typeId}-q${i}`} required={q.required} checked={d.answers[i] === false} onChange={() => answer(i, false)}/>No</label></fieldset>)}
    {t.waiver ? <>
      <div className={s.boundary} style={{ whiteSpace: 'pre-line', maxHeight: 200, overflowY: 'auto' }} data-testid="parent-type-waiver">{t.waiver}</div>
      <label><input type="checkbox" required checked={d.waiverAccepted} onChange={(e) => set({ waiverAccepted: e.target.checked })}/>I have read and accept this.</label></> : null}
    <p><button type="submit" disabled={!d.startsAt}>{p.acting === t.typeId ? 'Booking…' : 'Book this time'}</button></p>
  </fieldset></form>;
}

/** The page body, from verified reads only. Other families never appear; only open spots are shown. */
export function ParentSchoolBookingsView(p: ParentSchoolBookingsViewProps): React.ReactElement {
  const v = p.view;
  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent" prefetch={false} className={s.wordmark}>HON <span>Events &amp; bookings</span></Link><Link href="/parent/classes" prefetch={false}>Book a class</Link></nav>
    <header className={s.header}><p>YOUR FAMILY</p><h1>Events &amp; bookings</h1><p>School events with open times, and bookings your school offers to current families, like a belt test. Times are in the school’s time zone.</p></header>
    <p className={s.actions}><button type="button" disabled={p.busy || !!p.acting} onClick={p.onRefresh}>{p.busy ? 'Loading…' : 'Refresh'}</button></p>
    <div aria-live="polite" aria-atomic="true">
      {p.error && <div className={s.error} role="alert"><strong>{p.lost ? 'Not available on this account' : 'That did not go through'}</strong><p>{p.error}</p>{p.lost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}
      {p.notice && <p className={s.notice} role="status">{p.notice}</p>}
    </div>
    {!p.busy && v && <>
      {!v.canBook && <aside className={s.boundary}><strong>View only</strong><p>{v.contact ? 'Your access to this family lets you see these times but not book them. A guardian on the account can book.'
        : 'Your account has no email the school can use for a booking. Please contact the school.'}</p></aside>}
      {v.canBook && v.contact && <p className={s.subtle} data-testid="parent-booking-contact">Bookings are made as {v.contact.name}, {v.contact.email}.</p>}
      <section className={s.card} aria-labelledby="mine-title"><h2 id="mine-title">Your upcoming bookings</h2>
        {!v.bookings.length ? <p className={s.empty}>No upcoming bookings made here.</p> : <ul className={s.list}>{v.bookings.map((b) => <li key={b.bookingId} data-testid="parent-school-booking">
          <strong>{b.title}</strong><p>{day(b.localDate)}, {b.localStart}–{b.localEnd}</p>
          <p><span className={s.badge}>{b.status === 'ARRIVED' ? 'Checked in' : 'Booked'}</span></p>
          {v.canBook && b.canCancel && <button type="button" disabled={!!p.acting} onClick={() => p.onCancel?.(b)}>{p.acting === b.bookingId ? 'Cancelling…' : 'Cancel booking'}</button>}
        </li>)}</ul>}
      </section>
      <section className={s.card} aria-labelledby="events-title"><h2 id="events-title">School events</h2>
        {!v.events.length ? <p className={s.empty}>No school events are taking bookings right now.</p> : <ul className={s.list}>{v.events.map((e) => <li key={e.eventId} data-testid="parent-event">
          <strong>{e.title}</strong><p>{day(e.localDate)}{e.place ? ` · ${e.place}` : ''}</p>{e.description ? <p>{e.description}</p> : null}
          {e.bookingId ? <p><span className={s.badge}>Your family is booked</span></p>
            : <p className={s.actions}>{e.slots.map((x) => <button key={x.slotId} type="button" disabled={!v.canBook || x.spotsLeft < 1 || !!p.acting} onClick={() => p.onBookSlot?.(e, x.slotId)}>
              {x.localStart}–{x.localEnd} · {x.spotsLeft > 0 ? `${x.spotsLeft} left` : 'Full'}</button>)}</p>}
        </li>)}</ul>}
      </section>
      <section className={s.card} aria-labelledby="types-title"><h2 id="types-title">Family bookings</h2>
        {!v.bookingTypes.length ? <p className={s.empty}>Your school has no family bookings open right now.</p> : <ul className={s.list}>{v.bookingTypes.map((t) => <li key={t.typeId} data-testid="parent-type">
          <strong>{t.name}</strong><p>{t.durationMinutes} minutes</p>{t.description ? <p style={{ whiteSpace: 'pre-line' }}>{t.description}</p> : null}
          {t.bookingId ? <p><span className={s.badge}>Your family is booked</span></p> : v.canBook ? <TypeForm t={t} p={p}/> : null}
        </li>)}</ul>}
      </section>
    </>}
    <footer className={s.footer}>Bookings go straight to your school. No payment is taken and no message is sent.</footer>
  </div></main>;
}

/** Parents book school event slots and families-only booking types, and cancel bookings they made here (0448). Reads never act. */
export function ParentSchoolBookings(): React.ReactElement {
  const [view, setView] = useState<View | null>(null), [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(true), [acting, setActing] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [lost, setLost] = useState(false);
  const generation = useRef(0), attempt = useRef<{ action: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setBusy(true); setError(''); setLost(false);
    try {
      const data = await loadParentSchoolBookings();
      if (generation.current === token) setView(data);
    } catch (problem) {
      if (generation.current !== token) return;
      setView(null); setError(failure(problem)); setLost(problem instanceof ParentSchoolBookingAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { if (document.visibilityState === 'hidden') { ++generation.current; setView(null); setDrafts({}); attempt.current = null; } else void load(); };
    document.addEventListener('visibilitychange', hide);
    return () => { ++generation.current; document.removeEventListener('visibilitychange', hide); };
  }, [load]);

  async function run(id: string, action: string, send: (key: string) => Promise<unknown>, done: string): Promise<boolean> {
    if (acting) return false;
    attempt.current = schoolBookingAttempt(action, attempt.current, () => crypto.randomUUID());
    setActing(id); setError(''); setNotice('');
    try {
      await send(attempt.current.key);
      attempt.current = null; setNotice(done);
      await load();
      return true;
    } catch (problem) {
      setError(failure(problem));
      // An unknown outcome (5xx or no answer) keeps the key so the same action retries exactly; a definite refusal does not.
      if (problem instanceof ParentSchoolBookingAccessError) { setLost(true); setView(null); attempt.current = null; } else if (problem instanceof ParentSchoolBookingRefusal) attempt.current = null;
      return false;
    } finally { setActing(''); }
  }
  const onBookSlot = (e: ParentSchoolEventChoice, slotId: string) => {
    const x = e.slots.find((y) => y.slotId === slotId);
    void run(slotId, `slot:${slotId}`, (key) => bookParentEventSlot(slotId, key), `Booked: ${e.title}, ${day(e.localDate)} at ${x?.localStart ?? ''}.`);
  };
  const onBookType = (t: ParentSchoolBookingTypeChoice) => {
    const d = drafts[t.typeId] ?? { startsAt: '', answers: t.questions.map(() => null), waiverAccepted: false };
    const answers = t.questions.map((q, i) => { const a = d.answers[i] ?? null; return q.kind === 'TEXT' ? (typeof a === 'string' ? a.trim() : '') : (typeof a === 'boolean' ? a : null); });
    const input = { typeId: t.typeId, startsAt: d.startsAt, answers, waiverAccepted: t.waiver !== '' && d.waiverAccepted };
    const x = t.times.find((y) => y.startsAt === d.startsAt);
    void run(t.typeId, `type:${JSON.stringify(input)}`, (key) => bookParentBookingType(input, key), `Booked: ${t.name}, ${x ? `${day(x.localDate)} at ${x.localStart}` : ''}.`)
      .then((booked) => { if (booked) setDrafts((all) => { const next = { ...all }; delete next[t.typeId]; return next; }); });
  };
  const onCancel = (b: ParentSchoolBooking) => {
    void run(b.bookingId, `cancel:${b.bookingId}:${b.version}`, (key) => cancelParentSchoolBooking(b.bookingId, b.version, key), `Cancelled: ${b.title}, ${day(b.localDate)} at ${b.localStart}.`);
  };
  return <ParentSchoolBookingsView view={view} busy={busy} acting={acting} error={error} notice={notice} lost={lost} drafts={drafts}
    onRefresh={() => void load()} onBookSlot={onBookSlot} onDraft={(typeId, draft) => { setDrafts((all) => ({ ...all, [typeId]: draft })); attempt.current = null; }}
    onBookType={onBookType} onCancel={onCancel}/>;
}
