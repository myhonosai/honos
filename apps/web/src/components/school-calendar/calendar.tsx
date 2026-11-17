'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { RosterError, rosterApi, type RosterApi, type RosterScope } from '../class-roster/http';
import { useRosterDetail } from '../class-roster/use-roster-detail';
import { RosterSessionDetail } from '../class-roster/view';
import { ClassBookingWorkbench } from '../class-booking-workbench';
import { EventError, schoolEventsApi, type SchoolEventsApi } from '../school-events/http';
import { calendarText } from './copy';
import { loadCalendarClasses } from './http';
import { calendarRange, shiftAnchor, type CalendarView } from './range';
import { CalendarViewPane, type CalendarSelection, type ClassesState, type EventsState } from './view';
import styles from './school-calendar.module.css';

const classesError = (error: unknown): ClassesState => {
  const kind = error instanceof RosterError ? error.kind : 'UNAVAILABLE';
  return { state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' };
};
const signalFor = (abort: AbortController) => AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);

/**
 * School Calendar: the school's classes (0221 session list) and sale days and events (0261 list) on a day, week or month
 * calendar. A class opens its roster with attendance marks and the manual booking form, all through the existing APIs,
 * which re-check the school and the person's permission on every read and write. Privacy events hide the page at once
 * and retire every read; reads start again only after the shell re-verifies the school.
 */
export function SchoolCalendar({ api = rosterApi, events: eventsApi = schoolEventsApi, initialView = 'week', onManageEvent }: {
  api?: RosterApi; events?: Pick<SchoolEventsApi, 'list'>; initialView?: CalendarView; onManageEvent?: () => void;
}): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: RosterScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const school = selection ? `${selection.organizationId}:${selection.schoolId}`.toLowerCase() : null;
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [classes, setClasses] = useState<ClassesState>({ state: 'LOADING' });
  const [events, setEvents] = useState<EventsState>({ state: 'LOADING' });
  const [selected, setSelected] = useState<CalendarSelection>(null);
  const [booking, setBooking] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const privacy = useRef(0), mounted = useRef(false), generation = useRef(0), lastSchool = useRef<string | null>(null);
  const selectedClass = selected?.kind === 'class' ? selected.id : null;
  const detail = useRosterDetail(api, scope, selectedClass, privacy, mounted);
  const retire = () => { detail.retire(); generation.current++; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++;
    setClasses({ state: 'LOADING' }); setEvents({ state: 'LOADING' }); setSelected(null); setBooking(false); detail.clear();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setAnchor(null); setSelected(null); setBooking(false); setClassFilter(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  // Sale days and events: one read per school and refresh, filtered to the visible days by the view.
  useEffect(() => {
    if (!scope) return;
    const shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    setEvents({ state: 'LOADING' });
    eventsApi.list(scope, signalFor(abort), owned).then(
      (list) => { if (owned()) setEvents({ state: 'READY', events: list.events, timezone: list.timezone, localToday: list.localToday }); },
      (error) => { if (owned()) setEvents({ state: error instanceof EventError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [school, refresh, eventsApi]); // eslint-disable-line react-hooks/exhaustive-deps

  // Classes: before the first visible day is known, one page from the school's today tells the page what today is.
  useEffect(() => {
    if (!scope) return;
    const current = ++generation.current, shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && current === generation.current && shown === privacy.current && !abort.signal.aborted;
    setClasses({ state: 'LOADING' });
    if (anchor === null) {
      api.sessions(scope, null, null, signalFor(abort), owned).then(
        (page) => { if (owned()) setAnchor(page.localToday); },
        (error) => { if (owned()) setClasses(classesError(error)); });
    } else {
      const range = calendarRange(view, anchor);
      loadCalendarClasses(api, scope, range, signalFor(abort), owned).then(
        (read) => { if (owned()) setClasses({ state: 'READY', range, ...read }); },
        (error) => { if (owned()) setClasses(classesError(error)); });
    }
    return () => abort.abort();
  }, [school, anchor, view, refresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  // A school whose classes cannot be read still shows its events from the events' own today.
  useEffect(() => { if (anchor === null && classes.state !== 'LOADING' && events.state === 'READY') setAnchor(events.localToday); }, [anchor, classes.state, events]);

  // Escape closes the details drawer.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelected(null); setBooking(false); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const today = classes.state === 'READY' ? classes.localToday : events.state === 'READY' ? events.localToday : null;
  const onView = useCallback((next: CalendarView) => setView(next), []);
  const onShift = useCallback((step: 1 | -1) => setAnchor((a) => a === null ? a : shiftAnchor(view, a, step)), [view]);
  const onToday = useCallback(() => { if (today) setAnchor(today); }, [today]);
  const onSelect = useCallback((next: CalendarSelection) => { setSelected(next); setBooking(false); if (next?.kind === 'class') detail.reload(); }, [detail.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const onDay = useCallback((date: string) => { setAnchor(date); setView('day'); }, []);
  const onRefresh = useCallback(() => { setRefresh((n) => n + 1); detail.reload(); }, [detail.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = selectedClass && classes.state === 'READY' ? classes.items.find((s) => s.sessionId === selectedClass) ?? null : null;
  const t = (key: Parameters<typeof calendarText>[1], vars?: Record<string, string>) => calendarText(preferences.language, key, vars);
  const classDetail = session && scope && classes.state === 'READY' ? booking
    ? <article className={styles.card} aria-labelledby="calendar-book-title" data-testid="calendar-booking">
        <div className={styles.cardHead}><h3 id="calendar-book-title">{t('bookTitle', { name: session.name })}</h3>
          <button type="button" className={styles.secondary} onClick={() => { setBooking(false); detail.reload(); }}>{t('bookClose')}</button></div>
        <ClassBookingWorkbench key={session.sessionId} shellScope={scope}
          initialPrefill={{ organizationId: scope.organizationId.toLowerCase(), schoolId: scope.schoolId.toLowerCase(), sessionId: session.sessionId.toLowerCase() }}/>
      </article>
    : <RosterSessionDetail language={preferences.language} scope={scope} session={session} timeZone={classes.timezone} roster={detail.roster}
        onMore={detail.onMore} onReloadRoster={detail.reload} marks={detail.marks} onMark={detail.onMark} onBook={() => setBooking(true)}/>
    : null;

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <CalendarViewPane language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} hasScope={scope !== null}
      view={view} anchor={anchor} classes={classes} events={events} selected={session || selected?.kind === 'event' ? selected : null} classDetail={classDetail}
      onView={onView} onShift={onShift} onToday={onToday} onSelect={onSelect} onDay={onDay} onRefresh={onRefresh} onManageEvent={onManageEvent}
      classFilter={classFilter} onClassFilter={setClassFilter}/>
  </div>;
}
