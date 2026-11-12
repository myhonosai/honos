'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  validateCreateClassSeriesInput, validateEndClassSeriesInput, validateFillClassSeriesInput, validateReviseClassSeriesInput, validateSetClassSeriesOngoingInput,
  type ClassSeriesBookingPolicy, type ClassSeriesPattern, type SchoolClassSeries, type WeeklyTimetable,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SeriesError, classSeriesApi, keepForRetry, type ClassSeriesApi, type SeriesAction, type SeriesBody, type SeriesErrorKind, type SeriesScope } from './http';
import { ClassSeriesView, addDays, type ReadState, type SeriesFields, type SeriesForm, type SeriesOutcome, type TopUpState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: SeriesScope; body: SeriesBody }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
/** Failures the person can fix in the open form; every other answer closes it and reads again. */
const FIXABLE: readonly SeriesErrorKind[] = ['INVALID', 'TOO_FAR', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof SeriesError ? error.kind : 'UNKNOWN';
const readState = (error: unknown): { state: 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' } => {
  const kind = readKind(error);
  return { state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' };
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function whole(value: string | undefined): number {
  const v = (value ?? '').trim();
  if (!/^\d{1,4}$/.test(v)) throw new SeriesError('INVALID');
  return Number(v);
}
function pattern(fields: SeriesFields): ClassSeriesPattern {
  const weekdays = (fields.weekdays ?? '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
  const room = (fields.roomName ?? '').trim(), endsOn = (fields.endsOn ?? '').trim();
  if (endsOn && !DATE.test(endsOn)) throw new SeriesError('INVALID');
  return { name: (fields.name ?? '').trim(), roomName: room || null, capacity: whole(fields.capacity), bookingPolicy: (fields.bookingPolicy ?? '') as ClassSeriesBookingPolicy,
    weekdays, localStartTime: (fields.localStartTime ?? '').trim().slice(0, 5), durationMinutes: whole(fields.durationMinutes), endsOn: endsOn || null };
}

/** The request body for an action, from the form and the last verified series read; it throws when the details are not acceptable. */
export function seriesBody(action: SeriesAction, fields: SeriesFields, read: SchoolClassSeries, seriesId: string | null): SeriesBody {
  if (action === 'create') {
    const startsOn = (fields.startsOn ?? '').trim();
    // The server checks the school-local dates again; this only stops obvious mistakes before anything is sent.
    if (!DATE.test(startsOn) || startsOn < addDays(read.localToday, -7)) throw new SeriesError('INVALID');
    return { action, input: validateCreateClassSeriesInput({ programId: (fields.programId ?? '').trim(), startsOn, ...pattern(fields) }) };
  }
  const series = read.series.find((s) => s.seriesId === seriesId);
  if (!series || series.status !== 'ACTIVE') throw new SeriesError('INVALID');
  const expectedVersion = series.version;
  if (action === 'revise') {
    const next = pattern(fields);
    if (next.endsOn && next.endsOn < read.localToday) throw new SeriesError('INVALID');
    return { action, seriesId: series.seriesId, input: validateReviseClassSeriesInput({ expectedVersion, ...next }) };
  }
  if (action === 'end') {
    const lastDate = (fields.lastDate ?? '').trim();
    if (!DATE.test(lastDate) || lastDate < addDays(read.localToday, -1)) throw new SeriesError('INVALID');
    return { action, seriesId: series.seriesId, input: validateEndClassSeriesInput({ expectedVersion, lastDate, reason: (fields.reason ?? '').trim() }) };
  }
  // The switch flips what the last verified read showed; the server refuses it if the series changed since.
  if (action === 'ongoing') return { action, seriesId: series.seriesId, input: validateSetClassSeriesOngoingInput({ expectedVersion, ongoing: !series.ongoing }) };
  const throughDate = (fields.throughDate ?? '').trim();
  if (!DATE.test(throughDate) || throughDate < read.localToday || throughDate > read.fillLimit) throw new SeriesError('TOO_FAR');
  return { action, seriesId: series.seriesId, input: validateFillClassSeriesInput({ expectedVersion, throughDate }) };
}

/**
 * Weekly timetable and recurring class series (B-SCH-1, 0239). Readers see one school week; managers also see the school's
 * series and can create, change, end, fill or switch one to ongoing. When the series read says a top-up is due, the page sends
 * one top-up of the school's ongoing series (0251) once per school while it is open, then reads again. Blur, a hidden tab, page hide, a school change or a session end hide the page
 * at once, retire every read and drop any kept command. Every command answer is followed by fresh reads: the server, not this
 * tab, says what changed. Nothing here contacts anyone or charges.
 */
export function ClassSeriesPage({ api = classSeriesApi }: { api?: ClassSeriesApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [week, setWeek] = useState<ReadState<WeeklyTimetable>>({ state: 'LOADING' });
  const [series, setSeries] = useState<ReadState<SchoolClassSeries>>({ state: 'LOADING' });
  const [weekOf, setWeekOf] = useState<string | null>(null);
  const [form, setForm] = useState<SeriesForm>(null);
  const [outcome, setOutcome] = useState<SeriesOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef({ week: 0, series: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  const [topUp, setTopUp] = useState<TopUpState>({ state: 'IDLE' });
  const toppedUp = useRef<string | null>(null);
  const retire = () => { gen.current.week++; gen.current.series++; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null; toppedUp.current = null; setTopUp({ state: 'IDLE' });
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null);
    setWeek({ state: 'LOADING' }); setSeries({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing chosen at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setWeekOf(null); setForm(null); setOutcome(null); setTopUp({ state: 'IDLE' }); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++gen.current.week, shown = privacy.current;
    setWeek({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.week && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.timetable({ organizationId: orgId, schoolId }, weekOf, signal, owned).then(
      (read) => { if (owned()) setWeek({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setWeek(readState(error)); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, weekOf, refresh]);

  useEffect(() => {
    const current = ++gen.current.series, shown = privacy.current;
    setSeries({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.series && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setSeries({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setSeries(readState(error)); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  // At most one top-up per school while the page is open: a failure is shown and left for the next visit, never looped.
  useEffect(() => {
    if (series.state !== 'READY' || !series.read.topUpDue || !orgId || !schoolId || lock !== 'NONE' || sending.current) return;
    const at = schoolId.toLowerCase();
    if (toppedUp.current === at) return;
    toppedUp.current = at;
    const shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    setTopUp({ state: 'SENDING' });
    api.topUp({ organizationId: orgId, schoolId }, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000), owned).then(
      (receipt) => { if (owned()) { setTopUp({ state: 'DONE', created: receipt.created }); setRefresh((n) => n + 1); } },
      () => { if (owned()) setTopUp({ state: 'FAILED' }); });
  }, [api, orgId, schoolId, series, lock]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current, action = request.body.action;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action });
    let next: SeriesOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await api.send(request.scope, request.body, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', action, sessions: receipt.sessions };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof SeriesError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as SeriesErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const onSubmit = useCallback((action: SeriesAction, fields: SeriesFields) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || series.state !== 'READY' || !form || form.kind !== action) return;
    let body: SeriesBody;
    try { body = seriesBody(action, fields, series.read, form.kind === 'create' ? null : form.seriesId); }
    catch (error) { setOutcome({ kind: readKind(error) === 'TOO_FAR' ? 'TOO_FAR' : 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, body };
    void send();
  }, [lock, orgId, schoolId, series, form, send]);

  const onWeek = useCallback((next: string | null) => { if (lock === 'NONE') setWeekOf(next); }, [lock]);
  const onOpen = useCallback((next: SeriesForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <ClassSeriesView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} week={week} series={series} form={form} outcome={outcome} locked={lock !== 'NONE' || topUp.state === 'SENDING'} canRetry={lock === 'KEPT'}
      topUp={topUp}
      onWeek={onWeek} onRefresh={onRefresh} onOpen={onOpen} onClose={onClose} onSubmit={onSubmit} onTryAgain={onTryAgain}/>
  </div>;
}
