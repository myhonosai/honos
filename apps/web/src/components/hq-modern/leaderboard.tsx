'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ChampionsHqLeaderboard } from '@hon/contracts';
import { HqChampionsReadError, loadHqChampionsLeaderboard, type ChampionsReadFailure, type LeaderboardSelection } from './champions-http';
import { HQ_GROWTH } from './catalog';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

type ReadState = { key: string; kind: 'loading' }
  | { key: string; kind: 'ready'; board: ChampionsHqLeaderboard; retrievedAt: string }
  | { key: string; kind: 'failed'; failure: ChampionsReadFailure };

const failures: Record<ChampionsReadFailure, { title: string; detail: string }> = {
  UNAUTHORIZED: { title: 'Sign in to view referral standings', detail: 'A current authenticated HQ session is required. No standings or confidential reviews are displayed.' },
  FORBIDDEN: { title: 'Champions Club access denied', detail: 'This account does not have the required Champions Club HQ authority. School and family access cannot grant it.' },
  INVALID_FILTER: { title: 'This month could not be requested', detail: 'Choose a UTC calendar month from January 2026 through the current month. No empty result is assumed.' },
  UNAVAILABLE: { title: 'Referral standings unavailable', detail: 'The authorized service could not be reached. Refresh to check again; no cached or sample standings are displayed.' },
  INVALID_RESPONSE: { title: 'Referral standings could not be verified', detail: 'The response did not match the official ranking contract and selected period. No standings or confidential reviews are displayed.' },
};

/** Render the backend order, ranks and counts unchanged; never sort or derive official standings here. */
export function LeaderboardResults({ board }: { board: ChampionsHqLeaderboard }): React.ReactElement {
  return <>
    <div className={styles.leaderboardSummary}>
      <div><span>Ranked schools</span><strong>{board.totalRanked.toLocaleString()}</strong><small>Showing {board.standings.length} of {board.totalRanked} · maximum {board.limit}</small></div>
      <div><span>Qualification basis</span><strong>Qualified only</strong><small>{board.period === 'MONTH' ? `${board.month} · UTC qualification month` : 'All-time qualified referrals'}</small></div>
    </div>
    <section className={`${styles.panel} ${styles.leaderboardPanel}`} aria-labelledby="hq-standings-heading">
      <div className={styles.sectionHeader}><h2 id="hq-standings-heading">{board.period === 'MONTH' ? `Monthly standings · ${board.month}` : 'All-time standings'}</h2><span className={styles.badge}>Official · UTC</span></div>
      {board.standings.length === 0 ? <p className={styles.leaderboardEmpty} role="status">No ranked schools for this period. Only eligible schools with qualified referrals appear.</p>
        : <table className={styles.leaderboardTable}>
          <caption>Official referral standings. Ties share rank; position preserves the service order. Pending counts are all-time and do not contribute to rank.</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">School / organization</th><th scope="col">Qualified</th><th scope="col">Pending · all time</th><th scope="col">Position</th></tr></thead>
          <tbody>{board.standings.map((row) => <tr key={row.schoolId}>
            <th scope="row"><span className={styles.rowLabel}>Rank </span>{row.rank}</th>
            <td className={styles.standingSchool}><strong dir="auto">{row.schoolName}</strong><span dir="auto">{row.organizationName}</span><small>{row.displayMode === 'ANONYMOUS' ? 'Anonymous in school standings' : 'School-name display opted in'}</small></td>
            <td><span className={styles.rowLabel}>Qualified </span>{row.qualifiedReferrals.toLocaleString()}</td>
            <td><span className={styles.rowLabel}>Pending · all time </span>{row.pendingReferrals.toLocaleString()}</td>
            <td><span className={styles.rowLabel}>Position </span>{row.position}</td>
          </tr>)}</tbody>
        </table>}
    </section>
    <details className={`${styles.panel} ${styles.confidentialHolds}`}>
      <summary><HqIcon name="shield" size={18}/><span>Confidential HQ reviews</span><span className={styles.badge}>{board.held.length} held</span></summary>
      <p>Restricted HQ information. Held schools are excluded from every ranking. These qualified totals are all-time, including when monthly standings are selected. A hold is a review state, not a finding of fraud.</p>
      {board.held.length === 0 ? <p>No active leaderboard holds were returned.</p> : <ul>{board.held.map((hold) => <li key={hold.schoolId}>
        <strong dir="auto">{hold.schoolName}</strong><span>{hold.reasonCode.replaceAll('_', ' ')}</span><span>{hold.qualifiedReferrals.toLocaleString()} qualified · all time</span><small>Placed {new Date(hold.placedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</small>
      </li>)}</ul>}
    </details>
  </>;
}

export function HqChampionsLeaderboard(): React.ReactElement {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState<'ALL_TIME' | 'MONTH'>('ALL_TIME');
  const [month, setMonth] = useState(currentMonth);
  const [revision, setRevision] = useState(0);
  const key = `${period}:${period === 'MONTH' ? month : ''}:${revision}`;
  const [state, setState] = useState<ReadState>({ key: '', kind: 'loading' });
  // A changed filter hides previous facts during render, before the next effect runs.
  const visible: ReadState = state.key === key ? state : { key, kind: 'loading' };
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const selection: LeaderboardSelection = period === 'ALL_TIME' ? { period } : { period, month };
    setState({ key, kind: 'loading' });
    loadHqChampionsLeaderboard(selection, controller.signal).then(
      (board) => { if (current) setState({ key, kind: 'ready', board, retrievedAt: new Date().toISOString() }); },
      (error: unknown) => { if (current) setState({ key, kind: 'failed', failure: error instanceof HqChampionsReadError ? error.kind : 'UNAVAILABLE' }); },
    );
    return () => { current = false; controller.abort(); };
  }, [key, period, month]);
  const months: string[] = [];
  for (let year = 2026; year <= Number(currentMonth.slice(0, 4)); year++) {
    for (let value = 1; value <= 12; value++) {
      const candidate = `${year}-${String(value).padStart(2, '0')}`;
      if (candidate <= currentMonth) months.unshift(candidate);
    }
  }
  return <div className={styles.leaderboard}>
    <section className={`${styles.panel} ${styles.moduleIntro}`}><span className={styles.badge}>Champions Club · HQ</span><h2>Referral leaderboard</h2><p>Official qualified-referral standings from Champions Club. Pending, rejected, refunded, reversed and held referrals do not determine rankings.</p></section>
    <nav className={styles.moduleLinks} aria-label="Growth modules">{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path} aria-current={item.path === '/hq/growth/leaderboard' ? 'page' : undefined}>{item.title}</Link>)}</nav>
    <section className={`${styles.panel} ${styles.leaderboardFilters}`} aria-label="Leaderboard filters">
      <div role="group" aria-label="Ranking period"><button type="button" aria-pressed={period === 'ALL_TIME'} onClick={() => setPeriod('ALL_TIME')}>All time</button><button type="button" aria-pressed={period === 'MONTH'} onClick={() => setPeriod('MONTH')}>Monthly</button></div>
      <label>UTC month<select aria-label="UTC ranking month" disabled={period !== 'MONTH'} value={month} onChange={(event) => setMonth(event.target.value)}>{months.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <button type="button" disabled={visible.kind === 'loading'} onClick={() => setRevision((value) => value + 1)}>Refresh standings</button>
    </section>
    <div aria-busy={visible.kind === 'loading'} aria-live="polite">
      {visible.kind === 'loading' && <section className={`${styles.panel} ${styles.leaderboardEmpty}`}><h2>Loading authorized standings…</h2><p role="status">Verifying this period with the Champions Club service. Previous results are cleared.</p></section>}
      {visible.kind === 'ready' && <><p className={styles.leaderboardRetrieved} role="status">Retrieved {new Date(visible.retrievedAt).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC · refresh to recheck current records.</p><LeaderboardResults key={key} board={visible.board}/></>}
      {visible.kind === 'failed' && <section className={`${styles.panel} ${styles.leaderboardEmpty}`}><h2>{failures[visible.failure].title}</h2><p role="status">{failures[visible.failure].detail}</p>{visible.failure === 'UNAUTHORIZED' && <Link href="/auth/login" className={styles.primary}>Sign in to HON</Link>}</section>}
    </div>
    <p className={styles.finePrint}>Identities and confidential reviews come only from the independently authorized HQ API. Contest standings are unavailable here; no contest, reward issuance or payment is activated.</p>
  </div>;
}
