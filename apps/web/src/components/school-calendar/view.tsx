import React from 'react';
import type { CurrentSchoolClassSession } from '@hon/contracts';
import { calendarText, type CalendarKey } from './copy';
import { groupByDay, type CalendarEvent, type CalendarItem } from './http';
import { CALENDAR_VIEWS, calendarRange, daysOf, hourBounds, layoutLanes, localMinutesOf, monthGrid, type CalendarView, type DateRange, type Span } from './range';
import styles from './school-calendar.module.css';

type T = (key: CalendarKey, vars?: Record<string, string>) => string;
export type ClassesState = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' }
  | { state: 'READY'; range: DateRange; items: readonly CurrentSchoolClassSession[]; truncated: boolean; timezone: string; localToday: string };
export type EventsState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; events: readonly CalendarEvent[]; timezone: string; localToday: string };
export type CalendarSelection = Readonly<{ kind: 'class' | 'event'; id: string }> | null;
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
      {p.selected ? <aside className={styles.drawer} aria-labelledby="calendar-drawer-title" data-testid="calendar-drawer">
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
  if (!filter?.length) return classes.items;
  const chosen = new Set(filter);
  return classes.items.filter((s) => chosen.has(s.name));
}

/** A compact Filter menu: one button that says what is shown, and a short checklist of class names under it. */
function Filter({ classes, classFilter = [], onClassFilter, t }: CalendarViewProps & { t: T }): React.ReactElement | null {
  if (classes.state !== 'READY') return null;
  const names = [...new Set(classes.items.map((s) => s.name))].sort((a, b) => a.localeCompare(b));
  if (names.length < 2) return null;
  const chosen = new Set(classFilter.filter((n) => names.includes(n)));
  const summary = chosen.size === 0 ? t('allClasses') : chosen.size === 1 ? [...chosen][0]! : t('classesChosen', { n: String(chosen.size) });
  const toggle = (name: string) => onClassFilter?.(chosen.has(name) ? [...chosen].filter((n) => n !== name) : [...chosen, name]);
  return <div className={styles.filterBar}>
    <details className={styles.filter} data-testid="calendar-filter">
      <summary className={styles.filterButton} aria-label={`${t('filterLabel')}: ${summary}`}>
        <span aria-hidden="true" className={styles.filterIcon}>⏷</span> {t('filterTitle')}
        <span className={styles.filterValue}>{summary}</span>
        {chosen.size ? <span className={styles.filterCount} aria-hidden="true">{chosen.size}</span> : null}
      </summary>
      <div className={styles.filterMenu}>
        <fieldset className={styles.filterGroup}>
          <legend>{t('filterClasses')}</legend>
          <ul>{names.map((name) => <li key={name}><label className={styles.filterOption}>
            <input type="checkbox" checked={chosen.has(name)} onChange={() => toggle(name)}/> <span>{name}</span></label></li>)}</ul>
        </fieldset>
        <button type="button" className={styles.secondary} onClick={() => onClassFilter?.([])} disabled={chosen.size === 0}>{t('filterClear')}</button>
      </div>
    </details>
    {chosen.size ? <button type="button" className={styles.clearLink} onClick={() => onClassFilter?.([])}>{t('filterClear')}</button> : null}
  </div>;
}

const zoneOf = (classes: ClassesState, events: EventsState) => classes.state === 'READY' ? classes.timezone : events.state === 'READY' ? events.timezone : 'UTC';
const todayOf = (classes: ClassesState, events: EventsState) => classes.state === 'READY' ? classes.localToday : events.state === 'READY' ? events.localToday : '';

function Board(p: CalendarViewProps & { anchor: string; t: T }): React.ReactElement {
  const { view, anchor, classes, events, language, t } = p;
  const range = calendarRange(view, anchor), zone = zoneOf(classes, events), today = todayOf(classes, events);
  const days = groupByDay(visibleClasses(classes, p.classFilter), events.state === 'READY' ? events.events : [], zone, range);
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
  // the column side by side. Sale days and events sit in a row above the hours.
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
        {entries.map(([date, items]) => {
          const classes = items.filter((i): i is Extract<CalendarItem, { kind: 'class' }> => i.kind === 'class');
          const lanes = layoutLanes(classes.map((c) => spans.get(c.session.sessionId)!));
          return <section key={date} className={styles.dayColumn} style={{ height }} data-today={date === today ? 'true' : undefined} aria-label={day(language, date, { dateStyle: 'full' })}>
            {classes.length === 0 ? <p className={styles.hidden}>{t('nothing')}</p> : null}
            <ul className={styles.blocks}>{classes.map((c, i) => { const span = spans.get(c.session.sessionId)!, lane = lanes[i]!;
              return <li key={keyOf(c)} className={styles.block} style={{ top: (span.start - first * 60) * HOUR_HEIGHT / 60, height: Math.max(28, (span.end - span.start) * HOUR_HEIGHT / 60 - 3),
                left: `calc(${(lane.lane * 100) / lane.lanes}% + 2px)`, width: `calc(${100 / lane.lanes}% - 4px)` }}><Item {...p} item={c} zone={zone}/></li>; })}</ul>
          </section>;
        })}
      </div>
    </div>{footer}</>;
}

const keyOf = (item: CalendarItem) => item.kind === 'class' ? `c:${item.session.sessionId}` : `e:${item.event.eventId}`;

function Item({ item, zone, compact = false, selected, onSelect, language, t }: CalendarViewProps & { item: CalendarItem; zone: string; compact?: boolean; t: T }): React.ReactElement {
  if (item.kind === 'event') {
    const e = item.event, current = selected?.kind === 'event' && selected.id === e.eventId;
    return <button type="button" className={styles.item} data-kind="event" data-status={e.status} aria-current={current ? 'true' : undefined} onClick={() => onSelect?.({ kind: 'event', id: e.eventId })}>
      <span className={styles.tag}>{t('eventTag')}</span> {compact ? null : <span className={styles.time}>{clock(language, e.opensAt)}</span>} <span className={styles.name}>{e.title}</span>
      {e.status === 'CANCELLED' ? <small> · {t('cancelled')}</small> : null}
    </button>;
  }
  const s = item.session, current = selected?.kind === 'class' && selected.id === s.sessionId;
  return <button type="button" className={styles.item} data-kind="class" data-status={s.status} aria-current={current ? 'true' : undefined} onClick={() => onSelect?.({ kind: 'class', id: s.sessionId })}>
    <span className={styles.time}>{time(language, zone, s.startsAt)}</span> <span className={styles.name}>{s.name}</span>
    {s.status === 'CANCELLED' ? <small> · {t('cancelled')}</small> : null}
    {!compact && s.roomName ? <small className={styles.room}>{s.roomName}</small> : null}
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
