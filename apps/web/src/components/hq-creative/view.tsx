import React from 'react';
import { CREATIVE_GENERATION_FORMATS, type HqCreativeGeneration, type HqCreativeStudio, type HqMarketingCampaign } from '@hon/contracts';
import { creativeText, isCreativeKey, type CreativeKey } from './copy';
import type { HqCreativeReceipt } from './http';
import { resolvable, type BudgetDraft, type RequestDraft, type ResolveDraft } from './model';
import type { MarketingOutcome } from '../hq-marketing/model';
import styles from '../hq-access/hq-access.module.css';

export type CreativeState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqCreativeStudio };
export type CreativeDone = 'REQUEST' | 'BUDGET' | 'RESOLVE';
export type CreativeOutcome = MarketingOutcome<{ done: CreativeDone; receipt: HqCreativeReceipt }>;
export type CreativeViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: CreativeState;
  campaigns: readonly HqMarketingCampaign[]; outcome: CreativeOutcome; locked: boolean; canRetry: boolean; resolving: string | null;
  onRefresh: () => void; onReveal: () => void; onRequest: (d: RequestDraft) => void; onBudget: (d: BudgetDraft) => void;
  onResolveOpen: (generationId: string | null) => void; onResolve: (g: HqCreativeGeneration, d: ResolveDraft) => void; onTryAgain: () => void }>;

const formatTime = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const formatMonth = (locale: string, day: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(new Date(`${day}T00:00:00.000Z`));
const n = (locale: string, v: number) => new Intl.NumberFormat(locale).format(v);
const tone = (s: HqCreativeGeneration['status']) => s === 'SUCCEEDED' ? 'ready' : s === 'GENERATING' || s === 'UNDER_REVIEW' ? 'waiting' : s === 'RESOLVED_CHARGED' ? 'ready' : 'blocked';

function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Outcome({ language, outcome, canRetry, onTryAgain }: { language: string; outcome: CreativeOutcome; canRetry: boolean; onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  const t = (key: CreativeKey) => creativeText(language, key);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-creative-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.outcome} data-tone="ok" role="status" data-creative-outcome="done">
    {t(outcome.receipt.done === 'REQUEST' ? 'created_ok' : outcome.receipt.done === 'BUDGET' ? 'budget_ok' : 'resolve_ok')}</p>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-creative-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: CreativeKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid'
    : outcome.code && isCreativeKey(outcome.code) ? outcome.code : 'refused';
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-creative-outcome={outcome.kind.toLowerCase()} data-creative-code={outcome.kind === 'REFUSED' ? outcome.code ?? '' : undefined}>{t(key)}</p>;
}

function BudgetForm({ language, locked, onBudget }: { language: string; locked: boolean; onBudget: (d: BudgetDraft) => void }): React.ReactElement {
  const t = (key: CreativeKey) => creativeText(language, key);
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    onBudget({ creditCap: String(f.get('creditCap') ?? ''), reason: String(f.get('reason') ?? '') }); };
  return <form className={styles.form} onSubmit={submit} aria-labelledby="hq-cs-budget-form" data-creative-budget-form="">
    <h3 id="hq-cs-budget-form">{t('setBudget')}</h3>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor="hq-cs-cap">{t('capLabel')}</label>
      <input id="hq-cs-cap" name="creditCap" required inputMode="numeric" autoComplete="off" aria-describedby="hq-cs-cap-help"/>
      <p id="hq-cs-cap-help" className={styles.meta}>{t('capHelp')}</p>
      <label htmlFor="hq-cs-reason">{t('reason')}</label>
      <input id="hq-cs-reason" name="reason" required minLength={3} maxLength={300} autoComplete="off"/>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('saveBudget')}</button></div>
  </form>;
}

function RequestForm({ language, view, campaigns, locked, onRequest }: { language: string; view: HqCreativeStudio; campaigns: readonly HqMarketingCampaign[];
  locked: boolean; onRequest: (d: RequestDraft) => void }): React.ReactElement {
  const t = (key: CreativeKey, vars?: Record<string, string>) => creativeText(language, key, vars);
  const off = view.provider !== 'CONNECTED' || view.budget.creditCap === null || view.rates.length === 0;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onRequest({ operationCode: v('operationCode'), units: v('units'), format: v('format'), prompt: v('prompt'), campaignId: v('campaignId') }); };
  return <form className={styles.form} onSubmit={submit} aria-labelledby="hq-cs-request" data-creative-request-form="">
    <h3 id="hq-cs-request">{t('requestTitle')}</h3>
    {off && <p className={styles.meta} data-creative-requests-off="">{t('requestsOff')}</p>}
    <fieldset className={styles.fields} disabled={locked || off}>
      <label htmlFor="hq-cs-op">{t('operation')}</label>
      <select id="hq-cs-op" name="operationCode">{view.rates.map(r => <option key={r.operationCode} value={r.operationCode}>
        {t('rateLine', { name: r.displayName, credits: String(r.creditsPerUnit), unit: t(r.billingUnit), max: String(r.maxUnitsPerRequest) })}</option>)}</select>
      <div className={styles.pair}>
        <div><label htmlFor="hq-cs-units">{t('units')}</label><input id="hq-cs-units" name="units" required inputMode="numeric" defaultValue="1" autoComplete="off"/></div>
        <div><label htmlFor="hq-cs-format">{t('format')}</label>
          <select id="hq-cs-format" name="format" defaultValue="SQUARE">{CREATIVE_GENERATION_FORMATS.map(f => <option key={f} value={f}>{t(f)}</option>)}</select></div>
      </div>
      <label htmlFor="hq-cs-campaign">{t('campaign')}</label>
      <select id="hq-cs-campaign" name="campaignId" defaultValue=""><option value="">{t('noCampaign')}</option>
        {campaigns.map(c => <option key={c.campaignId} value={c.campaignId}>{`${c.code} · ${c.name}`}</option>)}</select>
      <label htmlFor="hq-cs-prompt">{t('prompt')}</label>
      <textarea id="hq-cs-prompt" name="prompt" required rows={4} maxLength={1000} aria-describedby="hq-cs-prompt-help"/>
      <p id="hq-cs-prompt-help" className={styles.meta}>{t('promptHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked || off}>{t('submitRequest')}</button></div>
  </form>;
}

function ResolveForm({ language, g, locked, onResolve, onCancel }: { language: string; g: HqCreativeGeneration; locked: boolean;
  onResolve: (d: ResolveDraft) => void; onCancel: () => void }): React.ReactElement {
  const t = (key: CreativeKey) => creativeText(language, key), id = `hq-cs-r-${g.generationId}`;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onResolve({ resolution: v('resolution'), finalUnits: v('finalUnits'), evidenceReference: v('evidenceReference') }); };
  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-t`} data-creative-resolve-form={g.generationId}>
    <h4 id={`${id}-t`}>{t('resolveTitle')}</h4>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor={`${id}-res`}>{t('resolution')}</label>
      <select id={`${id}-res`} name="resolution" defaultValue="NOT_CHARGED"><option value="NOT_CHARGED">{t('resolveNotCharged')}</option>
        <option value="SUCCEEDED">{t('resolveSucceeded')}</option></select>
      <label htmlFor={`${id}-units`}>{t('finalUnits')}</label>
      <input id={`${id}-units`} name="finalUnits" inputMode="numeric" autoComplete="off"/>
      <label htmlFor={`${id}-ev`}>{t('evidence')}</label>
      <input id={`${id}-ev`} name="evidenceReference" required maxLength={200} autoComplete="off"/>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('saveResolve')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button></div>
  </form>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqCreativeView(props: CreativeViewProps): React.ReactElement {
  const { language, formattingLocale: loc, concealed, state, locked } = props;
  const t = (key: CreativeKey, vars?: Record<string, string>) => creativeText(language, key, vars);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p><p className={styles.meta}><a href="/hq/marketing">{t('back')}</a></p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-creative="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-creative={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, b = v.budget;
  return <section className={styles.access} data-hq-creative="ready">{head}
    <p className={styles.meta}>{t('viewer', { name: v.viewer.displayName })}{v.viewer.canManage ? '' : ` ${t('readOnly')}`}</p>
    <p className={styles.notice} data-creative-provider={v.provider}>{t(v.provider === 'CONNECTED' ? 'providerOn' : 'providerOff')}</p>
    <h2>{t('budgetTitle', { month: formatMonth(loc, b.periodStart) })}</h2>
    <p className={styles.meta}>{t('budgetSeparate')}</p>
    {b.creditCap === null ? <p className={styles.notice} data-creative-budget="unset">{t('noBudget')}</p> : <>
      <div data-creative-budget="set"><Facts rows={[[t('cap'), n(loc, b.creditCap)], [t('used'), n(loc, b.usedCredits)], [t('held'), n(loc, b.heldCredits)],
        [t('available'), n(loc, b.availableCredits)], [t('inProgress'), String(b.inProgress)], [t('setBy'), b.setBy?.displayName ?? '']]}/></div>
      <meter min={0} max={Math.max(b.creditCap, 1)} value={b.usedCredits + b.heldCredits} aria-label={t('used')} style={{ width: '100%' }}/></>}
    <Outcome language={language} outcome={props.outcome} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    {v.viewer.isOwner && <BudgetForm language={language} locked={locked} onBudget={props.onBudget}/>}
    {v.budgetHistory.length > 0 && <><h3>{t('history')}</h3><ul className={styles.list} data-creative-history="">
      {v.budgetHistory.map(h => <li key={`${h.periodStart}-${h.version}`} className={styles.meta}>{t(h.previousCap === null ? 'historyFirst' : 'historyRow',
        { month: formatMonth(loc, h.periodStart), cap: n(loc, h.creditCap), prev: h.previousCap === null ? '' : n(loc, h.previousCap), name: h.actor.displayName, reason: h.reason })}</li>)}</ul></>}
    {v.rates.length === 0 && <p className={styles.meta}>{t('noRates')}</p>}
    {v.viewer.canManage && <RequestForm language={language} view={v} campaigns={props.campaigns} locked={locked} onRequest={props.onRequest}/>}
    <h2>{t('listTitle')}</h2>
    {v.generations.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} aria-label={t('listTitle')}>
      {v.generations.map(g => <li key={g.generationId} className={styles.card} data-creative-generation={g.generationId}>
        <div className={styles.cardHead}><h3>{v.rates.find(r => r.operationCode === g.operationCode)?.displayName ?? g.operationCode}</h3>
          <span className={styles.status} data-tone="waiting">{t(g.format)}</span>
          <span className={styles.status} data-tone={tone(g.status)} data-creative-status={g.status}>{t(g.status)}</span></div>
        <p className={styles.meta}>{g.prompt}</p>
        {g.failureReason && <p className={styles.meta}>{t(g.failureReason)}</p>}
        <Facts rows={[[t('units'), String(g.units)], [t('reserved'), n(loc, g.reservedCredits)], [t('charged'), g.chargedCredits === null ? '—' : n(loc, g.chargedCredits)],
          [t('campaign'), g.campaign ? g.campaign.code : t('noCampaign')], [t('requestedBy'), g.requestedBy.displayName], [t('created'), `${formatTime(loc, g.createdAt)} UTC`],
          ...(g.assets.length ? [[t('results'), t('resultsLine', { count: String(g.assets.length) })] as [string, string]] : [])]}/>
        {v.viewer.isOwner && resolvable(g, v.asOf) && (props.resolving === g.generationId
          ? <ResolveForm language={language} g={g} locked={locked} onResolve={(d) => props.onResolve(g, d)} onCancel={() => props.onResolveOpen(null)}/>
          : <div className={styles.actions}><button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onResolveOpen(g.generationId)}>{t('resolveTitle')}</button></div>)}
      </li>)}
    </ul>}
    <p className={styles.meta}>{t('asOf', { time: formatTime(loc, v.asOf) })}</p>
  </section>;
}
