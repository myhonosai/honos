'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateSaveSchoolEventInput, type SchoolEvent, type SchoolEventBooking, type SchoolEventBookingStatus, type SchoolEventDetail, type SchoolEvents,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { EventError, keepEventForRetry, schoolEventsApi, type EventCommand, type EventErrorKind, type EventScope, type SchoolEventsApi } from './http';
import { eventDay, eventsText, type EventsKey } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type EventRead<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: T };
export type EventForm = null | Readonly<{ kind: 'create' }> | Readonly<{ kind: 'edit'; eventId: string }>;
export type EventOutcome = null | Readonly<{ kind: 'SENDING' | EventErrorKind }> | Readonly<{ kind: 'DONE'; skippedTimes: readonly string[] }>;
export type EventFields = Readonly<Record<string, string>>;
/** A staff command: one event command, or one booking status change. */
export type EventRequest = Readonly<{ run: 'event'; body: EventCommand }> | Readonly<{ run: 'booking'; bookingId: string; expectedVersion: number; status: SchoolEventBookingStatus }>;
type Pending = Readonly<{ key: string; scope: EventScope; request: EventRequest }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
type T = (key: EventsKey, vars?: Readonly<Record<string, string | number>>) => string;
const textFor = (language: string): T => (key, vars) => eventsText(language, key, vars);
/** Failures the person can fix in the open form; every other answer closes it and reads again. */
const FIXABLE: readonly EventErrorKind[] = ['INVALID', 'DATE', 'UNKNOWN'];
const readState = (error: unknown): { state: 'DENIED' | 'UNAVAILABLE' } => ({ state: error instanceof EventError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
const isLocked = (e: SchoolEvent) => e.status !== 'DRAFT';

function whole(value: string | undefined): number {
  const v = (value ?? '').trim();
  if (!/^\d{1,3}$/.test(v)) throw new EventError('INVALID');
  return Number(v);
}

/** The request body for the open form, from its fields and the last verified read; it throws when the details are not acceptable. */
export function eventFormBody(form: NonNullable<EventForm>, fields: EventFields, list: SchoolEvents): EventCommand {
  const event = form.kind === 'edit' ? list.events.find((e) => e.eventId === form.eventId) : undefined;
  if (form.kind === 'edit' && (!event || event.status === 'CANCELLED')) throw new EventError('INVALID');
  // Once published the date and times are fixed: the form shows them disabled and the last verified values are sent.
  const fixed = event && isLocked(event) ? event : null;
  const pick = (name: string, fallback: string | undefined) => fixed && fallback !== undefined ? fallback : (fields[name] ?? '').trim();
  const input = validateSaveSchoolEventInput({
    expectedVersion: event ? event.version : 0,
    title: (fields.title ?? '').trim(), description: (fields.description ?? '').trim(), place: (fields.place ?? '').trim(),
    localDate: pick('localDate', fixed?.localDate), opensAt: pick('opensAt', fixed?.opensAt).slice(0, 5), closesAt: pick('closesAt', fixed?.closesAt).slice(0, 5),
    slotMinutes: fixed ? fixed.slotMinutes : whole(fields.slotMinutes), spotsPerSlot: whole(fields.spotsPerSlot),
  });
  // The server checks the school date again; this only stops an obvious mistake before anything is sent.
  if (!fixed && input.localDate < list.localToday) throw new EventError('DATE');
  return event ? { action: 'edit', eventId: event.eventId, input } : { action: 'create', input };
}

export type SchoolEventsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; origin: string;
  list: EventRead<SchoolEvents>; selected: string | null; detail: EventRead<SchoolEventDetail> | null; form: EventForm; outcome: EventOutcome;
  locked: boolean; canRetry: boolean; copied?: boolean | undefined;
  onRefresh?: (() => void) | undefined; onSelect?: ((eventId: string | null) => void) | undefined; onOpen?: ((form: EventForm) => void) | undefined;
  onClose?: (() => void) | undefined; onSubmit?: ((fields: EventFields) => void) | undefined; onRequest?: ((request: EventRequest) => void) | undefined;
  onCopy?: ((link: string) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

function fieldsOf(form: HTMLFormElement): EventFields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = value;
  return out;
}

function Form({ p, t }: { p: SchoolEventsViewProps; t: T }) {
  const form = p.form, list = p.list;
  if (!form || list.state !== 'READY') return null;
  const e = form.kind === 'edit' ? list.read.events.find((x) => x.eventId === form.eventId) ?? null : null;
  if (form.kind === 'edit' && !e) return null;
  const fixed = !!e && isLocked(e);
  const submit = (ev: React.FormEvent<HTMLFormElement>) => { ev.preventDefault(); p.onSubmit?.(fieldsOf(ev.currentTarget)); };
  return <article className={styles.card} aria-labelledby="event-form-title" data-testid="event-form">
    <h2 id="event-form-title">{e ? `${t('edit')}: ${e.title}` : t('newEvent')}</h2>
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>{t('fTitle')}<input name="title" required maxLength={120} defaultValue={e?.title ?? ''}/></label>
      <label className={styles.field}>{t('fDescription')}<textarea name="description" maxLength={500} rows={3} defaultValue={e?.description ?? ''}/></label>
      <label className={styles.field}>{t('fPlace')}<input name="place" maxLength={120} defaultValue={e?.place ?? ''}/></label>
      {fixed ? <p className={styles.meta}>{t('lockedHelp')}</p> : null}
      <label className={styles.field}>{t('fDate')}<input name="localDate" type="date" required disabled={fixed} min={fixed ? undefined : list.read.localToday} defaultValue={e?.localDate ?? list.read.localToday}/></label>
      <label className={styles.field}>{t('fOpens')}<input name="opensAt" type="time" step={60} required disabled={fixed} defaultValue={e?.opensAt ?? '10:00'}/></label>
      <label className={styles.field}>{t('fCloses')}<input name="closesAt" type="time" step={60} required disabled={fixed} defaultValue={e?.closesAt ?? '14:00'}/></label>
      <label className={styles.field}>{t('fSlot')}<input name="slotMinutes" type="number" min={10} max={240} required disabled={fixed} defaultValue={e?.slotMinutes ?? 30}/></label>
      <label className={styles.field}>{t('fSpots')}<input name="spotsPerSlot" type="number" min={1} max={500} required defaultValue={e?.spotsPerSlot ?? 4}/></label>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={p.locked}>{t('save')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('cancelForm')}</button>
      </div>
    </form>
  </article>;
}

const STATUS_ACTIONS: Record<SchoolEvent['status'], readonly ('PUBLISHED' | 'CLOSED' | 'CANCELLED')[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'], PUBLISHED: ['CLOSED', 'CANCELLED'], CLOSED: ['PUBLISHED', 'CANCELLED'], CANCELLED: [],
};
function Booking({ b, p, t }: { b: SchoolEventBooking; p: SchoolEventsViewProps; t: T }) {
  const ask = (status: SchoolEventBookingStatus) => p.onRequest?.({ run: 'booking', bookingId: b.bookingId, expectedVersion: b.version, status });
  return <li className={styles.row} data-testid="event-booking">
    <span><strong>{b.name}</strong> {[b.email, b.mobile].filter(Boolean).join(' / ')} ({t(`b${b.status}`)}{b.cancelledBy ? ` ${t(b.cancelledBy === 'FAMILY' ? 'byFamily' : 'byStaff')}` : ''})</span>
    <span className={styles.actions}>
      {b.status === 'BOOKED' ? <>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => ask('ARRIVED')}>{t('arrived')}</button>
        <button type="button" className={styles.danger} disabled={p.locked} onClick={() => ask('CANCELLED')}>{t('cancelBooking')}</button>
      </> : b.status === 'ARRIVED' ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => ask('BOOKED')}>{t('undo')}</button> : null}
    </span>
  </li>;
}

function Detail({ e, p, t }: { e: SchoolEvent; p: SchoolEventsViewProps; t: T }) {
  const d = p.detail;
  const link = `${p.origin}/book/${e.publicId}`;
  const status = (target: 'PUBLISHED' | 'CLOSED' | 'CANCELLED') => p.onRequest?.({ run: 'event', body: { action: 'status', eventId: e.eventId, input: { expectedVersion: e.version, status: target } } });
  return <div data-testid="event-detail">
    {e.description ? <p>{e.description}</p> : null}
    <div className={styles.actions}>
      {e.status !== 'CANCELLED' ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'edit', eventId: e.eventId })}>{t('edit')}</button> : null}
      {STATUS_ACTIONS[e.status].map((target) => <button key={target} type="button" className={target === 'CANCELLED' ? styles.danger : styles.primary} disabled={p.locked} onClick={() => status(target)}>
        {t(target === 'CANCELLED' ? 'cancelEvent' : target === 'CLOSED' ? 'close' : e.status === 'CLOSED' ? 'reopen' : 'publish')}</button>)}
    </div>
    {e.status !== 'CANCELLED' ? <p className={styles.meta}>{t('cancelEventHelp')}</p> : null}
    {e.status === 'PUBLISHED' || e.status === 'CLOSED' ? <p className={styles.meta}>{t('link')}: <code data-testid="event-link">{link}</code>{' '}
      <button type="button" className={styles.secondary} onClick={() => p.onCopy?.(link)}>{t('copyLink')}</button>{p.copied ? ` ${t('copied')}` : null}</p> : null}
    {!d || d.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : d.state !== 'READY' ? <p className={styles.meta} role="alert">{t(d.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : <ul className={styles.list}>{d.read.slots.map((s) => <li key={s.slotId} data-testid="event-slot">
        <strong>{t('slotLine', { start: s.localStart, end: s.localEnd, taken: s.taken, spots: d.read.event.spotsPerSlot })}</strong>
        {s.bookings.length ? <ul className={styles.list}>{s.bookings.map((b) => <Booking key={b.bookingId} b={b} p={p} t={t}/>)}</ul> : null}
      </li>)}</ul>}
  </div>;
}

function List({ p, t }: { p: SchoolEventsViewProps; t: T }) {
  const list = p.list;
  return <article className={styles.card} aria-labelledby="events-title" data-testid="events">
    <div className={styles.cardHead}><h2 id="events-title">{t('pageTitle')}</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={p.locked || list.state !== 'READY'} onClick={() => p.onOpen?.({ kind: 'create' })}>{t('newEvent')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>
      </div></div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="alert">{t(list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : !list.read.events.length ? <p className={styles.meta}>{t('none')}</p>
      : <ul className={styles.list}>{list.read.events.map((e) => <li key={e.eventId} data-testid="event-row">
        <button type="button" className={styles.tab} aria-expanded={p.selected === e.eventId} disabled={p.locked} onClick={() => p.onSelect?.(p.selected === e.eventId ? null : e.eventId)}>
          <strong>{e.title}</strong> <span className={styles.chip}>{t(`s${e.status}`)}</span></button>
        <p className={styles.meta}>{eventDay(p.language, e.localDate)}, {e.opensAt}–{e.closesAt}{e.place ? `, ${e.place}` : ''}. {t('slots', { n: e.slotCount || Math.floor(minutes(e) / e.slotMinutes), m: e.slotMinutes, spots: e.spotsPerSlot })}. {t('booked', { n: e.bookedCount })}</p>
        {p.selected === e.eventId ? <Detail e={e} p={p} t={t}/> : null}
      </li>)}</ul>}
  </article>;
}
const minutes = (e: SchoolEvent) => { const m = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)); return m(e.closesAt) - m(e.opensAt); };

export function SchoolEventsView(p: SchoolEventsViewProps): React.ReactElement {
  const o = p.outcome, t = textFor(p.language);
  return <main className={styles.page} aria-labelledby="school-events-title">
    <header className={styles.head}><h1 id="school-events-title">{t('pageTitle')}</h1>
      <p className={styles.intro}>{t('pageIntro')}</p></header>
    {p.concealed ? <p className={styles.meta} role="status">{t('concealed')}</p>
      : p.waiting ? <p className={styles.meta} role="status">{t('waiting')}</p>
      : !p.hasSchool ? <p className={styles.meta} role="status">{t('noSchool')}</p>
      : <>
        {o ? <div className={styles.notice} role={o.kind === 'SENDING' ? 'status' : 'alert'} data-testid="event-outcome">
          <p>{o.kind === 'DONE' ? `${t('oDONE')}${o.skippedTimes.length ? ` ${t('skipped', { times: o.skippedTimes.join(', ') })}` : ''}` : t(`o${o.kind}`)}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        </div> : null}
        <Form p={p} t={t}/>
        <List p={p} t={t}/>
      </>}
  </main>;
}

/**
 * Sale-day and event slot booking for staff (B-SCH-3, 0261). Lists the school's events, opens one to see its slots and who
 * booked, and sends one command at a time. Blur, a hidden tab, page hide, a school change or a session end hide the page at once,
 * retire every read and drop any kept command. Every command answer is followed by fresh reads. Nothing here contacts anyone or charges.
 */
export function SchoolEventsPage({ api = schoolEventsApi }: { api?: SchoolEventsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<EventRead<SchoolEvents>>({ state: 'LOADING' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventRead<SchoolEventDetail> | null>(null);
  const [form, setForm] = useState<EventForm>(null);
  const [outcome, setOutcome] = useState<EventOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [copied, setCopied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [origin, setOrigin] = useState('');
  const gen = useRef({ list: 0, detail: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  const retire = () => { gen.current.list++; gen.current.detail++; };
  useEffect(() => { mounted.current = true; setOrigin(globalThis.location?.origin ?? ''); return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null); setSelected(null); setDetail(null); setCopied(false);
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
    let next: EventOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === p.key;
      const signal = AbortSignal.timeout(30000), r = p.request;
      if (r.run === 'event') {
        const receipt = await api.send(p.scope, r.body, p.key, signal, owned);
        next = { kind: 'DONE', skippedTimes: receipt.skippedTimes };
      } else {
        await api.bookingStatus(p.scope, r.bookingId, { expectedVersion: r.expectedVersion, status: r.status }, p.key, signal, owned);
        next = { kind: 'DONE', skippedTimes: [] };
      }
    } catch (error) {
      keep = keepEventForRetry(error);
      next = { kind: error instanceof EventError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === p.key) pending.current = keep ? p : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as EventErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((request: EventRequest) => {
    if (!orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, request };
    void send();
  }, [orgId, schoolId, send]);

  const onSubmit = useCallback((fields: EventFields) => {
    if (lock !== 'NONE' || pending.current || sending.current || list.state !== 'READY' || !form) return;
    let body: EventCommand;
    try { body = eventFormBody(form, fields, list.read); }
    catch (error) { setOutcome({ kind: error instanceof EventError && error.kind === 'DATE' ? 'DATE' : 'INVALID' }); return; }
    start({ run: 'event', body });
  }, [lock, list, form, start]);
  const onRequest = useCallback((request: EventRequest) => { if (lock === 'NONE' && !pending.current && !sending.current) { setOutcome(null); start(request); } }, [lock, start]);
  const onSelect = useCallback((eventId: string | null) => { if (lock === 'NONE') { setSelected(eventId); setCopied(false); } }, [lock]);
  const onOpen = useCallback((next: EventForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);
  const onCopy = useCallback((link: string) => {
    void globalThis.navigator?.clipboard?.writeText(link).then(() => { if (mounted.current) setCopied(true); }, () => undefined);
  }, []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolEventsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} origin={origin} list={list} selected={selected} detail={detail} form={form} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} copied={copied}
      onRefresh={onRefresh} onSelect={onSelect} onOpen={onOpen} onClose={onClose} onSubmit={onSubmit} onRequest={onRequest} onCopy={onCopy} onTryAgain={onTryAgain}/>
  </div>;
}
