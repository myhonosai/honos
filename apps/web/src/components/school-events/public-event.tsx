'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatEventBookingCode, type PublicEventBookingOutcome, type PublicEventCancelResult, type PublicSchoolEvent } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { publicEventApi, type PublicEventApi } from './http';
import { eventDay, eventsText, type EventsKey } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type PublicRead = 'LOADING' | 'NOT_FOUND' | 'UNAVAILABLE' | PublicSchoolEvent;
export type PublicValues = Readonly<{ slotId: string; name: string; email: string; mobile: string; website: string }>;
const EMPTY: PublicValues = { slotId: '', name: '', email: '', mobile: '', website: '' };
type T = (key: EventsKey, vars?: Readonly<Record<string, string | number>>) => string;

export type PublicEventViewProps = Readonly<{
  language: string; read: PublicRead; values: PublicValues; busy: boolean; booking: PublicEventBookingOutcome | null; cancel: PublicEventCancelResult | null; code: string;
  onChange?: ((values: PublicValues) => void) | undefined; onBook?: (() => void) | undefined; onCode?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined;
}>;

export function bookingText(t: T, o: PublicEventBookingOutcome): string {
  if (o.result !== 'BOOKED') return t(`r${o.result}`);
  if (o.status === 'CANCELLED') return t('rBOOKED_CANCELLED');
  return t('rBOOKED', { start: o.localStart ?? '', end: o.localEnd ?? '', code: o.code ? formatEventBookingCode(o.code) : '' });
}

/** The family page: no account, no names of other families, only spots left. The server decides every spot and rule again. */
export function PublicEventView(p: PublicEventViewProps): React.ReactElement {
  const t: T = (key, vars) => eventsText(p.language, key, vars);
  const r = p.read, v = p.values;
  const set = (patch: Partial<PublicValues>) => p.onChange?.({ ...v, ...patch });
  if (r === 'LOADING' || r === 'NOT_FOUND' || r === 'UNAVAILABLE') {
    return <main className={styles.page}><p className={styles.meta} role="status">{t(r === 'LOADING' ? 'pubLoading' : r === 'NOT_FOUND' ? 'pubNotFound' : 'pubUnavailable')}</p></main>;
  }
  const booked = p.booking?.result === 'BOOKED' && p.booking.status !== 'CANCELLED';
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onBook?.(); };
  const cancel = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onCancel?.(); };
  return <main className={styles.page} aria-labelledby="public-event-title">
    <header className={styles.head}><p className={styles.meta}>{r.schoolName}</p><h1 id="public-event-title">{r.title}</h1>
      <p className={styles.intro}>{eventDay(p.language, r.localDate)}{r.place ? `, ${r.place}` : ''}</p>
      {r.description ? <p>{r.description}</p> : null}</header>
    {p.booking ? <div className={styles.notice} role={booked ? 'status' : 'alert'} data-testid="public-booking-outcome"><p>{bookingText(t, p.booking)}</p></div> : null}
    {r.status === 'CANCELLED' ? <p className={styles.notice} role="status">{t('pubCancelled')}</p>
      : r.status === 'CLOSED' ? <p className={styles.notice} role="status">{t('pubClosed')}</p>
      : booked ? null
      : <article className={styles.card}><form className={styles.form} onSubmit={submit} data-testid="public-booking-form"><fieldset disabled={p.busy} className={styles.form}>
        <legend>{t('pickTime')}</legend>
        {r.slots.map((s) => <label key={s.slotId} className={styles.check}>
          <input type="radio" name="slotId" value={s.slotId} required disabled={s.spotsLeft < 1} checked={v.slotId === s.slotId} onChange={() => set({ slotId: s.slotId })}/>
          {s.localStart}–{s.localEnd} ({s.spotsLeft > 0 ? t('left', { n: s.spotsLeft }) : t('full')})</label>)}
        <h2>{t('yourDetails')}</h2>
        <label className={styles.field}>{t('name')}<input required autoComplete="name" maxLength={120} value={v.name} onChange={(e) => set({ name: e.target.value })}/></label>
        <label className={styles.field}>{t('email')}<input type="email" autoComplete="email" maxLength={254} value={v.email} onChange={(e) => set({ email: e.target.value })}/></label>
        <label className={styles.field}>{t('mobile')}<input type="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{6,14}" value={v.mobile} onChange={(e) => set({ mobile: e.target.value })}/></label>
        <p className={styles.meta}>{t('contactHelp')}</p>
        {/* Left empty by people; the server refuses a booking that fills it. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>Website<input name="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={(e) => set({ website: e.target.value })}/></label></div>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={p.busy || !v.slotId}>{t('book')}</button></div>
      </fieldset></form></article>}
    <article className={styles.card} aria-labelledby="public-cancel-title"><h2 id="public-cancel-title">{t('cancelTitle')}</h2>
      <form className={styles.form} onSubmit={cancel} data-testid="public-cancel-form"><fieldset disabled={p.busy} className={styles.form}>
        <label className={styles.field}>{t('code')}<input required autoComplete="off" maxLength={14} value={p.code} onChange={(e) => p.onCode?.(e.target.value)}/></label>
        {p.cancel ? <p role={p.cancel === 'CANCELLED' ? 'status' : 'alert'} data-testid="public-cancel-outcome">{t(`c${p.cancel}`)}</p> : null}
        <div className={styles.actions}><button type="submit" className={styles.danger} disabled={p.busy}>{t('cancelMine')}</button></div>
      </fieldset></form></article>
    <p className={styles.meta}>{t('poweredBy')}</p>
  </main>;
}

/**
 * Public booking page at /book/<link id> (B-SCH-3, 0261). An unchanged retry reuses its key, so a lost answer can be sent again
 * without a second booking; any change of details takes a new key. Every answer is followed by a fresh read of spots left.
 */
export function PublicEventPage({ publicId, api = publicEventApi }: { publicId: string; api?: PublicEventApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [read, setRead] = useState<PublicRead>('LOADING');
  const [values, setValues] = useState<PublicValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<PublicEventBookingOutcome | null>(null);
  const [cancel, setCancel] = useState<PublicEventCancelResult | null>(null);
  const [code, setCode] = useState('');
  const [refresh, setRefresh] = useState(0);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null), gate = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const abort = new AbortController();
    void api.read(publicId, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then((next) => { if (!abort.signal.aborted) setRead(next); });
    return () => { abort.abort(); };
  }, [api, publicId, refresh]);

  const onBook = useCallback(async () => {
    if (gate.current) return;
    const fingerprint = JSON.stringify(values);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: globalThis.crypto.randomUUID().replace(/-/g, '') };
    gate.current = true; setBusy(true); setCancel(null);
    const outcome = await api.book(publicId, values, retry.current.key, AbortSignal.timeout(30000));
    gate.current = false;
    if (!mounted.current) return;
    setBusy(false); setBooking(outcome);
    if (outcome.result === 'BOOKED' && outcome.code) setCode(formatEventBookingCode(outcome.code));
    if (outcome.result !== 'UNAVAILABLE') setRefresh((n) => n + 1);
  }, [api, publicId, values]);

  const onCancel = useCallback(async () => {
    if (gate.current) return;
    gate.current = true; setBusy(true);
    const result = await api.cancel(publicId, code, AbortSignal.timeout(30000));
    gate.current = false;
    if (!mounted.current) return;
    setBusy(false); setCancel(result);
    if (result === 'CANCELLED') { setBooking(null); retry.current = null; setRefresh((n) => n + 1); }
  }, [api, publicId, code]);

  return <PublicEventView language={preferences.language} read={read} values={values} busy={busy} booking={booking} cancel={cancel} code={code}
    onChange={setValues} onBook={() => { void onBook(); }} onCode={setCode} onCancel={() => { void onCancel(); }}/>;
}
