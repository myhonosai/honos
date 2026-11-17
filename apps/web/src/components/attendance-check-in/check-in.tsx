'use client';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { ClassSessionRosterEntry, CurrentSchoolClassSession } from '@hon/contracts';
import { AttendanceWorkbenchUiError, loadRosterAttendance, saveRosterAttendance } from '../attendance-workbench-http';
import { RosterError, rosterApi, rosterCategory, type Owned, type RosterApi, type RosterScope } from '../class-roster/http';
import { localDateOf } from '../school-calendar/range';
import { StudentPicker } from '../school-pickers/pickers';
import type { PickerStudent } from '../school-pickers/http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { useClassByTime } from './class-by-time';
import styles from '../attendance-workbench.module.css';

/**
 * Front-desk check-in by the class schedule (owner, 2026-11-17): staff choose the class (or let the time of day choose
 * it) and check in any active student by name. A booking is never required; when the student is booked, the booking's
 * kind sets the attendance category, as on the roster. The one write is the existing attendance command, re-checked by
 * the server (attendance.record) on every check-in.
 */
export const MAX_PAGES = 10;
export type TodaysClasses = Readonly<{ items: readonly CurrentSchoolClassSession[]; timeZone: string; localToday: string }>;
const PRESENT_LIKE = ['PRESENT', 'LATE', 'MAKEUP'];

/** Today's classes (school day, school zone), not cancelled, in start order. */
export async function loadTodaysClasses(api: Pick<RosterApi, 'sessions'>, scope: RosterScope, signal: AbortSignal, owned: Owned): Promise<TodaysClasses> {
  const items: CurrentSchoolClassSession[] = [];
  let cursor: string | null = null, timeZone = '', localToday = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await api.sessions(scope, null, cursor, signal, owned);
    if (!localToday) { localToday = read.localToday; timeZone = read.schoolTimezone; }
    for (const s of read.items) {
      const day = localDateOf(s.startsAt, timeZone);
      if (day > localToday) return { items, timeZone, localToday };
      if (day === localToday && s.status !== 'CANCELLED') items.push(s);
    }
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  return { items, timeZone, localToday };
}

/** Everyone booked on or recorded for one class, up to ten pages. */
export async function loadRosterEntries(api: Pick<RosterApi, 'roster'>, scope: RosterScope, sessionId: string, signal: AbortSignal, owned: Owned): Promise<ClassSessionRosterEntry[]> {
  const entries: ClassSessionRosterEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await api.roster(scope, sessionId, cursor, signal, owned);
    entries.push(...read.entries);
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  return entries;
}

export type CheckInResult = 'CHECKED_IN' | 'ALREADY';
export type CheckInErrorKind = 'SESSION' | 'DENIED' | 'CHANGED' | 'REJECTED' | 'UNKNOWN';
export class CheckInError extends Error { constructor(readonly kind: CheckInErrorKind) { super(kind); } }

/**
 * Check one student in as Present. An existing Present, Late or make-up record is left as it is; an existing absence is
 * changed to Present with its own category, note and version. A new record takes the booking's category, or a regular
 * participant's when there is no booking.
 */
export async function checkInStudent(scope: RosterScope, sessionId: string, studentProfileId: string, booking: Pick<ClassSessionRosterEntry, 'booking' | 'attendance'> | null, key: string): Promise<CheckInResult> {
  const target = { organizationId: scope.organizationId.toLowerCase(), schoolId: scope.schoolId.toLowerCase(), sessionId: sessionId.toLowerCase(), studentProfileId: studentProfileId.toLowerCase() };
  try {
    const current = await loadRosterAttendance(target);
    if (current && PRESENT_LIKE.includes(current.status)) return 'ALREADY';
    const category = current?.category ?? rosterCategory(booking ?? { booking: null, attendance: null });
    await saveRosterAttendance(target, { studentProfileId: target.studentProfileId, status: 'PRESENT', category, note: current?.note ?? '', ...(current ? { expectedVersion: current.version } : {}) }, key);
    return 'CHECKED_IN';
  } catch (error) {
    const status = error instanceof AttendanceWorkbenchUiError ? error.status : 0;
    if (status === 401) { reportConfirmedSessionInvalidation(); throw new CheckInError('SESSION'); }
    throw new CheckInError(status === 403 ? 'DENIED' : status === 409 ? 'CHANGED' : status === 400 || status === 404 || status === 422 ? 'REJECTED' : 'UNKNOWN');
  }
}

const ERROR_TEXT: Record<CheckInErrorKind, string> = {
  SESSION: 'Your sign-in has ended. Sign in again to continue.',
  DENIED: 'Your access does not include checking students in at this school. Nothing was saved.',
  CHANGED: 'This student’s attendance changed a moment ago. Check them in again.',
  REJECTED: 'That student or class is not available at this school. Nothing was saved.',
  UNKNOWN: 'We could not confirm the check-in. Tap Check in again: it is never saved twice.',
};
export const classTime = (s: CurrentSchoolClassSession, timeZone: string, language = 'en') => `${new Date(s.startsAt).toLocaleTimeString(language, { timeZone, hour: 'numeric', minute: '2-digit' })} ${s.name}`;

type Classes = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' }> | Readonly<{ state: 'READY' } & TodaysClasses>;
type Roster = Readonly<{ sessionId: string; entries: readonly ClassSessionRosterEntry[] }>;
type Message = Readonly<{ kind: 'ok' | 'error'; text: string }> | null;

export function CheckInPanel({ scope, api = rosterApi }: { scope: RosterScope; api?: Pick<RosterApi, 'sessions' | 'roster'> }): React.ReactElement {
  const ids = { title: useId(), session: useId() };
  const [classes, setClasses] = useState<Classes>({ state: 'LOADING' });
  const [sessionId, setSessionId] = useState('');
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rosterTick, setRosterTick] = useState(0);
  const [student, setStudent] = useState<PickerStudent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const retained = useRef(new Map<string, string>());
  const [auto, setAuto] = useClassByTime(classes.state === 'READY' ? classes.items : null, setSessionId, busy);

  useEffect(() => {
    let current = true;
    const abort = new AbortController();
    setClasses({ state: 'LOADING' });
    loadTodaysClasses(api, scope, abort.signal, () => current).then(
      (read) => { if (current) setClasses({ state: 'READY', ...read }); },
      (error) => { if (current && !abort.signal.aborted) setClasses({ state: error instanceof RosterError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Who is booked on, or already checked in to, the chosen class. Only used for the booking's category and the list below.
  useEffect(() => {
    if (!sessionId) { setRoster(null); return undefined; }
    let current = true;
    const abort = new AbortController();
    loadRosterEntries(api, scope, sessionId, abort.signal, () => current).then(
      (entries) => { if (current) setRoster({ sessionId, entries }); },
      () => { if (current && !abort.signal.aborted) setRoster({ sessionId, entries: [] }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId, sessionId, rosterTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The class list (for a booked student's category) must be the chosen class's before a check-in is sent.
  const rosterReady = roster?.sessionId === sessionId;
  async function checkIn(): Promise<void> {
    if (busy || !student || !sessionId || !rosterReady) return;
    const who = `${student.givenName} ${student.familyName}`, slot = `${sessionId}/${student.studentProfileId.toLowerCase()}`;
    const key = retained.current.get(slot) ?? globalThis.crypto.randomUUID();
    retained.current.set(slot, key);
    const entry = roster!.entries.find((e) => e.studentProfileId.toLowerCase() === student.studentProfileId.toLowerCase()) ?? null;
    setBusy(true); setMessage(null);
    try {
      const result = await checkInStudent(scope, sessionId, student.studentProfileId, entry, key);
      retained.current.delete(slot);
      setMessage({ kind: 'ok', text: result === 'ALREADY' ? `${who} is already checked in.` : `${who} is checked in.` });
      setStudent(null);
      setRosterTick((n) => n + 1);
    } catch (error) {
      const kind = error instanceof CheckInError ? error.kind : 'UNKNOWN';
      if (kind !== 'UNKNOWN') retained.current.delete(slot);
      setMessage({ kind: 'error', text: ERROR_TEXT[kind] });
    } finally { setBusy(false); }
  }

  const checkedIn = roster && roster.sessionId === sessionId
    ? roster.entries.filter((e) => e.attendance && PRESENT_LIKE.includes(e.attendance.status)).map((e) => `${e.givenName} ${e.familyName}`) : [];
  return <section aria-labelledby={ids.title} data-check-in="">
    <h2 id={ids.title}>Check in</h2>
    <p>Choose the class, find the student and tap Check in. Students don’t need to be booked.</p>
    {classes.state === 'LOADING' && <p role="status">Reading today’s classes…</p>}
    {classes.state === 'DENIED' && <p role="status">Your access does not include this school’s classes.</p>}
    {classes.state === 'UNAVAILABLE' && <p role="status">Today’s classes could not be loaded. Reload the page to try again.</p>}
    {classes.state === 'READY' && (classes.items.length === 0 ? <p role="status">No classes are scheduled today. Add classes in the schedule first.</p> : <>
      <div className={styles.scopeGrid}>
        <label htmlFor={ids.session}>Class</label>
        <select id={ids.session} value={sessionId} disabled={busy} onChange={(e) => { setAuto(false); setSessionId(e.target.value); setMessage(null); }}>
          <option value="">Choose a class</option>
          {classes.items.map((s) => <option key={s.sessionId} value={s.sessionId}>{classTime(s, classes.timeZone)}</option>)}
        </select>
        <label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Choose the class by the time</label>
      </div>
      {sessionId && <>
        <StudentPicker scope={scope} purpose="attendance" value={student?.studentProfileId ?? ''} disabled={busy} onPick={(s) => { setStudent(s); setMessage(null); }} />
        <div className={styles.actions}><button type="button" disabled={busy || !student || !rosterReady} onClick={() => void checkIn()}>{busy ? 'Checking in…' : student ? `Check in ${student.givenName} ${student.familyName}` : 'Check in'}</button></div>
      </>}
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? styles.error : styles.notice}>{message.text}</p>}
      {sessionId && <p>{checkedIn.length ? `Checked in (${checkedIn.length}): ${checkedIn.join(', ')}` : 'No one is checked in to this class yet.'}</p>}
    </>)}
  </section>;
}
