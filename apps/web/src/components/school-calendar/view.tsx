import React, { useEffect, useRef, useState } from 'react';
import type { CalendarCard, CalendarCardPerson, CurrentSchoolClassSession } from '@hon/contracts';
import { calendarText, type CalendarKey } from './copy';
import { groupByDay, type CalendarEvent, type CalendarItem } from './http';
import { CALENDAR_VIEWS, calendarRange, daysOf, hourBounds, layoutLanes, localMinutesOf, monthGrid, type CalendarView, type DateRange, type Span } from './range';
import { dragTarget, keyboardStep, MAX_LENGTH, SNAP_MINUTES, type DragOrigin, type DragSpot } from './drag';
import styles from './school-calendar.module.css';

type T = (key: CalendarKey, vars?: Record<string, string>) => string;
export type ClassesState = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' }
  | { state: 'READY'; range: DateRange; items: readonly CurrentSchoolClassSession[]; truncated: boolean; timezone: string; localToday: string };
export type EventsState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; events: readonly CalendarEvent[]; timezone: string; localToday: string };
export type CalendarSelection = Readonly<{ kind: 'class' | 'event'; id: string }> | null;
/** Card details (0551): kind, program, roster, lead instructor and booked count per class, plus what a manager may pick. */
export type CardsState = { state: 'LOADING' | 'UNAVAILABLE' }
  | { state: 'READY'; byId: ReadonlyMap<string, CalendarCard>; canManage: boolean; programs: readonly { programId: string; name: string }[]; instructors: readonly CalendarCardPerson[] };
/** A move waiting for the booked-students question or for the server. */
export type PendingMove = Readonly<{ sessionId: string; date: string; start: number; end: number; saving: boolean }>;
/** "No instructor" in the Instructor filter. */
export const NO_INSTRUCTOR = 'none';
/** Items a month cell lists before "+N more". */
export const MONTH_CELL_ITEMS = 3;
/** Pixels per hour on the week and day grid. */
export const HOUR_HEIGHT = 64;

export type CalendarViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasScope: boolean;
  view: CalendarView; anchor: string | null; classes: ClassesState; events: EventsState; selected: CalendarSelection;
  /** The selected class's panel (roster, attendance, booking), built by the page. */
  classDetail?: React.ReactNode;
  onView?: ((view: CalendarView) => void) | undefined; onShift?: ((step: 1 | -1) => void) | undefined; onToday?: (() => void) | undefined;
  onSelect?: ((selection: CalendarSelection) => void) | undefined; onDay?: ((date: string) => void) | undefined;
  onRefresh?: (() => void) | undefined; onManageEvent?: (() => void) | undefined;
  /** The chosen class names (empty = all classes). A compact Filter menu replaces the old wall of chips. */
  classFilter?: readonly string[] | undefined; onClassFilter?: ((names: readonly string[]) => void) | undefined;
  /** 0551: card details, and the Program and Instructor filter groups (program ids; principal ids or NO_INSTRUCTOR). */
  cards?: CardsState | undefined;
  programFilter?: readonly string[] | undefined; onProgramFilter?: ((ids: readonly string[]) => void) | undefined;
  instructorFilter?: readonly string[] | undefined; onInstructorFilter?: ((ids: readonly string[]) => void) | undefined;
  /** Week and Day: an empty time was clicked (school date, minutes after school midnight). */
  onCreateAt?: ((date: string, minutes: number) => void) | undefined;
  /** A card was dropped, resized or moved by keyboard to a new school date and minutes. */
  onDrop?: ((sessionId: string, date: string, start: number, end: number) => void) | undefined;
  pending?: PendingMove | null | undefined;
  /** The create form, shown in the side panel. */
  createPanel?: React.ReactNode;
  /** A short result or refusal line above the board. */
  message?: React.ReactNode;
}>;

const day = (language: string, date: string, options: Intl.DateTimeFormatOptions) => new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { ...options, timeZone: 'UTC' });
const clock = (language: string, hhmm: string) => new Date(`2000-01-01T${hhmm}:00Z`).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const time = (language: string, timeZone: string, instant: string) => new Date(instant).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', timeZone });

export function rangeLabel(language: string, view: CalendarView, anchor: string): string {
  if (view === 'day') return day(language, anchor, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  if (view === 'month') return day(language, anchor, { year: 'numeric', month: 'long' });
  const { start, end } = calendarRange('week', anchor), last = daysOf({ start, end })[6]!;
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${start}T00:00:00Z`), new Date(`${last}T00:00:00Z`));
}

/** Pure view. Every class and event comes from the school's reads; nothing shows before the shell verifies the school. */
export function CalendarViewPane(p: CalendarViewProps): React.ReactElement {
  const t: T = (key, vars) => calendarText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasScope ? t('noSchool') : null;
  const loading = p.classes.state === 'LOADING' || p.events.state === 'LOADING';
  return <section className={styles.calendar} aria-labelledby="calendar-view-title" data-testid="school-calendar">
    <h2 id="calendar-view-title" className={styles.hidden}>{t('tabCalendar')}</h2>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <button type="button" className={styles.secondary} onClick={() => p.onShift?.(-1)} disabled={p.anchor === null} aria-label={t('previous')}>‹</button>
          <button type="button" className={styles.secondary} onClick={p.onToday} disabled={p.anchor === null}>{t('today')}</button>
          <button type="button" className={styles.secondary} onClick={() => p.onShift?.(1)} disabled={p.anchor === null} aria-label={t('next')}>›</button>
          {p.anchor ? <strong className={styles.label} aria-live="polite" data-testid="calendar-range">{rangeLabel(p.language, p.view, p.anchor)}</strong> : null}
        </div>
        <div className={styles.views} role="group" aria-label={t('viewLabel')}>
          {CALENDAR_VIEWS.map((v) => <button key={v} type="button" className={styles.tab} aria-pressed={p.view === v} onClick={() => p.onView?.(v)}>{t(v)}</button>)}
          <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={loading}>{t('refresh')}</button>
        </div>
      </div>
      <Notices {...p} t={t}/>
      {!loading ? <Filter {...p} t={t}/> : null}
      <div className={styles.board}>{loading ? <p className={styles.meta} role="status">{t('loading')}</p> : p.anchor !== null ? <Board {...p} anchor={p.anchor} t={t}/> : null}</div>
      {p.message ? <div className={styles.messageBar}>{p.message}</div> : null}
      {p.createPanel ? <aside className={styles.drawer} aria-label={t('createTitle')} data-testid="calendar-create-drawer">
        <div className={styles.drawerHead}><button type="button" className={styles.secondary} onClick={() => p.onSelect?.(null)}>{t('close')}</button></div>
        {p.createPanel}
      </aside> : p.selected ? <aside className={styles.drawer} aria-labelledby="calendar-drawer-title" data-testid="calendar-drawer">
        <div className={styles.drawerHead}><h2 id="calendar-drawer-title" className={styles.hidden}>{t('details')}</h2>
          <button type="button" className={styles.secondary} onClick={() => p.onSelect?.(null)}>{t('close')}</button></div>
        <Detail {...p} t={t}/>
      </aside> : null}
    </>}
  </section>;
}

function Notices({ classes, events, t }: CalendarViewProps & { t: T }): React.ReactElement {
  return <>
    {classes.state === 'DENIED' ? <p className={styles.notice} role="status">{t('classesDenied')}</p> : null}
    {classes.state === 'TIMEZONE' ? <p className={styles.notice} role="status">{t('classesTimezone')}</p> : null}
    {classes.state === 'UNAVAILABLE' ? <p className={styles.notice} role="status">{t('classesUnavailable')}</p> : null}
    {classes.state === 'READY' && classes.truncated ? <p className={styles.notice} role="status">{t('truncated')}</p> : null}
    {events.state === 'DENIED' ? <p className={styles.meta} role="status">{t('eventsDenied')}</p> : null}
    {events.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('eventsUnavailable')}</p> : null}
  </>;
}

/** The classes shown: all, or only those whose name is chosen. */
export function visibleClasses(classes: ClassesState, filter: readonly string[] | undefined): readonly CurrentSchoolClassSession[] {
  if (classes.state !== 'READY') return [];
  // Only names loaded in this range count, as in the Filter menu: a choice that matches nothing here shows every class,
  // so the board never goes empty behind a menu that says "All classes".
  const loaded = new Set(classes.items.map((s) => s.name)), chosen = new Set((filter ?? []).filter((n) => loaded.has(n)));
  return chosen.size === 0 ? classes.items : classes.items.filter((s) => chosen.has(s.name));
}

export type FilterOptions = Readonly<{ names: string[]; programs: { id: string; name: string }[]; instructors: { id: string; name: string }[] }>;
/** The choices each filter group offers for the classes loaded in this range. */
export function filterOptions(classes: ClassesState, cards: CardsState | undefined): FilterOptions {
  if (classes.state !== 'READY') return { names: [], programs: [], instructors: [] };
  const names = [...new Set(classes.items.map((s) => s.name))].sort((a, b) => a.localeCompare(b));
  const programs = new Map<string, string>(), instructors = new Map<string, string>();
  if (cards?.state === 'READY') for (const s of classes.items) {
    const card = cards.byId.get(s.sessionId);
    if (!card) continue;
    programs.set(card.programId, card.programName);
    instructors.set(card.instructor?.principalId ?? NO_INSTRUCTOR, card.instructor?.displayName ?? '');
  }
  const sorted = (m: Map<string, string>) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => (a.id === NO_INSTRUCTOR ? 1 : 0) - (b.id === NO_INSTRUCTOR ? 1 : 0) || a.name.localeCompare(b.name));
  return { names, programs: sorted(programs), instructors: sorted(instructors) };
}
const chosenOf = (filter: readonly string[] | undefined, offered: readonly string[]) => new Set((filter ?? []).filter((x) => offered.includes(x)));

/**
 * Every filter at once: choices in different groups combine with AND, several in one group with OR. A choice that matches
 * nothing loaded here is ignored, so the board never goes empty behind a menu that shows nothing chosen.
 */
export function filteredClasses(classes: ClassesState, cards: CardsState | undefined,
  f: Readonly<{ names?: readonly string[] | undefined; programs?: readonly string[] | undefined; instructors?: readonly string[] | undefined }>): readonly CurrentSchoolClassSession[] {
  const byName = visibleClasses(classes, f.names);
  if (cards?.state !== 'READY') return byName;
  const o = filterOptions(classes, cards);
  const programs = chosenOf(f.programs, o.programs.map((x) => x.id)), instructors = chosenOf(f.instructors, o.instructors.map((x) => x.id));
  if (!programs.size && !instructors.size) return byName;
  return byName.filter((s) => {
    const card = cards.byId.get(s.sessionId);
    if (!card) return false;
    return (!programs.size || programs.has(card.programId)) && (!instructors.size || instructors.has(card.instructor?.principalId ?? NO_INSTRUCTOR));
  });
}

function FilterGroup({ legend, options, chosen, onChange }: { legend: string; options: readonly { id: string; name: string }[]; chosen: Set<string>;
  onChange?: ((ids: readonly string[]) => void) | undefined }): React.ReactElement {
  const toggle = (id: string) => onChange?.(chosen.has(id) ? [...chosen].filter((n) => n !== id) : [...chosen, id]);
  return <fieldset className={styles.filterGroup}>
    <legend>{legend}</legend>
    <ul>{options.map((o) => <li key={o.id}><label className={styles.filterOption}>
      <input type="checkbox" checked={chosen.has(o.id)} onChange={() => toggle(o.id)}/> <span>{o.name}</span></label></li>)}</ul>
  </fieldset>;
}

/** A compact Filter menu: one button that says what is shown, and short checklists (classes, programs, instructors) under it. */
function Filter({ classes, cards, classFilter = [], onClassFilter, programFilter, onProgramFilter, instructorFilter, onInstructorFilter, t }: CalendarViewProps & { t: T }): React.ReactElement | null {
  if (classes.state !== 'READY') return null;
  const o = filterOptions(classes, cards);
  const instructorOptions = o.instructors.map((x) => x.id === NO_INSTRUCTOR ? { ...x, name: t('noInstructor') } : x);
  const showNames = o.names.length >= 2, showPrograms = o.programs.length >= 2, showInstructors = instructorOptions.length >= 2;
  if (!showNames && !showPrograms && !showInstructors) return null;
  const names = chosenOf(classFilter, o.names), programs = chosenOf(programFilter, o.programs.map((x) => x.id)), instructors = chosenOf(instructorFilter, instructorOptions.map((x) => x.id));
  const count = names.size + programs.size + instructors.size;
  const only = count === 1 ? [...names][0] ?? o.programs.find((x) => programs.has(x.id))?.name ?? instructorOptions.find((x) => instructors.has(x.id))?.name : undefined;
  const summary = count === 0 ? t('allClasses') : only !== undefined ? only : names.size === count ? t('classesChosen', { n: String(count) }) : t('filtersChosen', { n: String(count) });
  const clear = () => { onClassFilter?.([]); onProgramFilter?.([]); onInstructorFilter?.([]); };
  return <div className={styles.filterBar}>
    <details className={styles.filter} data-testid="calendar-filter">
      <summary className={styles.filterButton} aria-label={`${t('filterLabel')}: ${summary}`}>
        <span aria-hidden="true" className={styles.filterIcon}>⏷</span> {t('filterTitle')}
        <span className={styles.filterValue}>{summary}</span>
        {count ? <span className={styles.filterCount} aria-hidden="true">{count}</span> : null}
      </summary>
      <div className={styles.filterMenu}>
        {showNames ? <FilterGroup legend={t('filterClasses')} options={o.names.map((n) => ({ id: n, name: n }))} chosen={names} onChange={onClassFilter}/> : null}
        {showPrograms ? <FilterGroup legend={t('filterPrograms')} options={o.programs} chosen={programs} onChange={onProgramFilter}/> : null}
        {showInstructors ? <FilterGroup legend={t('filterInstructors')} options={instructorOptions} chosen={instructors} onChange={onInstructorFilter}/> : null}
        <button type="button" className={styles.secondary} onClick={clear} disabled={count === 0}>{t('filterClear')}</button>
      </div>
    </details>
    {count ? <button type="button" className={styles.clearLink} onClick={clear}>{t('filterClear')}</button> : null}
  </div>;
}

const zoneOf = (classes: ClassesState, events: EventsState) => classes.state === 'READY' ? classes.timezone : events.state === 'READY' ? events.timezone : 'UTC';
const todayOf = (classes: ClassesState, events: EventsState) => classes.state === 'READY' ? classes.localToday : events.state === 'READY' ? events.localToday : '';

function Board(p: CalendarViewProps & { anchor: string; t: T }): React.ReactElement {
  const { view, anchor, classes, events, language, t } = p;
  const range = calendarRange(view, anchor), zone = zoneOf(classes, events), today = todayOf(classes, events);
  const days = groupByDay(filteredClasses(classes, p.cards, { names: p.classFilter, programs: p.programFilter, instructors: p.instructorFilter }), events.state === 'READY' ? events.events : [], zone, range);
  const weekdays = daysOf(calendarRange('week', anchor)).map((d) => day(language, d, { weekday: 'short' }));
  const footer = <p className={styles.meta}>{t('zone', { zone })}</p>;
  if (view === 'month') return <>
    <div className={styles.month} role="grid" aria-label={rangeLabel(language, view, anchor)} data-testid="calendar-month">
      <div role="row" className={styles.weekHead}>{weekdays.map((w) => <span role="columnheader" key={w}>{w}</span>)}</div>
      {monthGrid(anchor).map((week) => <div role="row" key={week[0]!.date} className={styles.week}>{week.map(({ date, inMonth }) => {
        const items = days.get(date) ?? [], shown = items.slice(0, MONTH_CELL_ITEMS), hidden = items.length - shown.length;
        return <div role="gridcell" key={date} className={styles.cell} data-out={inMonth ? undefined : 'true'} data-today={date === today ? 'true' : undefined}>
          <div className={styles.cellHead}>
            <button type="button" className={styles.dateButton} onClick={() => p.onDay?.(date)} aria-label={day(language, date, { dateStyle: 'full' })}>{Number(date.slice(8))}</button>
            {items.length ? <span className={styles.count} aria-hidden="true">{items.length}</span> : null}
          </div>
          <ul className={styles.items}>{shown.map((item) => <li key={keyOf(item)}><Item {...p} item={item} zone={zone} compact/></li>)}</ul>
          {hidden > 0 ? <button type="button" className={styles.more} onClick={() => p.onDay?.(date)}
            aria-label={t('moreLabel', { n: String(items.length), day: day(language, date, { dateStyle: 'medium' }) })}>{t('more', { n: String(hidden) })}</button> : null}
        </div>;
      })}</div>)}
    </div>{footer}</>;
  // Week and day: an hour grid. Each class sits at its school-time start, as tall as it is long; classes that overlap share
  // the column side by side. Sale days and events sit in a row above the hours. A manager can click an empty time to add a
  // class, drag a class to move it and drag its bottom edge to change its length (0551).
  const entries = [...days.entries()];
  const spans = new Map<string, Span>();
  for (const [, items] of entries) for (const item of items) if (item.kind === 'class') {
    const start = localMinutesOf(item.session.startsAt, zone);
    spans.set(item.session.sessionId, { start, end: Math.min(24 * 60, Math.max(start + 15, start + Math.round((Date.parse(item.session.endsAt) - Date.parse(item.session.startsAt)) / 60_000))) });
  }
  const { first, last } = hourBounds([...spans.values()]);
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const height = hours.length * HOUR_HEIGHT;
  const hasEvents = entries.some(([, items]) => items.some((i) => i.kind === 'event'));
  const manage = p.cards?.state === 'READY' && p.cards.canManage;
  return <>
    <div className={styles.gridScroll}>
      <div className={styles.timeGrid} data-view={view} data-testid={`calendar-${view}`} style={{ ['--days' as string]: String(entries.length) }}>
        <div className={styles.corner} aria-hidden="true"/>
        {entries.map(([date]) => <div key={date} className={styles.dayHead} data-today={date === today ? 'true' : undefined}>
          {view === 'week' ? <button type="button" className={styles.dateButton} onClick={() => p.onDay?.(date)} aria-label={day(language, date, { dateStyle: 'full' })}>
            <small>{day(language, date, { weekday: 'short' })}</small> <strong>{Number(date.slice(8))}</strong></button>
            : <strong>{day(language, date, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>}
        </div>)}
        {hasEvents ? <>
          <div className={styles.rowLabel}>{t('eventsRow')}</div>
          {entries.map(([date, items]) => <ul key={date} className={styles.eventRow}>{items.filter((i) => i.kind === 'event').map((item) => <li key={keyOf(item)}><Item {...p} item={item} zone={zone}/></li>)}</ul>)}
        </> : null}
        <div className={styles.hours} style={{ height }} aria-hidden="true">{hours.map((h) => <span key={h} style={{ top: (h - first) * HOUR_HEIGHT }}>{clock(language, `${String(h).padStart(2, '0')}:00`)}</span>)}</div>
        <DayColumns {...p} entries={entries} spans={spans} first={first} hours={hours} height={height} zone={zone} today={today} manage={manage}/>
      </div>
    </div>
    {manage ? <p className={styles.meta}>{t('dragHint')}</p> : p.cards?.state === 'READY' ? <p className={styles.meta}>{t('cannotManage')}</p> : null}
    {footer}</>;
}

type ClassItem = Extract<CalendarItem, { kind: 'class' }>;
type Drag = { sessionId: string; origin: DragOrigin; x0: number; y0: number; width: number; spot: DragSpot; moved: boolean };
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Whether this class can be dragged: a manager, a scheduled class not yet started, with no attendance. */
export function canDrag(session: CurrentSchoolClassSession, card: CalendarCard | undefined, manage: boolean, now = Date.now()): boolean {
  return manage && !!card && session.status === 'SCHEDULED' && Date.parse(session.startsAt) > now && !card.attended;
}

function DayColumns(p: CalendarViewProps & { anchor: string; t: T; entries: [string, CalendarItem[]][]; spans: Map<string, Span>; first: number; hours: number[];
  height: number; zone: string; today: string; manage: boolean }): React.ReactElement {
  const { entries, spans, first, hours, height, language, t } = p;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null), suppressClick = useRef(false);
  const update = (next: Drag | null) => { dragRef.current = next; setDrag(next); };
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); suppressClick.current = dragRef.current?.moved ?? false; update(null); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const cards = p.cards?.state === 'READY' ? p.cards.byId : null;
  const start = (event: React.PointerEvent<HTMLElement>, c: ClassItem, dayIndex: number, mode: DragOrigin['mode']) => {
    if (event.button !== 0 || !p.onDrop) return;
    const column = event.currentTarget.closest('section'), span = spans.get(c.session.sessionId)!;
    const origin: DragOrigin = { mode, dayIndex, start: span.start, end: span.end, days: entries.length };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (mode === 'resize') event.stopPropagation();
    update({ sessionId: c.session.sessionId, origin, x0: event.clientX, y0: event.clientY, width: column?.getBoundingClientRect().width || 1, spot: origin, moved: false });
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = event.clientX - d.x0, dy = event.clientY - d.y0;
    const moved = d.moved || Math.hypot(dx, dy) > 4;
    update({ ...d, moved, spot: moved ? dragTarget(d.origin, dx / d.width, dy, HOUR_HEIGHT) : d.spot });
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    update(null);
    if (!d.moved) return;
    suppressClick.current = true;
    const { spot, origin } = d;
    if (spot.dayIndex !== origin.dayIndex || spot.start !== origin.start || spot.end !== origin.end) p.onDrop?.(d.sessionId, entries[spot.dayIndex]![0], spot.start, spot.end);
  };
  const keys = (event: React.KeyboardEvent<HTMLElement>, c: ClassItem, dayIndex: number) => {
    const step = keyboardStep(event.key, event.altKey, event.shiftKey), span = spans.get(c.session.sessionId);
    if (!step || !span || !p.onDrop) return;
    event.preventDefault();
    const length = span.end - span.start;
    if (step.resize) {
      const finish = Math.min(Math.min(24 * 60, span.start + MAX_LENGTH), Math.max(span.start + SNAP_MINUTES, span.end + step.minutes));
      if (finish !== span.end) p.onDrop(c.session.sessionId, entries[dayIndex]![0], span.start, finish);
      return;
    }
    const target = Math.min(entries.length - 1, Math.max(0, dayIndex + step.days)), begin = Math.min(24 * 60 - length, Math.max(0, span.start + step.minutes));
    if (target !== dayIndex || begin !== span.start) p.onDrop(c.session.sessionId, entries[target]![0], begin, begin + length);
  };
  const ghostAt = (dayIndex: number, date: string) => {
    const g = drag?.moved && drag.spot.dayIndex === dayIndex ? { ...drag.spot, saving: false, sessionId: drag.sessionId }
      : p.pending && p.pending.date === date ? { ...p.pending } : null;
    if (!g) return null;
    const name = (cards && cards.get(g.sessionId)?.programName) ?? '';
    return <div className={styles.ghost} data-testid="calendar-ghost" data-saving={g.saving ? 'true' : undefined} aria-hidden="true"
      style={{ top: (g.start - first * 60) * HOUR_HEIGHT / 60, height: Math.max(20, (g.end - g.start) * HOUR_HEIGHT / 60 - 3) }}>
      <strong>{clock(language, hhmm(g.start))} – {clock(language, hhmm(g.end))}</strong>{g.saving ? <small>{t('moving')}</small> : name ? <small>{name}</small> : null}
    </div>;
  };
  return <>{entries.map(([date, items], dayIndex) => {
    const classes = items.filter((i): i is ClassItem => i.kind === 'class');
    const lanes = layoutLanes(classes.map((c) => spans.get(c.session.sessionId)!));
    return <section key={date} className={styles.dayColumn} style={{ height }} data-today={date === p.today ? 'true' : undefined} aria-label={day(language, date, { dateStyle: 'full' })}>
      {classes.length === 0 ? <p className={styles.hidden}>{t('nothing')}</p> : null}
      {p.manage && p.onCreateAt ? <div className={styles.slots}>{hours.map((h) => <button key={h} type="button" className={styles.slot} data-testid="calendar-slot"
        style={{ top: (h - first) * HOUR_HEIGHT, height: HOUR_HEIGHT }} aria-label={t('slotLabel', { day: day(language, date, { dateStyle: 'medium' }), time: clock(language, hhmm(h * 60)) })}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const quarter = event.detail === 0 ? 0 : Math.min(3, Math.max(0, Math.floor((event.clientY - rect.top) / (HOUR_HEIGHT / 4))));
          p.onCreateAt?.(date, h * 60 + quarter * SNAP_MINUTES);
        }}/>)}</div> : null}
      <ul className={styles.blocks}>{classes.map((c, i) => {
        const span = spans.get(c.session.sessionId)!, lane = lanes[i]!, card = cards?.get(c.session.sessionId);
        const draggable = canDrag(c.session, card, p.manage) && !!p.onDrop;
        const dragging = drag?.moved && drag.sessionId === c.session.sessionId || p.pending?.sessionId === c.session.sessionId;
        return <li key={keyOf(c)} className={styles.block} data-dragging={dragging ? 'true' : undefined} style={{ top: (span.start - first * 60) * HOUR_HEIGHT / 60,
          height: Math.max(28, (span.end - span.start) * HOUR_HEIGHT / 60 - 3), left: `calc(${(lane.lane * 100) / lane.lanes}% + 2px)`, width: `calc(${100 / lane.lanes}% - 4px)` }}>
          <Item {...p} item={c} zone={p.zone} draggable={draggable} suppressClick={suppressClick}
            onPointerDown={draggable ? (event) => start(event, c, dayIndex, 'move') : undefined} onPointerMove={draggable ? move : undefined}
            onPointerUp={draggable ? end : undefined} onPointerCancel={draggable ? () => update(null) : undefined}
            onKeyDown={draggable ? (event) => keys(event, c, dayIndex) : undefined}/>
          {draggable ? <span className={styles.resize} role="presentation" title={t('resizeLabel', { name: c.session.name })} data-testid="calendar-resize"
            onPointerDown={(event) => start(event, c, dayIndex, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={() => update(null)}/> : null}
        </li>;
      })}</ul>
      {ghostAt(dayIndex, date)}
    </section>;
  })}</>;
}

const keyOf = (item: CalendarItem) => item.kind === 'class' ? `c:${item.session.sessionId}` : `e:${item.event.eventId}`;

type ItemHandlers = {
  draggable?: boolean; suppressClick?: React.MutableRefObject<boolean>;
  onPointerDown?: ((event: React.PointerEvent<HTMLButtonElement>) => void) | undefined; onPointerMove?: ((event: React.PointerEvent<HTMLButtonElement>) => void) | undefined;
  onPointerUp?: ((event: React.PointerEvent<HTMLButtonElement>) => void) | undefined; onPointerCancel?: (() => void) | undefined;
  onKeyDown?: ((event: React.KeyboardEvent<HTMLButtonElement>) => void) | undefined;
};
function Item({ item, zone, compact = false, selected, onSelect, language, t, cards, draggable, suppressClick, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown }:
  CalendarViewProps & ItemHandlers & { item: CalendarItem; zone: string; compact?: boolean; t: T }): React.ReactElement {
  if (item.kind === 'event') {
    const e = item.event, current = selected?.kind === 'event' && selected.id === e.eventId;
    return <button type="button" className={styles.item} data-kind="event" data-status={e.status} aria-current={current ? 'true' : undefined} onClick={() => onSelect?.({ kind: 'event', id: e.eventId })}>
      <span className={styles.tag}>{t('eventTag')}</span> {compact ? null : <span className={styles.time}>{clock(language, e.opensAt)}</span>} <span className={styles.name}>{e.title}</span>
      {e.status === 'CANCELLED' ? <small> · {t('cancelled')}</small> : null}
    </button>;
  }
  const s = item.session, current = selected?.kind === 'class' && selected.id === s.sessionId;
  const card = cards?.state === 'READY' ? cards.byId.get(s.sessionId) : undefined;
  return <button type="button" className={styles.item} data-kind="class" data-card-kind={card?.kind ?? 'CLASS'} data-status={s.status} data-draggable={draggable ? 'true' : undefined}
    aria-current={current ? 'true' : undefined} aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown' : undefined}
    onClick={() => { if (suppressClick?.current) { suppressClick.current = false; return; } onSelect?.({ kind: 'class', id: s.sessionId }); }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onKeyDown={onKeyDown}>
    <span className={styles.time}>{time(language, zone, s.startsAt)}</span> <span className={styles.name}>{s.name}</span>
    {card && card.kind !== 'CLASS' ? <span className={styles.kindTag}>{t(`kind${card.kind}` as CalendarKey)}</span> : null}
    {s.status === 'CANCELLED' ? <small> · {t('cancelled')}</small> : null}
    {!compact && card?.instructor ? <small className={styles.room}>{card.instructor.displayName}</small> : null}
    {!compact && s.roomName ? <small className={styles.room}>{s.roomName}</small> : null}
    {!compact && card && card.booked > 0 ? <small className={styles.room}>{t('booked', { n: String(card.booked) })}</small> : null}
  </button>;
}

function Detail(p: CalendarViewProps & { t: T }): React.ReactElement {
  const { selected, events, language, t } = p;
  if (selected?.kind === 'class' && p.classDetail) return <>{p.classDetail}</>;
  const event = selected?.kind === 'event' && events.state === 'READY' ? events.events.find((e) => e.eventId === selected.id) ?? null : null;
  if (!event) return <p className={styles.notice}>{t('pick')}</p>;
  const total = (event.slotCount ?? 0) * (event.spotsPerSlot ?? 0);
  return <article className={styles.card} aria-labelledby="calendar-event-title" data-testid="calendar-event-detail">
    <div className={styles.cardHead}><h3 id="calendar-event-title">{event.title}</h3><span className={styles.chip} data-status={event.status}>{t(event.status as CalendarKey)}</span></div>
    <dl className={styles.facts}>
      <div><dt>{t('whenLabel')}</dt><dd>{t('eventWhen', { day: day(language, event.localDate, { dateStyle: 'medium' }), from: clock(language, event.opensAt),
        to: event.closesAt ? clock(language, event.closesAt) : '' })}</dd></div>
      <div><dt>{t('eventPlace')}</dt><dd>{event.place ? event.place : t('noPlace')}</dd></div>
      {total > 0 ? <div><dt>{t('eventSpots')}</dt><dd>{t('spots', { booked: String(event.bookedCount ?? 0), total: String(total) })}</dd></div> : null}
    </dl>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} onClick={p.onManageEvent}>{t('manageEvent')}</button>
    </div>
  </article>;
}
