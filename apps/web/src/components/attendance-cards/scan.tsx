'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { normalizeAttendanceCardCode, type AttendanceCheckInResult, type AttendanceCheckInStatus, type CurrentSchoolClassSession } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from '../class-sessions-read-http';
import { useClassByTime } from '../attendance-check-in/class-by-time';
import { initialsOf } from '../people/photo';
import { photoApi, type PhotoApi } from '../people/photo-http';
import { openFallbackDetector, type FrameDetector } from './camera-decoder';
import { cardsText, type CardsKey } from './copy';
import { CardsError, cardsApi, keepForRetry, type CardsApi, type CardsErrorKind } from './http';
import styles from './cards.module.css';

export type SessionsState = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'NO_SCHOOL' }> | Readonly<{ state: 'READY'; sessions: readonly CurrentSchoolClassSession[] }>;
export type ScanResult = null | Readonly<{ kind: 'SENDING' | 'NOT_A_CODE' | Exclude<CardsErrorKind, 'SESSION'> }>
  | Readonly<{ kind: 'ANSWER'; answer: AttendanceCheckInResult; photo: string | null }>;
const ERROR_KEY: Record<Exclude<CardsErrorKind, 'SESSION'>, CardsKey> = { DENIED: 'scanDenied', MISSING: 'scanMissing', CONFLICT: 'outConflict', INVALID: 'notACode', BUSY: 'outBusy', UNKNOWN: 'outUnknown' };

/** Classes of today (in this device's time zone) that are not cancelled, earliest first. */
export function todaysSessions(sessions: readonly CurrentSchoolClassSession[], now = new Date()): CurrentSchoolClassSession[] {
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  return sessions.filter(s => s.status !== 'CANCELLED' && day(new Date(s.startsAt)) === day(now)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export type ScanViewProps = Readonly<{
  language: string; sessions: SessionsState; sessionId: string; status: AttendanceCheckInStatus; code: string; result: ScanResult;
  locked: boolean; canRetry: boolean; camera: 'OFF' | 'ON' | 'UNSUPPORTED' | 'FAILED';
  /** The class follows the school's schedule by the time of day. */ autoClass?: boolean | undefined; onAutoClass?: ((on: boolean) => void) | undefined;
  inputRef?: React.Ref<HTMLInputElement> | undefined; videoRef?: React.Ref<HTMLVideoElement> | undefined;
  onSession?: ((id: string) => void) | undefined; onStatus?: ((s: AttendanceCheckInStatus) => void) | undefined; onCode?: ((v: string) => void) | undefined;
  onSubmit?: (() => void) | undefined; onCamera?: (() => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

/** Pure view of the front-desk scan screen. */
export function ScanView(p: ScanViewProps): React.ReactElement {
  const t = (key: CardsKey, vars?: Record<string, string>) => cardsText(p.language, key, vars);
  const base = useId();
  const sessions = p.sessions.state === 'READY' ? p.sessions.sessions : null;
  const r = p.result;
  let line: React.ReactElement | null = null;
  if (r) {
    if (r.kind === 'ANSWER') {
      const a = r.answer, name = a.student ? `${a.student.givenName} ${a.student.familyName}` : '';
      const status = a.attendance ? t(a.attendance.status === 'LATE' ? 'LATE' : 'PRESENT') : '';
      const good = a.outcome === 'RECORDED' || a.outcome === 'ALREADY_RECORDED';
      line = <div className={styles.result} role="status" aria-live="assertive" data-testid="scan-result" data-outcome={a.outcome} data-tone={good ? 'ok' : 'blocked'}>
        {a.student ? <div className={styles.avatar}>{r.photo ? <img src={r.photo} alt={t('photoAlt', { name })}/> : <span aria-hidden="true">{initialsOf(a.student.givenName, a.student.familyName)}</span>}</div> : null}
        <p>{t(a.outcome, { name, status })}</p>
      </div>;
    } else {
      line = <div className={styles.outcome} role="status" aria-live="assertive" data-testid="scan-result" data-outcome={r.kind}
        data-tone={r.kind === 'SENDING' || r.kind === 'UNKNOWN' || r.kind === 'BUSY' ? 'waiting' : 'blocked'}>
        <p>{r.kind === 'SENDING' ? t('sending') : r.kind === 'NOT_A_CODE' ? t('notACode') : t(ERROR_KEY[r.kind])}</p>
        {p.canRetry ? <div className={styles.actions}>
          {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
          {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button> : null}
        </div> : null}
      </div>;
    }
  }
  return <section className={styles.page} aria-labelledby={`${base}-title`} data-testid="attendance-scan">
    <header><h1 id={`${base}-title`}>{t('scanTitle')}</h1><p className={styles.intro}>{t('scanIntro')}</p><p className={styles.meta}>{t('staffOnly')}</p></header>
    {p.sessions.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
    {p.sessions.state === 'NO_SCHOOL' ? <p className={styles.meta} role="status">{t('noSchool')}</p> : null}
    {p.sessions.state === 'DENIED' ? <p className={styles.meta} role="status">{t('scanDenied')}</p> : null}
    {p.sessions.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('sessionsUnavailable')}</p> : null}
    {sessions ? <div className={styles.panel}>
      <div className={styles.form}>
        <div className={styles.field}><label htmlFor={`${base}-session`}>{t('sessionLabel')}</label>
          {sessions.length ? <select id={`${base}-session`} value={p.sessionId} onChange={e => p.onSession?.(e.currentTarget.value)} data-testid="scan-session">
            <option value="">{t('chooseSession')}</option>
            {sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{`${new Date(s.startsAt).toLocaleTimeString(p.language, { hour: 'numeric', minute: '2-digit' })} ${s.name}`}</option>)}
          </select> : <p className={styles.meta}>{t('noSessions')}</p>}
          {sessions.length ? <label className={styles.choice}><input type="checkbox" checked={p.autoClass ?? false} onChange={e => p.onAutoClass?.(e.currentTarget.checked)} data-testid="scan-auto-class"/>{t('autoClass')}</label> : null}</div>
        <fieldset><legend>{t('statusLabel')}</legend>
          {(['PRESENT', 'LATE'] as const).map(s => <label key={s} className={styles.choice}>
            <input type="radio" name={`${base}-status`} value={s} checked={p.status === s} onChange={() => p.onStatus?.(s)}/>{t(s)}</label>)}
        </fieldset>
        <form className={styles.field} onSubmit={e => { e.preventDefault(); p.onSubmit?.(); }}>
          <label htmlFor={`${base}-code`}>{t('codeInput')}</label>
          <input id={`${base}-code`} ref={p.inputRef} className={styles.scanInput} value={p.code} inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
            placeholder={t('codePlaceholder')} disabled={!p.sessionId || p.locked} onChange={e => p.onCode?.(e.currentTarget.value)} data-testid="scan-code"/>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={!p.sessionId || p.locked || !p.code.trim()}>{t('checkIn')}</button>
            {p.camera !== 'UNSUPPORTED' ? <button type="button" className={styles.secondary} disabled={!p.sessionId} onClick={p.onCamera}>{t(p.camera === 'ON' ? 'stopCamera' : 'camera')}</button> : null}
          </div>
        </form>
        {p.camera === 'UNSUPPORTED' ? <p className={styles.meta}>{t('noCamera')}</p> : null}
        {p.camera === 'FAILED' ? <p className={styles.meta} role="status">{t('cameraDenied')}</p> : null}
        {p.camera === 'ON' ? <video ref={p.videoRef} className={styles.video} muted playsInline aria-hidden="true"/> : null}
      </div>
      {line}
    </div> : null}
  </section>;
}

type Pending = Readonly<{ key: string; schoolId: string; sessionId: string; code: string; status: AttendanceCheckInStatus }>;
type DetectorClass = { new(options: { formats: string[] }): FrameDetector; getSupportedFormats?: () => Promise<string[]> };
const detectorClass = (): DetectorClass | null => typeof window !== 'undefined' && 'BarcodeDetector' in window ? (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector : null;
const canUseCamera = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
/** The browser's own reader when it has one for both formats; otherwise the on-device ZXing reader (Safari, iPad). */
async function openDetector(): Promise<FrameDetector | null> {
  const Class = detectorClass();
  if (Class) {
    const formats = await Class.getSupportedFormats?.().catch(() => null) ?? ['qr_code', 'code_128'];
    if (formats.includes('qr_code') && formats.includes('code_128')) return new Class({ formats: ['qr_code', 'code_128'] });
  }
  return openFallbackDetector();
}

/**
 * Front-desk scan check-in. A USB scanner types the code and Enter into the focused field; a camera is used where the
 * browser can read codes. Each scan has its own key; an unknown outcome keeps that exact scan for Try again.
 */
export function AttendanceScan({ api = cardsApi, photos = photoApi, loadSessions = loadCurrentSchoolClassSessions }: {
  api?: CardsApi; photos?: PhotoApi; loadSessions?: typeof loadCurrentSchoolClassSessions;
}): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [sessions, setSessions] = useState<SessionsState>({ state: 'LOADING' });
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<AttendanceCheckInStatus>('PRESENT');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<ScanResult>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const [camera, setCamera] = useState<'OFF' | 'ON' | 'UNSUPPORTED' | 'FAILED'>('OFF');
  const [autoClass, setAutoClass] = useClassByTime(sessions.state === 'READY' ? sessions.sessions : null, setSessionId, lock !== 'NONE');
  const mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null), videoRef = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  useEffect(() => { mounted.current = true; if (!canUseCamera()) setCamera('UNSUPPORTED'); return () => { mounted.current = false; pending.current = null; stream.current?.getTracks().forEach(t => t.stop()); }; }, []);
  const stopCamera = useCallback(() => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(c => c === 'ON' ? 'OFF' : c); }, []);
  const drop = useCallback(() => { pending.current = null; setResult(null); setCode(''); setLock(sending.current ? 'SENDING' : 'NONE'); stopCamera(); }, [stopCamera]);
  useEffect(() => {
    const events = [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT, 'pagehide'];
    for (const e of events) window.addEventListener(e, drop);
    return () => { for (const e of events) window.removeEventListener(e, drop); };
  }, [drop]);

  useEffect(() => {
    if (!selection) { setSessions({ state: shell.phase === 'READY' ? 'NO_SCHOOL' : 'LOADING' }); return; }
    let live = true; const abort = new AbortController();
    setSessions({ state: 'LOADING' }); setSessionId('');
    loadSessions(selection.organizationId, selection.schoolId, abort.signal).then(list => { if (live) setSessions({ state: 'READY', sessions: todaysSessions(list) }); },
      error => { if (live) setSessions({ state: error instanceof ClassSessionsReadAccessError && error.status === 403 ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, shell.phase, loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setLock('SENDING'); setResult({ kind: 'SENDING' });
    const owned = () => mounted.current && pending.current?.key === request.key;
    let next: ScanResult, keep = false;
    try {
      const answer = await api.checkIn(request.schoolId, request.sessionId, request.code, request.status, request.key, AbortSignal.timeout(20000), owned);
      let photo: string | null = null;
      if (answer.student) {
        try { const r = await photos.read({ schoolId: request.schoolId }, answer.student.personId, AbortSignal.timeout(8000), owned); photo = r.photo ? `data:${r.photo.mediaType};base64,${r.photo.data}` : null; } catch { photo = null; }
      }
      next = { kind: 'ANSWER', answer, photo };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof CardsError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE'); setResult(next);
    inputRef.current?.focus();
  }, [api, photos]);

  const submit = useCallback((raw: string) => {
    if (!selection || !sessionId || lock !== 'NONE' || pending.current) return;
    const normalized = normalizeAttendanceCardCode(raw);
    setCode('');
    if (!normalized) { setResult({ kind: 'NOT_A_CODE' }); inputRef.current?.focus(); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), schoolId: selection.schoolId, sessionId, code: normalized, status };
    void send();
  }, [selection, sessionId, lock, status, send]);

  // Camera: read one code at a time; the same code is ignored for a few seconds so one card is not sent twice.
  const submitRef = useRef(submit); submitRef.current = submit;
  useEffect(() => {
    if (camera !== 'ON') return;
    let live = true, last = '', lastAt = 0;
    void (async () => {
      try {
        const detector = await openDetector();
        if (!live) return;
        if (!detector) { setCamera('UNSUPPORTED'); return; }
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!live) { media.getTracks().forEach(t => t.stop()); return; }
        stream.current = media;
        const video = videoRef.current; if (!video) return;
        video.srcObject = media; await video.play();
        while (live) {
          const found = await detector.detect(video).catch(() => []);
          const value = found[0]?.rawValue;
          if (value && (value !== last || Date.now() - lastAt > 4000)) { last = value; lastAt = Date.now(); submitRef.current(value); }
          await new Promise(r => setTimeout(r, 250));
        }
      } catch { if (live) { setCamera('FAILED'); stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; } }
    })();
    return () => { live = false; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, [camera]);
  useEffect(() => { if (sessionId) inputRef.current?.focus(); }, [sessionId]);

  return <ScanView language={preferences.language} sessions={sessions} sessionId={sessionId} status={status} code={code} result={result}
    locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} camera={camera} inputRef={inputRef} videoRef={videoRef}
    autoClass={autoClass} onAutoClass={setAutoClass}
    onSession={id => { setAutoClass(false); setSessionId(id); setResult(null); }} onStatus={setStatus} onCode={setCode} onSubmit={() => submit(code)}
    onCamera={() => { if (camera === 'ON') stopCamera(); else setCamera('ON'); }}
    onTryAgain={() => { void send(); }} onStop={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setResult(null); inputRef.current?.focus(); }}/>;
}
