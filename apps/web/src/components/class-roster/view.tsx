import React from 'react';
import type { ClassSessionRosterEntry, ClassSessionRosterSession, CurrentSchoolClassSession } from '@hon/contracts';
import { classBookingHandoffHref } from '../class-sessions-read';
import { rosterText, type RosterKey } from './copy';
import { rosterCounts, type RosterScope } from './http';
import styles from './class-roster.module.css';

type T = (key: RosterKey, vars?: Record<string, string>) => string;
export const SESSION_TABS = ['UPCOMING', 'PAST'] as const;
export type SessionTab = typeof SESSION_TABS[number];
export type SessionListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly CurrentSchoolClassSession[] };
export type RosterState = { state: 'NONE' | 'LOADING' | 'DENIED' | 'MISSING' | 'UNAVAILABLE' }
  | { state: 'READY'; sessionId: string; session: ClassSessionRosterSession; entries: readonly ClassSessionRosterEntry[]; nextCursor: string | null; more: 'IDLE' | 'LOADING' | 'FAILED'; restarted: boolean };
export type RosterViewProps = Readonly<{
  language: string; timeZone: string; waiting: boolean; concealed: boolean; scope: RosterScope | null; now: number;
  tab: SessionTab; list: SessionListState; selectedId: string | null; roster: RosterState;
  onTab?: ((tab: SessionTab) => void) | undefined; onOpen?: ((id: string) => void) | undefined; onRefresh?: (() => void) | undefined;
  onMore?: (() => void) | undefined; onReloadRoster?: (() => void) | undefined;
}>;
/** Local, display-only split of the sessions already read: upcoming (not yet ended) soonest first, past most recent first. */
export function sessionsFor(items: readonly CurrentSchoolClassSession[], tab: SessionTab, now: number): readonly CurrentSchoolClassSession[] {
  const upcoming = tab === 'UPCOMING';
  return items.filter((s) => (Date.parse(s.endsAt) >= now) === upcoming)
    .slice().sort((a, b) => (upcoming ? 1 : -1) * (a.startsAt.localeCompare(b.startsAt) || a.sessionId.localeCompare(b.sessionId)));
}
const fmt = (language: string, timeZone: string, value: string, options: Intl.DateTimeFormatOptions) => new Date(value).toLocaleString(language, { ...options, timeZone });
const when = (t: T, language: string, timeZone: string, startsAt: string, endsAt: string) => t('when', { day: fmt(language, timeZone, startsAt, { dateStyle: 'medium' }),
  from: fmt(language, timeZone, startsAt, { timeStyle: 'short' }), to: fmt(language, timeZone, endsAt, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) });

/** Pure view. Every class and roster row comes from the school's reads; nothing shows before the shell verifies the school. */
export function RosterView(props: RosterViewProps): React.ReactElement {
  const { language, waiting, concealed, scope, tab, list, now, onTab, onRefresh } = props;
  const t: T = (key, vars) => rosterText(language, key, vars);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !scope ? t('noSchool') : null;
  return <section className={styles.roster} aria-labelledby="roster-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="roster-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={list.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {notice === null ? <>
      <nav className={styles.tabs} aria-label={t('tabsLabel')}>{SESSION_TABS.map((value) =>
        <button key={value} type="button" className={styles.tab} aria-pressed={tab === value} onClick={() => onTab?.(value)}>{t(value)}</button>)}</nav>
      <div className={styles.layout}>
        <article className={styles.card} aria-labelledby="session-list-title">
          <div className={styles.cardHead}><h2 id="session-list-title">{t('listTitle')}</h2>
            {list.state === 'READY' ? <span className={styles.meta}>{t('shown', { n: String(sessionsFor(list.items, tab, now).length) })}</span> : null}</div>
          <SessionList {...props} t={t}/>
          <p className={styles.meta}>{t('listWindow')}</p>
        </article>
        <div className={styles.detail}><RosterDetail {...props} t={t}/></div>
      </div>
      <p className={styles.meta}>{t('readOnly')}</p>
    </> : null}
  </section>;
}

function SessionList({ list, tab, now, selectedId, onOpen, language, timeZone, t }: RosterViewProps & { t: T }): React.ReactElement {
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('listLoading')}</p>;
  if (list.state === 'DENIED') return <p className={styles.meta} role="status">{t('listDenied')}</p>;
  if (list.state !== 'READY') return <p className={styles.meta} role="status">{t('listUnavailable')}</p>;
  const shown = sessionsFor(list.items, tab, now);
  if (!shown.length) return <p className={styles.meta}>{t('listNone')}</p>;
  return <ul className={styles.list} data-testid="session-list">{shown.map((s) => <li key={s.sessionId}>
    <button type="button" className={styles.session} aria-current={s.sessionId === selectedId ? 'true' : undefined} onClick={() => onOpen?.(s.sessionId)}>
      <span className={styles.sessionTop}><strong>{s.name}</strong><span className={styles.chip} data-status={s.status}>{t(s.status)}</span></span>
      <small>{when(t, language, timeZone, s.startsAt, s.endsAt)} · {s.roomName ?? t('noRoom')}</small>
    </button>
  </li>)}</ul>;
}

function RosterDetail({ list, selectedId, roster, scope, language, timeZone, onMore, onReloadRoster, t }: RosterViewProps & { t: T }) {
  const s = list.state === 'READY' ? list.items.find((item) => item.sessionId === selectedId) ?? null : null;
  if (!s || !scope) return <p className={styles.notice}>{t('pick')}</p>;
  const ready = roster.state === 'READY' && roster.sessionId === s.sessionId ? roster : null;
  const counts = ready ? rosterCounts(ready.entries) : null;
  const book = classBookingHandoffHref(scope, s.sessionId);
  const attendance = `/staff/attendance?${new URLSearchParams({ organizationId: scope.organizationId.toLowerCase(), schoolId: scope.schoolId.toLowerCase() })}`;
  return <>
    <article className={styles.card} aria-labelledby="session-detail-title" data-testid="session-detail">
      <div className={styles.cardHead}><h2 id="session-detail-title">{s.name}</h2><span className={styles.chip} data-status={s.status}>{t(s.status)}</span></div>
      <dl className={styles.facts}>
        <div><dt>{t('whenLabel')}</dt><dd>{when(t, language, timeZone, s.startsAt, s.endsAt)}</dd></div>
        <div><dt>{t('room')}</dt><dd>{s.roomName ?? t('noRoom')}</dd></div>
        <div><dt>{t('capacity')}</dt><dd>{new Intl.NumberFormat(language).format(s.capacity)}</dd></div>
      </dl>
    </article>
    <article className={styles.card} aria-labelledby="roster-list-title">
      <h2 id="roster-list-title">{t('rosterTitle')}</h2>
      {roster.state === 'LOADING' || roster.state === 'NONE' || (roster.state === 'READY' && !ready) ? <p className={styles.meta} role="status">{t('rosterLoading')}</p> : null}
      {roster.state === 'DENIED' ? <p className={styles.meta} role="status">{t('rosterDenied')}</p> : null}
      {roster.state === 'MISSING' ? <p className={styles.meta} role="status">{t('rosterMissing')}</p> : null}
      {roster.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('rosterUnavailable')}</p>
        {onReloadRoster ? <button type="button" className={styles.secondary} onClick={onReloadRoster}>{t('refresh')}</button> : null}</div> : null}
      {ready && counts ? <>
        {ready.restarted ? <p className={styles.notice} role="status">{t('rosterRestarted')}</p> : null}
        <dl className={styles.counts} data-testid="roster-counts">
          {([['booked', counts.booked], ['waitlisted', counts.waitlisted], ['cancelledCount', counts.cancelled], ['walkIns', counts.walkIns], ['recorded', counts.recorded]] as const).map(([k, n]) =>
            <div key={k}><dt>{t(k)}</dt><dd>{new Intl.NumberFormat(language).format(n)}</dd></div>)}
        </dl>
        {ready.nextCursor ? <p className={styles.meta}>{t('partial', { n: new Intl.NumberFormat(language).format(ready.entries.length) })}</p> : null}
        {ready.entries.length === 0 ? <p className={styles.meta}>{t('rosterNone')}</p> : <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="roster-table">
            <thead><tr><th scope="col">{t('student')}</th><th scope="col">{t('booking')}</th><th scope="col">{t('attendance')}</th></tr></thead>
            <tbody>{ready.entries.map((e) => <tr key={e.studentProfileId}>
              <th scope="row">{e.givenName} {e.familyName}</th>
              <td data-label={t('booking')}>{e.booking ? <>{t(e.booking.status)}<small>{t(e.booking.kind)}</small></> : t('walkIn')}</td>
              <td data-label={t('attendance')}>{e.attendance ? t(e.attendance.status) : t('notRecorded')}</td>
            </tr>)}</tbody>
          </table></div>}
        {ready.nextCursor ? <button type="button" className={styles.secondary} onClick={onMore} disabled={ready.more === 'LOADING'}>{ready.more === 'LOADING' ? t('moreLoading') : t('more')}</button> : null}
        {ready.more === 'FAILED' ? <p className={styles.meta} role="status">{t('rosterUnavailable')}</p> : null}
      </> : null}
    </article>
    <article className={styles.card} aria-labelledby="roster-next-title">
      <h2 id="roster-next-title">{t('nextSteps')}</h2>
      <ul className={styles.actions}>
        <li><a className={styles.primary} href={attendance}>{t('recordAttendance')}</a></li>
        {book && s.status !== 'CANCELLED' && s.status !== 'COMPLETED' ? <li><a className={styles.secondary} href={book}>{t('book')}</a></li> : null}
      </ul>
    </article>
  </>;
}
