'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ATTENDANCE_STATUSES, ATTENDANCE_CATEGORIES, type AttendanceStatus, type AttendanceCategory, type AttendanceRecordSummary, type CurrentSchoolClassSession, type GenericClassBookingKind } from '@hon/contracts';
import { useLocale } from './localization/provider';
import { activationText } from './membership-activation-catalog';
import { verifyEnrollmentSession } from './crm-enrollment-privacy';
import { PlanAccessError } from './membership-plans/http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import { loadCurrentSchoolClassSessions } from './class-sessions-read-http';
import { MANUAL_CLASS_BOOKING_KINDS, prepareClassBooking, submitClassBooking, ClassBookingUncertainError, ClassBookingAccessError, type PreparedClassBooking, type ClassBookingWorkbenchResult } from './class-booking-workbench-http';
import { attendanceSelection, readStudentAttendance, prepareStudentAttendance, sendStudentAttendance, StudentOperationsError, type StudentOperationsScope, type AttendanceCommand } from './connected-student-operations-http';
import { operationsText, type OperationsText } from './connected-student-operations-copy';
import styles from './connected-student-operations.module.css';

type BookingCommand = Readonly<{ operation: 'booking'; request: PreparedClassBooking }>;
type Command = BookingCommand | AttendanceCommand;
type Props = { selection: StudentOperationsScope; sessionSubject: string; verifyStudent(signal: AbortSignal): Promise<void>; onReturn(): void; initialPresentation?: 'modern' | 'classic' | 'big' };
/** Caller supplies a fresh protected student reference; it is never authority for the canonical commands. */
export function ConnectedStudentOperations(props: Props): React.ReactElement {
  return <StudentOperations key={JSON.stringify([props.sessionSubject, props.selection])} {...props} />;
}
function StudentOperations({ selection, sessionSubject, verifyStudent, onReturn, initialPresentation = 'modern' }: Props): React.ReactElement {
  const { preferences, date, number } = useLocale(), language = preferences.language;
  const t = (key: OperationsText) => operationsText(language, key);
  const [mode, setMode] = useState(initialPresentation), [sessions, setSessions] = useState<CurrentSchoolClassSession[] | null>(null);
  const [selected, setSelected] = useState<CurrentSchoolClassSession | null>(null), [kind, setKind] = useState<GenericClassBookingKind | ''>('');
  const [record, setRecord] = useState<AttendanceRecordSummary | null | undefined>(undefined), [mustRead, setMustRead] = useState(true);
  const [status, setStatus] = useState<AttendanceStatus>('PRESENT'), [category, setCategory] = useState<AttendanceCategory>('REGULAR_PARTICIPANT'), [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false), [attendanceConfirmed, setAttendanceConfirmed] = useState(false), [abandon, setAbandon] = useState(false);
  const [hidden, setHidden] = useState(false), [reading, setReading] = useState(false), [busy, setBusy] = useState(false), [pending, setPending] = useState<Command | null>(null);
  const [booking, setBooking] = useState<ClassBookingWorkbenchResult | null>(null), [message, setMessage] = useState<OperationsText | ''>(''), [failure, setFailure] = useState<OperationsText | ''>('');
  const mounted = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null), concealed = useRef(false), schoolChanged = useRef(false);
  const command = useRef<Command | null>(null), retained = useRef<Command | null>(null), readingNow = useRef(false), used = useRef(new Set<string>());
  const area = useRef<HTMLDivElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null), shield = useRef<HTMLHeadingElement | null>(null);
  const selectedHeading = useRef<HTMLHeadingElement | null>(null);
  const selectedRef = useRef<CurrentSchoolClassSession | null>(null), receiptRef = useRef<ClassBookingWorkbenchResult | null>(null);
  const owner = useRef(sessionSubject), lifetime = useRef(0);
  const revision = useRef(0), renderedRevision = revision.current;
  function conceal(reason: OperationsText | '' = ''): void {
    if (area.current) { area.current.hidden = true; area.current.inert = true; }
    concealed.current = true; epoch.current++; revision.current++; abort.current?.abort(); readingNow.current = false;
    setHidden(true); setReading(false); setSessions(null); setSelected(null); setRecord(undefined); setMustRead(true);
    setBooking(null); setConfirmed(false); setAttendanceConfirmed(false); setNote(''); setMessage(''); setFailure(reason); setAbandon(false);
  }
  useEffect(() => {
    mounted.current = true;
    const hide = (e: Event) => { if (e.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) schoolChanged.current = true; conceal(e.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : e.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT ? 'schoolChanged' : ''); };
    const visibility = () => { if (document.visibilityState !== 'visible') conceal(); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    events.forEach(e => window.addEventListener(e, hide)); document.addEventListener('visibilitychange', visibility);
    const leave = (e: BeforeUnloadEvent) => { if (command.current || retained.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', leave); heading.current?.focus();
    return () => { mounted.current = false; lifetime.current++; epoch.current++; abort.current?.abort(); command.current = null; retained.current = null; events.forEach(e => window.removeEventListener(e, hide)); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', leave); };
  }, []);
  useEffect(() => { if (hidden && document.visibilityState === 'visible') shield.current?.focus(); }, [hidden]);
  useEffect(() => { if (!hidden) { if (selected) selectedHeading.current?.focus(); else heading.current?.focus(); } }, [selected?.sessionId]);
  async function authorize(signal: AbortSignal): Promise<void> {
    if (schoolChanged.current) throw new StudentOperationsError(403);
    await verifyEnrollmentSession(owner.current, signal);
    await verifyStudent(signal);
    await verifyEnrollmentSession(owner.current, signal);
  }
  function errorKey(e: unknown): OperationsText {
    if (e instanceof PlanAccessError) return 'SESSION';
    const status = (e as { status?: number })?.status;
    return status === 401 ? 'SESSION' : status === 403 ? 'DENIED' : status === 404 ? 'MISSING' : status === 409 ? 'CONFLICT' : status && status < 500 ? 'REJECTED' : 'UNAVAILABLE';
  }
  async function load(attendanceOnly = false): Promise<void> {
    if (!mounted.current || command.current || readingNow.current || schoolChanged.current || (attendanceOnly && (!selectedRef.current || concealed.current))) return;
    const run = ++epoch.current, ctrl = new AbortController(); revision.current++; abort.current?.abort(); abort.current = ctrl;
    readingNow.current = true; setReading(true); setFailure('');
    try {
      await authorize(ctrl.signal);
      const list = attendanceOnly ? null : await loadCurrentSchoolClassSessions(selection.organizationId, selection.schoolId, ctrl.signal);
      const current = selectedRef.current;
      const fresh = attendanceOnly && current ? await readStudentAttendance(attendanceSelection(selection, current.sessionId), ctrl.signal) : undefined;
      await verifyEnrollmentSession(owner.current, ctrl.signal);
      if (!mounted.current || run !== epoch.current || ctrl.signal.aborted || document.visibilityState !== 'visible') return;
      if (attendanceOnly) { setRecord(fresh); setMustRead(false); setAttendanceConfirmed(false); if (fresh) { setStatus(fresh.status); setCategory(fresh.category); setNote(fresh.note ?? ''); } }
      else {
        setSessions(list); const restored = list?.find(s => s.sessionId === current?.sessionId) ?? null;
        selectedRef.current = restored; setSelected(restored); setRecord(undefined); setMustRead(true); setBooking(receiptRef.current);
      }
      concealed.current = false; setHidden(false);
    } catch (e) {
      if (mounted.current && run === epoch.current) {
        const key = errorKey(e); if (key === 'SESSION' || key === 'DENIED') conceal(key);
        else { if (attendanceOnly) { setRecord(undefined); setMustRead(true); } else { setSessions(null); setSelected(null); } setFailure(key); }
      }
    } finally { if (run === epoch.current && mounted.current) { readingNow.current = false; setReading(false); } }
  }
  async function send(request: Command, retry = false): Promise<void> {
    if (!mounted.current || command.current || readingNow.current || concealed.current || schoolChanged.current || (retry && retained.current !== request)) return;
    const life = lifetime.current, run = epoch.current, ctrl = new AbortController(); let sent = false;
    command.current = request; retained.current = request; setPending(request); setBusy(true); setFailure(''); setMessage('');
    try {
      await authorize(ctrl.signal);
      if (!mounted.current || life !== lifetime.current || run !== epoch.current || concealed.current) return;
      sent = true;
      if (request.operation === 'booking') {
        used.current.add(request.request.sessionId);
        const receipt = await submitClassBooking(request.request);
        receiptRef.current = receipt;
        if (!concealed.current && run === epoch.current) setBooking(receipt);
      } else {
        const receipt = await sendStudentAttendance(request);
        if (!concealed.current && run === epoch.current) { setRecord(receipt.attendance); setMustRead(true); setMessage('saved'); }
      }
      retained.current = null; if (mounted.current && life === lifetime.current) { setPending(null); setConfirmed(false); setAttendanceConfirmed(false); }
    } catch (e) {
      if (!mounted.current || life !== lifetime.current) return;
      const access = e instanceof ClassBookingAccessError || e instanceof PlanAccessError || [401,403].includes((e as { status?: number })?.status ?? 0);
      const uncertain = e instanceof ClassBookingUncertainError || e instanceof StudentOperationsError && e.uncertain;
      if (!access && !uncertain && sent) { retained.current = null; setPending(null); if (request.operation === 'attendance') setMustRead(true); }
      if (access) conceal(errorKey(e));
      else if (!concealed.current && run === epoch.current) setFailure(uncertain ? 'unknown' : errorKey(e));
    } finally {
      // Command settlement belongs to the instance/request, not the read epoch invalidated by blur.
      if (mounted.current && lifetime.current === life && command.current === request) {
        if (!sent && !retry) { retained.current = null; setPending(null); }
        command.current = null; setBusy(false);
      }
    }
  }
  function choose(item: CurrentSchoolClassSession): void {
    if (!mounted.current || command.current || retained.current || readingNow.current || concealed.current || !sessions?.includes(item)) return;
    revision.current++; selectedRef.current = item; setSelected(item); setKind(''); setConfirmed(false); setRecord(undefined); setMustRead(true); setBooking(null); receiptRef.current = null; setNote(''); setMessage(''); setFailure('');
  }
  function book(): void {
    if (!mounted.current || renderedRevision !== revision.current || selectedRef.current !== selected || !selected || !kind || !confirmed || command.current || retained.current || concealed.current || used.current.has(selected.sessionId) || selected.status === 'CANCELLED') return;
    void send(Object.freeze({ operation: 'booking', request: prepareClassBooking({ ...selection, sessionId: selected.sessionId }, kind, crypto.randomUUID()) }));
  }
  function attendance(): void {
    if (!mounted.current || renderedRevision !== revision.current || selectedRef.current !== selected || !selected || mustRead || record === undefined || !attendanceConfirmed || command.current || retained.current || concealed.current) return;
    void send(prepareStudentAttendance(attendanceSelection(selection, selected.sessionId), { studentProfileId: selection.studentProfileId, status, category, note, ...(record ? { expectedVersion: record.version } : {}) }, crypto.randomUUID()));
  }
  const locked = busy || pending !== null, selectedUsed = !!selected && used.current.has(selected.sessionId);
  function edit(action: () => void): void { if (!mounted.current || command.current || retained.current || readingNow.current || concealed.current) return; revision.current++; action(); }
  return <main data-student-operations className={`${styles.page} ${styles[`mode_${mode}`]}`}>
    <header><p>HON OS</p><h1 ref={heading} tabIndex={-1}>{t('title')}</h1><p>{t('intro')}</p></header>
    <label>{activationText(language, 'Presentation')}<select aria-label={activationText(language, 'Presentation')} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="modern">{activationText(language,'Modern')}</option><option value="classic">{activationText(language,'Classic')}</option><option value="big">{activationText(language,'Big Button')}</option></select></label>
    <div role="status" aria-live="polite" aria-atomic="true" className={styles.status}>{busy ? t('pending') : reading ? t('loading') : hidden ? t('hidden') : message ? t(message) : ''}</div>
    <button type="button" disabled={locked || reading} onClick={() => { if (!command.current && !retained.current && !readingNow.current) onReturn(); }}>{t('back')}</button>
    <aside>{t('limits')}</aside>
    {hidden && <section><h2 tabIndex={-1} ref={shield}>{t('hidden')}</h2><p>{t('privacy')}</p><button type="button" disabled={busy || reading || schoolChanged.current} onClick={() => void load()}>{t('verify')}</button></section>}
    <div ref={area} hidden={hidden} inert={hidden}>{!hidden && <>
      <section><h2>{t('student')}</h2><code>{selection.studentProfileId}</code><p>{t('bounded')}</p><button type="button" disabled={locked || reading} onClick={() => void load()}>{t('load')}</button></section>
      {sessions === null && !reading && <p>{t('idle')}</p>}{sessions?.length === 0 && <p>{t('empty')}</p>}
      {!selected && sessions && <ol className={styles.records}>{sessions.map(s => <li className={styles.record} key={s.sessionId}><h2>{s.name}</h2><p>{date(s.startsAt)} – {date(s.endsAt)}</p><dl><dt>{t('room')}</dt><dd>{s.roomName ?? t('noRoom')}</dd><dt>{t('capacity')}</dt><dd>{number(s.capacity)}</dd><dt>{t('policy')}</dt><dd>{t(s.bookingPolicy)}</dd></dl><p>{t(s.status)}</p><button type="button" disabled={locked || reading} onClick={() => choose(s)}>{t('choose')} · {s.name}</button></li>)}</ol>}
      {selected && <><section><h2 ref={selectedHeading} tabIndex={-1}>{t('selected')} · {selected.name}</h2><p>{date(selected.startsAt)} – {date(selected.endsAt)} · {selected.roomName ?? t('noRoom')}</p><p>{t(selected.status)} · {t(selected.bookingPolicy)} · {t('capacity')}: {number(selected.capacity)}</p><button type="button" disabled={locked || reading} onClick={() => { if (!command.current && !retained.current) { setSelected(null); selectedRef.current = null; } }}>{t('classes')}</button>
        <fieldset disabled={locked || reading || selected.status === 'CANCELLED' || selectedUsed}><label>{t('kind')}<select aria-label={t('kind')} value={kind} onChange={e => edit(() => { setKind(e.target.value as GenericClassBookingKind); setConfirmed(false); })}><option value="">{t('chooseKind')}</option>{MANUAL_CLASS_BOOKING_KINDS.map(k => <option key={k} value={k}>{t(k)}</option>)}</select></label><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={e => edit(() => setConfirmed(e.target.checked))} />{t('bookingConfirm')}</label><button type="button" disabled={!kind || !confirmed} onClick={book}>{t('book')}</button></fieldset>
        {selectedUsed && <p>{t('bookedOnce')}</p>}{booking && booking.booking.classSessionId === selected.sessionId && <section><h3>{t('bookingReceipt')}</h3><p>{t(booking.booking.status)} · {date(booking.booking.bookedAt)}</p><code>{booking.booking.id}</code><p>{t('historical')}</p></section>}
      </section><section><h2>{t('attendance')}</h2><button type="button" disabled={locked || reading} onClick={() => void load(true)}>{t('readAttendance')}</button>
        {record === undefined ? <p>{t('notRead')}</p> : record === null ? <p>{t('noRecord')}</p> : <p>{t(record.status)} · {t(record.category)} · {date(record.recordedAt)} · v{number(record.version)}</p>}
        <fieldset disabled={locked || reading || mustRead || record === undefined}><label>{t('status')}<select aria-label={t('status')} value={status} onChange={e => edit(() => { setStatus(e.target.value as AttendanceStatus); setAttendanceConfirmed(false); })}>{ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{t(s)}</option>)}</select></label><label>{t('category')}<select aria-label={t('category')} value={category} onChange={e => edit(() => { setCategory(e.target.value as AttendanceCategory); setAttendanceConfirmed(false); })}>{ATTENDANCE_CATEGORIES.map(c => <option key={c} value={c}>{t(c)}</option>)}</select></label><label>{t('note')}<textarea maxLength={2000} autoComplete="off" value={note} onChange={e => edit(() => { setNote(e.target.value); setAttendanceConfirmed(false); })} /></label><label className={styles.check}><input type="checkbox" checked={attendanceConfirmed} onChange={e => edit(() => setAttendanceConfirmed(e.target.checked))} />{t('attendanceConfirm')}</label><button type="button" disabled={!attendanceConfirmed} onClick={attendance}>{t('save')}</button></fieldset>
      </section></>}
    </>}</div>
    {failure && <p role="alert" className={styles.error}>{t(failure)}</p>}
    {pending && <section><p>{t(busy ? 'pending' : 'unknown')}</p><button type="button" disabled={busy || hidden || reading} onClick={() => { if (retained.current) void send(retained.current, true); }}>{t('retry')}</button><p>{t('abandonWarning')}</p><label className={styles.check}><input type="checkbox" disabled={busy} checked={abandon} onChange={e => setAbandon(e.target.checked)} />{t('abandonConfirm')}</label><button type="button" disabled={busy || !abandon} onClick={() => { if (command.current || !abandon || retained.current !== pending) return; retained.current = null; setPending(null); setAbandon(false); setMustRead(true); setFailure(''); }}>{t('abandon')}</button></section>}
  </main>;
}
