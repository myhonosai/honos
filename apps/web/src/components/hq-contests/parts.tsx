'use client';
import React, { useState } from 'react';
import type { ChampionsContestConfig, ChampionsContestStatus } from '@hon/contracts';
import { contestText, type ContestKey } from './copy';
import { PRIZE_KINDS, TIERS, configFrom, dollarsToMinor, emptyPrize, formatMoney, type ContestDraft, type PrizeDraft } from './form';
import type { ContestOutcome } from './model';
import styles from '../hq-access/hq-access.module.css';
import local from './contests.module.css';

export const statusTone = (s: ChampionsContestStatus) => s === 'ACTIVE' || s === 'COMPLETED' ? 'ready' : s === 'CANCELLED' ? 'blocked' : 'waiting';
export const formatTime = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
export const formatDay = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(iso));

export function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/** The answer to the last command, worded only from what the server said. */
export function Outcome({ language, outcome, canRetry, onTryAgain }: { language: string; outcome: ContestOutcome; canRetry: boolean; onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  const t = (key: ContestKey) => contestText(language, key);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-contest-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.outcome} data-tone="ok" role="status" data-contest-outcome="done">{t('done')}</p>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-contest-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const refusal = (code: string | null): ContestKey => code && code.startsWith('CHAMPIONS_CONTEST_') || code === 'CHAMPIONS_GIFT_CARDS_NOT_PERMITTED' ? code as ContestKey : 'refusedOther';
  const key: ContestKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid' : refusal(outcome.code);
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-contest-outcome={outcome.kind.toLowerCase()} data-contest-code={outcome.kind === 'REFUSED' ? outcome.code ?? '' : undefined}>{t(key)}</p>;
}

export type SchoolChoice = { schoolId: string; label: string };
export type SchoolChoices = { state: 'LOADING' } | { state: 'UNAVAILABLE' } | { state: 'READY'; schools: SchoolChoice[] };

/**
 * The contest form, for a new draft or editing a draft. It keeps its own draft; submitting hands the checked
 * configuration up, or reports that the form is not acceptable as typed. Nothing is sent from here.
 */
export function ContestForm({ language, formattingLocale, initial, schools, mode, disabled, onSubmit, onInvalid, onClose }: {
  language: string; formattingLocale: string; initial: ContestDraft; schools: SchoolChoices; mode: 'new' | 'edit'; disabled: boolean;
  onSubmit: (config: ChampionsContestConfig) => void; onInvalid: () => void; onClose?: () => void }): React.ReactElement {
  const t = (key: ContestKey, vars?: Record<string, string>) => contestText(language, key, vars);
  const [d, setD] = useState<ContestDraft>(initial);
  const set = <K extends keyof ContestDraft>(k: K, v: ContestDraft[K]) => setD(x => ({ ...x, [k]: v }));
  const setPrize = (i: number, patch: Partial<PrizeDraft>) => setD(x => ({ ...x, prizes: x.prizes.map((p, j) => j === i ? { ...p, ...patch } : p) }));
  const estimate = d.prizes.reduce((sum, p) => {
    const from = Number(p.placeFrom), to = Number(p.placeTo), q = Number(p.quantity), c = dollarsToMinor(p.unitCost);
    return Number.isInteger(from) && Number.isInteger(to) && to >= from && Number.isInteger(q) && c !== null ? sum + (to - from + 1) * q * c : sum;
  }, 0);
  const id = (k: string) => `contest-${mode}-${k}`;
  const field = (k: string, label: ContestKey, input: React.ReactElement, help?: ContestKey) => <div className={styles.fields}>
    <label htmlFor={id(k)}>{t(label)}</label>{input}{help && <small className={styles.meta}>{t(help)}</small>}</div>;
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (disabled) return; const c = configFrom(d); if (c) onSubmit(c); else onInvalid(); };
  return <form className={`${styles.card} ${styles.form}`} onSubmit={submit} aria-labelledby={id('title')} data-contest-form={mode} noValidate>
    <div className={styles.cardHead}><h2 id={id('title')}>{t(mode === 'new' ? 'formTitleNew' : 'formTitleEdit')}</h2>
      {onClose && <button type="button" className={styles.secondary} onClick={onClose}>{t('cancelForm')}</button>}</div>
    {field('name', 'name', <input id={id('name')} name="name" value={d.name} maxLength={120} onChange={e => set('name', e.target.value)}/>)}
    {field('description', 'description', <textarea id={id('description')} name="description" value={d.description} maxLength={2000} rows={3} onChange={e => set('description', e.target.value)}/>)}
    {field('terms', 'terms', <input id={id('terms')} name="termsReference" value={d.termsReference} maxLength={500} onChange={e => set('termsReference', e.target.value)}/>, 'termsHelp')}
    {field('starts', 'startsOn', <input id={id('starts')} name="startsOn" type="date" value={d.startsOn} onChange={e => set('startsOn', e.target.value)}/>)}
    {field('ends', 'endsOn', <input id={id('ends')} name="endsOn" type="date" value={d.endsOn} onChange={e => set('endsOn', e.target.value)}/>)}
    {field('basis', 'countBasis', <select id={id('basis')} value={d.countBasis} onChange={e => set('countBasis', e.target.value as ContestDraft['countBasis'])}>
      {(['QUALIFIED_IN_WINDOW', 'CAPTURED_AND_QUALIFIED_IN_WINDOW'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select>)}
    {field('minimum', 'minimum', <input id={id('minimum')} inputMode="numeric" value={d.minimumQualified} onChange={e => set('minimumQualified', e.target.value)}/>)}
    {field('tie', 'tieRule', <select id={id('tie')} value={d.tieRule} onChange={e => set('tieRule', e.target.value as ContestDraft['tieRule'])}>
      {(['OWNER_RESOLVES', 'EARLIEST_TO_REACH'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select>)}
    <fieldset className={local.group}><legend>{t('eligibility')}</legend>
      {(['ALL_ACTIVE_SCHOOLS', 'SELECTED_SCHOOLS'] as const).map(v => <label key={v} className={local.choice}><input type="radio" name={id('scope')} value={v} checked={d.scope === v}
        disabled={v === 'SELECTED_SCHOOLS' && schools.state !== 'READY'} onChange={() => set('scope', v)}/> {t(v)}</label>)}
      <fieldset className={local.group}><legend>{t('tiers')}</legend>{TIERS.map(tier => <label key={tier} className={local.choice}><input type="checkbox" checked={d.tiers.includes(tier)}
        onChange={e => set('tiers', e.target.checked ? [...d.tiers, tier] : d.tiers.filter(x => x !== tier))}/> {t(tier)}</label>)}</fieldset>
      {d.scope === 'SELECTED_SCHOOLS' && schools.state === 'READY' && <fieldset className={local.group} data-contest-schools><legend>{t('schools')} · {t('schoolsChosen', { n: String(d.schoolIds.length) })}</legend>
        <div className={local.scroll}>{schools.schools.map(s => <label key={s.schoolId} className={local.choice}><input type="checkbox" checked={d.schoolIds.includes(s.schoolId)}
          onChange={e => set('schoolIds', e.target.checked ? [...d.schoolIds, s.schoolId] : d.schoolIds.filter(x => x !== s.schoolId))}/> {s.label}</label>)}</div></fieldset>}
      {schools.state === 'LOADING' && <small className={styles.meta}>{t('schoolsLoading')}</small>}
      {schools.state === 'UNAVAILABLE' && <small className={styles.meta}>{t('schoolsUnavailable')}</small>}
    </fieldset>
    {field('budget', 'budget', <input id={id('budget')} inputMode="decimal" value={d.budget} onChange={e => set('budget', e.target.value)}/>, 'budgetHelp')}
    {field('gift', 'giftCards', <select id={id('gift')} value={d.giftCardCompliance} onChange={e => set('giftCardCompliance', e.target.value as ContestDraft['giftCardCompliance'])}>
      {(['UNDECIDED', 'PERMITTED', 'NOT_PERMITTED'] as const).map(v => <option key={v} value={v}>{t(v)}</option>)}</select>)}
    <fieldset className={local.group}><legend>{t('prizes')}</legend>
      {d.prizes.map((p, i) => <fieldset key={i} className={local.prize} data-contest-prize={i + 1}><legend>{t('prizeRow', { n: String(i + 1) })}</legend>
        {field(`p${i}from`, 'placeFrom', <input id={id(`p${i}from`)} inputMode="numeric" value={p.placeFrom} onChange={e => setPrize(i, { placeFrom: e.target.value })}/>)}
        {field(`p${i}to`, 'placeTo', <input id={id(`p${i}to`)} inputMode="numeric" value={p.placeTo} onChange={e => setPrize(i, { placeTo: e.target.value })}/>)}
        {field(`p${i}kind`, 'kind', <select id={id(`p${i}kind`)} value={p.kind} onChange={e => setPrize(i, { kind: e.target.value as PrizeDraft['kind'] })}>
          {PRIZE_KINDS.map(k => <option key={k} value={k}>{t(k)}</option>)}</select>)}
        {field(`p${i}desc`, 'prizeDescription', <input id={id(`p${i}desc`)} value={p.description} maxLength={300} onChange={e => setPrize(i, { description: e.target.value })}/>)}
        {field(`p${i}qty`, 'quantity', <input id={id(`p${i}qty`)} inputMode="numeric" value={p.quantity} onChange={e => setPrize(i, { quantity: e.target.value })}/>)}
        {field(`p${i}cost`, 'unitCost', <input id={id(`p${i}cost`)} inputMode="decimal" value={p.unitCost} onChange={e => setPrize(i, { unitCost: e.target.value })}/>)}
        <button type="button" className={styles.secondary} onClick={() => setD(x => ({ ...x, prizes: x.prizes.filter((_, j) => j !== i) }))}>{t('removePrize')}</button>
      </fieldset>)}
      {d.prizes.length < 20 && <button type="button" className={styles.secondary} onClick={() => setD(x => {
        const next = x.prizes.reduce((m, p) => Math.max(m, Number(p.placeTo) || 0), 0) + 1; return { ...x, prizes: [...x.prizes, emptyPrize(Math.min(next, 100))] }; })}>{t('addPrize')}</button>}
      <p className={styles.meta} data-contest-estimate>{t('estimate', { cost: formatMoney(estimate, formattingLocale) })}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={disabled}>{t(mode === 'new' ? 'create' : 'saveDraft')}</button></div>
  </form>;
}
