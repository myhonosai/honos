'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SignupProgramsInput, SignupProgramsStatus, SignupProgramsVersion } from '@hon/contracts';
import styles from '../hq-trials/hq-trials.module.css';
import { admissionCopy } from './copy';
import { AdmissionError, keepForRetry, programsApi, type AdmissionErrorKind, type ProgramsApi } from './http';

/**
 * 0710 HQ switch for self-serve sign-up and the public free trial. One tap opens both or closes both, always after a
 * confirmation. The database decides again that the caller is the HQ owner, and it never accepts TEST_MODE.
 */
export type ProgramsRead = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: SignupProgramsStatus };
export type SwitchTarget = 'OPEN' | 'CLOSED';
export type SwitchOutcome = null | { kind: 'SENDING' } | { kind: 'DONE'; version: number; replayed: boolean; signup: string; trial: string } | { kind: AdmissionErrorKind };

/** The fixed reason recorded with each change, so the history says where it came from. */
export const SWITCH_REASON: Readonly<Record<SwitchTarget, string>> = Object.freeze({
  OPEN: 'Opened sign-up and trials from HQ Sign-up Limits', CLOSED: 'Closed sign-up and trials from HQ Sign-up Limits',
});
export function switchRequest(target: SwitchTarget, view: SignupProgramsStatus): SignupProgramsInput {
  return Object.freeze({ expectedVersion: view.programs.version, signup: target, trial: target, reason: SWITCH_REASON[target] });
}
/** Both open means the next tap closes; anything else (closed, test mode, or mixed) offers to open both. */
export const nextTarget = (view: SignupProgramsStatus): SwitchTarget => view.current.signup === 'OPEN' && view.current.trial === 'OPEN' ? 'CLOSED' : 'OPEN';

const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

export type ProgramsViewProps = {
  language: string; read: ProgramsRead; confirming: SwitchTarget | null; outcome: SwitchOutcome; locked: boolean; canRetry: boolean;
  onAsk: (target: SwitchTarget) => void; onConfirm: () => void; onCancel: () => void; onTryAgain: () => void; onStop: () => void;
};

export function ProgramsView(p: ProgramsViewProps): React.ReactElement | null {
  const t = admissionCopy(p.language);
  if (p.read.state === 'LOADING') return <section className={styles.card} data-programs-switch="LOADING"><p role="status">{t('loading')}</p></section>;
  if (p.read.state !== 'READY') return <section className={styles.card} data-programs-switch={p.read.state}><p role="status">{p.read.state === 'DENIED' ? t('sw_DENIED') : t('unavailable')}</p></section>;
  const v = p.read.view, target = nextTarget(v), o = p.outcome;
  const state = (s: string) => t(`p_${s}` as 'p_OPEN');
  const row = (h: SignupProgramsVersion) => <li key={h.versionId} data-programs-version={h.version}>
    <strong>{t('version', { version: String(h.version) })}</strong> <span>{t('progRow', { signup: state(h.signup), trial: state(h.trial) })}</span>
    <span className={styles.meta}>{h.recordedBy === 'HQ_OWNER' ? t('byOwner', { time: moment(p.language, h.recordedAt) }) : t('byMigration', { time: moment(p.language, h.recordedAt) })}</span>
  </li>;
  return <section className={styles.card} data-programs-switch="READY" data-programs-current={`${v.current.signup}/${v.current.trial}`}>
    <h2>{t('switchTitle')}</h2>
    <dl className={styles.grid}>
      <div><dt>{t('signupProgram')}</dt><dd data-programs-now="signup">{state(v.current.signup)}</dd></div>
      <div><dt>{t('trialProgram')}</dt><dd data-programs-now="trial">{state(v.current.trial)}</dd></div>
    </dl>
    <p className={styles.meta} data-programs-terms={v.terms?.status ?? 'NONE'}>{v.terms
      ? t('termsLine', { title: v.terms.title, version: String(v.terms.version), state: t(v.terms.status === 'FINAL' ? 't_FINAL' : 't_TEST_ONLY_DRAFT') }) : t('noTerms')}</p>
    <p className={styles.meta}>{t('switchNote')}</p>
    {p.confirming ? <div className={`${styles.notice} ${styles.warn}`} role="alertdialog" data-programs-confirm={p.confirming}>
      <p>{t(p.confirming === 'OPEN' ? 'confirmOpen' : 'confirmClose')}</p>
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={p.onConfirm} disabled={p.locked}>{t('confirmYes')}</button>
        <button type="button" className={styles.secondary} onClick={p.onCancel} disabled={p.locked}>{t('cancel')}</button>
      </div>
    </div> : <button type="button" className={target === 'OPEN' ? styles.primary : styles.secondary} data-programs-ask={target}
      onClick={() => p.onAsk(target)} disabled={p.locked}>{t(target === 'OPEN' ? 'openBoth' : 'closeBoth')}</button>}
    {o && o.kind !== 'SENDING' ? <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role="status" data-programs-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? (o.replayed ? t('switchedAgain', { version: String(o.version) }) : t('switched', { signup: state(o.signup), trial: state(o.trial), version: String(o.version) }))
        : o.kind === 'DENIED' ? t('sw_DENIED') : o.kind === 'CHANGED' ? t('sw_CHANGED') : t(`o_${o.kind}`)}</p>
      {p.canRetry ? <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>
        <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button>
      </div> : null}
    </div> : null}
    <h3>{t('switchHistory')}</h3>
    <ul className={styles.list}>{v.history.map(row)}</ul>
  </section>;
}

type Pending = Readonly<{ key: string; body: SignupProgramsInput }>;

/** Reads on mount and whenever `refresh` changes; after any answer it reads again and tells the page to read again. */
export function ProgramsSwitch({ language, refresh, onChanged, api = programsApi }: { language: string; refresh: number; onChanged: () => void; api?: ProgramsApi }): React.ReactElement | null {
  const [read, setRead] = useState<ProgramsRead>({ state: 'LOADING' });
  const [confirming, setConfirming] = useState<SwitchTarget | null>(null);
  const [outcome, setOutcome] = useState<SwitchOutcome>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const [reads, setReads] = useState(0);
  const mounted = useRef(false), generation = useRef(0), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);
  useEffect(() => {
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead({ state: 'LOADING' });
    api.status(signal, owned).then((view) => { if (owned()) setRead({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof AdmissionError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, refresh, reads]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: NonNullable<SwitchOutcome>, keep = false;
    try {
      const receipt = await api.set(request.body, request.key, AbortSignal.timeout(30000), () => mounted.current && pending.current?.key === request.key);
      next = { kind: 'DONE', version: receipt.programs.version, replayed: receipt.replayed, signup: receipt.programs.signup, trial: receipt.programs.trial };
    } catch (error) {
      keep = keepForRetry(error); next = { kind: error instanceof AdmissionError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    if (!mounted.current) return;
    setLock(pending.current ? 'KEPT' : 'NONE'); setOutcome(next); setConfirming(null);
    setReads(n => n + 1); onChanged();
  }, [api, onChanged]);

  const onConfirm = useCallback(() => {
    if (!confirming || lock !== 'NONE' || pending.current || read.state !== 'READY') return;
    pending.current = { key: globalThis.crypto.randomUUID(), body: switchRequest(confirming, read.view) };
    void send();
  }, [confirming, lock, read, send]);

  return <ProgramsView language={language} read={read} confirming={confirming} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
    onAsk={(target) => { if (lock === 'NONE') { setOutcome(null); setConfirming(target); } }} onCancel={() => setConfirming(null)}
    onConfirm={onConfirm} onTryAgain={() => { void send(); }}
    onStop={() => { if (lock === 'KEPT' && !sending.current) { pending.current = null; setLock('NONE'); setOutcome(null); setReads(n => n + 1); } }}/>;
}
