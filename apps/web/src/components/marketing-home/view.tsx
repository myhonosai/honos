import React from 'react';
import type { CampaignFunnel, CampaignStatus, CampaignSummary } from '@hon/contracts';
import { marketingText, type MarketingKey } from './copy';
import styles from './marketing-home.module.css';

type T = (key: MarketingKey, vars?: Record<string, string>) => string;
export const CAMPAIGN_TABS = ['ACTIVE', 'DRAFT', 'PAUSED', 'ARCHIVED', 'ALL'] as const;
export type CampaignTab = typeof CAMPAIGN_TABS[number];
export type CampaignListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly CampaignSummary[] };
export type FunnelState = { state: 'NONE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; campaignId: string; funnel: CampaignFunnel };
export type MarketingViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  tab: CampaignTab; list: CampaignListState; selectedId: string | null; funnel: FunnelState;
  onTab?: ((tab: CampaignTab) => void) | undefined; onOpen?: ((id: string) => void) | undefined;
  onRefresh?: (() => void) | undefined; onReloadFunnel?: (() => void) | undefined;
}>;
const ORDER: Record<CampaignStatus, number> = { ACTIVE: 0, DRAFT: 1, PAUSED: 2, ARCHIVED: 3 };
/** Local, display-only narrowing of the campaigns already read; it never reads anything else. */
export function campaignsFor(items: readonly CampaignSummary[], tab: CampaignTab): readonly CampaignSummary[] {
  return items.filter((c) => tab === 'ALL' || c.status === tab)
    .slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startsAt.localeCompare(a.startsAt) || a.id.localeCompare(b.id));
}
const day = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const money = (language: string, minor: number, currency: string) => {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(language, { style: 'currency', currency }).format(minor / 10 ** digits);
};

/** Pure view. Every plan and count comes from the school's campaign reads; nothing shows before the shell verifies the school. */
export function MarketingView(props: MarketingViewProps): React.ReactElement {
  const { language, waiting, concealed, hasSchool, tab, list, onTab, onRefresh } = props;
  const t: T = (key, vars) => marketingText(language, key, vars);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !hasSchool ? t('noSchool') : null;
  return <section className={styles.marketing} aria-labelledby="marketing-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="marketing-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={list.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {notice === null ? <>
      <nav className={styles.tabs} aria-label={t('tabsLabel')}>{CAMPAIGN_TABS.map((value) =>
        <button key={value} type="button" className={styles.tab} aria-pressed={tab === value} onClick={() => onTab?.(value)}>{t(value)}</button>)}</nav>
      <div className={styles.layout}>
        <article className={styles.card} aria-labelledby="campaign-list-title">
          <div className={styles.cardHead}><h2 id="campaign-list-title">{t('listTitle')}</h2>
            {list.state === 'READY' ? <span className={styles.meta}>{t('shown', { n: String(campaignsFor(list.items, tab).length) })}</span> : null}</div>
          <CampaignList {...props} t={t}/>
        </article>
        <div className={styles.detail}><CampaignDetail {...props} t={t}/></div>
      </div>
      <p className={styles.meta}>{t('readOnly')}</p>
    </> : null}
  </section>;
}

function CampaignList({ list, tab, selectedId, onOpen, language, t }: MarketingViewProps & { t: T }): React.ReactElement {
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('listLoading')}</p>;
  if (list.state === 'DENIED') return <p className={styles.meta} role="status">{t('listDenied')}</p>;
  if (list.state !== 'READY') return <p className={styles.meta} role="status">{t('listUnavailable')}</p>;
  const shown = campaignsFor(list.items, tab);
  if (!shown.length) return <p className={styles.meta}>{t('listNone')}</p>;
  return <ul className={styles.list} data-testid="campaign-list">{shown.map((c) => <li key={c.id}>
    <button type="button" className={styles.campaign} aria-current={c.id === selectedId ? 'true' : undefined} onClick={() => onOpen?.(c.id)}>
      <span className={styles.campaignTop}><strong>{c.name}</strong><span className={styles.chip} data-status={c.status}>{t(c.status)}</span></span>
      <small>{t(c.channel)} · {t('window', { from: day(language, c.startsAt), to: day(language, c.endsAt) })}</small>
    </button>
  </li>)}</ul>;
}

function CampaignDetail({ list, selectedId, funnel, language, onReloadFunnel, t }: MarketingViewProps & { t: T }) {
  const c = list.state === 'READY' ? list.items.find((item) => item.id === selectedId) ?? null : null;
  if (!c) return <p className={styles.notice}>{t('pick')}</p>;
  const counts = funnel.state === 'READY' && funnel.campaignId === c.id ? funnel.funnel : null;
  return <>
    <article className={styles.card} aria-labelledby="campaign-detail-title" data-testid="campaign-detail">
      <div className={styles.cardHead}><h2 id="campaign-detail-title">{c.name}</h2><span className={styles.chip} data-status={c.status}>{t(c.status)}</span></div>
      <p className={styles.meta}>{c.goal}</p>
      <dl className={styles.facts}>
        <div><dt>{t('dates')}</dt><dd>{t('window', { from: day(language, c.startsAt), to: day(language, c.endsAt) })}</dd></div>
        <div><dt>{t('channel')}</dt><dd>{t(c.channel)}</dd></div>
        <div><dt>{t('budget')}</dt><dd>{money(language, c.plannedBudgetMinor, c.currency)} <small className={styles.meta}>({t('budgetNote')})</small></dd></div>
        <div><dt>{t('offer')}</dt><dd>{c.offerLabel || t('offerNone')}</dd></div>
        <div><dt>{t('code')}</dt><dd>{c.code}</dd></div>
      </dl>
    </article>
    <article className={styles.card} aria-labelledby="campaign-funnel-title">
      <h2 id="campaign-funnel-title">{t('funnelTitle')}</h2>
      {funnel.state === 'LOADING' || funnel.state === 'NONE' || (funnel.state === 'READY' && !counts) ? <p className={styles.meta} role="status">{t('funnelLoading')}</p> : null}
      {funnel.state === 'DENIED' ? <p className={styles.meta} role="status">{t('funnelDenied')}</p> : null}
      {funnel.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('funnelUnavailable')}</p>
        {onReloadFunnel ? <button type="button" className={styles.secondary} onClick={onReloadFunnel}>{t('reload')}</button> : null}</div> : null}
      {counts ? <>
        <dl className={styles.counts} data-testid="campaign-funnel">
          {(['leads', 'trialLeads', 'completedTrialAppointments', 'wonLeads'] as const).map((k) =>
            <div key={k}><dt>{t(k)}</dt><dd>{new Intl.NumberFormat(language).format(counts[k])}</dd></div>)}
        </dl>
        <p className={styles.meta}>{t('funnelNote')}</p>
      </> : null}
    </article>
    <article className={styles.card} aria-labelledby="campaign-next-title">
      <h2 id="campaign-next-title">{t('nextSteps')}</h2>
      <ul className={styles.actions}>
        <li><a className={styles.primary} href="/staff/marketing/campaigns">{t('edit')}</a></li>
        {c.status !== 'ARCHIVED' ? <li><a className={styles.secondary} href="/staff/marketing/assistant">{t('marcus')}</a><span className={styles.meta}>{t('marcusHelp')}</span></li> : null}
        <li><a className={styles.secondary} href="/staff/marketing/forms">{t('forms')}</a></li>
        <li><a className={styles.secondary} href="/staff/marketing/intake">{t('intake')}</a></li>
      </ul>
    </article>
  </>;
}
