import React, { useId, useState } from 'react';
import { CREATIVE_GENERATION_FORMATS, CREATIVE_GENERATION_LIMITS, isCreativePrompt, type CreativeGeneration, type CreativeGenerationFormat, type CreativeGenerationInput } from '@hon/contracts';
import { accountValue } from '../account-status/copy';
import { studioText, type StudioKey } from './copy';
import type { CreateOutcome, GenerationsState, StudioWallet } from './model';
import styles from './creative-studio.module.css';

type T = (key: StudioKey, vars?: Record<string, string>) => string;
const REASONS: Record<string, StudioKey> = { SAAS_CREATIVE_AI_PAUSED_BY_HQ: 'reasonPaused', CREATIVE_TOO_MANY_IN_PROGRESS: 'reasonBusy', SAAS_CREATIVE_RATES_NOT_PUBLISHED: 'reasonRates' };

export function refusalReason(language: string, code: string | null): string {
  if (code && REASONS[code]) return studioText(language, REASONS[code]!);
  const plain = code?.replace(/^SAAS_CREATIVE_(AI_)?/, '') ?? '';
  const mapped = plain ? accountValue(language, plain) : '';
  return mapped && mapped !== plain ? mapped : studioText(language, 'createBlocked').replace(/\.$/, '');
}

export function outcomeText(language: string, outcome: CreateOutcome): Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string }> | null {
  const t = (key: StudioKey, vars?: Record<string, string>) => studioText(language, key, vars);
  if (!outcome) return null;
  switch (outcome.kind) {
    case 'SENDING': return { tone: 'waiting', text: t('createSending') };
    case 'UNKNOWN': return { tone: 'waiting', text: t('resultUnknown') };
    case 'HIDDEN_PENDING': return { tone: 'waiting', text: t('pendingHidden') };
    case 'DONE': return { tone: 'ok', text: t('resultDone') };
    case 'HELD': return { tone: 'waiting', text: t('resultHeld') };
    case 'FAILED': return { tone: 'blocked', text: t('resultFailed') };
    case 'DENIED': return { tone: 'blocked', text: t('resultDenied') };
    case 'NOT_CONNECTED': return { tone: 'blocked', text: t('resultNotConnected') };
    case 'INVALID': return { tone: 'blocked', text: t('resultInvalid') };
    case 'REFUSED': return { tone: 'blocked', text: t('resultRefused', { reason: refusalReason(language, outcome.code) }) };
  }
}

export type CreatePanelProps = Readonly<{
  language: string; wallet: StudioWallet | null; generations: GenerationsState; outcome: CreateOutcome;
  onCreate?: ((input: CreativeGenerationInput) => void) | undefined; onCheckAgain?: (() => void) | undefined;
}>;

/**
 * The Create card. It offers a form only when the server says a provider is connected and the wallet read shows an
 * eligible school with published rates; otherwise it says plainly why nothing can be created. The cost shown is
 * rate × amount from the published rates; the server reserves the real amount.
 */
export function CreatePanel({ language, wallet, generations, outcome, onCreate, onCheckAgain }: CreatePanelProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const connected = generations.state === 'READY' && generations.provider === 'CONNECTED';
  const usable = connected && wallet && wallet.programActive && wallet.eligible && wallet.rates && wallet.rates.length > 0;
  const status = outcomeText(language, outcome);
  const pending = outcome?.kind === 'SENDING' || outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING';
  return <article className={styles.create} aria-labelledby="creative-create-title" data-create-state={usable ? 'OPEN' : connected ? 'BLOCKED' : 'NOT_CONNECTED'}>
    <div className={styles.cardHead}><h2 id="creative-create-title">{t('createTitle')}</h2>
      <span className={styles.status} data-tone={usable ? 'ready' : 'planned'}>{usable ? t('readyStatus') : t('createStatus')}</span></div>
    {usable ? <CreateForm language={language} wallet={wallet} disabled={pending} onCreate={onCreate}/>
      : connected ? <p className={styles.note}>{t('createBlocked')}</p>
      : <><p className={styles.note}>{t('createNote')}</p><p className={styles.meta}>{t('createPlanned')}</p></>}
    {status ? <div className={styles.outcome} data-tone={status.tone} role="status">
      <p>{status.text}</p>
      {(outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING') && onCheckAgain ? <button type="button" className={styles.secondary} onClick={onCheckAgain}>{t('checkAgain')}</button> : null}
    </div> : null}
  </article>;
}

function CreateForm({ language, wallet, disabled, onCreate }: { language: string; wallet: StudioWallet; disabled: boolean; onCreate?: ((input: CreativeGenerationInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const id = useId(), rates = wallet.rates ?? [];
  const [operationCode, setOperation] = useState('');
  const [units, setUnits] = useState(1);
  const [format, setFormat] = useState<CreativeGenerationFormat>('SQUARE');
  const [prompt, setPrompt] = useState('');
  const rate = rates.find(r => r.operationCode === operationCode) ?? null;
  const amount = rate ? Math.min(Math.max(1, Math.trunc(units) || 1), rate.maxUnitsPerRequest) : 1;
  const cost = rate ? rate.creditsPerUnit * amount : null;
  const short = cost !== null && cost > wallet.available;
  const text = prompt.trim();
  const ready = !!rate && !short && isCreativePrompt(text) && !disabled;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (ready && onCreate) onCreate({ operationCode: rate.operationCode, units: amount, format, prompt: text });
  };
  return <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-cost`}>
    <label htmlFor={`${id}-what`}>{t('createWhat')}</label>
    <select id={`${id}-what`} value={operationCode} disabled={disabled} onChange={e => { setOperation(e.target.value); setUnits(1); }}>
      <option value="">{t('createChoose')}</option>
      {rates.map(r => <option key={r.operationCode} value={r.operationCode}>{r.displayName} · {t(r.mediaKind)}</option>)}
    </select>
    {rate ? <>
      <label htmlFor={`${id}-units`}>{rate.billingUnit === 'VIDEO_SECOND' ? t('createUnitsSeconds') : t('createUnits')}</label>
      <input id={`${id}-units`} type="number" inputMode="numeric" min={1} max={rate.maxUnitsPerRequest} step={1} value={amount} disabled={disabled}
        onChange={e => setUnits(Number(e.target.value))}/>
    </> : null}
    <fieldset className={styles.modes} disabled={disabled}>
      <legend>{t('createFormat')}</legend>
      {CREATIVE_GENERATION_FORMATS.map(value => <label key={value}><input type="radio" name={`${id}-format`} value={value} checked={format === value} onChange={() => setFormat(value)}/>{t(value)}</label>)}
    </fieldset>
    <label htmlFor={`${id}-prompt`}>{t('createPrompt')}</label>
    <textarea id={`${id}-prompt`} rows={4} maxLength={CREATIVE_GENERATION_LIMITS.promptCharacters} value={prompt} disabled={disabled}
      aria-describedby={`${id}-help`} onChange={e => setPrompt(e.target.value)}/>
    <p id={`${id}-help`} className={styles.meta}>{t('createPromptHelp', { n: number(CREATIVE_GENERATION_LIMITS.promptCharacters) })}</p>
    <p id={`${id}-cost`} className={styles.meta} aria-live="polite">
      {cost === null ? t('createChoose') : short ? t('createShort') : t('createCost', { cost: number(cost), available: number(wallet.available) })}
    </p>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('createButton')}</button></div>
  </form>;
}

export function GenerationsPanel({ language, generations }: { language: string; generations: GenerationsState }): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(stamp)) + ' UTC';
  const credits = (g: CreativeGeneration) => g.chargedCredits !== null ? t('credits', { n: number(g.chargedCredits) })
    : g.status === 'GENERATING' || g.status === 'UNDER_REVIEW' ? t('creditsHeld', { n: number(g.reservedCredits) }) : t('credits', { n: number(0) });
  return <article className={styles.card} aria-labelledby="creative-generations-title">
    <h2 id="creative-generations-title">{t('generationsTitle')}</h2>
    {generations.state === 'READY' ? generations.items.length ? <ul className={styles.list}>{generations.items.map(g => <li key={g.generationId} data-status={g.status}>
      <span className={styles.rowMain}><strong>{t(g.mediaKind)}</strong> <small>{t(g.format)}</small>
        <span className={styles.status} data-tone={g.status === 'SUCCEEDED' || g.status === 'RESOLVED_CHARGED' ? 'ready' : g.status === 'FAILED' || g.status === 'RESOLVED_NOT_CHARGED' ? 'planned' : 'waiting'}>{t(g.status)}</span></span>
      <span>{credits(g)}</span>
      <p className={styles.prompt}>{g.prompt}</p>
      {g.assets.map(a => <small key={a.assetId} className={styles.asset}>{t('assetPreview', { kind: t(g.mediaKind), w: String(a.width), h: String(a.height), d: a.durationSeconds ? t('seconds', { n: String(a.durationSeconds) }) : '' })}</small>)}
      <small><time dateTime={g.createdAt}>{date(g.createdAt)}</time></small>
    </li>)}</ul> : <p className={styles.meta}>{t('generationsNone')}</p>
      : generations.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : <p className={styles.meta}>{t('generationsUnavailable')}</p>}
  </article>;
}
