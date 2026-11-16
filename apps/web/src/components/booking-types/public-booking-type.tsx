'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatEventBookingCode, schoolBrandingColorOk, schoolBrandingImageUrlOk,
  type BookingTypeAnswer, type PublicBookingType, type PublicBookingTypeCancelResult, type PublicBookingTypeOutcome,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { publicBookingTypeApi, type PublicBookingTypeApi } from './http';
import { bookingTypesText, schoolDay, type BookingTypesKey } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type PublicTypeRead = 'LOADING' | 'NOT_FOUND' | 'UNAVAILABLE' | PublicBookingType;
export type PublicTypeValues = Readonly<{ startsAt: string; name: string; email: string; mobile: string; answers: readonly BookingTypeAnswer[]; waiverAccepted: boolean; website: string }>;
export const emptyPublicTypeValues = (count: number): PublicTypeValues => ({ startsAt: '', name: '', email: '', mobile: '', answers: Array(count).fill(null), waiverAccepted: false, website: '' });
type T = (key: BookingTypesKey, vars?: Readonly<Record<string, string | number>>) => string;
const DEFAULT_ACCENT = '#1d4ed8';

export type PublicBookingTypeViewProps = Readonly<{
  language: string; read: PublicTypeRead; values: PublicTypeValues; busy: boolean; booking: PublicBookingTypeOutcome | null; cancel: PublicBookingTypeCancelResult | null; code: string;
  onChange?: ((values: PublicTypeValues) => void) | undefined; onBook?: (() => void) | undefined; onCode?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined;
}>;

export function typeBookingText(t: T, language: string, o: PublicBookingTypeOutcome): string {
  if (o.result !== 'BOOKED') return t(`r${o.result}`);
  if (o.status === 'CANCELLED') return t('rBOOKED_CANCELLED');
  return t('rBOOKED', { date: o.localDate ? schoolDay(language, o.localDate) : '', start: o.localStart ?? '', code: o.code ? formatEventBookingCode(o.code) : '' });
}

/** The family page: no names of other families, only spots left. The server decides every time, spot, answer and rule again. */
export function PublicBookingTypeView(p: PublicBookingTypeViewProps): React.ReactElement {
  const t: T = (key, vars) => bookingTypesText(p.language, key, vars);
  const r = p.read, v = p.values;
  const set = (patch: Partial<PublicTypeValues>) => p.onChange?.({ ...v, ...patch });
  if (r === 'LOADING' || r === 'NOT_FOUND' || r === 'UNAVAILABLE') {
    return <main className={styles.page}><p className={styles.meta} role="status">{t(r === 'LOADING' ? 'pubLoading' : r === 'NOT_FOUND' ? 'pubNotFound' : 'pubUnavailable')}</p></main>;
  }
  const b = r.branding;
  const accent = b.accentColor !== null && schoolBrandingColorOk(b.accentColor) ? b.accentColor : DEFAULT_ACCENT;
  const logo = b.logoUrl !== null && schoolBrandingImageUrlOk(b.logoUrl) ? b.logoUrl : null;
  const cover = b.coverUrl !== null && schoolBrandingImageUrlOk(b.coverUrl) ? b.coverUrl : null;
  const booked = p.booking?.result === 'BOOKED' && p.booking.status !== 'CANCELLED';
  const days = [...new Set(r.times.map((x) => x.localDate))];
  const answer = (i: number, value: BookingTypeAnswer) => set({ answers: v.answers.map((a, j) => (j === i ? value : a)) });
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onBook?.(); };
  const cancel = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onCancel?.(); };
  return <main className={styles.page} aria-labelledby="public-type-title" data-testid="public-type">
    {cover ? <img src={cover} alt="" referrerPolicy="no-referrer" style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 12, display: 'block' }}/>
      : <div aria-hidden="true" style={{ height: 8, background: accent, borderRadius: 4 }}/>}
    <header className={styles.head}>
      <div className={styles.row} style={{ alignItems: 'center' }}>
        {logo ? <img src={logo} alt="" referrerPolicy="no-referrer" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 8, background: '#fff' }}/> : null}
        <p className={styles.meta}>{r.schoolName}</p></div>
      <h1 id="public-type-title" style={{ color: accent }}>{r.name}</h1>
      {r.description ? <p className={styles.intro} style={{ whiteSpace: 'pre-line' }}>{r.description}</p> : null}
      {b.contactLine ? <p className={styles.meta}>{b.contactLine}</p> : null}</header>
    {p.booking ? <div className={styles.notice} role={booked ? 'status' : 'alert'} data-testid="public-type-outcome">
      <p>{typeBookingText(t, p.language, p.booking)}</p>
      {booked && p.booking.thankYou ? <p style={{ whiteSpace: 'pre-line' }} data-testid="public-type-thanks">{p.booking.thankYou}</p> : null}</div> : null}
    {r.audience === 'FAMILIES_ONLY' ? <div className={styles.notice} role="status"><p>{t('pubFamiliesOnly')}</p>
      <a className={styles.primary} href="/parent">{t('signIn')}</a></div>
      : r.status === 'CLOSED' ? <p className={styles.notice} role="status">{t('pubClosed')}</p>
      : r.status === 'PAUSED' ? <p className={styles.notice} role="status">{t('pubPaused')}</p>
      : booked ? null
      : !r.times.length ? <p className={styles.notice} role="status">{t('noTimes')}</p>
      : <article className={styles.card}><form className={styles.form} onSubmit={submit} data-testid="public-type-form"><fieldset disabled={p.busy} className={styles.form}>
        <legend>{t('pickTime')}</legend>
        {days.map((day) => <fieldset key={day} className={styles.form}><legend>{schoolDay(p.language, day)}</legend>
          {r.times.filter((x) => x.localDate === day).map((x) => <label key={x.startsAt} className={styles.check}>
            <input type="radio" name="startsAt" value={x.startsAt} required disabled={x.spotsLeft < 1} checked={v.startsAt === x.startsAt} onChange={() => set({ startsAt: x.startsAt })}/>
            {x.localStart}–{x.localEnd} ({x.spotsLeft > 0 ? t('left', { n: x.spotsLeft }) : t('full')})</label>)}</fieldset>)}
        <h2>{t('yourDetails')}</h2>
        <label className={styles.field}>{t('name')}<input required autoComplete="name" maxLength={120} value={v.name} onChange={(e) => set({ name: e.target.value })}/></label>
        <label className={styles.field}>{t('email')}<input type="email" autoComplete="email" maxLength={254} value={v.email} onChange={(e) => set({ email: e.target.value })}/></label>
        <label className={styles.field}>{t('mobile')}<input type="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{6,14}" value={v.mobile} onChange={(e) => set({ mobile: e.target.value })}/></label>
        <p className={styles.meta}>{t('contactHelp')}</p>
        {r.questions.length ? <><h2>{t('questionsTitle')}</h2>
          {r.questions.map((q, i) => q.kind === 'TEXT'
            ? <label key={i} className={styles.field} data-testid="public-type-question">{q.label}<input required={q.required} maxLength={300}
              value={typeof v.answers[i] === 'string' ? v.answers[i] as string : ''} onChange={(e) => answer(i, e.target.value)}/></label>
            : <fieldset key={i} className={styles.form} data-testid="public-type-question"><legend>{q.label}</legend>
              <label className={styles.check}><input type="radio" name={`q${i}`} required={q.required} checked={v.answers[i] === true} onChange={() => answer(i, true)}/>{t('yes')}</label>
              <label className={styles.check}><input type="radio" name={`q${i}`} required={q.required} checked={v.answers[i] === false} onChange={() => answer(i, false)}/>{t('no')}</label>
            </fieldset>)}</> : null}
        {r.waiver ? <><h2>{t('waiverTitle')}</h2>
          <div className={styles.card} style={{ whiteSpace: 'pre-line', maxHeight: 240, overflowY: 'auto' }} data-testid="public-type-waiver">{r.waiver}</div>
          <label className={styles.check}><input type="checkbox" required checked={v.waiverAccepted} onChange={(e) => set({ waiverAccepted: e.target.checked })}/>{t('waiverAccept')}</label></> : null}
        {/* Left empty by people; the server refuses a booking that fills it. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>Website<input name="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={(e) => set({ website: e.target.value })}/></label></div>
        <div className={styles.actions}><button type="submit" className={styles.primary} style={{ background: accent, borderColor: accent }} disabled={p.busy || !v.startsAt}>{t('book')}</button></div>
      </fieldset></form></article>}
    <article className={styles.card} aria-labelledby="public-type-cancel-title"><h2 id="public-type-cancel-title">{t('cancelTitle')}</h2>
      <form className={styles.form} onSubmit={cancel} data-testid="public-type-cancel-form"><fieldset disabled={p.busy} className={styles.form}>
        <label className={styles.field}>{t('code')}<input required autoComplete="off" maxLength={14} value={p.code} onChange={(e) => p.onCode?.(e.target.value)}/></label>
        {p.cancel ? <p role={p.cancel === 'CANCELLED' ? 'status' : 'alert'} data-testid="public-type-cancel-outcome">{t(`c${p.cancel}`)}</p> : null}
        <div className={styles.actions}><button type="submit" className={styles.danger} disabled={p.busy}>{t('cancelMine')}</button></div>
      </fieldset></form></article>
    <p className={styles.meta}>{t('poweredBy')}</p>
  </main>;
}

/** The body the page sends: text answers trimmed, an empty optional text answer sent as an empty string, an unanswered yes/no as null. */
export function publicTypeInput(type: PublicBookingType, v: PublicTypeValues) {
  return {
    startsAt: v.startsAt, name: v.name.trim(), email: v.email.trim(), mobile: v.mobile.trim(),
    answers: type.questions.map((q, i) => { const a = v.answers[i] ?? null; return q.kind === 'TEXT' ? (typeof a === 'string' ? a.trim() : '') : (typeof a === 'boolean' ? a : null); }),
    waiverAccepted: type.waiver !== '' && v.waiverAccepted, website: v.website,
  };
}

/**
 * Public booking type page at /book/t/<link id> (0286 PR 2). An unchanged retry reuses its key, so a lost answer can be sent
 * again without a second booking; any change of details takes a new key. Every answer is followed by a fresh read of spots left.
 */
export function PublicBookingTypePage({ publicId, api = publicBookingTypeApi }: { publicId: string; api?: PublicBookingTypeApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [read, setRead] = useState<PublicTypeRead>('LOADING');
  const [values, setValues] = useState<PublicTypeValues>(emptyPublicTypeValues(0));
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<PublicBookingTypeOutcome | null>(null);
  const [cancel, setCancel] = useState<PublicBookingTypeCancelResult | null>(null);
  const [code, setCode] = useState('');
  const [refresh, setRefresh] = useState(0);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null), gate = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const abort = new AbortController();
    void api.read(publicId, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then((next) => {
      if (abort.signal.aborted) return;
      setRead(next);
      // Answers follow the questions as last read; a change of questions starts the answers again.
      if (typeof next !== 'string') setValues((v) => (v.answers.length === next.questions.length ? v : { ...v, answers: Array(next.questions.length).fill(null) }));
    });
    return () => { abort.abort(); };
  }, [api, publicId, refresh]);

  const onBook = useCallback(async () => {
    if (gate.current || typeof read === 'string') return;
    const input = publicTypeInput(read, values);
    const fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: globalThis.crypto.randomUUID().replace(/-/g, '') };
    gate.current = true; setBusy(true); setCancel(null);
    const outcome = await api.book(publicId, read, input, retry.current.key, AbortSignal.timeout(30000));
    gate.current = false;
    if (!mounted.current) return;
    setBusy(false); setBooking(outcome);
    if (outcome.result === 'BOOKED' && outcome.code) setCode(formatEventBookingCode(outcome.code));
    if (outcome.result !== 'UNAVAILABLE') setRefresh((n) => n + 1);
  }, [api, publicId, read, values]);

  const onCancel = useCallback(async () => {
    if (gate.current) return;
    gate.current = true; setBusy(true);
    const result = await api.cancel(publicId, code, AbortSignal.timeout(30000));
    gate.current = false;
    if (!mounted.current) return;
    setBusy(false); setCancel(result);
    if (result === 'CANCELLED') { setBooking(null); retry.current = null; setRefresh((n) => n + 1); }
  }, [api, publicId, code]);

  return <PublicBookingTypeView language={preferences.language} read={read} values={values} busy={busy} booking={booking} cancel={cancel} code={code}
    onChange={setValues} onBook={() => { void onBook(); }} onCode={setCode} onCancel={() => { void onCancel(); }}/>;
}
