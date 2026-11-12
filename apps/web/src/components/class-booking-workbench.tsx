'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { GenericClassBookingKind } from '@hon/contracts';
import {
  ClassBookingAccessError, ClassBookingUncertainError, MANUAL_CLASS_BOOKING_KINDS,
  prepareClassBooking, submitClassBooking, validateClassBookingDraft,
  type ClassBookingKnownIds, type ClassBookingWorkbenchResult, type PreparedClassBooking,
} from './class-booking-workbench-http';
import { exactClassBookingSelectorPrefill, type ClassBookingSelectorPrefill } from './class-booking-selector-prefill';
import { ClassBookingPickers, type BookingScope } from './class-booking-pickers';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: ClassBookingKnownIds = { organizationId: '', schoolId: '', sessionId: '', studentProfileId: '' };
const ID_LABELS: Record<keyof ClassBookingKnownIds, string> = {
  organizationId: 'Organization UUID', schoolId: 'School UUID', sessionId: 'Class session UUID', studentProfileId: 'Student profile UUID',
};
export type ClassBookingWorkbenchPrefill = ClassBookingSelectorPrefill;

function initialIds(prefill: unknown): ClassBookingKnownIds {
  const selectors = exactClassBookingSelectorPrefill(prefill);
  return { organizationId: selectors?.organizationId ?? '', schoolId: selectors?.schoolId ?? '', sessionId: selectors?.sessionId ?? '', studentProfileId: '' };
}

/** With a shell school, the school comes from the shell; a class or student picked at another school is dropped. */
export function shellBookingIds(rawIds: ClassBookingKnownIds, shellScope: BookingScope | null): ClassBookingKnownIds {
  if (!shellScope) return rawIds;
  const moved = rawIds.schoolId !== '' && rawIds.schoolId.toLowerCase() !== shellScope.schoolId.toLowerCase();
  return { organizationId: shellScope.organizationId, schoolId: shellScope.schoolId, sessionId: moved ? '' : rawIds.sessionId, studentProfileId: moved ? '' : rawIds.studentProfileId };
}

/** Conventional canonical booking only; IDs are untrusted selectors, not authority. */
export function ClassBookingWorkbench({ initialPrefill, shellScope = null }: { initialPrefill?: unknown; shellScope?: BookingScope | null } = {}): React.ReactElement {
  const [rawIds, setIds] = useState<ClassBookingKnownIds>(initialIds(initialPrefill));
  // With a shell-verified school, the school selectors come from the shell and staff pick the class and student by name.
  const ids = shellBookingIds(rawIds, shellScope);
  const [bookingKind, setBookingKind] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedClassBooking | null>(null);
  const [result, setResult] = useState<ClassBookingWorkbenchResult | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const submitted = useRef(false);
  const retained = useRef<PreparedClassBooking | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  // Cleanup only, never an effect-triggered request or key allocation.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; retained.current = null; };
  }, []);

  let valid = false;
  try { validateClassBookingDraft(ids, bookingKind); valid = true; } catch { /* local invalid draft */ }

  function edit(change: () => void): void {
    if (active.current || !mounted.current) return;
    epoch.current++; change(); submitted.current = false; retained.current = null;
    setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setError('');
  }
  function discard(): void {
    edit(() => { setIds(EMPTY_IDS); setBookingKind(''); });
  }
  function clearAccess(): void {
    epoch.current++; submitted.current = false; retained.current = null;
    setIds(EMPTY_IDS); setBookingKind(''); setConfirmed(false); setAttempted(false); setRetry(null); setResult(null);
  }
  async function send(command: PreparedClassBooking): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current;
    active.current = true; submitted.current = true; retained.current = null;
    setBusy(true); setAttempted(true); setRetry(null); setResult(null); setError('');
    try {
      const receipt = await submitClassBooking(command);
      if (mounted.current && generation === epoch.current) setResult(receipt);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof ClassBookingAccessError) clearAccess();
      else if (caught instanceof ClassBookingUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified booking receipt.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || submitted.current || !confirmed || !mounted.current) return;
    try {
      // Validate before generating the one key for this direct human submission.
      validateClassBookingDraft(ids, bookingKind);
      void send(prepareClassBooking(ids, bookingKind as GenericClassBookingKind, crypto.randomUUID()));
    } catch { setError('Enter the four exact already-known UUIDs and one permitted booking kind. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedClassBooking): void {
    if (retained.current !== command || active.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / CONVENTIONAL STAFF OPERATIONS</p><h1>Manual class booking</h1>
      <p>Record one exact student/session booking through the existing canonical staff command. This page starts idle: a closed URL handoff may prefill only three untrusted selectors; there is no lookup, search, roster, directory, calendar or automatic request.</p>
    </header>
    <aside><strong>Current school authority stays server-owned.</strong>
      <p>The four IDs are untrusted selectors. The existing server authorization, tenant RLS and current <code>schedule.booking.manage</code> gates remain authoritative. Capacity and waitlist decisions are made only by the canonical booking service.</p>
      <p>This workbench does not infer identity, enrollment, eligibility or availability; manage sessions; grant ClassPass; or create attendance, progression, testing, membership, payment, messages, provider, AI, Action Engine or automation effects. Canonical booking audit/outbox evidence is unchanged.</p>
    </aside>
    <section aria-labelledby="booking-command"><h2 id="booking-command">Exact-known-ID booking command</h2>
      <p>Use already-known organization, current school, class session and student profile UUIDs. A closed handoff may prefill only exact organization, school and class-session UUID selectors; student profile remains blank, booking kind remains unselected, and confirmation remains required. No other query selector is accepted. A booking kind is intent only, not an eligibility or makeup approval decision.</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{shellScope ? <ClassBookingPickers scope={shellScope} sessionId={ids.sessionId} studentProfileId={ids.studentProfileId} disabled={busy}
            onSession={value => edit(() => setIds({ ...ids, sessionId: value }))} onStudent={value => edit(() => setIds({ ...ids, studentProfileId: value }))}/>
          : (Object.keys(ID_LABELS) as (keyof ClassBookingKnownIds)[]).map(field =>
          <label key={field}>{ID_LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}
          <label>Booking kind<select name="bookingKind" required value={bookingKind} onChange={event => edit(() => setBookingKind(event.target.value))}>
            <option value="">Choose a booking kind</option>{MANUAL_CLASS_BOOKING_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select></label>
        </div>
        <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={attempted || !valid} onChange={event => setConfirmed(event.target.checked)} />I explicitly confirm this exact current-school booking command only.</label>
        <div className={styles.actions}><button type="submit" disabled={!valid || !confirmed || attempted}>Submit manual class booking</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
      {busy && <p role="status">Submitting the exact human booking command…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {retry && <div className={styles.warning}><p>Only this exact path, body and UUID key are retained in memory. No automatic retry occurs. Editing or discarding removes the retry; the earlier uncertain command may still have recorded a booking. Seek staff review before submitting a different command.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged booking command</button></div>}
      {!result && !busy && <p className={styles.empty}>No verified booking receipt is shown.</p>}
    </section>
    {result && <section aria-label="Returned booking receipt" className={styles.record}>
      <h2>Returned booking receipt: {result.booking.status}</h2>
      <p>{result.replayed ? 'Replayed or previously recorded booking receipt.' : 'Recorded booking receipt.'} This is a command-response snapshot, not a live booking status.</p>
      <dl>
        <dt>Booking UUID</dt><dd>{result.booking.id}</dd>
        <dt>Class session UUID</dt><dd>{result.booking.classSessionId}</dd>
        <dt>Student profile UUID</dt><dd>{result.booking.studentProfileId}</dd>
        <dt>Returned kind / source</dt><dd>{result.booking.bookingKind} / {result.booking.source}</dd>
        <dt>Returned booking version</dt><dd>{result.booking.version}</dd>
        <dt>Booked at</dt><dd>{result.booking.bookedAt}</dd>
        <dt>Created / updated at</dt><dd>{result.booking.createdAt} / {result.booking.updatedAt}</dd>
        <dt>Returned session capacity</dt><dd>{result.booking.sessionCapacity}</dd>
        <dt>Returned active seat count</dt><dd>{result.booking.activeSeatCount}</dd>
        <dt>Returned booking policy</dt><dd>{result.booking.bookingPolicy}</dd>
      </dl>
      <p>{result.booking.status === 'WAITLISTED' ? 'WAITLISTED is not a confirmed seat or a future promotion promise.' : 'BOOKED is the returned record status, not a seat guarantee.'} Neither status establishes attendance, eligibility, availability, enrollment, identity, makeup approval, ClassPass allowance, payment, membership, parent access or communication.</p>
      <p>Capacity, count and policy are returned facts only, not editable policy or a current availability calculation. WALK_IN can legitimately record above capacity.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only retries are memory-only. Input edits reset confirmation, receipt and retry; access loss clears them. Remount/reload discards the retry. No booking list or current-status refresh is provided.</p>
  </main>;
}
