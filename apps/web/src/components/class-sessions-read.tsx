'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from './class-sessions-read-http';
import styles from './attendance-workbench.module.css';

const EMPTY_SCOPE = { organizationId: '', schoolId: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function display(value: string): string { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(value)) + ' UTC'; }
function validScope(scope: typeof EMPTY_SCOPE): boolean { return UUID.test(scope.organizationId) && UUID.test(scope.schoolId); }

/** Deliberately bounded read/selection aid; it never creates a booking or changes a session. */
export function ClassSessionsRead(): React.ReactElement {
  const [scope, setScope] = useState(EMPTY_SCOPE);
  const [sessions, setSessions] = useState<CurrentSchoolClassSession[] | null>(null);
  const [selected, setSelected] = useState<CurrentSchoolClassSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  function edit(next: typeof EMPTY_SCOPE): void {
    if (busy) return;
    generation.current += 1; setScope(next); setSessions(null); setSelected(null); setError('');
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !validScope(scope)) { setSessions(null); setSelected(null); setError('Enter exact already-known organization and current-school UUIDs. No request was sent.'); return; }
    const current = ++generation.current;
    setBusy(true); setSessions(null); setSelected(null); setError('');
    try {
      const list = await loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId);
      if (current === generation.current) setSessions(list);
    } catch (reason) {
      if (current !== generation.current) return;
      if (reason instanceof ClassSessionsReadAccessError) { setScope(EMPTY_SCOPE); }
      setSessions(null); setSelected(null); setError(reason instanceof Error ? reason.message : 'Class Sessions is unavailable.');
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/schedule/sessions/create">Create a class session</a><a href="/staff/schedule/bookings">Manual class booking</a></nav>
    <header><p>HON / CONVENTIONAL STAFF OPERATIONS</p><h1>Class Sessions</h1><p>Select from one bounded, current-school operational session list. This page begins blank and makes no request until you enter an exact current-school scope and explicitly load it.</p></header>
    <aside><strong>Not availability, roster, or a seat guarantee.</strong><p>The list covers sessions whose start is from 00:00 UTC 30 calendar days before today through (but excluding) 00:00 UTC 91 days after today: today through 90 days forward. It returns at most 50 sessions, ordered by start then ID. Authorization is independently rechecked on every read.</p><p>It does not show or infer instructors, students, roster, families, enrollment, eligibility, attendance, bookings or waitlist, ClassPass, membership/payment, providers, AI, Action Engine, aggregates, availability, or any write effect.</p></aside>
    <section aria-labelledby="current-school-sessions"><h2 id="current-school-sessions">Current school scope</h2><p>Organization and school UUIDs are untrusted selectors only. The server and fixed database projection independently establish the signed-in direct human, exact school, <code>schedule.session.read</code> permission, active entitlement, and RLS boundary.</p>
      <form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}><div className={styles.scopeGrid}><label>Organization UUID<input name="organizationId" required autoComplete="off" spellCheck={false} maxLength={36} value={scope.organizationId} onChange={(event) => edit({ ...scope, organizationId: event.target.value })} /></label><label>Current school UUID<input name="schoolId" required autoComplete="off" spellCheck={false} maxLength={36} value={scope.schoolId} onChange={(event) => edit({ ...scope, schoolId: event.target.value })} /></label></div><div className={styles.actions}><button type="submit" disabled={!validScope(scope)}>{busy ? 'Loading bounded sessions…' : 'Load bounded Class Sessions'}</button><button type="button" onClick={() => edit(EMPTY_SCOPE)}>Clear scope and results</button></div></fieldset></form>
      {busy && <p role="status">Verifying current-school authority and loading the bounded session list…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
      {sessions === null && !busy && !error && <p className={styles.empty}>No session list is shown until a current school is explicitly loaded.</p>}
      {sessions && sessions.length === 0 && <p className={styles.empty}>No sessions are returned in this fixed bounded window. This is not an availability or seat result.</p>}
    </section>
    {sessions && sessions.length > 0 && <section aria-labelledby="returned-sessions"><h2 id="returned-sessions">Bounded returned sessions</h2><p>Choose one returned operational record. Selecting a row is local-only; it does not book, reserve, waitlist, check in, change, or guarantee a session.</p><div className={styles.records}>{sessions.map((session) => <article key={session.sessionId} className={styles.record} aria-label={`Class session ${session.name}`}><div className={styles.actions}><strong>{session.name}</strong><button type="button" onClick={() => setSelected(session)} aria-pressed={selected?.sessionId === session.sessionId}>{selected?.sessionId === session.sessionId ? 'Selected' : 'Select session'}</button></div><dl><dt>UTC start / end</dt><dd>{display(session.startsAt)} / {display(session.endsAt)}</dd><dt>Room</dt><dd>{session.roomName ?? 'No room recorded'}</dd><dt>Capacity / booking policy</dt><dd>{session.capacity} / {session.bookingPolicy}</dd><dt>Persisted status</dt><dd>{session.status}</dd><dt>Created at</dt><dd>{display(session.createdAt)}</dd></dl></article>)}</div></section>}
    {selected && <section aria-label="Selected class session" className={styles.record}><h2>Selected session</h2><p><strong>{selected.name}</strong> is selected in this browser only. Its technical ID is intentionally not needed to make this selection.</p><p>This selection does not establish eligibility, instructor availability, booking/waitlist, attendance, enrollment, capacity/seat guarantee, ClassPass, membership/payment, or any action. If a separate manual booking is needed, that independent workflow reauthorizes every exact selector.</p><a href="/staff/schedule/bookings">Open independent manual booking workflow</a></section>}
    <p>Scope inputs, bounded results and selection remain memory-only. Editing scope, clearing, access loss, remounting or reload clears them. No polling, search, calendar integration, auto-selection, automatic booking, mutation or retry occurs.</p>
  </main>;
}
