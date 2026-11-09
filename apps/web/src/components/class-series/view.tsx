import React from 'react';
import { CLASS_SERIES_BOOKING_POLICIES, type ClassSeries, type ClassSeriesBookingPolicy, type ClassSeriesSessionEffect, type SchoolClassSeries, type TimetableSession, type WeeklyTimetable } from '@hon/contracts';
import type { SeriesAction, SeriesErrorKind } from './http';
import styles from '../membership-changes/membership-changes.module.css';

export type SeriesForm = null | Readonly<{ kind: 'create' }> | Readonly<{ kind: 'revise' | 'end' | 'fill'; seriesId: string }>;
export type ReadState<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'TIMEZONE' } | { state: 'READY'; read: T };
export type SeriesOutcome = null | Readonly<{ kind: 'SENDING' | SeriesErrorKind; action: SeriesAction }> | Readonly<{ kind: 'DONE'; action: SeriesAction; sessions: ClassSeriesSessionEffect }>;
export type SeriesFields = Readonly<Record<string, string>>;

export type ClassSeriesViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  week: ReadState<WeeklyTimetable>; series: ReadState<SchoolClassSeries>; form: SeriesForm; outcome: SeriesOutcome; locked: boolean; canRetry: boolean;
  onWeek?: ((weekOf: string | null) => void) | undefined; onRefresh?: (() => void) | undefined; onOpen?: ((form: SeriesForm) => void) | undefined;
  onClose?: (() => void) | undefined; onSubmit?: ((action: SeriesAction, fields: SeriesFields) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

export const WEEKDAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const POLICY_LABEL: Record<ClassSeriesBookingPolicy, string> = { WALK_IN: 'Walk-in', OPTIONAL_BOOKING: 'Booking optional', REQUIRED_BOOKING: 'Booking required' };
const ACTION_LABEL: Record<SeriesAction, string> = { create: 'New class series', revise: 'Change the series', end: 'End the series', fill: 'Create sessions' };
const OUTCOME_TEXT: Record<Exclude<NonNullable<SeriesOutcome>['kind'], 'DONE'>, string> = {
  SENDING: 'Saving. Keep this page open.',
  SESSION: 'Your session ended. Sign in again; nothing was saved by this page after that.',
  DENIED: 'You are not allowed to manage class series at this school. Nothing changed.',
  GONE: 'That series or program is not available at this school. Nothing changed.',
  CHANGED: 'The series changed since it was shown. Nothing changed; check the fresh series and try again.',
  ENDED: 'This series has ended. Nothing changed.',
  TOO_FAR: 'Sessions can be created from today up to 12 weeks ahead. Nothing changed.',
  TIMEZONE: 'The school time zone is not set correctly, so dates cannot be checked. Nothing changed.',
  INVALID: 'Check the details: a name, at least one weekday, a start time, a length of 5 to 600 minutes, a capacity of 1 to 1000 and dates in order.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so it can never be applied twice.',
};
// School-local calendar dates are shown as dates, never shifted by the viewer's time zone.
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const weekdaysText = (days: readonly number[]) => days.map((d) => WEEKDAY_LABEL[d - 1]).join(', ');
function fieldsOf(form: HTMLFormElement): SeriesFields {
  const data = new FormData(form), out: Record<string, string> = {};
  for (const [name, value] of data.entries()) if (typeof value === 'string' && name !== 'weekday') out[name] = value;
  out.weekdays = data.getAll('weekday').filter((v): v is string => typeof v === 'string').join(',');
  return out;
}
export function effectText(action: SeriesAction, s: ClassSeriesSessionEffect, language: string): string {
  const parts = [s.created ? `${plural(s.created, 'session', 'sessions')} created` : null, s.updated ? `${plural(s.updated, 'session', 'sessions')} updated` : null,
    s.cancelled ? `${plural(s.cancelled, 'unbooked session', 'unbooked sessions')} cancelled` : null,
    s.keptBooked ? (s.keptBooked === 1 ? '1 booked session kept as it was' : `${s.keptBooked} booked sessions kept as they were`) : null,
    s.skippedDates.length ? `skipped because the start time does not exist that day: ${s.skippedDates.map((d) => shortDay(language, d)).join(', ')}` : null].filter(Boolean);
  const head = action === 'create' ? 'The series was created. Use Create sessions to put it on the timetable.' : 'Saved.';
  return `${head}${parts.length ? ` ${parts.join('; ')}.` : action === 'fill' ? ' No new sessions were needed.' : ''} The page was read again from the server.`;
}

function Week({ p }: { p: ClassSeriesViewProps }) {
  const week = p.week;
  const days = week.state === 'READY' ? Array.from({ length: 7 }, (_, n) => addDays(week.read.weekStart, n)) : [];
  const byDay = (date: string): TimetableSession[] => week.state === 'READY' ? week.read.sessions.filter((s) => s.localDate === date) : [];
  return <article className={styles.card} aria-labelledby="timetable-title" data-testid="timetable">
    <div className={styles.cardHead}><h2 id="timetable-title">Weekly timetable</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={p.locked || week.state !== 'READY'} onClick={() => week.state === 'READY' && p.onWeek?.(addDays(week.read.weekStart, -7))}>Previous week</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onWeek?.(null)}>This week</button>
        <button type="button" className={styles.secondary} disabled={p.locked || week.state !== 'READY'} onClick={() => week.state === 'READY' && p.onWeek?.(addDays(week.read.weekStart, 7))}>Next week</button>
      </div></div>
    {week.state === 'LOADING' ? <p className={styles.meta} role="status">Reading the timetable…</p>
      : week.state === 'DENIED' ? <p className={styles.meta} role="status">You need the class schedule read permission at this school to see the timetable.</p>
      : week.state === 'TIMEZONE' ? <p className={styles.meta} role="status">The school time zone is not set correctly, so the timetable cannot be shown.</p>
      : week.state !== 'READY' ? <p className={styles.meta} role="status">The timetable is not available right now. Nothing changed.</p>
      : <>
        <p className={styles.meta} data-testid="timetable-week">{shortDay(p.language, week.read.weekStart)} to {shortDay(p.language, week.read.weekEnd)}, school time ({week.read.timezone})</p>
        {week.read.truncated ? <p className={styles.warnText} role="status">This week has more than 500 sessions; only the first 500 are shown.</p> : null}
        {days.map((date) => <section key={date} aria-label={day(p.language, date)} data-testid={`day-${date}`}>
          <h3>{day(p.language, date)}{date === week.read.localToday ? ' (today)' : ''}</h3>
          {byDay(date).length === 0 ? <p className={styles.meta}>No classes.</p> : <ul className={styles.list}>
            {byDay(date).map((s) => <li key={s.sessionId}>
              {s.localStart}–{s.localEnd} {s.name}{s.roomName ? ` · ${s.roomName}` : ''} · {s.booked}/{s.capacity} booked · {POLICY_LABEL[s.bookingPolicy]}
              {s.status === 'CANCELLED' ? ' · cancelled' : s.status === 'COMPLETED' ? ' · completed' : s.status === 'DRAFT' ? ' · draft' : ''}{s.seriesId ? '' : ' · one-off'}
            </li>)}
          </ul>}
        </section>)}
      </>}
  </article>;
}

function SeriesList({ p }: { p: ClassSeriesViewProps }) {
  const list = p.series;
  return <article className={styles.card} aria-labelledby="series-title" data-testid="series">
    <div className={styles.cardHead}><h2 id="series-title">Class series</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>Refresh</button>
        {list.state === 'READY' ? <button type="button" className={styles.primary} disabled={p.locked || list.read.programs.length === 0} onClick={() => p.onOpen?.({ kind: 'create' })}>New class series</button> : null}
      </div></div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading class series…</p>
      : list.state === 'DENIED' ? <p className={styles.meta} role="status">Managing class series needs the class schedule manage permission at this school.</p>
      : list.state === 'TIMEZONE' ? <p className={styles.meta} role="status">The school time zone is not set correctly, so class series cannot be shown.</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="status">Class series are not available right now. Nothing changed.</p>
      : <>
        <p className={styles.meta}>A series repeats every week in school time. Sessions appear on the timetable only when you create them, up to 12 weeks ahead (through {shortDay(p.language, list.read.fillLimit)}). Changing or ending a series never moves or cancels a session that already has bookings or attendance.</p>
        {list.read.programs.length === 0 ? <p className={styles.meta}>Add a program first; every series belongs to a program.</p> : null}
        {list.read.series.length === 0 ? <p className={styles.meta}>No class series yet.</p> : <ul className={styles.list}>
          {list.read.series.map((s) => <li key={s.seriesId} data-testid={`series-${s.seriesId}`}>
            <strong>{s.name}</strong> · {weekdaysText(s.weekdays)} at {s.localStartTime} for {s.durationMinutes} min{s.roomName ? ` · ${s.roomName}` : ''} · capacity {s.capacity} · {POLICY_LABEL[s.bookingPolicy]}
            <span className={styles.meta}> · from {shortDay(p.language, s.startsOn)}{s.endsOn ? ` to ${shortDay(p.language, s.endsOn)}` : ''}
              {s.generatedThrough ? ` · sessions created through ${shortDay(p.language, s.generatedThrough)}` : ' · no sessions created yet'} · {plural(s.futureSessions, 'upcoming session', 'upcoming sessions')}
              {s.status === 'ENDED' ? ` · ended (${s.endReason ?? ''})` : ''}</span>
            {s.status === 'ACTIVE' ? <div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'fill', seriesId: s.seriesId })}>Create sessions</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'revise', seriesId: s.seriesId })}>Change</button>
              <button type="button" className={styles.danger} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'end', seriesId: s.seriesId })}>End</button>
            </div> : null}
          </li>)}
        </ul>}
      </>}
  </article>;
}

function PatternFields({ s }: { s: ClassSeries | null }) {
  return <>
    <label className={styles.field}>Class name<input name="name" required maxLength={120} defaultValue={s?.name ?? ''}/></label>
    <label className={styles.field}>Room (optional)<input name="roomName" maxLength={120} defaultValue={s?.roomName ?? ''}/></label>
    <fieldset className={styles.field}><legend>Weekdays</legend>
      {WEEKDAY_LABEL.map((label, n) => <label key={label} className={styles.check}><input type="checkbox" name="weekday" value={String(n + 1)} defaultChecked={s?.weekdays.includes(n + 1) ?? false}/>{label}</label>)}
    </fieldset>
    <label className={styles.field}>Start time (school time)<input name="localStartTime" type="time" step={60} required defaultValue={s?.localStartTime ?? '18:00'}/></label>
    <label className={styles.field}>Length in minutes<input name="durationMinutes" type="number" min={5} max={600} required defaultValue={s?.durationMinutes ?? 60}/></label>
    <label className={styles.field}>Capacity<input name="capacity" type="number" min={1} max={1000} required defaultValue={s?.capacity ?? 20}/></label>
    <label className={styles.field}>Booking<select name="bookingPolicy" defaultValue={s?.bookingPolicy ?? 'OPTIONAL_BOOKING'}>
      {CLASS_SERIES_BOOKING_POLICIES.map((policy) => <option key={policy} value={policy}>{POLICY_LABEL[policy]}</option>)}</select></label>
    <label className={styles.field}>Last date (optional)<input name="endsOn" type="date" defaultValue={s?.endsOn ?? ''}/></label>
  </>;
}

function Form({ p }: { p: ClassSeriesViewProps }) {
  const form = p.form, list = p.series;
  if (!form || list.state !== 'READY') return null;
  const s = form.kind === 'create' ? null : list.read.series.find((x) => x.seriesId === form.seriesId) ?? null;
  if (form.kind !== 'create' && !s) return null;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onSubmit?.(form.kind, fieldsOf(e.currentTarget)); };
  const today = list.read.localToday;
  return <article className={styles.card} aria-labelledby="series-form-title" data-testid="series-form">
    <h2 id="series-form-title">{ACTION_LABEL[form.kind]}{s ? `: ${s.name}` : ''}</h2>
    <form className={styles.form} onSubmit={submit}>
      {form.kind === 'create' ? <>
        <label className={styles.field}>Program<select name="programId" required defaultValue="">
          <option value="" disabled>Choose a program</option>
          {list.read.programs.map((x) => <option key={x.programId} value={x.programId}>{x.name}</option>)}</select></label>
        <label className={styles.field}>First date<input name="startsOn" type="date" required min={addDays(today, -7)} defaultValue={today}/></label>
        <PatternFields s={null}/>
      </> : form.kind === 'revise' ? <>
        <p className={styles.meta}>Upcoming unbooked sessions move to the new pattern; ones on days no longer in it, or whose new start time has already passed today, are cancelled rather than moved. Sessions with bookings or attendance stay as they are.</p>
        <PatternFields s={s}/>
      </> : form.kind === 'end' ? <>
        <p className={styles.meta}>Unbooked sessions after the last date are cancelled. Sessions with bookings or attendance stay as they are. The series is kept, shown as ended.</p>
        <label className={styles.field}>Last date<input name="lastDate" type="date" required min={addDays(today, -1)} defaultValue={today}/></label>
        <label className={styles.field}>Reason<input name="reason" required maxLength={500}/></label>
      </> : <>
        <p className={styles.meta}>Creates the sessions of this series from today through the date you choose, at most 12 weeks ahead. Sessions that already exist are not created twice.</p>
        <label className={styles.field}>Create through<input name="throughDate" type="date" required min={today} max={list.read.fillLimit} defaultValue={addDays(today, 27) > list.read.fillLimit ? list.read.fillLimit : addDays(today, 27)}/></label>
      </>}
      <div className={styles.actions}>
        <button type="submit" className={form.kind === 'end' ? styles.danger : styles.primary} disabled={p.locked}>{form.kind === 'create' ? 'Create series' : form.kind === 'revise' ? 'Save changes' : form.kind === 'end' ? 'End series' : 'Create sessions'}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Cancel</button>
      </div>
    </form>
  </article>;
}

export function ClassSeriesView(p: ClassSeriesViewProps): React.ReactElement {
  const o = p.outcome;
  return <main className={styles.page} aria-labelledby="class-series-title">
    <header className={styles.head}><h1 id="class-series-title">Weekly timetable</h1>
      <p className={styles.intro}>Recurring classes in school time. Nothing here contacts families or charges anyone.</p></header>
    {p.concealed ? <p className={styles.meta} role="status">Hidden while this window is not in use.</p>
      : p.waiting ? <p className={styles.meta} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.meta} role="status">Choose a school to see its timetable.</p>
      : <>
        {o ? <div className={styles.notice} role={o.kind === 'SENDING' ? 'status' : 'alert'} data-testid="series-outcome">
          <p>{o.kind === 'DONE' ? effectText(o.action, o.sessions, p.language) : OUTCOME_TEXT[o.kind]}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        <Form p={p}/>
        <Week p={p}/>
        <SeriesList p={p}/>
      </>}
  </main>;
}
