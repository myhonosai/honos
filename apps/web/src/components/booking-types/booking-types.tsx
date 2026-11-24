'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BOOKING_TYPE_AUDIENCES, BOOKING_TYPE_LIMITS, BOOKING_TYPE_QUESTION_KINDS, BOOKING_TYPE_TEMPLATES, validateSaveBookingTypeInput,
  type BookingType, type BookingTypeAnswer, type BookingTypeAudience, type BookingTypeBooking, type BookingTypeBookingStatus, type BookingTypeDetail,
  type BookingTypeQuestionKind, type BookingTypes, type BookingTypeTemplate,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import {
  BookingTypeError, bookingTypesApi, keepBookingTypeForRetry, type BookingTypeCommand, type BookingTypeErrorKind, type BookingTypeScope, type BookingTypesApi,
} from './http';
import { bookingTypesText, schoolDay, weekdayName, type BookingTypesKey } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type TypeRead<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: T };
export type TypeForm = null | Readonly<{ kind: 'create' }> | Readonly<{ kind: 'edit'; typeId: string }>;
export type TypeOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | BookingTypeErrorKind }>;
/** The open form as typed: numbers stay text until the whole form is checked. */
export type TypeDraft = Readonly<{
  name: string; description: string; template: BookingTypeTemplate; durationMinutes: string; spotsPerTime: string;
  weeklyHours: readonly Readonly<{ day: string; start: string; end: string }>[]; horizonDays: string; noticeHours: string; audience: BookingTypeAudience;
  questions: readonly Readonly<{ label: string; kind: BookingTypeQuestionKind; required: boolean }>[]; waiver: string; thankYou: string;
}>;
export type TypeRequest = Readonly<{ run: 'type'; body: BookingTypeCommand }> | Readonly<{ run: 'booking'; bookingId: string; expectedVersion: number; status: BookingTypeBookingStatus }>;
type Pending = Readonly<{ key: string; scope: BookingTypeScope; request: TypeRequest }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
type T = (key: BookingTypesKey, vars?: Readonly<Record<string, string | number>>) => string;
const textFor = (language: string): T => (key, vars) => bookingTypesText(language, key, vars);
/** Failures the person can fix in the open form; every other answer closes it and reads again. */
const FIXABLE: readonly BookingTypeErrorKind[] = ['INVALID', 'NO_TIMES', 'UNKNOWN'];
const readState = (error: unknown): { state: 'DENIED' | 'UNAVAILABLE' } => ({ state: error instanceof BookingTypeError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });

export function draftFor(type: BookingType | null): TypeDraft {
  if (!type) {
    return { name: '', description: '', template: 'TEST_RESERVATION', durationMinutes: '30', spotsPerTime: '1', weeklyHours: [{ day: '6', start: '10:00', end: '12:00' }],
      horizonDays: '30', noticeHours: '12', audience: 'OPEN', questions: [], waiver: '', thankYou: '' };
  }
  return {
    name: type.name, description: type.description, template: type.template, durationMinutes: String(type.durationMinutes), spotsPerTime: String(type.spotsPerTime),
    weeklyHours: type.weeklyHours.map((w) => ({ day: String(w.day), start: w.start, end: w.end })), horizonDays: String(type.horizonDays),
    noticeHours: String(type.noticeHours), audience: type.audience, questions: type.questions.map((q) => ({ ...q })), waiver: type.waiver, thankYou: type.thankYou,
  };
}

function whole(value: string): number {
  const v = value.trim();
  if (!/^\d{1,3}$/.test(v)) throw new BookingTypeError('INVALID');
  return Number(v);
}

/** The request body for the open form, from its draft and the last verified read; it throws when the details are not acceptable. */
export function bookingTypeFormBody(form: NonNullable<TypeForm>, draft: TypeDraft, list: BookingTypes): BookingTypeCommand {
  const type = form.kind === 'edit' ? list.bookingTypes.find((x) => x.typeId === form.typeId) : undefined;
  if (form.kind === 'edit' && (!type || type.status === 'ARCHIVED')) throw new BookingTypeError('INVALID');
  let input;
  try {
    input = validateSaveBookingTypeInput({
      expectedVersion: type ? type.version : 0, name: draft.name.trim(), description: draft.description.trim(), template: draft.template,
      durationMinutes: whole(draft.durationMinutes), spotsPerTime: whole(draft.spotsPerTime),
      weeklyHours: draft.weeklyHours.map((w) => ({ day: whole(w.day), start: w.start.slice(0, 5), end: w.end.slice(0, 5) })),
      horizonDays: whole(draft.horizonDays), noticeHours: whole(draft.noticeHours), audience: draft.audience,
      questions: draft.questions.map((q) => ({ label: q.label.trim(), kind: q.kind, required: q.required })),
      waiver: draft.waiver.trim(), thankYou: draft.thankYou.trim(),
    });
  } catch { throw new BookingTypeError('INVALID'); }
  return type ? { action: 'edit', typeId: type.typeId, input } : { action: 'create', input };
}

/** A plain link for a school website. It opens the booking page in a new tab; nothing is framed. */
export function embedSnippet(link: string, name: string): string {
  const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<a href="${escape(link)}" target="_blank" rel="noopener">${escape(name)}</a>`;
}

export type BookingTypesViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; origin: string;
  list: TypeRead<BookingTypes>; selected: string | null; detail: TypeRead<BookingTypeDetail> | null; form: TypeForm; outcome: TypeOutcome;
  locked: boolean; canRetry: boolean; copied?: string | null | undefined;
  onRefresh?: (() => void) | undefined; onSelect?: ((typeId: string | null) => void) | undefined; onOpen?: ((form: TypeForm) => void) | undefined;
  onClose?: (() => void) | undefined; onSubmit?: ((draft: TypeDraft) => void) | undefined; onRequest?: ((request: TypeRequest) => void) | undefined;
  onCopy?: ((what: 'link' | 'embed', value: string) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

function Form({ p, t }: { p: BookingTypesViewProps; t: T }) {
  const form = p.form, list = p.list;
  const type = form?.kind === 'edit' && list.state === 'READY' ? list.read.bookingTypes.find((x) => x.typeId === form.typeId) ?? null : null;
  const [draft, setDraft] = useState<TypeDraft>(() => draftFor(type));
  if (!form || list.state !== 'READY' || (form.kind === 'edit' && !type)) return null;
  const set = (patch: Partial<TypeDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setWindow = (i: number, patch: Partial<TypeDraft['weeklyHours'][number]>) => set({ weeklyHours: draft.weeklyHours.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const setQuestion = (i: number, patch: Partial<TypeDraft['questions'][number]>) => set({ questions: draft.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const submit = (ev: React.FormEvent<HTMLFormElement>) => { ev.preventDefault(); p.onSubmit?.(draft); };
  return <article className={styles.card} aria-labelledby="type-form-title" data-testid="type-form">
    <h2 id="type-form-title">{type ? `${t('edit')}: ${type.name}` : t('newType')}</h2>
    {type ? <p className={styles.meta}>{t('editHelp')}</p> : null}
    <form className={styles.form} onSubmit={submit}><fieldset disabled={p.locked} className={styles.form}>
      <label className={styles.field}>{t('fName')}<input name="name" required maxLength={BOOKING_TYPE_LIMITS.name} value={draft.name} onChange={(e) => set({ name: e.target.value })}/></label>
      <label className={styles.field}>{t('fTemplate')}<select name="template" value={draft.template} onChange={(e) => set({ template: e.target.value as BookingTypeTemplate })}>
        {BOOKING_TYPE_TEMPLATES.map((k) => <option key={k} value={k}>{t(`t${k}`)}</option>)}</select></label>
      <label className={styles.field}>{t('fDescription')}<textarea name="description" rows={3} maxLength={BOOKING_TYPE_LIMITS.description} value={draft.description} onChange={(e) => set({ description: e.target.value })}/></label>
      <label className={styles.field}>{t('fDuration')}<input name="durationMinutes" type="number" required min={BOOKING_TYPE_LIMITS.minDuration} max={BOOKING_TYPE_LIMITS.maxDuration} value={draft.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })}/></label>
      <label className={styles.field}>{t('fSpots')}<input name="spotsPerTime" type="number" required min={1} max={BOOKING_TYPE_LIMITS.maxSpots} value={draft.spotsPerTime} onChange={(e) => set({ spotsPerTime: e.target.value })}/></label>
      <fieldset className={styles.form} data-testid="type-hours"><legend>{t('fHours')}</legend>
        <p className={styles.meta}>{t('fHoursHelp')}</p>
        {draft.weeklyHours.map((w, i) => <div key={i} className={styles.row} data-testid="type-window">
          <label className={styles.field}>{t('fDay')}<select value={w.day} onChange={(e) => setWindow(i, { day: e.target.value })}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={String(d)}>{weekdayName(p.language, d)}</option>)}</select></label>
          <label className={styles.field}>{t('fFrom')}<input type="time" step={60} required value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })}/></label>
          <label className={styles.field}>{t('fTo')}<input type="time" step={60} required value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })}/></label>
          <button type="button" className={styles.secondary} disabled={draft.weeklyHours.length < 2} onClick={() => set({ weeklyHours: draft.weeklyHours.filter((_, j) => j !== i) })}>{t('remove')}</button>
        </div>)}
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={draft.weeklyHours.length >= BOOKING_TYPE_LIMITS.windows}
          onClick={() => set({ weeklyHours: [...draft.weeklyHours, { day: '6', start: '10:00', end: '12:00' }] })}>{t('addWindow')}</button></div>
      </fieldset>
      <label className={styles.field}>{t('fHorizon')}<input name="horizonDays" type="number" required min={1} max={BOOKING_TYPE_LIMITS.maxHorizonDays} value={draft.horizonDays} onChange={(e) => set({ horizonDays: e.target.value })}/></label>
      <label className={styles.field}>{t('fNotice')}<input name="noticeHours" type="number" required min={0} max={BOOKING_TYPE_LIMITS.maxNoticeHours} value={draft.noticeHours} onChange={(e) => set({ noticeHours: e.target.value })}/></label>
      <fieldset className={styles.form}><legend>{t('fAudience')}</legend>
        {BOOKING_TYPE_AUDIENCES.map((a) => <label key={a} className={styles.check}><input type="radio" name="audience" value={a} checked={draft.audience === a} onChange={() => set({ audience: a })}/>{t(`a${a}`)}</label>)}
        {draft.audience === 'FAMILIES_ONLY' ? <p className={styles.meta}>{t('familiesOnlyHelp')}</p> : null}
      </fieldset>
      <fieldset className={styles.form} data-testid="type-questions"><legend>{t('fQuestions')}</legend>
        {draft.questions.map((q, i) => <div key={i} className={styles.row} data-testid="type-question">
          <label className={styles.field}>{t('qLabel')}<input required maxLength={BOOKING_TYPE_LIMITS.questionLabel} value={q.label} onChange={(e) => setQuestion(i, { label: e.target.value })}/></label>
          <label className={styles.field}>{t('qKind')}<select value={q.kind} onChange={(e) => setQuestion(i, { kind: e.target.value as BookingTypeQuestionKind })}>
            {BOOKING_TYPE_QUESTION_KINDS.map((k) => <option key={k} value={k}>{t(`q${k}`)}</option>)}</select></label>
          <label className={styles.check}><input type="checkbox" checked={q.required} onChange={(e) => setQuestion(i, { required: e.target.checked })}/>{t('qRequired')}</label>
          <button type="button" className={styles.secondary} onClick={() => set({ questions: draft.questions.filter((_, j) => j !== i) })}>{t('remove')}</button>
        </div>)}
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={draft.questions.length >= BOOKING_TYPE_LIMITS.questions}
          onClick={() => set({ questions: [...draft.questions, { label: '', kind: 'TEXT', required: false }] })}>{t('addQuestion')}</button></div>
      </fieldset>
      <label className={styles.field}>{t('fWaiver')}<textarea name="waiver" rows={4} maxLength={BOOKING_TYPE_LIMITS.waiver} value={draft.waiver} onChange={(e) => set({ waiver: e.target.value })}/></label>
      <label className={styles.field}>{t('fThankYou')}<textarea name="thankYou" rows={2} maxLength={BOOKING_TYPE_LIMITS.thankYou} value={draft.thankYou} onChange={(e) => set({ thankYou: e.target.value })}/></label>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary}>{t('save')}</button>
        <button type="button" className={styles.secondary} onClick={p.onClose}>{t('cancelForm')}</button>
      </div>
    </fieldset></form>
  </article>;
}

const STATUS_ACTIONS: Record<BookingType['status'], readonly ('ACTIVE' | 'PAUSED' | 'ARCHIVED')[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'], ACTIVE: ['PAUSED', 'ARCHIVED'], PAUSED: ['ACTIVE', 'ARCHIVED'], ARCHIVED: [],
};
const answerText = (t: T, a: BookingTypeAnswer) => (a === null || a === '' ? t('noAnswer') : a === true ? t('yes') : a === false ? t('no') : a);
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

function Booking({ b, p, t }: { b: BookingTypeBooking; p: BookingTypesViewProps; t: T }) {
  const ask = (status: BookingTypeBookingStatus) => p.onRequest?.({ run: 'booking', bookingId: b.bookingId, expectedVersion: b.version, status });
  return <li className={styles.row} data-testid="type-booking">
    <span><strong>{schoolDay(p.language, b.localDate)} {b.localStart}</strong> {b.name} {[b.email, b.mobile].filter(Boolean).join(' / ')}{' '}
      ({t(`b${b.status}`)}{b.cancelledBy ? ` ${t(b.cancelledBy === 'FAMILY' ? 'byFamily' : 'byStaff')}` : ''})
      {b.questions.length ? <ul className={styles.list}>{b.questions.map((q, i) => <li key={i}>{q.label}: {answerText(t, b.answers[i] ?? null)}</li>)}</ul> : null}
      {b.waiverAcceptedAt ? <span className={styles.meta}> {t('waiverAt', { at: instant(p.language, b.waiverAcceptedAt) })}</span> : null}</span>
    <span className={styles.actions}>
      {b.status === 'BOOKED' ? <>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => ask('ARRIVED')}>{t('arrived')}</button>
        <button type="button" className={styles.danger} disabled={p.locked} onClick={() => ask('CANCELLED')}>{t('cancelBooking')}</button>
      </> : b.status === 'ARRIVED' ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => ask('BOOKED')}>{t('undo')}</button> : null}
    </span>
  </li>;
}

function Detail({ type, p, t }: { type: BookingType; p: BookingTypesViewProps; t: T }) {
  const d = p.detail;
  const link = `${p.origin}/book/t/${type.publicId}`;
  const status = (target: 'ACTIVE' | 'PAUSED' | 'ARCHIVED') => p.onRequest?.({ run: 'type', body: { action: 'status', typeId: type.typeId, input: { expectedVersion: type.version, status: target } } });
  const label = (target: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'): BookingTypesKey => (target === 'ARCHIVED' ? 'archive' : target === 'PAUSED' ? 'pause' : type.status === 'PAUSED' ? 'resume' : 'activate');
  return <div data-testid="type-detail">
    {type.description ? <p>{type.description}</p> : null}
    <div className={styles.actions}>
      {type.status !== 'ARCHIVED' ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'edit', typeId: type.typeId })}>{t('edit')}</button> : null}
      {STATUS_ACTIONS[type.status].map((target) => <button key={target} type="button" className={target === 'ARCHIVED' ? styles.danger : styles.primary} disabled={p.locked} onClick={() => status(target)}>{t(label(target))}</button>)}
    </div>
    {type.status !== 'ARCHIVED' ? <p className={styles.meta}>{t('archiveHelp')}</p> : null}
    {type.status === 'ACTIVE' || type.status === 'PAUSED' ? <>
      <p className={styles.meta}>{t('link')}: <code data-testid="type-link">{link}</code>{' '}
        <button type="button" className={styles.secondary} onClick={() => p.onCopy?.('link', link)}>{t('copyLink')}</button>{p.copied === 'link' ? ` ${t('copied')}` : null}</p>
      <p className={styles.meta}>{t('embed')}: <code data-testid="type-embed">{embedSnippet(link, type.name)}</code>{' '}
        <button type="button" className={styles.secondary} onClick={() => p.onCopy?.('embed', embedSnippet(link, type.name))}>{t('copyEmbed')}</button>{p.copied === 'embed' ? ` ${t('copied')}` : null}</p>
      {type.audience === 'FAMILIES_ONLY' ? <p className={styles.meta}>{t('familiesOnlyHelp')}</p> : null}
    </> : null}
    <h3>{t('bookingsTitle')}</h3>
    {!d || d.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : d.state !== 'READY' ? <p className={styles.meta} role="alert">{t(d.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : !d.read.bookings.length ? <p className={styles.meta}>{t('noBookings')}</p>
      : <ul className={styles.list}>{d.read.bookings.map((b) => <Booking key={b.bookingId} b={b} p={p} t={t}/>)}</ul>}
  </div>;
}

function List({ p, t }: { p: BookingTypesViewProps; t: T }) {
  const list = p.list;
  return <article className={styles.card} aria-labelledby="types-title" data-testid="booking-types">
    <div className={styles.cardHead}><h2 id="types-title">{t('pageTitle')}</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={p.locked || list.state !== 'READY'} onClick={() => p.onOpen?.({ kind: 'create' })}>{t('newType')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>
      </div></div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="alert">{t(list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : !list.read.bookingTypes.length ? <p className={styles.meta}>{t('none')}</p>
      : <ul className={styles.list}>{list.read.bookingTypes.map((x) => <li key={x.typeId} data-testid="type-row">
        <button type="button" className={styles.tab} aria-expanded={p.selected === x.typeId} disabled={p.locked} onClick={() => p.onSelect?.(p.selected === x.typeId ? null : x.typeId)}>
          <strong>{x.name}</strong> <span className={styles.chip}>{t(`s${x.status}`)}</span></button>
        <p className={styles.meta}>{t(`t${x.template}`)}. {t(`a${x.audience}`)}. {t('summary', { m: x.durationMinutes, spots: x.spotsPerTime, n: x.upcomingCount })}.{' '}
          {x.weeklyHours.map((w) => `${weekdayName(p.language, w.day)} ${w.start}–${w.end}`).join(', ')}</p>
        {p.selected === x.typeId ? <Detail type={x} p={p} t={t}/> : null}
      </li>)}</ul>}
  </article>;
}

export function BookingTypesView(p: BookingTypesViewProps): React.ReactElement {
  const o = p.outcome, t = textFor(p.language);
  const formKey = p.form ? (p.form.kind === 'edit' ? `edit:${p.form.typeId}` : 'create') : 'none';
  return <main className={styles.page} aria-labelledby="booking-types-title">
    <header className={styles.head}><h1 id="booking-types-title">{t('pageTitle')}</h1>
      <p className={styles.intro}>{t('pageIntro')}</p></header>
    {p.concealed ? <p className={styles.meta} role="status">{t('concealed')}</p>
      : p.waiting ? <p className={styles.meta} role="status">{t('waiting')}</p>
      : !p.hasSchool ? <p className={styles.meta} role="status">{t('noSchool')}</p>
      : <>
        {o ? <div className={styles.notice} role={o.kind === 'SENDING' ? 'status' : 'alert'} data-testid="type-outcome">
          <p>{t(`o${o.kind}`)}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        </div> : null}
        <Form key={formKey} p={p} t={t}/>
        <List p={p} t={t}/>
      </>}
  </main>;
}

/**
 * Settings › Booking types for staff (0286 PR 2). Lists the school's types, opens one to see its upcoming bookings, and sends
 * one command at a time. Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire every
 * read and drop any kept command. Every command answer is followed by fresh reads. Nothing here contacts anyone or charges.
 */
export function BookingTypesPage({ api = bookingTypesApi }: { api?: BookingTypesApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<TypeRead<BookingTypes>>({ state: 'LOADING' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TypeRead<BookingTypeDetail> | null>(null);
  const [form, setForm] = useState<TypeForm>(null);
  const [outcome, setOutcome] = useState<TypeOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [copied, setCopied] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [origin, setOrigin] = useState('');
  const gen = useRef({ list: 0, detail: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  const retire = () => { gen.current.list++; gen.current.detail++; };
  useEffect(() => { mounted.current = true; setOrigin(globalThis.location?.origin ?? ''); return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null); setSelected(null); setDetail(null); setCopied(null);
    setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing chosen at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelected(null); setDetail(null); setForm(null); setOutcome(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++gen.current.list, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList(readState(error)); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  useEffect(() => {
    const current = ++gen.current.detail, shown = privacy.current;
    if (!orgId || !schoolId || !selected) { setDetail(null); return; }
    setDetail({ state: 'LOADING' });
    const owned = () => mounted.current && current === gen.current.detail && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.detail({ organizationId: orgId, schoolId }, selected, signal, owned).then(
      (read) => { if (owned()) setDetail({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setDetail(readState(error)); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, selected, refresh]);

  const send = useCallback(async () => {
    const p = pending.current;
    if (!p || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: TypeOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === p.key;
      const signal = AbortSignal.timeout(30000), r = p.request;
      if (r.run === 'type') await api.send(p.scope, r.body, p.key, signal, owned);
      else await api.bookingStatus(p.scope, r.bookingId, { expectedVersion: r.expectedVersion, status: r.status }, p.key, signal, owned);
      next = { kind: 'DONE' };
    } catch (error) {
      keep = keepBookingTypeForRetry(error);
      next = { kind: error instanceof BookingTypeError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === p.key) pending.current = keep ? p : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as BookingTypeErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((request: TypeRequest) => {
    if (!orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, request };
    void send();
  }, [orgId, schoolId, send]);

  const onSubmit = useCallback((draft: TypeDraft) => {
    if (lock !== 'NONE' || pending.current || sending.current || list.state !== 'READY' || !form) return;
    let body: BookingTypeCommand;
    try { body = bookingTypeFormBody(form, draft, list.read); } catch { setOutcome({ kind: 'INVALID' }); return; }
    start({ run: 'type', body });
  }, [lock, list, form, start]);
  const onRequest = useCallback((request: TypeRequest) => { if (lock === 'NONE' && !pending.current && !sending.current) { setOutcome(null); start(request); } }, [lock, start]);
  const onSelect = useCallback((typeId: string | null) => { if (lock === 'NONE') { setSelected(typeId); setCopied(null); } }, [lock]);
  const onOpen = useCallback((next: TypeForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);
  const onCopy = useCallback((what: 'link' | 'embed', value: string) => {
    void globalThis.navigator?.clipboard?.writeText(value).then(() => { if (mounted.current) setCopied(what); }, () => undefined);
  }, []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <BookingTypesView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} origin={origin} list={list} selected={selected} detail={detail} form={form} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} copied={copied}
      onRefresh={onRefresh} onSelect={onSelect} onOpen={onOpen} onClose={onClose} onSubmit={onSubmit} onRequest={onRequest} onCopy={onCopy} onTryAgain={onTryAgain}/>
  </div>;
}
