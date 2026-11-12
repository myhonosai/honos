import React from 'react';
import { CLASS_SERIES_BOOKING_POLICIES, CLASS_SERIES_FILL_DAYS, type ClassSeries, type ClassSeriesBookingPolicy, type ClassSeriesSessionEffect, type SchoolClassSeries, type TimetableSession, type WeeklyTimetable } from '@hon/contracts';
import type { SeriesAction, SeriesErrorKind } from './http';
import { seriesText, type SeriesKey } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type SeriesForm = null | Readonly<{ kind: 'create' }> | Readonly<{ kind: 'revise' | 'end' | 'fill' | 'ongoing'; seriesId: string }>;
export type TopUpState = Readonly<{ state: 'IDLE' | 'SENDING' | 'FAILED' }> | Readonly<{ state: 'DONE'; created: number }>;
export type ReadState<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'TIMEZONE' } | { state: 'READY'; read: T };
export type SeriesOutcome = null | Readonly<{ kind: 'SENDING' | SeriesErrorKind; action: SeriesAction }> | Readonly<{ kind: 'DONE'; action: SeriesAction; sessions: ClassSeriesSessionEffect }>;
export type SeriesFields = Readonly<Record<string, string>>;

export type ClassSeriesViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  week: ReadState<WeeklyTimetable>; series: ReadState<SchoolClassSeries>; form: SeriesForm; outcome: SeriesOutcome; locked: boolean; canRetry: boolean;
  topUp?: TopUpState | undefined;
  onWeek?: ((weekOf: string | null) => void) | undefined; onRefresh?: (() => void) | undefined; onOpen?: ((form: SeriesForm) => void) | undefined;
  onClose?: (() => void) | undefined; onSubmit?: ((action: SeriesAction, fields: SeriesFields) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const WEEKDAY_KEYS = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7'] as const satisfies readonly SeriesKey[];
const FILL_WEEKS = Math.round(CLASS_SERIES_FILL_DAYS / 7);
type T = (key: SeriesKey, vars?: Readonly<Record<string, string | number>>) => string;
const textFor = (language: string): T => (key, vars) => seriesText(language, key, vars);
const ACTION_KEY: Record<Exclude<SeriesAction, 'ongoing'>, SeriesKey> = { create: 'actCreate', revise: 'actRevise', end: 'actEnd', fill: 'actFill' };
type OutcomeKind = Exclude<NonNullable<SeriesOutcome>['kind'], 'DONE'>;
const outcomeText = (t: T, kind: OutcomeKind) => t(`o${kind}` as SeriesKey, { weeks: FILL_WEEKS });
// School-local calendar dates are shown as dates, never shifted by the viewer's time zone.
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const count = (t: T, n: number, one: SeriesKey, many: SeriesKey) => t(n === 1 ? one : many, { n });
export const weekdaysText = (days: readonly number[], language = 'en') => { const t = textFor(language); return days.map((d) => t(WEEKDAY_KEYS[d - 1] ?? 'wd1')).join(', '); };
function fieldsOf(form: HTMLFormElement): SeriesFields {
  const data = new FormData(form), out: Record<string, string> = {};
  for (const [name, value] of data.entries()) if (typeof value === 'string' && name !== 'weekday') out[name] = value;
  out.weekdays = data.getAll('weekday').filter((v): v is string => typeof v === 'string').join(',');
  return out;
}
export function effectText(action: SeriesAction, s: ClassSeriesSessionEffect, language: string): string {
  const t = textFor(language);
  const parts = [s.created ? count(t, s.created, 'created1', 'createdN') : null, s.updated ? count(t, s.updated, 'updated1', 'updatedN') : null,
    s.cancelled ? count(t, s.cancelled, 'cancelled1', 'cancelledN') : null,
    s.keptBooked ? count(t, s.keptBooked, 'kept1', 'keptN') : null,
    s.skippedDates.length ? t('skipped', { dates: s.skippedDates.map((d) => shortDay(language, d)).join(', ') }) : null].filter(Boolean);
  const head = t(action === 'create' ? 'headCreate' : 'headSaved');
  return `${head}${parts.length ? ` ${parts.join(t('partsSep'))}${t('partsEnd')}` : action === 'fill' ? ` ${t('noneNeeded')}` : ''} ${t('reread')}`;
}

function Week({ p }: { p: ClassSeriesViewProps }) {
  const week = p.week, t = textFor(p.language);
  const days = week.state === 'READY' ? Array.from({ length: 7 }, (_, n) => addDays(week.read.weekStart, n)) : [];
  const byDay = (date: string): TimetableSession[] => week.state === 'READY' ? week.read.sessions.filter((s) => s.localDate === date) : [];
  return <article className={styles.card} aria-labelledby="timetable-title" data-testid="timetable">
    <div className={styles.cardHead}><h2 id="timetable-title">{t('weekTitle')}</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={p.locked || week.state !== 'READY'} onClick={() => week.state === 'READY' && p.onWeek?.(addDays(week.read.weekStart, -7))}>{t('prevWeek')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onWeek?.(null)}>{t('thisWeek')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked || week.state !== 'READY'} onClick={() => week.state === 'READY' && p.onWeek?.(addDays(week.read.weekStart, 7))}>{t('nextWeek')}</button>
      </div></div>
    {week.state === 'LOADING' ? <p className={styles.meta} role="status">{t('weekLoading')}</p>
      : week.state === 'DENIED' ? <p className={styles.meta} role="status">{t('weekDenied')}</p>
      : week.state === 'TIMEZONE' ? <p className={styles.meta} role="status">{t('weekTimezone')}</p>
      : week.state !== 'READY' ? <p className={styles.meta} role="status">{t('weekUnavailable')}</p>
      : <>
        <p className={styles.meta} data-testid="timetable-week">{t('weekRange', { start: shortDay(p.language, week.read.weekStart), end: shortDay(p.language, week.read.weekEnd), zone: week.read.timezone })}</p>
        {week.read.truncated ? <p className={styles.warnText} role="status">{t('truncated')}</p> : null}
        {days.map((date) => <section key={date} aria-label={day(p.language, date)} data-testid={`day-${date}`}>
          <h3>{day(p.language, date)}{date === week.read.localToday ? ` ${t('todayMark')}` : ''}</h3>
          {byDay(date).length === 0 ? <p className={styles.meta}>{t('noClasses')}</p> : <ul className={styles.list}>
            {byDay(date).map((s) => <li key={s.sessionId}>
              {s.localStart}–{s.localEnd} {s.name}{s.roomName ? ` · ${s.roomName}` : ''} · {t('bookedCount', { booked: s.booked, capacity: s.capacity })} · {t(s.bookingPolicy)}
              {s.status === 'CANCELLED' ? ` · ${t('statusCancelled')}` : s.status === 'COMPLETED' ? ` · ${t('statusCompleted')}` : s.status === 'DRAFT' ? ` · ${t('statusDraft')}` : ''}{s.seriesId ? '' : ` · ${t('oneOff')}`}
            </li>)}
          </ul>}
        </section>)}
      </>}
  </article>;
}

function SeriesList({ p }: { p: ClassSeriesViewProps }) {
  const list = p.series, t = textFor(p.language);
  return <article className={styles.card} aria-labelledby="series-title" data-testid="series">
    <div className={styles.cardHead}><h2 id="series-title">{t('seriesTitle')}</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>
        {list.state === 'READY' ? <button type="button" className={styles.primary} disabled={p.locked || list.read.programs.length === 0} onClick={() => p.onOpen?.({ kind: 'create' })}>{t('actCreate')}</button> : null}
      </div></div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('seriesLoading')}</p>
      : list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('seriesDenied')}</p>
      : list.state === 'TIMEZONE' ? <p className={styles.meta} role="status">{t('seriesTimezone')}</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="status">{t('seriesUnavailable')}</p>
      : <>
        <p className={styles.meta}>{t('seriesIntro', { weeks: FILL_WEEKS, date: shortDay(p.language, list.read.fillLimit) })} {t('ongoingIntro', { weeks: FILL_WEEKS })}</p>
        {p.topUp?.state === 'SENDING' ? <p className={styles.meta} role="status" data-testid="series-top-up">{t('topUpSending')}</p>
          : p.topUp?.state === 'DONE' && p.topUp.created > 0 ? <p className={styles.meta} role="status" data-testid="series-top-up">{count(t, p.topUp.created, 'topUpDone1', 'topUpDoneN')}</p>
          : p.topUp?.state === 'FAILED' ? <p className={styles.warnText} role="status" data-testid="series-top-up">{t('topUpFailed')}</p> : null}
        {list.read.programs.length === 0 ? <p className={styles.meta}>{t('needProgram')}</p> : null}
        {list.read.series.length === 0 ? <p className={styles.meta}>{t('noSeries')}</p> : <ul className={styles.list}>
          {list.read.series.map((s) => <li key={s.seriesId} data-testid={`series-${s.seriesId}`}>
            <strong>{s.name}</strong>{s.ongoing && s.status === 'ACTIVE' ? ` · ${t('ongoingTag')}` : ''} · {t('pattern', { days: weekdaysText(s.weekdays, p.language), time: s.localStartTime, n: s.durationMinutes })}{s.roomName ? ` · ${s.roomName}` : ''} · {t('capacity', { n: s.capacity })} · {t(s.bookingPolicy)}
            <span className={styles.meta}> · {t('from', { date: shortDay(p.language, s.startsOn) })}{s.endsOn ? ` ${t('to', { date: shortDay(p.language, s.endsOn) })}` : ''}
              {s.generatedThrough ? ` · ${t('through', { date: shortDay(p.language, s.generatedThrough) })}` : ` · ${t('noneYet')}`} · {count(t, s.futureSessions, 'upcoming1', 'upcomingN')}
              {s.status === 'ENDED' ? ` · ${t('ended', { reason: s.endReason ?? '' })}` : ''}</span>
            {s.status === 'ACTIVE' ? <div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'fill', seriesId: s.seriesId })}>{t('btnFill')}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'ongoing', seriesId: s.seriesId })}>{t(s.ongoing ? 'btnOngoingOff' : 'btnOngoingOn')}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'revise', seriesId: s.seriesId })}>{t('btnChange')}</button>
              <button type="button" className={styles.danger} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'end', seriesId: s.seriesId })}>{t('btnEnd')}</button>
            </div> : null}
          </li>)}
        </ul>}
      </>}
  </article>;
}

function PatternFields({ s, t }: { s: ClassSeries | null; t: T }) {
  return <>
    <label className={styles.field}>{t('fName')}<input name="name" required maxLength={120} defaultValue={s?.name ?? ''}/></label>
    <label className={styles.field}>{t('fRoom')}<input name="roomName" maxLength={120} defaultValue={s?.roomName ?? ''}/></label>
    <fieldset className={styles.field}><legend>{t('fWeekdays')}</legend>
      {WEEKDAY_KEYS.map((key, n) => <label key={key} className={styles.check}><input type="checkbox" name="weekday" value={String(n + 1)} defaultChecked={s?.weekdays.includes(n + 1) ?? false}/>{t(key)}</label>)}
    </fieldset>
    <label className={styles.field}>{t('fStart')}<input name="localStartTime" type="time" step={60} required defaultValue={s?.localStartTime ?? '18:00'}/></label>
    <label className={styles.field}>{t('fLength')}<input name="durationMinutes" type="number" min={5} max={600} required defaultValue={s?.durationMinutes ?? 60}/></label>
    <label className={styles.field}>{t('fCapacity')}<input name="capacity" type="number" min={1} max={1000} required defaultValue={s?.capacity ?? 20}/></label>
    <label className={styles.field}>{t('fBooking')}<select name="bookingPolicy" defaultValue={s?.bookingPolicy ?? 'OPTIONAL_BOOKING'}>
      {CLASS_SERIES_BOOKING_POLICIES.map((policy) => <option key={policy} value={policy}>{t(policy)}</option>)}</select></label>
    <label className={styles.field}>{t('fLastOptional')}<input name="endsOn" type="date" defaultValue={s?.endsOn ?? ''}/></label>
  </>;
}

function Form({ p }: { p: ClassSeriesViewProps }) {
  const form = p.form, list = p.series, t = textFor(p.language);
  if (!form || list.state !== 'READY') return null;
  const s = form.kind === 'create' ? null : list.read.series.find((x) => x.seriesId === form.seriesId) ?? null;
  if (form.kind !== 'create' && !s) return null;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onSubmit?.(form.kind, fieldsOf(e.currentTarget)); };
  const today = list.read.localToday;
  return <article className={styles.card} aria-labelledby="series-form-title" data-testid="series-form">
    <h2 id="series-form-title">{t(form.kind === 'ongoing' ? (s?.ongoing ? 'actOngoingOff' : 'actOngoingOn') : ACTION_KEY[form.kind])}{s ? `: ${s.name}` : ''}</h2>
    <form className={styles.form} onSubmit={submit}>
      {form.kind === 'create' ? <>
        <label className={styles.field}>{t('fProgram')}<select name="programId" required defaultValue="">
          <option value="" disabled>{t('choose')}</option>
          {list.read.programs.map((x) => <option key={x.programId} value={x.programId}>{x.name}</option>)}</select></label>
        <label className={styles.field}>{t('fFirst')}<input name="startsOn" type="date" required min={addDays(today, -7)} defaultValue={today}/></label>
        <PatternFields s={null} t={t}/>
      </> : form.kind === 'revise' ? <>
        <p className={styles.meta}>{t('reviseHelp')}</p>
        <PatternFields s={s} t={t}/>
      </> : form.kind === 'end' ? <>
        <p className={styles.meta}>{t('endHelp')}</p>
        <label className={styles.field}>{t('fLastDate')}<input name="lastDate" type="date" required min={addDays(today, -1)} defaultValue={today}/></label>
        <label className={styles.field}>{t('fReason')}<input name="reason" required maxLength={500}/></label>
      </> : form.kind === 'ongoing' ? <>
        <p className={styles.meta}>{t(s?.ongoing ? 'ongoingOffHelp' : 'ongoingOnHelp', { weeks: FILL_WEEKS })}</p>
      </> : <>
        <p className={styles.meta}>{t('fillHelp', { weeks: FILL_WEEKS })}</p>
        <label className={styles.field}>{t('fThrough')}<input name="throughDate" type="date" required min={today} max={list.read.fillLimit} defaultValue={addDays(today, 27) > list.read.fillLimit ? list.read.fillLimit : addDays(today, 27)}/></label>
      </>}
      <div className={styles.actions}>
        <button type="submit" className={form.kind === 'end' ? styles.danger : styles.primary} disabled={p.locked}>{t(form.kind === 'create' ? 'submitCreate' : form.kind === 'revise' ? 'submitRevise' : form.kind === 'end' ? 'submitEnd'
          : form.kind === 'ongoing' ? (s?.ongoing ? 'btnOngoingOff' : 'btnOngoingOn') : 'submitFill')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('cancel')}</button>
      </div>
    </form>
  </article>;
}

export function ClassSeriesView(p: ClassSeriesViewProps): React.ReactElement {
  const o = p.outcome, t = textFor(p.language);
  return <main className={styles.page} aria-labelledby="class-series-title">
    <header className={styles.head}><h1 id="class-series-title">{t('pageTitle')}</h1>
      <p className={styles.intro}>{t('pageIntro')}</p></header>
    {p.concealed ? <p className={styles.meta} role="status">{t('concealed')}</p>
      : p.waiting ? <p className={styles.meta} role="status">{t('waiting')}</p>
      : !p.hasSchool ? <p className={styles.meta} role="status">{t('noSchool')}</p>
      : <>
        {o ? <div className={styles.notice} role={o.kind === 'SENDING' ? 'status' : 'alert'} data-testid="series-outcome">
          <p>{o.kind === 'DONE' ? effectText(o.action, o.sessions, p.language) : outcomeText(t, o.kind)}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        </div> : null}
        <Form p={p}/>
        <Week p={p}/>
        <SeriesList p={p}/>
      </>}
  </main>;
}
