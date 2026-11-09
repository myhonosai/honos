import React from 'react';
import { SCHOOL_MEMBERSHIP_LIST_STATES, type SchoolMembershipListItem } from '@hon/contracts';
import { membershipListText, type MembershipListKey } from './copy';
import { membershipCounts, type MembershipListFilter, type MembershipListScope } from './http';
import styles from './membership-list.module.css';

type T = (key: MembershipListKey, vars?: Record<string, string>) => string;
export const MEMBERSHIP_FILTERS: readonly MembershipListFilter[] = [null, ...SCHOOL_MEMBERSHIP_LIST_STATES];
export type MembershipListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'TIMEZONE' }
  | { state: 'READY'; filter: MembershipListFilter; items: readonly SchoolMembershipListItem[]; nextCursor: string | null; schoolTimezone: string; localToday: string;
    more: 'IDLE' | 'LOADING' | 'FAILED'; restarted: boolean };
export type MembershipListViewProps = Readonly<{
  language: string; timeZone: string; waiting: boolean; concealed: boolean; scope: MembershipListScope | null; filter: MembershipListFilter; list: MembershipListState;
  onFilter?: ((filter: MembershipListFilter) => void) | undefined; onRefresh?: (() => void) | undefined; onMore?: (() => void) | undefined;
}>;
// School-local calendar dates are shown as dates, never shifted by the viewer's time zone; instants are shown on the school's day.
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const instantDay = (language: string, timeZone: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium', timeZone });
const filterKey = (filter: MembershipListFilter) => `f_${filter ?? 'ALL'}` as MembershipListKey;

function Dates({ m, language, timeZone, t }: { m: SchoolMembershipListItem; language: string; timeZone: string; t: T }) {
  if (m.currentPeriod) {
    const from = day(language, m.currentPeriod.startDate);
    return <>{m.currentPeriod.endDate ? t('range', { from, to: day(language, m.currentPeriod.endDate) }) : t('openEnded', { from })}</>;
  }
  const started = m.legacyStoredTerm?.termStartedAt ?? null;
  return <>{t('notConfirmed')}{started ? <small>{t('storedHint', { date: instantDay(language, timeZone, started) })}</small> : null}</>;
}

/** Pure view. Every row comes from the school's membership read; nothing shows before the shell verifies the school. */
export function MembershipListView(props: MembershipListViewProps): React.ReactElement {
  const { language, waiting, concealed, scope, filter, list, onFilter, onRefresh, onMore } = props;
  const t: T = (key, vars) => membershipListText(language, key, vars);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !scope ? t('noSchool') : null;
  const ready = list.state === 'READY' && list.filter === filter ? list : null;
  const counts = ready ? membershipCounts(ready.items) : null;
  const n = (value: number) => new Intl.NumberFormat(language).format(value);
  return <section className={styles.memberships} aria-labelledby="membership-list-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="membership-list-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={list.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {notice === null ? <>
      <nav className={styles.tabs} aria-label={t('filterLabel')}>{MEMBERSHIP_FILTERS.map((value) =>
        <button key={value ?? 'ALL'} type="button" className={styles.tab} aria-pressed={filter === value} onClick={() => onFilter?.(value)}>{t(filterKey(value))}</button>)}</nav>
      <article className={styles.card} aria-labelledby="membership-table-title">
        <div className={styles.cardHead}><h2 id="membership-table-title">{t('listTitle')}</h2>
          {ready ? <span className={styles.meta}>{t('shown', { n: n(ready.items.length) })}</span> : null}</div>
        {list.state === 'LOADING' || (list.state === 'READY' && !ready) ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
        {list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('denied')}</p> : null}
        {list.state === 'TIMEZONE' ? <p className={styles.notice} role="status">{t('timezone')}</p> : null}
        {list.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('unavailable')}</p>
          {onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh}>{t('refresh')}</button> : null}</div> : null}
        {ready && counts ? <>
          {ready.restarted ? <p className={styles.notice} role="status">{t('restarted')}</p> : null}
          <p className={styles.meta}>{t('schoolTime', { zone: ready.schoolTimezone, today: day(language, ready.localToday) })}</p>
          {filter === null ? <dl className={styles.counts} data-testid="membership-counts">
            {([['c_inEffect', counts.inEffect], ['c_scheduled', counts.scheduled], ['c_undated', counts.undated], ['c_draft', counts.draft], ['c_other', counts.other]] as const).map(([k, v]) =>
              <div key={k}><dt>{t(k)}</dt><dd>{n(v)}</dd></div>)}
          </dl> : null}
          {ready.nextCursor ? <p className={styles.meta}>{t('partial', { n: n(ready.items.length) })}</p> : null}
          {ready.items.length === 0 ? <p className={styles.meta}>{filter === null ? t('none') : t('noneFiltered')}</p> : <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="membership-table">
              <thead><tr><th scope="col">{t('member')}</th><th scope="col">{t('plan')}</th><th scope="col">{t('status')}</th><th scope="col">{t('dates')}</th><th scope="col">{t('created')}</th></tr></thead>
              <tbody>{ready.items.map((m) => <tr key={m.membershipId}>
                <th scope="row">{m.participant ? `${m.participant.givenName} ${m.participant.familyName}`.trim() || t('notVisible') : t('notVisible')}</th>
                <td data-label={t('plan')}>{m.planCode}</td>
                <td data-label={t('status')}><span className={styles.chip} data-status={m.effectiveStatus}>{t(m.effectiveStatus)}</span></td>
                <td data-label={t('dates')}><Dates m={m} language={language} timeZone={ready.schoolTimezone} t={t}/></td>
                <td data-label={t('created')}>{instantDay(language, ready.schoolTimezone, m.createdAt)}</td>
              </tr>)}</tbody>
            </table></div>}
          {ready.nextCursor ? <button type="button" className={styles.secondary} onClick={onMore} disabled={ready.more === 'LOADING'}>{ready.more === 'LOADING' ? t('moreLoading') : t('more')}</button> : null}
          {ready.more === 'FAILED' ? <p className={styles.meta} role="status">{t('unavailable')}</p> : null}
        </> : null}
      </article>
      <article className={styles.card} aria-labelledby="membership-next-title">
        <h2 id="membership-next-title">{t('nextSteps')}</h2>
        <ul className={styles.actions}>
          <li><a className={styles.primary} href="/staff/billing/memberships">{t('activate')}</a></li>
          <li><a className={styles.secondary} href="/staff/billing/membership-dates">{t('confirmDates')}</a></li>
          <li><a className={styles.secondary} href="/staff/billing/membership-changes">{t('changes')}</a></li>
        </ul>
      </article>
      <p className={styles.meta}>{t('readOnly')}</p>
    </> : null}
  </section>;
}
