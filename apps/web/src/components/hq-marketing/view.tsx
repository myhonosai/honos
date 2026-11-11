import React from 'react';
import { HQ_MARKETING_AD_ACCOUNTS, HQ_MARKETING_AUDIENCES, HQ_MARKETING_CHANNELS, HQ_MARKETING_LIMITS, HQ_MARKETING_STATUSES, HQ_MARKETING_TRANSITIONS,
  type HqMarketingCampaign, type HqMarketingCampaignList, type HqMarketingChannel, type HqMarketingListFilter, type HqMarketingStatus,
  type HqMarketingTargetStatus } from '@hon/contracts';
import { marketingText, type MarketingKey } from './copy';
import { draftFrom, type MarketingOutcome, type PlanDraft } from './model';
import styles from '../hq-access/hq-access.module.css';

export type MarketingListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqMarketingCampaignList; campaigns: readonly HqMarketingCampaign[]; loadingMore: boolean; moreFailed: boolean };
/** Which form is open: none, a new campaign, or editing one campaign. */
export type MarketingForm = null | { mode: 'CREATE' } | { mode: 'EDIT'; campaignId: string };

export type MarketingViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: MarketingListState;
  filter: HqMarketingListFilter | null; form: MarketingForm; outcome: MarketingOutcome; locked: boolean; canRetry: boolean;
  onFilter: (f: HqMarketingListFilter | null) => void; onMore: () => void; onRefresh: () => void; onReveal: () => void; onForm: (form: MarketingForm) => void;
  onCreate: (draft: PlanDraft) => void; onUpdate: (campaign: HqMarketingCampaign, draft: PlanDraft) => void;
  onStatus: (campaign: HqMarketingCampaign, status: HqMarketingTargetStatus) => void; onTryAgain: () => void }>;

const FILTERS: readonly (HqMarketingListFilter | null)[] = ['OPEN', ...HQ_MARKETING_STATUSES, null];
const statusTone = (s: HqMarketingStatus) => s === 'ACTIVE' ? 'ready' : s === 'ARCHIVED' ? 'blocked' : 'waiting';
const channelKey = (c: HqMarketingChannel): MarketingKey => c === 'OTHER' ? 'OTHER_CHANNEL' : c;
export const formatUsd = (locale: string, minor: number) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
const formatTime = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const formatDate = (locale: string, day: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${day}T00:00:00.000Z`));
const statusAction = (from: HqMarketingStatus, to: HqMarketingTargetStatus): MarketingKey =>
  to === 'ARCHIVED' ? 'archive' : to === 'PAUSED' ? 'pause' : from === 'PAUSED' ? 'resume' : 'activate';

function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Outcome({ language, outcome, canRetry, onTryAgain }: { language: string; outcome: MarketingOutcome; canRetry: boolean; onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  const t = (key: MarketingKey) => marketingText(language, key);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-marketing-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') {
    const op = outcome.receipt.operation;
    return <p className={styles.outcome} data-tone="ok" role="status" data-marketing-outcome="done">{t(op === 'CREATE' ? 'created_ok' : op === 'UPDATE' ? 'updated_ok' : 'status_ok')}</p>;
  }
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-marketing-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: MarketingKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid'
    : outcome.code === 'HQ_CAMPAIGN_CODE_TAKEN' ? 'refusedCode' : outcome.code === 'HQ_CAMPAIGN_NO_CHANGE' ? 'refusedNoChange' : 'refusedStatus';
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-marketing-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

function PlanForm({ language, campaign, locked, onSubmit, onCancel }: { language: string; campaign: HqMarketingCampaign | null; locked: boolean;
  onSubmit: (draft: PlanDraft) => void; onCancel: () => void }): React.ReactElement {
  const t = (key: MarketingKey) => marketingText(language, key);
  const d = campaign ? draftFrom(campaign) : null, id = campaign ? `hq-mk-${campaign.campaignId}` : 'hq-mk-new';
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onSubmit({ code: d ? d.code : v('code'), name: v('name'), goal: v('goal'), audience: v('audience'), offerLabel: v('offerLabel'), channel: v('channel'),
      startsOn: v('startsOn'), endsOn: v('endsOn'), budget: v('budget') });
  };
  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-title`} data-marketing-form={campaign ? 'edit' : 'create'}>
    <h3 id={`${id}-title`}>{campaign ? `${t('edit')} · ${campaign.code}` : t('newCampaign')}</h3>
    <fieldset className={styles.fields} disabled={locked}>
      {!campaign && <><label htmlFor={`${id}-code`}>{t('code')}</label>
        <input id={`${id}-code`} name="code" required minLength={2} maxLength={HQ_MARKETING_LIMITS.code} autoComplete="off" aria-describedby={`${id}-code-help`}/>
        <p id={`${id}-code-help`} className={styles.meta}>{t('codeHelp')}</p></>}
      <label htmlFor={`${id}-name`}>{t('name')}</label>
      <input id={`${id}-name`} name="name" required minLength={3} maxLength={HQ_MARKETING_LIMITS.name} defaultValue={d?.name} autoComplete="off"/>
      <label htmlFor={`${id}-goal`}>{t('goal')}</label>
      <textarea id={`${id}-goal`} name="goal" required rows={3} minLength={3} maxLength={HQ_MARKETING_LIMITS.goal} defaultValue={d?.goal}/>
      <div className={styles.pair}>
        <div><label htmlFor={`${id}-channel`}>{t('channel')}</label>
          <select id={`${id}-channel`} name="channel" defaultValue={d?.channel ?? 'GOOGLE_ADS'}>{HQ_MARKETING_CHANNELS.map(c => <option key={c} value={c}>{t(channelKey(c))}</option>)}</select></div>
        <div><label htmlFor={`${id}-audience`}>{t('audience')}</label>
          <select id={`${id}-audience`} name="audience" defaultValue={d?.audience ?? 'NEW_SCHOOLS'}>{HQ_MARKETING_AUDIENCES.map(a => <option key={a} value={a}>{t(a)}</option>)}</select></div>
      </div>
      <label htmlFor={`${id}-offer`}>{t('offer')}</label>
      <input id={`${id}-offer`} name="offerLabel" required maxLength={HQ_MARKETING_LIMITS.offerLabel} defaultValue={d?.offerLabel} autoComplete="off"/>
      <div className={styles.pair}>
        <div><label htmlFor={`${id}-starts`}>{t('startsOn')}</label><input id={`${id}-starts`} name="startsOn" type="date" required defaultValue={d?.startsOn}/></div>
        <div><label htmlFor={`${id}-ends`}>{t('endsOn')}</label><input id={`${id}-ends`} name="endsOn" type="date" required defaultValue={d?.endsOn}/></div>
      </div>
      <label htmlFor={`${id}-budget`}>{t('budget')}</label>
      <input id={`${id}-budget`} name="budget" required inputMode="decimal" defaultValue={d?.budget ?? '0'} autoComplete="off" aria-describedby={`${id}-budget-help`}/>
      <p id={`${id}-budget-help`} className={styles.meta}>{t('budgetHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t(campaign ? 'submitUpdate' : 'submitCreate')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button></div>
  </form>;
}

/** Fixed, honest ad account status. Nothing here contacts Google or Meta. */
function AdAccounts({ language }: { language: string }): React.ReactElement {
  const t = (key: MarketingKey) => marketingText(language, key);
  return <section aria-labelledby="hq-mk-ads" data-marketing-ad-accounts="">
    <h2 id="hq-mk-ads">{t('adAccounts')}</h2>
    <ul className={styles.list}>{HQ_MARKETING_AD_ACCOUNTS.map(a => <li key={a.provider} className={styles.card} data-ad-account={a.provider}>
      <div className={styles.cardHead}><h3>{t(a.provider === 'GOOGLE_ADS' ? 'GOOGLE_ADS_ACCOUNT' : 'META_ADS_ACCOUNT')}</h3>
        <span className={styles.status} data-tone="blocked">{t('notConnected')}</span></div>
      <p className={styles.meta}>{t('noSpend')}</p></li>)}</ul>
    <p className={styles.meta}>{t('adAccountsHelp')}</p>
  </section>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqMarketingView(props: MarketingViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state, filter, form, locked } = props;
  const t = (key: MarketingKey, vars?: Record<string, string>) => marketingText(language, key, vars);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-marketing="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-marketing={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, s = v.summary, manage = v.viewer.canManage;
  const count = (f: HqMarketingListFilter | null) => f === null ? s.DRAFT + s.ACTIVE + s.PAUSED + s.ARCHIVED : f === 'OPEN' ? s.DRAFT + s.ACTIVE + s.PAUSED : s[f];
  return <section className={styles.access} data-hq-marketing="ready">{head}
    <p className={styles.meta}>{t('viewer', { name: v.viewer.displayName })}{manage ? '' : ` ${t('readOnly')}`}</p>
    <AdAccounts language={language}/>
    <h2>{t('summary')}</h2>
    <Facts rows={[[t('ACTIVE'), String(s.ACTIVE)], [t('DRAFT'), String(s.DRAFT)], [t('PAUSED'), String(s.PAUSED)],
      [t('plannedOpen'), formatUsd(formattingLocale, s.plannedBudgetOpenMinor)]]}/>
    <p className={styles.meta}>{t('plannedNote')}</p>
    <div className={styles.filters} role="group" aria-label={t('filterLabel')}>
      {FILTERS.map(f => <button key={f ?? 'ALL'} type="button" aria-pressed={filter === f} onClick={() => props.onFilter(f)}>
        {t(f === null ? 'filterALL' : f === 'OPEN' ? 'filterOPEN' : f)}<span>{count(f)}</span></button>)}
    </div>
    <Outcome language={language} outcome={props.outcome} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    {manage && (form?.mode === 'CREATE'
      ? <PlanForm language={language} campaign={null} locked={locked} onSubmit={props.onCreate} onCancel={() => props.onForm(null)}/>
      : <div className={styles.actions}><button type="button" className={styles.primary} disabled={locked} onClick={() => props.onForm({ mode: 'CREATE' })}>{t('newCampaign')}</button></div>)}
    {state.campaigns.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} aria-label={t('summary')}>
      {state.campaigns.map(c => <li key={c.campaignId} className={styles.card} data-marketing-campaign={c.campaignId}>
        <div className={styles.cardHead}><h3>{c.name}</h3>
          <span className={styles.status} data-tone="waiting">{t(channelKey(c.channel))}</span>
          <span className={styles.status} data-tone={statusTone(c.status)}>{t(c.status)}</span></div>
        <p className={styles.meta}>{c.goal}</p>
        <Facts rows={[[t('code'), c.code], [t('audience'), t(c.audience)], [t('offer'), c.offerLabel],
          [t('dates'), `${formatDate(formattingLocale, c.startsOn)} – ${formatDate(formattingLocale, c.endsOn)}`],
          [t('budget'), formatUsd(formattingLocale, c.plannedBudgetMinor)], [t('createdBy'), c.createdBy.displayName],
          [t('updated'), `${formatTime(formattingLocale, c.updatedAt)} UTC`], [t('version'), String(c.version)]]}/>
        {manage && (form?.mode === 'EDIT' && form.campaignId === c.campaignId
          ? <PlanForm language={language} campaign={c} locked={locked} onSubmit={(d) => props.onUpdate(c, d)} onCancel={() => props.onForm(null)}/>
          : c.status === 'ARCHIVED' ? <p className={styles.meta}>{t('archivedFinal')}</p>
          : <><div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onForm({ mode: 'EDIT', campaignId: c.campaignId })}>{t('edit')}</button>
              {HQ_MARKETING_TRANSITIONS[c.status].map(to => <button key={to} type="button" className={styles.secondary} disabled={locked}
                data-marketing-status={to} onClick={() => props.onStatus(c, to)}>{t(statusAction(c.status, to))}</button>)}
            </div>{c.status === 'DRAFT' && <p className={styles.meta}>{t('activateHelp')}</p>}</>)}
      </li>)}
    </ul>}
    {state.moreFailed && <p className={styles.meta} role="alert">{t('moreFailed')}</p>}
    {v.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={state.loadingMore} onClick={props.onMore}>{t('more')}</button></div>}
    <h2>{t('creativeTitle')}</h2>
    <p className={styles.meta}>{t('creativeNext')}</p>
    <div className={styles.actions}><a className={styles.secondary} href="/hq/marketing/creative" data-marketing-creative-link="">{t('creativeOpen')}</a></div>
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, v.asOf) })}</p>
  </section>;
}
