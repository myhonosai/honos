'use client';
import React, { useEffect, useId, useState } from 'react';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from './class-sessions-read-http';
import { reportConfirmedSessionInvalidation } from './session-invalidation';
import { readSchoolClock, validTimeZone } from './school-time';

/**
 * Booking pickers for the school the shell verified: upcoming scheduled classes from the existing class-session read,
 * and the school's active students from the bookable-students read. Choosing only fills selectors; the booking command
 * still re-checks the session, student, school and permission itself.
 */
export type BookingScope = Readonly<{ organizationId: string; schoolId: string }>;
export type BookableStudent = Readonly<{ studentProfileId: string; givenName: string; familyName: string }>;
export type ListState<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly T[] };
export class BookingPickerError extends Error { constructor(readonly kind: 'DENIED' | 'UNAVAILABLE') { super(kind); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (): never => { throw new BookingPickerError('UNAVAILABLE'); };

export async function loadBookableStudents(scope: BookingScope, search: string, signal: AbortSignal): Promise<BookableStudent[]> {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) fail();
  const needle = search.trim().slice(0, 120);
  const path = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/schedule/bookable-students${needle ? `?${new URLSearchParams({ search: needle })}` : ''}`;
  let response: Response;
  try { response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal }); }
  catch (error) { if (signal.aborted) throw error; return fail(); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new BookingPickerError('DENIED'); }
  if (response.status === 403) throw new BookingPickerError('DENIED');
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail();
  let body: unknown; try { body = await response.json(); } catch { return fail(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') fail();
  const data = (body as { data: unknown }).data;
  if (!Array.isArray(data) || data.length > 50) fail();
  return (data as unknown[]).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'familyName,givenName,studentProfileId') fail();
    const r = row as Record<string, unknown>;
    if (typeof r.studentProfileId !== 'string' || !UUID.test(r.studentProfileId) || typeof r.givenName !== 'string' || typeof r.familyName !== 'string' || r.givenName.length > 500 || r.familyName.length > 500) fail();
    return Object.freeze({ studentProfileId: r.studentProfileId as string, givenName: r.givenName as string, familyName: r.familyName as string });
  });
}

export function bookableSessions(items: readonly CurrentSchoolClassSession[], now: number): CurrentSchoolClassSession[] {
  return items.filter((s) => s.status === 'SCHEDULED' && Date.parse(s.endsAt) > now).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
/** Times are shown in the school's timezone when it is known; otherwise they say UTC rather than guess. */
export function sessionLabel(s: CurrentSchoolClassSession, language: string, schoolTimezone: string | null = null): string {
  const zone = schoolTimezone && validTimeZone(schoolTimezone) ? schoolTimezone : 'UTC';
  const when = new Date(s.startsAt).toLocaleString(language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }) + (zone === 'UTC' ? ' UTC' : '');
  return [s.name, when, s.roomName].filter(Boolean).join(' · ');
}

export function BookingPickersView({ language, schoolTimezone = null, sessions, students, sessionId, studentProfileId, search, disabled, onSession, onStudent, onSearch }: {
  language: string; schoolTimezone?: string | null; sessions: ListState<CurrentSchoolClassSession>; students: ListState<BookableStudent>; sessionId: string; studentProfileId: string; search: string; disabled: boolean;
  onSession?: (id: string) => void; onStudent?: (id: string) => void; onSearch?: (text: string) => void;
}): React.ReactElement {
  const ids = { session: useId(), search: useId(), student: useId() };
  return <>
    {sessions.state === 'READY' ? (sessions.items.length ? <label htmlFor={ids.session}>Class</label> : <p role="status">No upcoming classes are scheduled. Add classes on the timetable first.</p>)
      : <p role="status">{sessions.state === 'LOADING' ? 'Reading upcoming classes…' : sessions.state === 'DENIED' ? 'Your access does not include this school’s classes.' : 'Classes could not be loaded. Nothing is shown.'}</p>}
    {sessions.state === 'READY' && sessions.items.length ? <select id={ids.session} required value={sessionId} disabled={disabled} onChange={(e) => onSession?.(e.target.value)}>
      <option value="">Choose a class</option>{sessions.items.map((s) => <option key={s.sessionId} value={s.sessionId}>{sessionLabel(s, language, schoolTimezone)}</option>)}</select> : null}
    {students.state === 'DENIED' ? <p role="status">Your access does not include booking students at this school.</p> : <>
      <label htmlFor={ids.search}>Find a student</label>
      <input id={ids.search} type="search" maxLength={120} autoComplete="off" value={search} disabled={disabled} onChange={(e) => onSearch?.(e.target.value)}/>
      {students.state === 'READY' ? (students.items.length ? <><label htmlFor={ids.student}>Student</label>
        <select id={ids.student} required value={studentProfileId} disabled={disabled} onChange={(e) => onStudent?.(e.target.value)}>
          <option value="">Choose a student</option>{students.items.map((s) => <option key={s.studentProfileId} value={s.studentProfileId}>{`${s.familyName}, ${s.givenName}`}</option>)}</select></>
        : <p role="status">No active students match. Students appear here once a membership is set up.</p>)
        : <p role="status">{students.state === 'LOADING' ? 'Reading students…' : 'Students could not be loaded. Nothing is shown.'}</p>}
    </>}
  </>;
}

export function ClassBookingPickers({ scope, sessionId, studentProfileId, disabled, onSession, onStudent }: {
  scope: BookingScope; sessionId: string; studentProfileId: string; disabled: boolean; onSession: (id: string) => void; onStudent: (id: string) => void;
}): React.ReactElement {
  const [sessions, setSessions] = useState<ListState<CurrentSchoolClassSession>>({ state: 'LOADING' });
  const [students, setStudents] = useState<ListState<BookableStudent>>({ state: 'LOADING' });
  const [search, setSearch] = useState('');
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    let current = true; const abort = new AbortController();
    readSchoolClock(scope, abort.signal).then((read) => { if (current && read.state === 'READY') setZone(read.clock.schoolTimezone); }, () => { /* labels say UTC */ });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let current = true; const abort = new AbortController();
    loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId, abort.signal).then(
      (items) => { if (current) setSessions({ state: 'READY', items: bookableSessions(items, Date.now()) }); },
      (error) => { if (current && !abort.signal.aborted) setSessions({ state: error instanceof ClassSessionsReadAccessError ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId]);
  useEffect(() => {
    let current = true; const abort = new AbortController();
    const timer = setTimeout(() => loadBookableStudents(scope, search, abort.signal).then(
      (items) => { if (current) setStudents({ state: 'READY', items }); },
      (error) => { if (current && !abort.signal.aborted) setStudents({ state: error instanceof BookingPickerError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); }), search ? 250 : 0);
    return () => { current = false; clearTimeout(timer); abort.abort(); };
  }, [scope.organizationId, scope.schoolId, search]); // eslint-disable-line react-hooks/exhaustive-deps
  return <BookingPickersView language={typeof navigator === 'undefined' ? 'en' : navigator.language} schoolTimezone={zone} sessions={sessions} students={students} sessionId={sessionId}
    studentProfileId={studentProfileId} search={search} disabled={disabled} onSession={onSession} onStudent={onStudent} onSearch={setSearch}/>;
}
