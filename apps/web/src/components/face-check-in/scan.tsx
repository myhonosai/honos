'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PERSON_PHOTO_MAX_BYTES, PERSON_PHOTO_MEDIA_TYPES, type FaceCheckInMatchResult, type PersonPhotoMediaType } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from '../class-sessions-read-http';
import { shrinkPhoto } from '../people/photo-http';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { todaysSessions, type SessionsState } from '../attendance-cards/scan';
import { useClassByTime } from '../attendance-check-in/class-by-time';
import { faceText, type FaceKey } from './copy';
import { OutcomeLine } from './settings';
import { useFaceCommands, type FaceOutcome } from './commands';
import { faceApi, type FaceApi } from './http';
import base from '../attendance-cards/cards.module.css';
import styles from './face.module.css';

export type Picture = Readonly<{ mediaType: PersonPhotoMediaType; data: string }>;
export type Proposal = Readonly<{ match: FaceCheckInMatchResult; preview: string }>;
type Status = 'PRESENT' | 'LATE';

/**
 * When the front desk stops looking at this screen (the tab is hidden, the page is left, the session ends or the school
 * changes), the camera is stopped and the suggested student (their picture and name) is cleared. Returns the unsubscribe.
 */
export function onFaceScanPrivacy(drop: () => void, doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document): () => void {
  const hidden = () => { if (doc.hidden) drop(); };
  const off = onShellPrivacyEvent(drop, ['pagehide']);
  doc.addEventListener('visibilitychange', hidden);
  return () => { off(); doc.removeEventListener('visibilitychange', hidden); };
}
/** A picked file sent as it is (test mode: the synthetic matcher only knows an exact copy of the profile photo). */
export async function fileToPicture(file: Blob): Promise<Picture | null> {
  if (!(PERSON_PHOTO_MEDIA_TYPES as readonly string[]).includes(file.type) || file.size < 4 || file.size > PERSON_PHOTO_MAX_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: file.type as PersonPhotoMediaType, data: btoa(text) };
}
/** The words for a decided match. */
export function decisionText(language: string, out: { outcome: string; checkIn: { outcome: string; attendance: { status: string } } | null }, name: string): Readonly<{ tone: 'ok' | 'blocked'; text: string }> {
  if (out.outcome === 'CONFIRMED' && out.checkIn) {
    const status = faceText(language, out.checkIn.attendance.status === 'LATE' ? 'LATE' : 'PRESENT');
    return { tone: 'ok', text: faceText(language, out.checkIn.outcome === 'ALREADY_RECORDED' ? 'ALREADY_RECORDED' : 'RECORDED', { name, status }) };
  }
  return { tone: 'blocked', text: faceText(language, out.outcome === 'EXPIRED' ? 'EXPIRED' : 'REJECTED') };
}

export type FaceScanViewProps = Readonly<{
  language: string; sessions: SessionsState; sessionId: string; status: Status; camera: 'OFF' | 'ON' | 'UNSUPPORTED' | 'FAILED';
  proposal: Proposal | null; outcome: FaceOutcome; busy: boolean; videoRef?: React.Ref<HTMLVideoElement> | undefined;
  /** The class follows the school's schedule by the time of day. */ autoClass?: boolean | undefined; onAutoClass?: ((on: boolean) => void) | undefined;
  onSession?: ((id: string) => void) | undefined; onStatus?: ((s: Status) => void) | undefined; onCamera?: (() => void) | undefined; onTake?: (() => void) | undefined;
  onFile?: ((file: File) => void) | undefined; onDecide?: ((accept: boolean) => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

/** Pure view of the front-desk face check-in screen. Only the staff member's Yes records attendance. */
export function FaceScanView(p: FaceScanViewProps): React.ReactElement {
  const t = (key: FaceKey, vars?: Record<string, string>) => faceText(p.language, key, vars);
  const id = useId();
  const sessions = p.sessions.state === 'READY' ? p.sessions.sessions : null;
  const student = p.proposal?.match.student ?? null;
  const loadKey: Record<Exclude<SessionsState['state'], 'READY'>, FaceKey> = { LOADING: 'loading', NO_SCHOOL: 'noSchool', DENIED: 'scanDenied', UNAVAILABLE: 'sessionsUnavailable' };
  return <section className={base.page} aria-labelledby={`${id}-title`} data-testid="face-scan">
    <header><h1 id={`${id}-title`}>{t('scanTitle')}</h1><p className={base.intro}>{t('scanIntro')}</p><p className={base.meta}>{t('staffOnly')}</p></header>
    {p.sessions.state !== 'READY' ? <p className={base.meta} role="status">{t(loadKey[p.sessions.state])}</p> : null}
    {sessions ? <div className={base.panel}>
      <div className={base.form}>
        <div className={base.field}><label htmlFor={`${id}-session`}>{t('sessionLabel')}</label>
          {sessions.length ? <select id={`${id}-session`} value={p.sessionId} disabled={p.busy || p.proposal !== null} onChange={e => p.onSession?.(e.currentTarget.value)} data-testid="face-session">
            <option value="">{t('chooseSession')}</option>
            {sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{`${new Date(s.startsAt).toLocaleTimeString(p.language, { hour: 'numeric', minute: '2-digit' })} ${s.name}`}</option>)}
          </select> : <p className={base.meta}>{t('noSessions')}</p>}
          {sessions.length ? <label className={base.choice}><input type="checkbox" checked={p.autoClass ?? false} onChange={e => p.onAutoClass?.(e.currentTarget.checked)} data-testid="face-auto-class"/>{t('autoClass')}</label> : null}</div>
        <fieldset><legend>{t('markAs')}</legend>
          {(['PRESENT', 'LATE'] as const).map(s => <label key={s} className={base.choice}>
            <input type="radio" name={`${id}-status`} value={s} checked={p.status === s} onChange={() => p.onStatus?.(s)}/>{t(s)}</label>)}
        </fieldset>
        <div className={base.actions}>
          {p.camera !== 'UNSUPPORTED' ? <button type="button" className={base.secondary} disabled={!p.sessionId} onClick={p.onCamera}>{t(p.camera === 'ON' ? 'stopCamera' : 'startCamera')}</button> : null}
          {p.camera === 'ON' ? <button type="button" className={base.primary} disabled={!p.sessionId || p.busy || p.proposal !== null} onClick={p.onTake} data-testid="face-take">{t('takePicture')}</button> : null}
        </div>
        {p.camera === 'UNSUPPORTED' ? <p className={base.meta}>{t('noCamera')}</p> : null}
        {p.camera === 'FAILED' ? <p className={base.meta} role="status">{t('cameraDenied')}</p> : null}
        {p.camera === 'ON' ? <video ref={p.videoRef} className={base.video} muted playsInline aria-hidden="true"/> : null}
        <div className={base.field}><label htmlFor={`${id}-file`}>{t('testPhoto')}</label>
          <input id={`${id}-file`} type="file" accept={PERSON_PHOTO_MEDIA_TYPES.join(',')} disabled={!p.sessionId || p.busy || p.proposal !== null}
            onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) p.onFile?.(f); }} data-testid="face-file"/></div>
        <p className={base.meta}>{t('pictureNote')}</p>
      </div>
      {p.proposal && student ? <div className={base.result} role="status" aria-live="assertive" data-testid="face-proposal" data-tone="waiting">
        <img className={styles.picture} src={p.proposal.preview} alt={t('pictureAlt')}/>
        <div className={base.form}>
          <p>{t('proposed', { name: `${student.givenName} ${student.familyName}` })}</p>
          <div className={base.actions}>
            <button type="button" className={base.primary} disabled={p.busy} onClick={() => p.onDecide?.(true)} data-testid="face-yes">{t('confirmYes')}</button>
            <button type="button" className={base.secondary} disabled={p.busy} onClick={() => p.onDecide?.(false)} data-testid="face-no">{t('confirmNo')}</button>
          </div>
        </div>
      </div> : null}
      <OutcomeLine language={p.language} outcome={p.outcome} onTryAgain={p.onTryAgain} onStop={p.onStop}/>
    </div> : null}
  </section>;
}

/**
 * Front-desk face check-in. A picture is taken (or, in test mode, a photo file picked), sent once to look for a match and
 * dropped. A proposal records nothing: the staff member says Yes (records attendance) or No.
 */
export function FaceCheckInScan({ api = faceApi, loadSessions = loadCurrentSchoolClassSessions }: { api?: FaceApi; loadSessions?: typeof loadCurrentSchoolClassSessions }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [sessions, setSessions] = useState<SessionsState>({ state: 'LOADING' });
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<Status>('PRESENT');
  const [camera, setCamera] = useState<'OFF' | 'ON' | 'UNSUPPORTED' | 'FAILED'>('OFF');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const commands = useFaceCommands(language, () => {});
  const [local, setLocal] = useState<FaceOutcome>(null);
  const [autoClass, setAutoClass] = useClassByTime(sessions.state === 'READY' ? sessions.sessions : null, setSessionId, commands.busy || proposal !== null);
  const videoRef = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  const stopCamera = useCallback(() => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(c => c === 'ON' ? 'OFF' : c); }, []);
  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') setCamera('UNSUPPORTED');
    return () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, []);
  // A kept unknown request names no student, so it stays for Try again; any other line (it may name one) is cleared.
  const commandsRef = useRef(commands); commandsRef.current = commands;
  // Bumped on every drop: a match still in flight when the screen was hidden never shows its student afterwards.
  const privacy = useRef(0);
  useEffect(() => onFaceScanPrivacy(() => { privacy.current++; setProposal(null); setLocal(null); stopCamera(); if (!commandsRef.current.busy) commandsRef.current.clear(); }), [stopCamera]);
  useEffect(() => {
    if (!selection) { setSessions({ state: shell.phase === 'READY' ? 'NO_SCHOOL' : 'LOADING' }); return; }
    let live = true; const abort = new AbortController();
    setSessions({ state: 'LOADING' }); setSessionId(''); setProposal(null);
    loadSessions(selection.organizationId, selection.schoolId, abort.signal).then(list => { if (live) setSessions({ state: 'READY', sessions: todaysSessions(list) }); },
      error => { if (live) setSessions({ state: error instanceof ClassSessionsReadAccessError && error.status === 403 ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, shell.phase, loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (camera !== 'ON') return;
    let live = true;
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        if (!live) { media.getTracks().forEach(t => t.stop()); return; }
        stream.current = media;
        const video = videoRef.current; if (!video) return;
        video.srcObject = media; await video.play();
      } catch { if (live) { setCamera('FAILED'); stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; } }
    })();
    return () => { live = false; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, [camera]);

  const sendPicture = useCallback((picture: Picture | null) => {
    if (!selection || !sessionId || proposal) return;
    if (commands.busy) return;
    if (!picture) { commands.clear(); setLocal({ tone: 'blocked', text: faceText(language, 'badPicture'), canRetry: false }); return; }
    setLocal(null);
    const input = { schoolId: selection.schoolId, sessionId, mediaType: picture.mediaType, data: picture.data };
    const preview = `data:${picture.mediaType};base64,${picture.data}`;
    const shown = privacy.current;
    commands.start(async (key, signal, owned) => {
      const match = await api.match(input, key, signal, owned);
      if (match.outcome === 'PROPOSED' && match.student) {
        if (privacy.current !== shown) return { tone: 'blocked', text: faceText(language, 'EXPIRED') };
        if (owned()) setProposal({ match, preview });
        return { tone: 'ok', text: faceText(language, 'proposed', { name: `${match.student.givenName} ${match.student.familyName}` }) };
      }
      return { tone: 'blocked', text: faceText(language, 'NO_MATCH') };
    });
  }, [api, commands, language, proposal, selection, sessionId]);

  const take = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return sendPicture(null);
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    const data = blob ? await shrinkPhoto(blob) : null;
    sendPicture(data ? { mediaType: 'image/jpeg', data } : null);
  }, [sendPicture]);

  const decide = useCallback((accept: boolean) => {
    if (!selection || !proposal?.match.student) return;
    const { match } = proposal, name = `${match.student!.givenName} ${match.student!.familyName}`;
    const input = { schoolId: selection.schoolId, matchId: match.matchId, accept, status };
    setLocal(null);
    commands.start(async (key, signal, owned) => {
      const out = await api.confirm(input, key, signal, owned);
      if (owned()) setProposal(null);
      return decisionText(language, out, name);
    });
  }, [api, commands, language, proposal, selection, status]);

  return <FaceScanView language={language} sessions={sessions} sessionId={sessionId} status={status} camera={camera} proposal={proposal}
    outcome={local ?? commands.outcome}
    busy={commands.busy} videoRef={videoRef}
    autoClass={autoClass} onAutoClass={setAutoClass}
    onSession={v => { setAutoClass(false); setSessionId(v); setProposal(null); setLocal(null); commands.clear(); }} onStatus={setStatus}
    onCamera={() => { if (camera === 'ON') stopCamera(); else setCamera('ON'); }} onTake={() => { void take(); }}
    onFile={f => { void fileToPicture(f).then(sendPicture); }} onDecide={decide}
    onTryAgain={commands.tryAgain} onStop={() => { commands.stop(); }}/>;
}
