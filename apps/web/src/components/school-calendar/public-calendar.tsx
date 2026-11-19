'use client';
import React, { useEffect, useState } from 'react';
import { schoolBrandingColorOk, schoolBrandingImageUrlOk, type PublicShareCalendar, type PublicShareCalendarTime } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { readPublicShareCalendar, type PublicCalendarRead } from './settings-http';
import { agesText, settingsText, type SettingsKey } from './settings-copy';
import styles from './public-calendar.module.css';

export type PublicCalendarState = 'LOADING' | PublicCalendarRead;
type T = (key: SettingsKey, vars?: Record<string, string | number>) => string;
const DEFAULT_ACCENT = '#1d4ed8';

/** Groups class times by school date, keeping the server's order (by start). */
export function timesByDay(times: readonly PublicShareCalendarTime[]): [string, PublicShareCalendarTime[]][] {
  const days = new Map<string, PublicShareCalendarTime[]>();
  for (const time of times) days.set(time.localDate, [...(days.get(time.localDate) ?? []), time]);
  return [...days.entries()];
}
const dayLabel = (language: string, date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const clock = (language: string, hhmm: string) => new Date(`2000-01-01T${hhmm}:00Z`).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/**
 * The public shared calendar (0552): the school's name, address and phone, then either "Choose a calendar" cards (a group)
 * or the class times of the next four weeks with open spots (a program). It never writes anything; booking is by phone
 * until online booking from a shared calendar is decided. The page holds no session and sends no credentials.
 */
export function PublicCalendarView({ language, read, group, onOpen, onBack }: {
  language: string; read: PublicCalendarState; group?: PublicShareCalendar | null;
  onOpen?: ((publicId: string) => void) | undefined; onBack?: (() => void) | undefined;
}): React.ReactElement {
  const t: T = (key, vars) => settingsText(language, key, vars);
  if (read === 'LOADING' || read === 'NOT_FOUND' || read === 'UNAVAILABLE') {
    return <main className={styles.page}>
      <p className={styles.notice} role={read === 'LOADING' ? 'status' : 'alert'} data-testid="public-calendar-state">
        {t(read === 'LOADING' ? 'pubLoading' : read === 'NOT_FOUND' ? 'pubNotFound' : 'pubUnavailable')}</p>
      {group && onBack ? <button type="button" className={styles.back} onClick={onBack}>{t('pubBack')}</button> : null}
    </main>;
  }
  const s = read.school;
  const accent = s.accentColor !== null && schoolBrandingColorOk(s.accentColor) ? s.accentColor : DEFAULT_ACCENT;
  const logo = s.logoUrl !== null && schoolBrandingImageUrlOk(s.logoUrl) ? s.logoUrl : null;
  const ages = agesText(t, read.ageMin, read.ageMax);
  return <main className={styles.page} style={{ ['--accent' as string]: accent }} aria-labelledby="public-calendar-title" data-testid="public-calendar">
    <header className={styles.school} data-testid="public-calendar-school">
      {logo ? <img src={logo} alt="" referrerPolicy="no-referrer" className={styles.logo}/> : <span className={styles.mark} aria-hidden="true">{s.name.slice(0, 1)}</span>}
      <div>
        <p className={styles.schoolName}>{s.name}</p>
        {s.address ? <p className={styles.line}><span className={styles.hidden}>{t('pubAddress')}: </span>{s.address}</p> : null}
        {s.phone ? <p className={styles.line}><span className={styles.hidden}>{t('pubPhone')}: </span><a href={`tel:${s.phone.replace(/[^0-9+]/g, '')}`}>{s.phone}</a></p> : null}
        {s.contactLine ? <p className={styles.line}>{s.contactLine}</p> : null}
      </div>
    </header>
    {group && onBack ? <button type="button" className={styles.back} onClick={onBack} data-testid="public-calendar-back">← {t('pubBack')}</button> : null}
    <section className={styles.title}>
      <h1 id="public-calendar-title">{read.name}</h1>
      {ages ? <span className={styles.ages}>{ages}</span> : null}
      {read.description ? <p className={styles.description}>{read.description}</p> : null}
    </section>
    {read.kind === 'GROUP' ? <section aria-labelledby="public-calendar-choose">
      <h2 id="public-calendar-choose" className={styles.heading}>{t('pubChoose')}</h2>
      {read.calendars.length ? <ul className={styles.cards}>{read.calendars.map((c) => {
        const cardAges = agesText(t, c.ageMin, c.ageMax);
        return <li key={c.publicId}><button type="button" className={styles.choice} onClick={() => onOpen?.(c.publicId)} data-testid="public-calendar-card">
          <strong>{c.name}</strong>
          {cardAges ? <span className={styles.ages}>{cardAges}</span> : null}
          {c.description ? <span className={styles.line}>{c.description}</span> : null}
          <span className={styles.count}>{t('pubUpcoming', { n: c.upcomingCount })}</span>
        </button></li>;
      })}</ul> : <p className={styles.notice}>{t('pubNoTimes')}</p>}
    </section> : <section aria-labelledby="public-calendar-times">
      <h2 id="public-calendar-times" className={styles.heading}>{t('pubTimes')}</h2>
      <p className={styles.book} data-testid="public-calendar-book">{s.phone ? t('pubCall', { phone: s.phone }) : t('pubCallNoPhone')}</p>
      {read.times.length ? timesByDay(read.times).map(([date, times]) => <div key={date} className={styles.day} data-testid="public-calendar-day">
        <h3>{dayLabel(language, date)}</h3>
        <ul className={styles.times}>{times.map((x) => <li key={x.startsAt + x.name} className={styles.time} data-testid="public-calendar-time">
          <span className={styles.clock}>{clock(language, x.localStart)} – {clock(language, x.localEnd)}</span>
          <span className={styles.timeName}>{x.name}{x.room ? <small> · {x.room}</small> : null}</span>
          <span className={styles.spots} data-full={x.spotsLeft === 0 ? 'true' : undefined}>{x.spotsLeft === 0 ? t('pubFull') : t('pubSpots', { n: x.spotsLeft })}</span>
        </li>)}</ul>
      </div>) : <p className={styles.notice}>{t('pubNoTimes')}</p>}
      <p className={styles.note}>{t('pubTimesNote', { zone: read.timezone })}</p>
    </section>}
  </main>;
}

/** Reads the calendar named by the link; a group's cards open a member calendar on the same page (and inside an embed). */
export function PublicCalendarPage({ publicId, read: readCalendar = readPublicShareCalendar }: {
  publicId: string; read?: (publicId: string, signal: AbortSignal) => Promise<PublicCalendarRead>;
}): React.ReactElement {
  const { preferences } = useLocale();
  const [group, setGroup] = useState<PublicShareCalendar | null>(null);
  const [current, setCurrent] = useState(publicId);
  const [state, setState] = useState<PublicCalendarState>('LOADING');
  useEffect(() => {
    const abort = new AbortController();
    setState('LOADING');
    readCalendar(current, AbortSignal.any([abort.signal, AbortSignal.timeout(20000)])).then((r) => { if (!abort.signal.aborted) setState(r); },
      () => { if (!abort.signal.aborted) setState('UNAVAILABLE'); });
    return () => abort.abort();
  }, [current, readCalendar]);
  // The first read of the link is the group, when it is one; cards then open members under it.
  useEffect(() => { if (current === publicId && typeof state === 'object' && state.kind === 'GROUP') setGroup(state); }, [state, current, publicId]);
  const inMember = current !== publicId && group !== null;
  return <PublicCalendarView language={preferences.language} read={state} group={inMember ? group : null}
    onOpen={(id) => { setCurrent(id); try { window.scrollTo({ top: 0 }); } catch { /* not available */ } }}
    onBack={() => setCurrent(publicId)}/>;
}
