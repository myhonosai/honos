'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AdmissionLimits, AdmissionLimitsInput, AdmissionStatus, AdmissionUsage } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import styles from '../hq-trials/hq-trials.module.css';
import { admissionCopy } from './copy';
import { AdmissionError, admissionApi, keepForRetry, type AdmissionApi, type AdmissionErrorKind } from './http';

export type ReadState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: AdmissionStatus };
export type Outcome = null | { kind: 'SENDING' } | { kind: 'DONE'; version: number; replayed: boolean } | { kind: AdmissionErrorKind };
export type Fields = Readonly<Record<string, string | undefined>>;

/** The change to send, from the form and the read it was opened on. Throws INVALID when the details are not acceptable. */
export function limitsRequest(fields: Fields, view: AdmissionStatus): AdmissionLimitsInput {
  const whole = (v: string | undefined) => { const s = (v ?? '').trim(); if (!/^\d{1,6}$/.test(s)) throw new AdmissionError('INVALID'); return Number(s); };
  const body = { expectedVersion: view.limits.version, signupsPerHour: whole(fields.signupsPerHour), signupsPerDay: whole(fields.signupsPerDay),
    trialsPerHour: whole(fields.trialsPerHour), trialsPerDay: whole(fields.trialsPerDay), reason: (fields.reason ?? '').trim() };
  if (body.signupsPerHour < 1 || body.trialsPerHour < 1 || body.signupsPerHour > body.signupsPerDay || body.trialsPerHour > body.trialsPerDay
    || body.signupsPerHour > 10_000 || body.trialsPerHour > 10_000 || body.signupsPerDay > 100_000 || body.trialsPerDay > 100_000
    || body.reason.length < 10 || body.reason.length > 500) throw new AdmissionError('INVALID');
  return body;
}

const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
const num = (language: string, n: number) => n.toLocaleString(language);

export type AdmissionViewProps = {
  language: string; concealed: boolean; read: ReadState; formOpen?: boolean; outcome?: Outcome; locked?: boolean; canRetry?: boolean;
  onRefresh: () => void; onReveal?: () => void; onOpen?: () => void; onClose?: () => void; onSubmit?: (fields: Fields) => void; onTryAgain?: () => void; onStop?: () => void;
};

function Usage({ title, usage, language, t }: { title: string; usage: AdmissionUsage; language: string; t: ReturnType<typeof admissionCopy> }) {
  return <section className={styles.card} data-admission-usage={title}>
    <div className={styles.cardHead}><h2>{title}</h2><span className={styles.chip} data-kind={usage.full ? 'open' : undefined}>{usage.full ? t('full') : t('open')}</span></div>
    <dl className={styles.grid}>
      <div><dt>{t('lastHour')}</dt><dd>{t('ofLimit', { used: num(language, usage.lastHour), limit: num(language, usage.perHour) })}</dd></div>
      <div><dt>{t('lastDay')}</dt><dd>{t('ofLimit', { used: num(language, usage.lastDay), limit: num(language, usage.perDay) })}</dd></div>
    </dl>
  </section>;
}
function Version({ v, language, t }: { v: AdmissionLimits; language: string; t: ReturnType<typeof admissionCopy> }) {
  return <li data-admission-version={v.version}>
    <strong>{t('version', { version: String(v.version) })}</strong>
    <span>{t('signups')}: {t('perHour')} {num(language, v.signupsPerHour)}, {t('perDay')} {num(language, v.signupsPerDay)}; {t('trials')}: {t('perHour')} {num(language, v.trialsPerHour)}, {t('perDay')} {num(language, v.trialsPerDay)}</span>
    <span className={styles.meta}>{v.recordedBy === 'HQ_OWNER' ? t('byOwner', { time: moment(language, v.recordedAt) }) : t('byMigration', { time: moment(language, v.recordedAt) })}</span>
    {v.reason ? <span className={styles.meta}>{t('because', { reason: v.reason })}</span> : null}
  </li>;
}

export function AdmissionView(p: AdmissionViewProps): React.ReactElement {
  const t = admissionCopy(p.language);
  const head = <div className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.concealed ? null : <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button>}
  </div>;
  if (p.concealed) return <main className={styles.page} data-hq-admission="concealed">{head}<div className={styles.notice}><p>{t('concealed')}</p>
    <button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></main>;
  if (p.read.state !== 'READY') return <main className={styles.page} data-hq-admission={p.read.state}>{head}
    <p className={styles.notice} role="status">{p.read.state === 'LOADING' ? t('loading') : p.read.state === 'DENIED' ? t('denied') : t('unavailable')}</p></main>;
  const v = p.read.view, l = v.limits, o = p.outcome ?? null;
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget), fields: Record<string, string> = {};
    data.forEach((value, name) => { if (typeof value === 'string') fields[name] = value; });
    p.onSubmit?.(fields);
  };
  return <main className={styles.page} data-hq-admission="READY">
    {head}
    <p className={styles.meta}>{t('scope')}</p>
    <p className={styles.meta}>{t('asOf', { time: moment(p.language, v.asOf) })}</p>
    <section className={styles.card}><h2>{t('programs')}</h2><dl className={styles.grid}>
      <div><dt>{t('signupProgram')}</dt><dd data-admission-program="signup">{t(`p_${v.programs.signup}`)}</dd></div>
      <div><dt>{t('trialProgram')}</dt><dd data-admission-program="trial">{t(`p_${v.programs.trial}`)}</dd></div>
    </dl><p className={styles.meta}>{t('domains', { n: num(p.language, v.blockedEmailDomains) })}</p></section>
    <div className={styles.grid}>
      <Usage title={t('signups')} usage={v.usage.signups} language={p.language} t={t}/>
      <Usage title={t('trials')} usage={v.usage.trials} language={p.language} t={t}/>
    </div>
    <section className={styles.card} data-admission-hits>
      <h2>{t('hitsTitle')}</h2>
      {v.refusals.length === 0 ? <p>{t('noHits')}</p> : <ul className={styles.list}>{v.refusals.map((r) =>
        <li key={r.kind + r.hourStart} data-admission-hit={r.kind}>{t('hitRow', { kind: t(`k_${r.kind}`), count: num(p.language, r.count), hour: moment(p.language, r.hourStart), last: moment(p.language, r.lastAt) })}</li>)}</ul>}
      <p className={styles.meta}>{t('hitsNote')}</p>
    </section>
    <section className={styles.card} data-admission-limits>
      <div className={styles.cardHead}><h2>{t('limitsTitle')}</h2>
        {p.formOpen ? null : <button type="button" className={styles.primary} onClick={p.onOpen} disabled={p.locked}>{t('change')}</button>}</div>
      <ul className={styles.list}><Version v={l} language={p.language} t={t}/></ul>
      {p.formOpen ? <form className={styles.form} onSubmit={submit} data-admission-form>
        <div className={styles.grid}>
          <label className={styles.field}>{t('fSignupsHour')}<input name="signupsPerHour" inputMode="numeric" defaultValue={String(l.signupsPerHour)} required/></label>
          <label className={styles.field}>{t('fSignupsDay')}<input name="signupsPerDay" inputMode="numeric" defaultValue={String(l.signupsPerDay)} required/></label>
          <label className={styles.field}>{t('fTrialsHour')}<input name="trialsPerHour" inputMode="numeric" defaultValue={String(l.trialsPerHour)} required/></label>
          <label className={styles.field}>{t('fTrialsDay')}<input name="trialsPerDay" inputMode="numeric" defaultValue={String(l.trialsPerDay)} required/></label>
        </div>
        <label className={styles.field}>{t('fReason')}<textarea name="reason" rows={2} minLength={10} maxLength={500} required/></label>
        <p className={styles.meta}>{t('formNote')}</p>
        <div className={styles.row}>
          <button type="submit" className={styles.primary} disabled={p.locked}>{o?.kind === 'SENDING' ? t('saving') : t('save')}</button>
          <button type="button" className={styles.secondary} onClick={p.onClose} disabled={p.locked}>{t('cancel')}</button>
        </div>
      </form> : null}
      {o && o.kind !== 'SENDING' ? <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role="status" data-admission-outcome={o.kind}>
        <p>{o.kind === 'DONE' ? t(o.replayed ? 'replayed' : 'done', { version: String(o.version) }) : t(`o_${o.kind}`)}</p>
        {p.canRetry ? <div className={styles.row}>
          <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>
          <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button>
        </div> : null}
      </div> : null}
    </section>
    <section className={styles.card} data-admission-history>
      <h2>{t('historyTitle')}</h2>
      <ul className={styles.list}>{v.history.map((h) => <Version key={h.versionId} v={h} language={p.language} t={t}/>)}</ul>
      {v.historyHasMore ? <p className={styles.meta}>{t('historyMore')}</p> : null}
    </section>
  </main>;
}

type Pending = Readonly<{ key: string; body: AdmissionLimitsInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * HQ Sign-up Limits. Blur, a hidden tab, page hide or a session end hide everything, retire every read and drop a kept
 * change; Show again reads fresh. Every change answer is followed by a fresh read. Nothing here opens sign-up or trials.
 */
export function HqAdmission({ api = admissionApi }: { api?: AdmissionApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [read, setRead] = useState<ReadState>({ state: 'LOADING' });
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false), reads = useRef(0);
  const reread = useCallback(() => { reads.current += 1; setRefresh(reads.current); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);
  useEffect(() => {
    const conceal = () => {
      generation.current++; privacy.current++; pending.current = null;
      setConcealed(true); setRead({ state: 'LOADING' }); setFormOpen(false); setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE');
    };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);
  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead({ state: 'LOADING' });
    api.status(signal, owned).then((view) => { if (owned()) setRead({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof AdmissionError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, refresh, concealed]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: NonNullable<Outcome>, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await api.set(request.body, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', version: receipt.limits.version, replayed: receipt.replayed };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof AdmissionError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    // Any answer closes the form: Try again replays the stored request, never the form as edited since.
    setFormOpen(false);
    reread();
  }, [api, reread]);

  const onSubmit = useCallback((fields: Fields) => {
    if (!formOpen || lock !== 'NONE' || pending.current || sending.current || read.state !== 'READY') return;
    let body: AdmissionLimitsInput;
    try { body = limitsRequest(fields, read.view); } catch { setOutcome({ kind: 'INVALID' }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), body };
    void send();
  }, [formOpen, lock, read, send]);
  const onStop = useCallback(() => {
    if (lock !== 'KEPT' || sending.current) return;
    pending.current = null; setLock('NONE'); setOutcome(null); reread();
  }, [lock, reread]);

  return <AdmissionView language={preferences.language} concealed={concealed} read={read} formOpen={formOpen} outcome={outcome}
    locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onRefresh={reread} onReveal={() => setConcealed(false)}
    onOpen={() => { if (lock === 'NONE') { setOutcome(null); setFormOpen(true); } }} onClose={() => setFormOpen(false)}
    onSubmit={onSubmit} onTryAgain={() => { void send(); }} onStop={onStop}/>;
}
