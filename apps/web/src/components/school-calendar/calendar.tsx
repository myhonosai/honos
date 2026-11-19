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
import type { CreateCalendarCardInput } from '@hon/contracts';
import { CalendarCardForm, initialCardForm } from './card-form';
import { CardError, calendarCardsApi, type CalendarCardsApi } from './cards-http';
import { calendarText, type CalendarKey } from './copy';
import { zonedInstant } from './drag';
import { loadCalendarClasses } from './http';
import { addDays, calendarRange, closedDays, localDateOf, localMinutesOf, shiftAnchor, type CalendarView } from './range';
import { calendarSettingsApi, type CalendarSettingsApi } from './settings-http';
import { CalendarViewPane, type CalendarSelection, type CardsState, type ClassesState, type EventsState, type PendingMove } from './view';
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
type Pending = PendingMove & Readonly<{ startsAt: string; endsAt: string; version: number; name: string; booked: number; done?: boolean }>;
type Creating = Readonly<{ date: string; minutes: number; key: string; busy: boolean; error: string | null; serial: number }>;
/** `confirm` asks about moving a booked class; `ask` asks before adding or moving onto a closed day (0552). */
type Message = Readonly<{ text: string; confirm?: boolean; ask?: () => void }>;
const newKey = () => crypto.randomUUID();
/** The next whole hour in school time, today; after 11 PM, 9 AM tomorrow. */
export function nextWholeHour(localToday: string, nowMinutes: number): { date: string; minutes: number } {
  const next = (Math.floor(nowMinutes / 60) + 1) * 60;
  return next >= 24 * 60 ? { date: addDays(localToday, 1), minutes: 9 * 60 } : { date: localToday, minutes: next };
}

export function SchoolCalendar({ api = rosterApi, events: eventsApi = schoolEventsApi, cardsApi = calendarCardsApi, blockOutsApi = calendarSettingsApi, initialView = 'week', onManageEvent, addSignal = 0 }: {
  api?: RosterApi; events?: Pick<SchoolEventsApi, 'list'>; cardsApi?: CalendarCardsApi; blockOutsApi?: Pick<CalendarSettingsApi, 'blockOuts'>; initialView?: CalendarView; onManageEvent?: () => void;
  /** Each increase opens the create form at the next whole hour today ("Add a class"). */
  addSignal?: number;
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
  const [classFilter, setClassFilter] = useState<readonly string[]>([]);
  const [programFilter, setProgramFilter] = useState<readonly string[]>([]);
  const [instructorFilter, setInstructorFilter] = useState<readonly string[]>([]);
  const [cards, setCards] = useState<CardsState>({ state: 'LOADING' });
  const [closed, setClosed] = useState<ReadonlyMap<string, string>>(new Map());
  const [creating, setCreating] = useState<Creating | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const writes = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const privacy = useRef(0), mounted = useRef(false), generation = useRef(0), lastSchool = useRef<string | null>(null);
  const selectedClass = selected?.kind === 'class' ? selected.id : null;
  const detail = useRosterDetail(api, scope, selectedClass, privacy, mounted);
  const retire = () => { detail.retire(); generation.current++; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++;
    setClasses({ state: 'LOADING' }); setEvents({ state: 'LOADING' }); setSelected(null); setBooking(false); detail.clear();
    setCards({ state: 'LOADING' }); setCreating(null); setPending(null); setMessage(null); writes.current++;
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setAnchor(null); setSelected(null); setBooking(false); setClassFilter([]);
      setProgramFilter([]); setInstructorFilter([]); setCreating(null); setPending(null); setMessage(null); writes.current++; }
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

  // Card details (0551) for the same visible days: kind, program, roster, lead instructor, booked count, and what a manager may pick.
  useEffect(() => {
    if (!scope || anchor === null) return;
    const shown = privacy.current, abort = new AbortController(), range = calendarRange(view, anchor);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    cardsApi.read(scope, range.start, addDays(range.end, -1), signalFor(abort), owned).then(
      (read) => { if (owned()) setCards({ state: 'READY', byId: new Map(read.cards.map((c) => [c.sessionId, c])), canManage: read.canManage, programs: read.programs, instructors: read.instructors }); },
      () => { if (owned()) setCards({ state: 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [school, anchor, view, refresh, cardsApi]); // eslint-disable-line react-hooks/exhaustive-deps

  // Block-out dates (0552) for the same visible days. A school whose block-outs cannot be read shows no closed days.
  useEffect(() => {
    if (!scope || anchor === null) return;
    const shown = privacy.current, abort = new AbortController(), range = calendarRange(view, anchor), last = addDays(range.end, -1);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    setClosed(new Map());
    blockOutsApi.blockOuts(scope, range.start, last, signalFor(abort), owned).then(
      (read) => { if (owned()) setClosed(closedDays(read.blockOuts, range.start, last)); }, () => { /* no closed days shown */ });
    return () => abort.abort();
  }, [school, anchor, view, refresh, blockOutsApi]); // eslint-disable-line react-hooks/exhaustive-deps

  // A confirmed move keeps its ghost until the calendar has been read again, so the card never jumps back first.
  useEffect(() => { if (pending?.done && classes.state !== 'LOADING') setPending(null); }, [classes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A school whose classes cannot be read still shows its events from the events' own today.
  useEffect(() => { if (anchor === null && classes.state !== 'LOADING' && events.state === 'READY') setAnchor(events.localToday); }, [anchor, classes.state, events]);

  // Escape closes the details drawer.
  useEffect(() => {
    if (!selected && !creating) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelected(null); setBooking(false); setCreating((c) => c?.busy ? c : null); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [selected, creating]);

  const today = classes.state === 'READY' ? classes.localToday : events.state === 'READY' ? events.localToday : null;
  const onView = useCallback((next: CalendarView) => setView(next), []);
  const onShift = useCallback((step: 1 | -1) => setAnchor((a) => a === null ? a : shiftAnchor(view, a, step)), [view]);
  const onToday = useCallback(() => { if (today) setAnchor(today); }, [today]);
  const onSelect = useCallback((next: CalendarSelection) => { setSelected(next); setBooking(false); setCreating((c) => c?.busy ? c : null); if (next?.kind === 'class') detail.reload(); }, [detail.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const onDay = useCallback((date: string) => { setAnchor(date); setView('day'); }, []);
  const onRefresh = useCallback(() => { setRefresh((n) => n + 1); detail.reload(); }, [detail.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = (key: CalendarKey, vars?: Record<string, string>) => calendarText(preferences.language, key, vars);
  const manage = cards.state === 'READY' && cards.canManage;
  const zone = classes.state === 'READY' ? classes.timezone : null;
  const errorText = (error: unknown) => t(`err${error instanceof CardError ? error.kind : 'UNKNOWN'}` as CalendarKey);
  const dayName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(preferences.language, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  /** On a closed day, asks first and runs `go` on Continue; otherwise runs it now. A block-out never refuses a class. */
  const askIfClosed = (date: string, go: () => void) => {
    const label = closed.get(date);
    if (label === undefined) { go(); return; }
    setMessage({ text: t('blockedAsk', { date: dayName(date), label }), ask: () => { setMessage(null); go(); } });
  };
  const openCreate = useCallback((date: string, minutes: number) => {
    if (!manage) { setMessage({ text: t('cannotManage') }); return; }
    setSelected(null); setBooking(false); setMessage(null);
    askIfClosed(date, () => setCreating((c) => c?.busy ? c : { date, minutes, key: newKey(), busy: false, error: null, serial: (c?.serial ?? 0) + 1 }));
  }, [manage, closed, preferences.language]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Add a class": waits for the calendar and card details, then opens the form at the next whole hour in school time.
  const handledSignal = useRef(0);
  useEffect(() => {
    if (addSignal === handledSignal.current || classes.state !== 'READY' || cards.state === 'LOADING') return;
    handledSignal.current = addSignal;
    const at = nextWholeHour(classes.localToday, localMinutesOf(new Date().toISOString(), classes.timezone));
    if (at.date !== classes.localToday) setAnchor(at.date);
    openCreate(at.date, at.minutes);
  }, [addSignal, classes.state, cards.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitCreate = (input: CreateCalendarCardInput) => {
    if (!scope || !creating || creating.busy) return;
    const write = ++writes.current, shown = privacy.current, abort = new AbortController(), key = creating.key;
    const owned = () => mounted.current && shown === privacy.current && write === writes.current;
    setCreating({ ...creating, busy: true, error: null });
    cardsApi.create(scope, input, key, signalFor(abort), owned).then((receipt) => {
      if (!owned()) return;
      setCreating(null);
      const text = receipt.repeats ? t('createdRoster', { name: input.name, n: String(receipt.created) }) : t('createdOne', { name: input.name });
      setMessage({ text: receipt.skippedDates.length ? `${text} ${t('createdSkipped', { n: String(receipt.skippedDates.length) })}` : text });
      setAnchor(input.localDate); setRefresh((n) => n + 1);
    }, (error) => {
      if (!owned()) return;
      setCreating((c) => c ? { ...c, busy: false, error: errorText(error), key: newKey() } : c);
      if (error instanceof CardError && (error.kind === 'GONE' || error.kind === 'UNKNOWN')) setRefresh((n) => n + 1);
    });
  };

  const sendMove = (move: Pending) => {
    if (!scope) return;
    const write = ++writes.current, shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && shown === privacy.current && write === writes.current;
    setPending({ ...move, saving: true }); setMessage({ text: t('moving') });
    cardsApi.move(scope, move.sessionId, { expectedVersion: move.version, startsAt: move.startsAt, endsAt: move.endsAt }, newKey(), signalFor(abort), owned).then((receipt) => {
      if (!owned()) return;
      const when = new Date(receipt.startsAt).toLocaleString(preferences.language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone ?? 'UTC' });
      setMessage({ text: `${t('moved', { name: move.name, when })}${receipt.detachedFromRoster ? ` ${t('movedDetached')}` : ''}` });
      setPending({ ...move, saving: true, done: true }); setRefresh((n) => n + 1); detail.reload();
    }, (error) => {
      if (!owned()) return;
      setPending(null); setMessage({ text: errorText(error) });
      if (!(error instanceof CardError) || ['CHANGED', 'GONE', 'LOCKED', 'UNKNOWN'].includes(error.kind)) setRefresh((n) => n + 1);
    });
  };
  const onDrop = useCallback((sessionId: string, date: string, start: number, end: number) => {
    if (classes.state !== 'READY' || cards.state !== 'READY' || pending) return;
    const session = classes.items.find((x) => x.sessionId === sessionId), card = cards.byId.get(sessionId);
    if (!session || !card) return;
    const startsAt = zonedInstant(date, start, classes.timezone), endsAt = zonedInstant(date, end, classes.timezone);
    if (!startsAt || !endsAt) { setMessage({ text: t('errGap') }); return; }
    const move: Pending = { sessionId, date, start, end, saving: false, startsAt, endsAt, version: card.version, name: session.name, booked: card.booked };
    const onto = () => {
      if (card.booked > 0) { setPending(move); setMessage({ text: t('moveConfirm', { n: String(card.booked), name: session.name }), confirm: true }); return; }
      sendMove(move);
    };
    // Moving within the same closed day asks nothing new.
    if (date !== localDateOf(session.startsAt, classes.timezone)) askIfClosed(date, onto); else onto();
  }, [classes, cards, pending, closed, preferences.language, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const messageBar = message ? <div className={styles.message} role={message.confirm || message.ask ? 'alert' : 'status'} data-testid="calendar-message">
    <span>{message.text}</span>
    {message.ask ? <span className={styles.messageActions}>
      <button type="button" className={styles.primary} onClick={message.ask} data-testid="calendar-blocked-continue">{t('blockedContinue')}</button>
      <button type="button" className={styles.secondary} onClick={() => setMessage(null)}>{t('blockedBack')}</button>
    </span> : message.confirm && pending && !pending.saving ? <span className={styles.messageActions}>
      <button type="button" className={styles.primary} onClick={() => sendMove(pending)}>{t('moveYes')}</button>
      <button type="button" className={styles.secondary} onClick={() => { setPending(null); setMessage(null); }}>{t('moveNo')}</button>
    </span> : pending?.saving ? null : <button type="button" className={styles.clearLink} onClick={() => setMessage(null)}>{t('dismiss')}</button>}
  </div> : null;
  const createPanel = creating && cards.state === 'READY' ? <CalendarCardForm key={creating.serial} language={preferences.language} programs={cards.programs} instructors={cards.instructors}
    initial={initialCardForm(creating.date, creating.minutes, cards.programs)} busy={creating.busy} error={creating.error}
    onCancel={() => setCreating(null)} onSubmit={submitCreate}/> : null;

  const session = selectedClass && classes.state === 'READY' ? classes.items.find((s) => s.sessionId === selectedClass) ?? null : null;
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
      classFilter={classFilter} onClassFilter={setClassFilter} cards={cards} programFilter={programFilter} onProgramFilter={setProgramFilter}
      instructorFilter={instructorFilter} onInstructorFilter={setInstructorFilter} onCreateAt={manage ? openCreate : undefined} onDrop={manage ? onDrop : undefined}
      pending={pending} createPanel={createPanel} message={messageBar} closed={closed}/>
  </div>;
}
