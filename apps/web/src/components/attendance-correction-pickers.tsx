'use client';
import React, { useEffect, useState } from 'react';
import type { ClassSessionRosterEntry, CurrentSchoolClassSession } from '@hon/contracts';
import { PickListView, type ListState } from './school-pickers/pickers';
import { RosterError, rosterApi, validFromDate, type Owned, type RosterApi, type RosterScope } from './class-roster/http';
import { SeriesError, classSeriesApi, type ClassSeriesApi } from './class-series/http';
import { addDays, localDateOf } from './school-calendar/range';
import { loadCalendarClasses } from './school-calendar/http';

/**
 * Pick-by-name controls for correcting one attendance record inside the school shell. Each list is an existing read of the
 * verified school (programs: the class-series read; classes: the session list; students: the class roster). Choosing a row
 * only fills the attendance page's own fields; the server re-checks every permission and record on each load and save.
 */
export const ROSTER_MAX_PAGES = 10;
export type Choice = Readonly<{ id: string; label: string }>;
export type ChoiceState = ListState<Choice>['state'];
/** A list read: its rows, whether more rows exist than were read, and (for classes) the school's time zone. */
export type Choices = Readonly<{ items: Choice[]; truncated: boolean; timeZone?: string }>;

export function classLabel(session: CurrentSchoolClassSession, timeZone: string, language = 'en'): string {
  const time = new Date(session.startsAt).toLocaleTimeString(language, { timeZone, hour: 'numeric', minute: '2-digit' });
  return [session.name, time, session.roomName, session.status === 'CANCELLED' ? 'Cancelled' : null].filter(Boolean).join(' · ');
}
export const studentLabel = (entry: Pick<ClassSessionRosterEntry, 'givenName' | 'familyName'>): string => `${entry.givenName} ${entry.familyName}`;

/** The browser's own calendar date, used only as the first date shown; the list itself is read in the school's zone. */
export function browserToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The classes that start on one school-local day, by name and start time. */
export async function loadClassChoices(api: Pick<RosterApi, 'sessions'>, scope: RosterScope, date: string, signal: AbortSignal, owned: Owned): Promise<Choices> {
  if (!validFromDate(date)) throw new RosterError('UNAVAILABLE');
  const read = await loadCalendarClasses(api, scope, { start: date, end: addDays(date, 1) }, signal, owned);
  const items = read.items.filter((s) => localDateOf(s.startsAt, read.timezone) === date).map((s) => ({ id: s.sessionId.toLowerCase(), label: classLabel(s, read.timezone) }));
  return { items, truncated: read.truncated, timeZone: read.timezone };
}

/** Every student on one class roster (booked or recorded), by name, up to ten pages; more than that is flagged. */
export async function loadStudentChoices(api: Pick<RosterApi, 'roster'>, scope: RosterScope, sessionId: string, signal: AbortSignal, owned: Owned): Promise<Choices> {
  const items: Choice[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < ROSTER_MAX_PAGES; page++) {
    const read = await api.roster(scope, sessionId, cursor, signal, owned);
    for (const entry of read.entries) {
      const id = entry.studentProfileId.toLowerCase();
      if (!seen.has(id)) { seen.add(id); items.push({ id, label: studentLabel(entry) }); }
    }
    if (read.nextCursor === null) return { items, truncated: false };
    cursor = read.nextCursor;
  }
  return { items, truncated: true };
}

export async function loadProgramChoices(api: Pick<ClassSeriesApi, 'list'>, scope: RosterScope, signal: AbortSignal, owned: Owned): Promise<Choices> {
  const read = await api.list(scope, signal, owned);
  return { items: [...read.programs].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.programId.toLowerCase(), label: p.name })), truncated: false };
}

const denied = (error: unknown) => (error instanceof RosterError || error instanceof SeriesError) && error.kind === 'DENIED';

/** One list read for the shown inputs; a newer input or unmount retires the older read. */
type Read = ListState<Choice> & { truncated?: boolean; timeZone?: string };
function useChoices(load: ((signal: AbortSignal, owned: Owned) => Promise<Choices>) | null, keys: readonly unknown[]): Read {
  const [list, setList] = useState<Read>({ state: 'LOADING' });
  useEffect(() => {
    if (!load) return undefined;
    let current = true;
    const abort = new AbortController();
    setList({ state: 'LOADING' });
    load(abort.signal, () => current).then(
      (read) => { if (current) setList({ state: 'READY', ...read }); },
      (error) => { if (current && !abort.signal.aborted) setList({ state: denied(error) ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, keys); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

type PickProps = Readonly<{ scope: RosterScope; value: string; disabled: boolean; onPick: (choice: Choice | null) => void; onState?: (state: ChoiceState) => void }>;
/** A list that could not show everyone reports UNAVAILABLE, so the page opens its ID fields beside it. */
function useReport(list: Read, onState?: (state: ChoiceState) => void): void {
  const state: ChoiceState = list.state === 'READY' && list.truncated ? 'UNAVAILABLE' : list.state;
  useEffect(() => { onState?.(state); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
}
const more = (list: Read, what: string) => list.state === 'READY' && list.truncated ? <p role="status">Not every {what} is listed here. If you can’t find one, enter its ID below.</p> : null;

export function ProgramChoice({ scope, value, disabled, onPick, onState, api = classSeriesApi }: PickProps & { api?: Pick<ClassSeriesApi, 'list'> }): React.ReactElement {
  const list = useChoices((signal, owned) => loadProgramChoices(api, scope, signal, owned), [scope.organizationId, scope.schoolId]);
  useReport(list, onState);
  return <PickListView copy={{ label: 'Program', choose: 'Choose a program', loading: 'Reading programs…', empty: 'This school has no programs yet.', denied: 'Your access does not include this school’s programs. You can enter the program ID below.', unavailable: 'Programs could not be loaded. You can enter the program ID below.' }}
    list={list} keyOf={(c) => c.id} describe={(c) => c.label} value={value} disabled={disabled} onPick={onPick} />;
}

export function ClassChoice({ scope, date, value, disabled, onPick, onState, onTimeZone, api = rosterApi }: PickProps & { date: string; onTimeZone?: (timeZone: string) => void; api?: Pick<RosterApi, 'sessions'> }): React.ReactElement {
  const list = useChoices(validFromDate(date) ? (signal, owned) => loadClassChoices(api, scope, date, signal, owned) : null, [scope.organizationId, scope.schoolId, date]);
  useReport(list, onState);
  useEffect(() => { if (list.timeZone) onTimeZone?.(list.timeZone); }, [list.timeZone]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{more(list, 'class')}<PickListView copy={{ label: 'Class', choose: 'Choose a class', loading: 'Reading classes…', empty: 'No classes on this day.', denied: 'Your access does not include this school’s classes. You can enter the class ID below.', unavailable: 'Classes could not be loaded. You can enter the class ID below.' }}
    list={list} keyOf={(c) => c.id} describe={(c) => c.label} value={value} disabled={disabled} onPick={onPick} /></>;
}

export function StudentChoice({ scope, sessionId, value, disabled, onPick, onState, api = rosterApi }: PickProps & { sessionId: string; api?: Pick<RosterApi, 'roster'> }): React.ReactElement {
  const list = useChoices((signal, owned) => loadStudentChoices(api, scope, sessionId, signal, owned), [scope.organizationId, scope.schoolId, sessionId]);
  useReport(list, onState);
  return <>{more(list, 'student')}<PickListView copy={{ label: 'Student', choose: 'Choose a student', loading: 'Reading the class roster…', empty: 'No one is booked on or recorded for this class.', denied: 'Your access does not include this class roster. You can enter the student ID below.', unavailable: 'The class roster could not be loaded. You can enter the student ID below.' }}
    list={list} keyOf={(c) => c.id} describe={(c) => c.label} value={value} disabled={disabled} onPick={onPick} /></>;
}
