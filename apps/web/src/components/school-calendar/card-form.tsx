'use client';
import React, { useState } from 'react';
import { CALENDAR_CARD_KINDS, CLASS_SERIES_BOOKING_POLICIES, type CalendarCardKind, type CalendarCardPerson, type ClassSeriesBookingPolicy, type CreateCalendarCardInput } from '@hon/contracts';
import { calendarText, type CalendarKey } from './copy';
import { DEFAULT_LENGTH, zonedInstant } from './drag';
import { addDays, weekday } from './range';
import styles from './school-calendar.module.css';

export type CardFormState = {
  kind: CalendarCardKind; name: string; programId: string; instructorPrincipalId: string; localDate: string; localStartTime: string;
  durationMinutes: string; roomName: string; capacity: string; bookingPolicy: ClassSeriesBookingPolicy; repeats: boolean; repeatWeekdays: number[]; repeatUntil: string;
};
/** ISO weekday (1 = Monday) of a school date. */
export const isoWeekday = (date: string) => { const d = weekday(date); return d === 0 ? 7 : d; };
const KIND_CAPACITY: Record<CalendarCardKind, string> = { CLASS: '20', PRIVATE_LESSON: '1', TRIAL: '10', EVENT: '30' };

export function initialCardForm(localDate: string, minutes: number, programs: readonly { programId: string }[]): CardFormState {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0'), mm = String(minutes % 60).padStart(2, '0');
  return { kind: 'CLASS', name: '', programId: programs.length === 1 ? programs[0]!.programId : '', instructorPrincipalId: '', localDate, localStartTime: `${hh}:${mm}`,
    durationMinutes: String(DEFAULT_LENGTH), roomName: '', capacity: KIND_CAPACITY.CLASS, bookingPolicy: 'OPTIONAL_BOOKING', repeats: false,
    repeatWeekdays: [], repeatUntil: '' };
}

/** The command body for the form, or null while a required field is empty. The server validates everything again. */
export function cardFormInput(f: CardFormState): CreateCalendarCardInput | null {
  const name = f.name.trim(), capacity = Number(f.capacity), duration = Number(f.durationMinutes);
  if (!name || !f.programId || !Number.isInteger(capacity) || !Number.isInteger(duration)) return null;
  const input: CreateCalendarCardInput = { kind: f.kind, programId: f.programId, name, capacity, bookingPolicy: f.bookingPolicy, localDate: f.localDate,
    localStartTime: f.localStartTime, durationMinutes: duration, instructorPrincipalId: f.instructorPrincipalId || null, roomName: f.roomName.trim() || null };
  if (f.repeats) {
    const days = [...new Set([isoWeekday(f.localDate), ...f.repeatWeekdays])].sort((a, b) => a - b);
    input.repeatWeekdays = days;
    input.repeatUntil = f.repeatUntil || null;
  }
  return input;
}

/** The instant a school date and HH:MM start, or null where that time does not exist (a clock change). */
function startOf(date: string, hhmm: string, timeZone: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  const at = m ? zonedInstant(date, Number(m[1]) * 60 + Number(m[2]), timeZone) : null;
  return at === null ? null : Date.parse(at);
}
/** Whether a start on a school date is already over (school time). */
export function startHasPassed(date: string, hhmm: string, timeZone: string, now = Date.now()): boolean {
  const at = startOf(date, hhmm, timeZone);
  return at !== null && at <= now;
}
/**
 * The school date of a new roster's first class. As the server does (0251 fill), a day whose time has already passed or
 * does not exist is left out, so a roster started today at an earlier time begins next week. Null when none is left.
 */
export function firstRosterDate(input: Pick<CreateCalendarCardInput, 'localDate' | 'localStartTime' | 'repeatWeekdays' | 'repeatUntil'>, timeZone: string, now = Date.now()): string | null {
  const days = input.repeatWeekdays?.length ? input.repeatWeekdays : [isoWeekday(input.localDate)];
  for (let d = input.localDate, i = 0; i < 92; i++, d = addDays(d, 1)) {
    if (input.repeatUntil && d > input.repeatUntil) return null;
    const at = startOf(d, input.localStartTime, timeZone);
    if (days.includes(isoWeekday(d)) && at !== null && at > now) return d;
  }
  return null;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const weekdayName = (language: string, iso: number) => new Date(Date.UTC(2026, 10, 15 + iso)).toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' });

/** The create form, shown in the calendar's side panel. It sends nothing itself: the page sends the command. */
export function CalendarCardForm({ language, programs, instructors, initial, busy, error, onCancel, onSubmit, timeZone, now }: {
  language: string; programs: readonly { programId: string; name: string }[]; instructors: readonly CalendarCardPerson[]; initial: CardFormState;
  /** The school's zone, to say before saving when the start time today is already over. */
  timeZone?: string | null | undefined; now?: number | undefined;
  busy: boolean; error: string | null; onCancel: () => void; onSubmit: (input: CreateCalendarCardInput) => void;
}): React.ReactElement {
  const t = (key: CalendarKey, vars?: Record<string, string>) => calendarText(language, key, vars);
  const [f, setF] = useState<CardFormState>(initial);
  const [missing, setMissing] = useState(false);
  const set = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const ownDay = isoWeekday(f.localDate);
  const at = (hhmm: string) => new Date(`2000-01-01T${hhmm}:00Z`).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const dayName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const passed = !!timeZone && startHasPassed(f.localDate, f.localStartTime, timeZone, now ?? Date.now());
  const firstDay = passed && f.repeats ? firstRosterDate({ localDate: f.localDate, localStartTime: f.localStartTime, repeatWeekdays: [ownDay, ...f.repeatWeekdays], repeatUntil: f.repeatUntil || null }, timeZone!, now ?? Date.now()) : null;
  const pastNote = !passed ? null : f.repeats
    ? firstDay ? t('formPastRepeat', { time: at(f.localStartTime), day: dayName(firstDay) }) : t('formPastNone', { time: at(f.localStartTime) })
    : t('formPast', { time: at(f.localStartTime) });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = cardFormInput(f);
    if (!input) { setMissing(true); return; }
    if (passed && (!f.repeats || !firstDay)) return;
    setMissing(false); onSubmit(input);
  };
  return <form className={styles.card} aria-labelledby="calendar-create-title" data-testid="calendar-create-form" onSubmit={submit} noValidate>
    <div className={styles.cardHead}><h3 id="calendar-create-title">{t('createTitle')}</h3></div>
    {programs.length === 0 ? <p className={styles.notice} role="status">{t('formNoPrograms')}</p> : null}
    <fieldset className={styles.kinds} disabled={busy}>
      <legend>{t('formKind')}</legend>
      {CALENDAR_CARD_KINDS.map((kind) => <label key={kind} className={styles.kindOption} data-card-kind={kind}>
        <input type="radio" name="calendar-card-kind" value={kind} checked={f.kind === kind}
          onChange={() => setF((prev) => ({ ...prev, kind, capacity: prev.capacity === KIND_CAPACITY[prev.kind] ? KIND_CAPACITY[kind] : prev.capacity }))}/>
        <span>{t(`kind${kind}` as CalendarKey)}</span></label>)}
    </fieldset>
    <div className={styles.fields}>
      <label className={styles.field} data-wide="true">{t('formTitle')}
        <input value={f.name} maxLength={120} required onChange={(e) => set('name', e.target.value)} disabled={busy} autoFocus/></label>
      <label className={styles.field}>{t('formProgram')}
        <select value={f.programId} required onChange={(e) => set('programId', e.target.value)} disabled={busy}>
          <option value="">{t('formChooseProgram')}</option>
          {programs.map((g) => <option key={g.programId} value={g.programId}>{g.name}</option>)}
        </select></label>
      <label className={styles.field}>{t('formInstructor')}
        <select value={f.instructorPrincipalId} onChange={(e) => set('instructorPrincipalId', e.target.value)} disabled={busy}>
          <option value="">{t('formNoInstructor')}</option>
          {instructors.map((i) => <option key={i.principalId} value={i.principalId}>{i.displayName}</option>)}
        </select></label>
      <label className={styles.field}>{t('formDate')}
        <input type="date" value={f.localDate} required onChange={(e) => { const d = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setF((prev) => ({ ...prev, localDate: d })); }} disabled={busy}/></label>
      <label className={styles.field}>{t('formStart')}
        <input type="time" step={900} value={f.localStartTime} required onChange={(e) => set('localStartTime', e.target.value.slice(0, 5))} disabled={busy}/></label>
      <label className={styles.field}>{t('formLength')}
        <input type="number" inputMode="numeric" min={5} max={600} step={5} value={f.durationMinutes} onChange={(e) => set('durationMinutes', e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('formCapacity')}
        <input type="number" inputMode="numeric" min={1} max={1000} value={f.capacity} onChange={(e) => set('capacity', e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('formRoom')}
        <input value={f.roomName} maxLength={120} onChange={(e) => set('roomName', e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('formBooking')}
        <select value={f.bookingPolicy} onChange={(e) => set('bookingPolicy', e.target.value as ClassSeriesBookingPolicy)} disabled={busy}>
          {CLASS_SERIES_BOOKING_POLICIES.map((p) => <option key={p} value={p}>{t(p as CalendarKey)}</option>)}
        </select></label>
    </div>
    <label className={styles.filterOption}><input type="checkbox" checked={f.repeats} onChange={(e) => set('repeats', e.target.checked)} disabled={busy}/> <span>{t('formRepeat')}</span></label>
    {f.repeats ? <div className={styles.repeat}>
      <fieldset className={styles.weekdays} disabled={busy}>
        <legend>{t('formRepeatDays')}</legend>
        {WEEKDAYS.map((d) => <label key={d} className={styles.weekdayOption}>
          <input type="checkbox" checked={d === ownDay || f.repeatWeekdays.includes(d)} disabled={d === ownDay}
            onChange={(e) => set('repeatWeekdays', e.target.checked ? [...f.repeatWeekdays, d] : f.repeatWeekdays.filter((x) => x !== d))}/>
          <span>{weekdayName(language, d)}</span></label>)}
      </fieldset>
      <label className={styles.field}>{t('formRepeatUntil')}
        <input type="date" value={f.repeatUntil} min={f.localDate} onChange={(e) => set('repeatUntil', e.target.value)} disabled={busy}/></label>
      <p className={styles.meta}>{t('formRepeatHelp')}</p>
    </div> : null}
    {pastNote ? <p className={styles.notice} role={f.repeats && firstDay ? 'status' : 'alert'} data-testid="calendar-create-past">{pastNote}</p> : null}
    {missing ? <p className={styles.notice} role="alert">{t('formMissing')}</p> : null}
    {error ? <p className={styles.notice} role="alert">{error}</p> : null}
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={busy || programs.length === 0}>{busy ? t('formSaving') : t('formSave')}</button>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>{t('formCancel')}</button>
    </div>
  </form>;
}
