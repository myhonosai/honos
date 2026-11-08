import React, { useId } from 'react';
import type { CrmAppointmentSummary, LeadListItem } from '@hon/contracts';
import type { CrmLeadStatus } from '../crm-leads-http';
import { crmFollowUpHref } from '../crm-follow-up-handoff';
import { leadMembershipHref, leadWorkflowHref } from '../crm-lead-memberships-http';
import type { TrialRecovery } from '../crm-journey/trial-recovery-http';
import { leadsText, type LeadsKey } from './copy';
import { LEADS_LIST_LIMIT, type LeadsScope } from './http';
import styles from './leads.module.css';

type T = (key: LeadsKey, vars?: Record<string, string>) => string;
export const LEAD_TABS = ['OPEN', 'WON', 'LOST', 'ARCHIVED', 'ALL'] as const;
export type LeadTab = typeof LEAD_TABS[number];
export const tabStatus = (tab: LeadTab): CrmLeadStatus | null => tab === 'ALL' ? null : tab;
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; tab: LeadTab; items: readonly LeadListItem[] };
export type TrialState = { state: 'NONE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; leadId: string; recovery: TrialRecovery };
export type LeadsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; scope: LeadsScope | null;
  tab: LeadTab; list: ListState; filter: string; selectedId: string | null; trials: TrialState;
  onTab?: ((tab: LeadTab) => void) | undefined; onFilter?: ((value: string) => void) | undefined; onOpen?: ((leadId: string) => void) | undefined;
  onRefresh?: (() => void) | undefined; onReloadTrials?: (() => void) | undefined;
}>;

const when = (language: string, value: string, time = true) => new Date(value).toLocaleString(language, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
/** Local, display-only narrowing of the leads already read; it never reads anything else. */
export function filterLeads(items: readonly LeadListItem[], filter: string): readonly LeadListItem[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((lead) => `${lead.givenName} ${lead.familyName}`.toLowerCase().includes(needle) || (lead.email ?? '').toLowerCase().includes(needle));
}

/** Pure view. Every name, contact and trial comes from the school's CRM reads; nothing shows before the shell verifies the school. */
export function LeadsView(props: LeadsViewProps): React.ReactElement {
  const { language, waiting, concealed, scope, tab, list, filter, onTab, onFilter, onRefresh } = props;
  const t: T = (key, vars) => leadsText(language, key, vars);
  const filterId = useId();
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !scope ? t('noSchool') : null;
  return <section className={styles.leads} aria-labelledby="leads-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="leads-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={list.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {notice === null && scope ? <>
      <nav className={styles.tabs} aria-label={t('tabsLabel')}>{LEAD_TABS.map((value) =>
        <button key={value} type="button" className={styles.tab} aria-pressed={tab === value} onClick={() => onTab?.(value)}>{t(value)}</button>)}</nav>
      <div className={styles.layout}>
        <article className={styles.card} aria-labelledby="leads-list-title">
          <div className={styles.cardHead}><h2 id="leads-list-title">{t('listTitle')}</h2>
            {list.state === 'READY' ? <span className={styles.meta}>{t('shown', { n: String(filterLeads(list.items, filter).length) })}</span> : null}</div>
          <div className={styles.filter}>
            <label htmlFor={filterId}>{t('filterLabel')}</label>
            <input id={filterId} type="search" maxLength={120} autoComplete="off" value={filter} disabled={list.state !== 'READY'} onChange={(e) => onFilter?.(e.target.value)}/>
          </div>
          <LeadList {...props} t={t}/>
        </article>
        <div className={styles.detail}><LeadDetail {...props} scope={scope} t={t}/></div>
      </div>
      <p className={styles.meta}>{t('readOnly')}</p>
    </> : null}
  </section>;
}

function LeadList({ list, filter, selectedId, onOpen, language, t }: LeadsViewProps & { t: T }): React.ReactElement {
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('listLoading')}</p>;
  if (list.state === 'DENIED') return <p className={styles.meta} role="status">{t('listDenied')}</p>;
  if (list.state !== 'READY') return <p className={styles.meta} role="status">{t('listUnavailable')}</p>;
  if (!list.items.length) return <p className={styles.meta}>{t('listNone')}</p>;
  const shown = filterLeads(list.items, filter);
  return <>
    {shown.length === 0 ? <p className={styles.meta}>{t('filterNone')}</p> : <ul className={styles.list} data-testid="leads-list">{shown.map((lead) => <li key={lead.id}>
      <button type="button" className={styles.lead} aria-current={lead.id === selectedId ? 'true' : undefined} onClick={() => onOpen?.(lead.id)}>
        <span className={styles.leadTop}><strong>{lead.givenName} {lead.familyName}</strong><span className={styles.chip} data-status={lead.status}>{t(lead.status)}</span></span>
        <small>{lead.nextFollowUpAt ? t('nextFollowUp', { date: when(language, lead.nextFollowUpAt) }) : t('noFollowUp')} · {t('added', { date: when(language, lead.createdAt, false) })}</small>
      </button>
    </li>)}</ul>}
    {list.items.length >= LEADS_LIST_LIMIT ? <p className={styles.meta}>{t('listCapped', { n: String(LEADS_LIST_LIMIT) })}</p> : null}
  </>;
}

function Trial({ trial, language, t }: { trial: CrmAppointmentSummary; language: string; t: T }) {
  return <li className={styles.trial}><span>{when(language, trial.startsAt)}{trial.location ? ` · ${trial.location}` : ''}</span><span className={styles.chip} data-status={trial.status}>{t(trial.status)}</span></li>;
}

function LeadDetail({ list, selectedId, trials, scope, language, onReloadTrials, t }: LeadsViewProps & { scope: LeadsScope; t: T }) {
  const lead = list.state === 'READY' ? list.items.find((item) => item.id === selectedId) ?? null : null;
  if (!lead) return <p className={styles.notice}>{t('pick')}</p>;
  const selectors = { organizationId: scope.organizationId, schoolId: scope.schoolId, leadId: lead.id };
  const followUp = lead.status === 'OPEN' ? crmFollowUpHref(lead.id) : undefined;
  return <>
    <article className={styles.card} aria-labelledby="lead-detail-title" data-testid="lead-detail">
      <div className={styles.cardHead}><h2 id="lead-detail-title">{lead.givenName} {lead.familyName}</h2><span className={styles.chip} data-status={lead.status}>{t(lead.status)}</span></div>
      <dl className={styles.facts}>
        <div><dt>{t('email')}</dt><dd>{lead.email ?? t('notRecorded')}</dd></div>
        <div><dt>{t('phone')}</dt><dd>{lead.phoneE164 ?? t('notRecorded')}</dd></div>
        <div><dt>{t('followUpLabel')}</dt><dd>{lead.nextFollowUpAt ? when(language, lead.nextFollowUpAt) : t('noFollowUp')}</dd></div>
        <div><dt>{t('addedLabel')}</dt><dd>{when(language, lead.createdAt, false)}</dd></div>
      </dl>
    </article>
    <article className={styles.card} aria-labelledby="lead-trials-title">
      <h2 id="lead-trials-title">{t('trialsTitle')}</h2>
      {trials.state === 'LOADING' || trials.state === 'NONE' ? <p className={styles.meta} role="status">{t('trialsLoading')}</p> : null}
      {trials.state === 'DENIED' ? <p className={styles.meta} role="status">{t('trialsDenied')}</p> : null}
      {trials.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('trialsUnavailable')}</p>
        {onReloadTrials ? <button type="button" className={styles.secondary} onClick={onReloadTrials}>{t('reload')}</button> : null}</div> : null}
      {trials.state === 'READY' && trials.leadId === lead.id ? <>
        {trials.recovery.activeTrial ? <p className={styles.upcoming} data-testid="upcoming-trial"><strong>{t('upcoming')}</strong> {when(language, trials.recovery.activeTrial.startsAt)}{trials.recovery.activeTrial.location ? ` · ${trials.recovery.activeTrial.location}` : ''}</p> : null}
        {trials.recovery.trials.length === 0 ? <p className={styles.meta}>{t('trialsNone')}</p>
          : <ul className={styles.trials}>{trials.recovery.trials.map((trial) => <Trial key={trial.id} trial={trial} language={language} t={t}/>)}</ul>}
        {trials.recovery.trials.length >= 50 ? <p className={styles.meta}>{t('moreTrials', { n: '50' })}</p> : null}
      </> : null}
    </article>
    <article className={styles.card} aria-labelledby="lead-next-title">
      <h2 id="lead-next-title">{t('nextSteps')}</h2>
      <ul className={styles.actions}>
        {lead.status !== 'ARCHIVED' ? <li><a className={styles.primary} href={leadWorkflowHref(selectors)}>{t('journey')}</a><span className={styles.meta}>{t('journeyHelp')}</span></li> : null}
        {followUp ? <li><a className={styles.secondary} href={followUp}>{t('followUp')}</a></li> : null}
        <li><a className={styles.secondary} href={leadMembershipHref(selectors)}>{t('membership')}</a></li>
      </ul>
    </article>
  </>;
}
