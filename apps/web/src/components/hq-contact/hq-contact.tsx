'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeHqContactPhone, type HqContact, type HqContactReceipt } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CommsError } from '../hq-communications/http';
import { useCommsCommand, type CommsOutcome } from '../hq-communications/model';
import { formatTime } from '../hq-support/parts';
import styles from '../hq-access/hq-access.module.css';
import { hqContactApi, type HqContactApi } from './http';
import { hqContactRefusalKey, hqContactText, type HqContactKey } from './copy';

export type HqContactState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; contact: HqContact };
/** The code from the start answer, held in memory only, tied to the number and expiry it was issued with. */
export type ShownCode = Readonly<{ code: string; phone: string; expiresAt: string }>;

/** The code to show, or null: only while that very code is still pending and not expired (wrong tries do not hide it). */
export function codeToShow(contact: HqContact, code: ShownCode | null): string | null {
  return code && contact.status === 'PENDING' && !contact.codeExpired && contact.phone === code.phone && contact.codeExpiresAt === code.expiresAt ? code.code : null;
}

export type HqContactViewProps = Readonly<{ language: string; formattingLocale: string; state: HqContactState; code: ShownCode | null;
  outcome: CommsOutcome<HqContactReceipt>; locked: boolean; canRetry: boolean; localInvalid: boolean;
  onStart: (phone: string) => void; onTexting: (enabled: boolean) => void; onRemove: () => void; onTryAgain: () => void; onRefresh: () => void }>;

function Outcome({ t, outcome, canRetry, onTryAgain }: { t: (k: HqContactKey) => string; outcome: CommsOutcome<HqContactReceipt>; canRetry: boolean;
  onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome || outcome.kind === 'LOCAL_INVALID') return null;
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-contact-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.outcome} data-tone="ok" role="status" data-contact-outcome="done">
    {t(outcome.receipt.operation === 'PHONE_START' && outcome.receipt.code ? 'codeReady' : 'saved')}</p>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-contact-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('retry')}</button>}</div>;
  const key: HqContactKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : hqContactRefusalKey(outcome.code);
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-contact-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

function PhoneForm({ t, label, locked, onStart }: { t: (k: HqContactKey) => string; label: HqContactKey; locked: boolean; onStart: (phone: string) => void }) {
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); onStart(String(new FormData(event.currentTarget).get('phone') ?? '')); };
  return <form className={styles.form} onSubmit={submit} data-contact-form="phone">
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor="hq-contact-phone">{t('phone')}</label>
      <input id="hq-contact-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={24} aria-describedby="hq-contact-phone-help"/>
      <p id="hq-contact-phone-help" className={styles.meta}>{t('phoneHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t(label)}</button></div>
  </form>;
}

/** The screen itself, with no fetching: everything it shows comes from the last read or command answer. */
export function HqContactView(p: HqContactViewProps): React.ReactElement {
  const t = (key: HqContactKey, vars?: Record<string, string>) => hqContactText(p.language, key, vars);
  const head = <header className={styles.head}><p className={styles.meta}>{t('crumb')}</p><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></header>;
  if (p.state.state !== 'READY') {
    const key: HqContactKey = p.state.state === 'LOADING' ? 'loading' : p.state.state === 'DENIED' ? 'denied' : 'unavailable';
    return <main className={styles.access} data-hq-contact={p.state.state.toLowerCase()}>{head}
      <p className={styles.notice} role={p.state.state === 'LOADING' ? 'status' : 'alert'}>{t(key)}</p>
      {p.state.state === 'UNAVAILABLE' && <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('retry')}</button></div>}
    </main>;
  }
  const c = p.state.contact, hq = c.hqNumber, shown = codeToShow(c, p.code);
  const outcome = <>
    {p.localInvalid && <p className={styles.outcome} data-tone="blocked" role="alert" data-contact-outcome="local_invalid">{t('phoneInvalid')}</p>}
    <Outcome t={t} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain}/>
  </>;
  const remove = <div className={styles.actions}><button type="button" className={styles.danger} disabled={p.locked} onClick={p.onRemove}>{t('remove')}</button>
    <p className={styles.meta}>{t('removedHelp')}</p></div>;
  let body: React.ReactNode;
  if (!hq && c.status === 'REMOVED') body = <p className={styles.notice} data-contact-step="not-ready">{t('notReady')}</p>;
  else if (!hq && c.status === 'PENDING') body = <><p className={styles.notice} data-contact-step="not-ready">{t('notReady')}</p>
    <p>{t('pendingFor', { phone: c.phone ?? '' })}</p>{remove}</>;
  else if (c.status === 'REMOVED') body = <><p className={styles.meta}>{t('consent')}</p><PhoneForm t={t} label="addPhone" locked={p.locked} onStart={p.onStart}/></>;
  else if (c.status === 'PENDING') body = <>
    <p data-contact-step="pending">{t('pendingFor', { phone: c.phone ?? '' })}</p>
    {shown && hq ? <div className={styles.card} data-contact-code="shown">
      <p>{t('codeSay', { hq: hq.number })}</p>
      <p><strong aria-label={shown.split('').join(' ')} data-contact-code-value>{shown}</strong></p>
      {c.codeExpiresAt && <p className={styles.meta}>{t('codeExpires', { time: formatTime(p.formattingLocale, c.codeExpiresAt) })}</p>}
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button></div>
    </div> : <div className={styles.card} data-contact-code="none">
      <p>{t(c.codeExpired ? 'codeExpired' : 'codeGone')}</p>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={p.locked || c.codesLeftToday === 0 || !hq}
        onClick={() => c.phone && p.onStart(c.phone)}>{t('newCode')}</button></div>
    </div>}
    <p className={styles.meta}>{t('codesLeft', { n: String(c.codesLeftToday) })}{c.wrongCodes > 0 ? ` ${t('wrongCodes', { n: String(c.wrongCodes) })}` : ''}</p>
    <details><summary>{t('changePhone')}</summary><PhoneForm t={t} label="addPhone" locked={p.locked} onStart={p.onStart}/></details>
    {remove}
  </>;
  else body = <>
    <p data-contact-step="confirmed">{t('confirmedFor', { phone: c.phone ?? '' })}</p>
    <p className={styles.status} data-tone={c.textingOn ? 'ready' : 'waiting'} data-contact-texting={c.textingOn ? 'on' : 'off'}>{t(c.textingOn ? 'textingOn' : 'textingOff')}</p>
    {c.stoppedByReply ? <p className={styles.notice} data-contact-step="stopped-by-reply">{t('stoppedByReply', { hq: hq?.number ?? '' })}</p> : <>
      {!c.textingOn && <p className={styles.meta}>{t('consent')}</p>}
      <div className={styles.actions}><button type="button" className={c.textingOn ? styles.secondary : styles.primary} disabled={p.locked}
        onClick={() => p.onTexting(!c.textingOn)}>{t(c.textingOn ? 'turnOff' : 'turnOn')}</button></div></>}
    {hq && <details><summary>{t('changePhone')}</summary><PhoneForm t={t} label="addPhone" locked={p.locked} onStart={p.onStart}/></details>}
    {remove}
  </>;
  return <main className={styles.access} data-hq-contact="ready" data-contact-status={c.status}>{head}{outcome}<section className={styles.card}>{body}</section></main>;
}

const POLL_MS = 5000;

/**
 * "Texts from HON": the signed-in person confirms their own mobile number by texting an on-screen code to the HQ
 * number (that text is also their own opt-in), and turns HQ texts on or off. HON never texts a code out. The code
 * lives in memory only and is dropped when the session ends. Every command answer is followed by a fresh read.
 */
export function HqContactSettings({ api = hqContactApi }: { api?: HqContactApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const language = preferences.language;
  const [state, setState] = useState<HqContactState>({ state: 'LOADING' });
  const [code, setCode] = useState<ShownCode | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [localInvalid, setLocalInvalid] = useState(false);
  const privacy = useRef(0), mounted = useRef(false), generation = useRef(0), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const end = () => { privacy.current++; generation.current++; dropRef.current(); setCode(null); setState({ state: 'LOADING' }); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, end);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, end);
  }, []);
  const after = useCallback((outcome: CommsOutcome<HqContactReceipt>) => {
    if (outcome?.kind === 'DONE') {
      const r = outcome.receipt;
      if (r.operation === 'PHONE_START' && r.code && r.contact.phone && r.contact.codeExpiresAt) setCode({ code: r.code, phone: r.contact.phone, expiresAt: r.contact.codeExpiresAt });
      setState({ state: 'READY', contact: r.contact });
    }
    setRefresh(n => n + 1);
  }, []);
  const command = useCommsCommand<HqContactReceipt>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(signal, owned).then(view => { if (owned()) setState({ state: 'READY', contact: view.contact }); }, (error: unknown) => {
      if (!owned()) return;
      if (error instanceof CommsError && error.kind === 'SESSION') return;
      setState(error instanceof CommsError && error.kind === 'DENIED' ? { state: 'DENIED' } : { state: 'UNAVAILABLE' });
    });
    return () => abort.abort();
  }, [api, refresh]);

  // While a code is on screen, look again every few seconds so the confirmation shows up without a click.
  const contact = state.state === 'READY' ? state.contact : null;
  const waiting = contact !== null && codeToShow(contact, code) !== null;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') setRefresh(n => n + 1); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting]);
  useEffect(() => { if (contact && contact.status !== 'PENDING' && code) setCode(null); }, [contact, code]);

  const onStart = useCallback((raw: string) => {
    if (!contact) return;
    const phone = normalizeHqContactPhone(raw);
    if (!phone) { setLocalInvalid(true); return; }
    setLocalInvalid(false);
    const expectedVersion = contact.version;
    command.start((key, signal, owned) => api.startPhone({ phone, expectedVersion }, key, signal, owned));
  }, [api, command, contact]);
  const onTexting = useCallback((enabled: boolean) => {
    if (!contact) return;
    setLocalInvalid(false);
    const expectedVersion = contact.version;
    command.start((key, signal, owned) => api.setTexting({ enabled, expectedVersion }, key, signal, owned));
  }, [api, command, contact]);
  const onRemove = useCallback(() => {
    if (!contact) return;
    setLocalInvalid(false);
    const expectedVersion = contact.version;
    command.start((key, signal, owned) => api.removePhone(expectedVersion, key, signal, owned));
  }, [api, command, contact]);

  useEffect(() => { document.title = `${hqContactText(language, 'title')} | HON OS`; }, [language]);
  return <HqContactView language={language} formattingLocale={formattingLocale} state={state} code={code} outcome={command.outcome}
    locked={command.locked} canRetry={command.canRetry} localInvalid={localInvalid} onStart={onStart} onTexting={onTexting} onRemove={onRemove}
    onTryAgain={command.tryAgain} onRefresh={() => setRefresh(n => n + 1)}/>;
}
