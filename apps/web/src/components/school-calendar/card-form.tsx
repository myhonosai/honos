'use client';
import React, { useState } from 'react';
import { CALENDAR_CARD_KINDS, CLASS_SERIES_BOOKING_POLICIES, type CalendarCardKind, type CalendarCardPerson, type ClassSeriesBookingPolicy, type CreateCalendarCardInput } from '@hon/contracts';
import { calendarText, type CalendarKey } from './copy';
import { DEFAULT_LENGTH } from './drag';
import { weekday } from './range';
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

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const weekdayName = (language: string, iso: number) => new Date(Date.UTC(2026, 10, 15 + iso)).toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' });

/** The create form, shown in the calendar's side panel. It sends nothing itself: the page sends the command. */
export function CalendarCardForm({ language, programs, instructors, initial, busy, error, onCancel, onSubmit }: {
  language: string; programs: readonly { programId: string; name: string }[]; instructors: readonly CalendarCardPerson[]; initial: CardFormState;
  busy: boolean; error: string | null; onCancel: () => void; onSubmit: (input: CreateCalendarCardInput) => void;
}): React.ReactElement {
  const t = (key: CalendarKey, vars?: Record<string, string>) => calendarText(language, key, vars);
  const [f, setF] = useState<CardFormState>(initial);
  const [missing, setMissing] = useState(false);
  const set = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const ownDay = isoWeekday(f.localDate);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = cardFormInput(f);
    if (!input) { setMissing(true); return; }
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
    {missing ? <p className={styles.notice} role="alert">{t('formMissing')}</p> : null}
    {error ? <p className={styles.notice} role="alert">{error}</p> : null}
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={busy || programs.length === 0}>{busy ? t('formSaving') : t('formSave')}</button>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>{t('formCancel')}</button>
    </div>
  </form>;
}
