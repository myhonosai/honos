'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS, type AiExceptionAllowanceInput, type AiExceptionAllowanceList, type AiExceptionAllowanceStatus } from '@hon/contracts';
import { exceptionAiText, type ExceptionAiKey } from './exception-ai-copy';
import { ExceptionAiError, allowanceInput, exceptionAiApi, type ExceptionAiApi } from './exception-ai-http';
import styles from './hq-access.module.css';

type T = (key: ExceptionAiKey, vars?: Record<string, string>) => string;
export type ExceptionAiState = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; list: AiExceptionAllowanceList }>;
export type ExceptionAiOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'UNKNOWN' | 'CHANGED' | 'DENIED' | 'INVALID' | 'LOCAL_INVALID' | 'LOCAL_INVALID_CLEAR'; school: string }>;
export type ExceptionAiForm = Readonly<{ command: 'set' | 'clear'; exceptionId: string }> | null;
export type ExceptionAiViewProps = Readonly<{
  language: string; state: ExceptionAiState; owner: boolean; outcome: ExceptionAiOutcome; locked: boolean; canRetry: boolean; form: ExceptionAiForm;
  onOpenForm?: (form: ExceptionAiForm) => void; onSet?: (row: AiExceptionAllowanceStatus, dollars: string, reason: string) => void;
  onClear?: (row: AiExceptionAllowanceStatus, reason: string) => void; onTryAgain?: () => void;
}>;

const dollars = (micros: number, language: string) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(micros / 1_000_000);

export function exceptionAiOutcomeText(language: string, outcome: ExceptionAiOutcome): Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string }> | null {
  const t: T = (key, vars) => exceptionAiText(language, key, vars);
  if (!outcome) return null;
  const p = `${outcome.school}: `;
  switch (outcome.kind) {
    case 'SENDING': return { tone: 'waiting', text: p + t('sending') };
    case 'DONE': return { tone: 'ok', text: p + t('done') };
    case 'UNKNOWN': return { tone: 'waiting', text: p + t('unknown') };
    case 'CHANGED': return { tone: 'blocked', text: p + t('changed') };
    case 'DENIED': return { tone: 'blocked', text: p + t('notAllowed') };
    case 'INVALID': return { tone: 'blocked', text: p + t('invalid') };
    case 'LOCAL_INVALID': return { tone: 'blocked', text: p + t('localInvalid') };
    case 'LOCAL_INVALID_CLEAR': return { tone: 'blocked', text: p + t('localInvalidClear') };
  }
}

/** Pure view. Every fact is from the HQ read; set and clear appear only for the HQ owner. */
export function ExceptionAiView(props: ExceptionAiViewProps): React.ReactElement {
  const { language, state, owner, outcome, canRetry, onTryAgain } = props;
  const t: T = (key, vars) => exceptionAiText(language, key, vars);
  const status = exceptionAiOutcomeText(language, outcome);
  return <section className={styles.policy} aria-labelledby="hq-exception-ai-title" data-testid="hq-exception-ai">
    <h2 id="hq-exception-ai-title" style={{ margin: 0, fontSize: 17 }}>{t('title')}</h2>
    <p className={styles.meta}>{t('intro')}</p>
    {state.state === 'LOADING' ? <p role="status">{t('loading')}</p> : state.state === 'DENIED' ? <p role="status">{t('denied')}</p>
      : state.state === 'UNAVAILABLE' ? <p role="status">{t('unavailable')}</p> : null}
    {status ? <div className={styles.outcome} data-tone={status.tone} role="status"><p>{status.text}</p>
      {outcome?.kind === 'UNKNOWN' && canRetry && onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
    {state.state === 'READY' ? <>
      {!owner ? <p data-testid="hq-exception-ai-owner-only">{t('ownerOnly')}</p> : null}
      {state.list.schools.length ? <ul className={styles.list}>{state.list.schools.map(row => <li key={row.exceptionId}><Row {...props} row={row} t={t}/></li>)}</ul>
        : <p>{t('none')}</p>}
    </> : null}
  </section>;
}

function Row(props: ExceptionAiViewProps & { row: AiExceptionAllowanceStatus; t: T }) {
  const { row, t, language, owner, locked, form, onOpenForm } = props;
  const base = useId();
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(row.exceptionExpiresAt));
  const open = form?.exceptionId === row.exceptionId ? form.command : null;
  const tone = row.aiAllowed ? (row.level === 'CEILING_REACHED' ? 'blocked' : row.level === 'NORMAL' ? 'ready' : 'waiting') : row.ceilingMicros !== null ? 'waiting' : 'blocked';
  const label = row.aiAllowed ? t('aiOn') : row.ceilingMicros !== null ? t('aiScheduled') : t('aiOff');
  return <article className={styles.card} aria-labelledby={`${base}-name`} data-exception-ai={row.aiAllowed ? 'ON' : 'OFF'}>
    <div className={styles.cardHead}><h3 id={`${base}-name`} style={{ margin: '0 auto 0 0', fontSize: 16 }}>{row.schoolName}</h3>
      <span className={styles.status} data-tone={tone}>{label}</span></div>
    <dl className={styles.facts}>
      <div><dt>{t('limit')}</dt><dd>{row.ceilingMicros !== null ? dollars(row.ceilingMicros, language) : t('noLimit')}</dd></div>
      <div><dt>{t('used')}</dt><dd>{row.ceilingMicros !== null ? t('of', { used: dollars(row.committedCostMicros, language), limit: dollars(row.ceilingMicros, language) }) : dollars(row.committedCostMicros, language)}</dd></div>
      <div><dt>{t('ends', { date })}</dt><dd>{row.aiAllowed && row.level !== 'NO_CEILING' ? t(row.level) : ''}</dd></div>
    </dl>
    {owner ? <div className={styles.actions}>
      {open !== 'set' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.({ command: 'set', exceptionId: row.exceptionId })}>
        {row.ceilingMicros !== null ? t('changeOpen') : t('setOpen')}</button> : null}
      {row.ceilingMicros !== null && open !== 'clear' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.({ command: 'clear', exceptionId: row.exceptionId })}>{t('clearOpen')}</button> : null}
    </div> : null}
    {owner && open === 'set' ? <SetForm {...props}/> : null}
    {owner && open === 'clear' ? <ClearForm {...props}/> : null}
  </article>;
}

function SetForm({ row, t, locked, onSet, onOpenForm, state }: ExceptionAiViewProps & { row: AiExceptionAllowanceStatus; t: T }) {
  const base = useId();
  const dflt = state.state === 'READY' ? state.list.defaultCeilingMicros : AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS;
  const initial = String((row.ceilingMicros ?? dflt) / 1_000_000);
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate onSubmit={e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); onSet?.(row, String(f.get('dollars') ?? ''), String(f.get('reason') ?? ''));
  }}>
    <h4 id={`${base}-title`} style={{ margin: 0 }}>{t('setTitle', { school: row.schoolName })}</h4>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t('setTitle', { school: row.schoolName })}</legend>
      <label htmlFor={`${base}-dollars`}>{t('amount')}</label>
      <input id={`${base}-dollars`} name="dollars" inputMode="decimal" defaultValue={initial} aria-describedby={`${base}-dollars-help`}/>
      <small id={`${base}-dollars-help`} className={styles.meta}>{t('amountHelp', { dflt: String(dflt / 1_000_000) })}</small>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
    </fieldset>
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={locked}>{t('save')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
    </div>
  </form>;
}

function ClearForm({ row, t, locked, onClear, onOpenForm }: ExceptionAiViewProps & { row: AiExceptionAllowanceStatus; t: T }) {
  const base = useId();
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate onSubmit={e => {
    e.preventDefault(); onClear?.(row, String(new FormData(e.currentTarget).get('reason') ?? ''));
  }}>
    <h4 id={`${base}-title`} style={{ margin: 0 }}>{t('clearTitle', { school: row.schoolName })}</h4>
    <p className={styles.meta}>{t('clearNote')}</p>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t('clearTitle', { school: row.schoolName })}</legend>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
    </fieldset>
    <div className={styles.actions}>
      <button type="submit" className={styles.danger} disabled={locked}>{t('clear')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
    </div>
  </form>;
}

type Pending = Readonly<{ key: string; school: string; input: AiExceptionAllowanceInput }>;

/**
 * Container, mounted by the HQ access overview only while it shows customer facts (it unmounts on blur, hidden tab or
 * session end, which drops any kept request). Every answer is followed by a fresh read; an unknown answer keeps the
 * exact request and key for Try again, and the database's version check means nothing is applied twice.
 */
export function HqExceptionAi({ language, owner, refresh, api = exceptionAiApi }: { language: string; owner: boolean; refresh: number; api?: ExceptionAiApi }): React.ReactElement {
  const [state, setState] = useState<ExceptionAiState>({ state: 'LOADING' });
  const [outcome, setOutcome] = useState<ExceptionAiOutcome>(null);
  const [form, setForm] = useState<ExceptionAiForm>(null);
  const [kept, setKept] = useState(false), [sendingNow, setSendingNow] = useState(false);
  const [reads, setReads] = useState(0);
  const mounted = useRef(false), generation = useRef(0), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);
  useEffect(() => {
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list(signal, owned).then(list => { if (owned()) setState({ state: 'READY', list }); },
      error => { if (owned()) setState({ state: error instanceof ExceptionAiError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, refresh, reads]);
  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setSendingNow(true); setOutcome({ kind: 'SENDING', school: request.school });
    let next: ExceptionAiOutcome, keep = false;
    try {
      await api.command(request.input, request.key, AbortSignal.timeout(30000), () => mounted.current && pending.current?.key === request.key);
      next = { kind: 'DONE', school: request.school };
    } catch (error) {
      if (!(error instanceof ExceptionAiError) || error.kind === 'UNKNOWN') { next = { kind: 'UNKNOWN', school: request.school }; keep = true; }
      else if (error.kind === 'SESSION') next = null;
      else next = { kind: error.kind, school: request.school };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setSendingNow(false); setKept(pending.current !== null); setOutcome(next);
    if (next?.kind === 'DONE' || next?.kind === 'CHANGED') setForm(null);
    setReads(n => n + 1);
  }, [api]);
  const locked = sendingNow || kept;
  const start = (row: AiExceptionAllowanceStatus, input: AiExceptionAllowanceInput | null, local: 'LOCAL_INVALID' | 'LOCAL_INVALID_CLEAR') => {
    if (!owner || locked || pending.current || sending.current) return;
    if (!input) { setOutcome({ kind: local, school: row.schoolName }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), school: row.schoolName, input };
    void send();
  };
  const onSet = (row: AiExceptionAllowanceStatus, amount: string, reason: string) => start(row, allowanceInput(row.schoolId, row.version, amount, reason), 'LOCAL_INVALID');
  const onClear = (row: AiExceptionAllowanceStatus, reason: string) => start(row, allowanceInput(row.schoolId, row.version, null, reason), 'LOCAL_INVALID_CLEAR');
  const onOpenForm = useCallback((next: ExceptionAiForm) => { if (!locked) { setForm(next); setOutcome(null); } }, [locked]);
  return <ExceptionAiView language={language} state={state} owner={owner} outcome={outcome} locked={locked} canRetry={kept} form={form}
    onOpenForm={onOpenForm} onSet={onSet} onClear={onClear} onTryAgain={() => { void send(); }}/>;
}
