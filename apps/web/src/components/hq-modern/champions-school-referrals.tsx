'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import type { ChampionsRewardKind } from '@hon/contracts';
import { HqSchoolDirectoryAccessError, loadHqSchoolDirectory } from '../hq-school-directory-http';
import { HqChampionsDetailError, loadHqSchoolReferrals, type SchoolReferralSnapshot } from './champions-school-rewards-http';
import { ChampionsDetailNav, DetailState, Retrieved, rewardNames, useChampionsDetailRead, utc } from './champions-detail-shared';
import base from './hq-modern.module.css';
import styles from './champions-management.module.css';
import detail from './champions-school-rewards.module.css';

async function directoryRead() {
  // Reuse the unchanged minimized selector-free directory transport/validator. Its rows
  // grant no Champions authority; the selected statistics GET performs its own HQ checks.
  try { return await loadHqSchoolDirectory(); }
  catch (error) { throw new HqChampionsDetailError(error instanceof HqSchoolDirectoryAccessError
    ? error.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' : 'UNAVAILABLE'); }
}
const stateName = (value: string) => value.replaceAll('_', ' ').toLowerCase();

export function SchoolReferralResults({ data }: { data: SchoolReferralSnapshot }): React.ReactElement {
  const { statistics: s, program } = data;
  const ms = s.milestones;
  const latest = ms.reached.at(-1);
  const policy = program.published;
  const ladder: { count: number; kind: ChampionsRewardKind; configured: number | null | undefined }[] = [
    { count: 5, kind: 'FREE_MONTHS', configured: policy?.firstFreeMonthsCount },
    { count: 10, kind: 'FREE_MONTHS', configured: policy?.secondFreeMonthsCount },
    { count: 20, kind: 'PRIZE', configured: policy?.prizeCount },
    { count: 30, kind: 'LIFETIME_MEMBERSHIP', configured: policy?.lifetimeCount },
  ];
  return <div className={styles.results} data-school-records={s.schoolId}>
    <section className={base.panel}><div className={base.sectionHeader}><h2 dir="auto">{s.schoolName}</h2><span className={base.badge}>Authorized HQ school details</span></div><p className={styles.note}>School identity: {s.schoolId} · Leaderboard display: {s.displayMode === 'ANONYMOUS' ? 'anonymous to other schools' : 'school name opted in'}. Names here are confidential to authorized HQ users.</p>
      <dl className={styles.states}>{(['qualified', 'pending', 'rejected', 'refunded', 'reversed'] as const).map((name) => <div key={name}><dt className={detail.capitalize}>{name} referrals</dt><dd data-referral-state={name}>{s.referrals[name].toLocaleString('en-US')}</dd></div>)}</dl>
      <dl className={styles.facts}><div><dt>Official all-time leaderboard rank</dt><dd>{s.allTimeRank === null ? 'Not ranked' : `#${s.allTimeRank.toLocaleString('en-US')}`}<small>Returned by Champions Club; ties share a rank. Exact tie-order position is not provided by this statistics contract.</small></dd></div><div><dt>Latest reported milestone</dt><dd>{latest ? `${latest.milestoneCount} referrals · ${rewardNames[latest.rewardKind]}` : 'None reported'}<small>Qualification progress is not an approved or fulfilled reward.</small></dd></div></dl>
    </section>
    <section className={base.panel} aria-labelledby="school-milestones-heading"><div className={base.sectionHeader}><h2 id="school-milestones-heading">Referral milestones</h2><span className={base.badge}>{policy ? `Reward policy v${policy.policyVersion}` : 'Policy undecided'}</span></div>
      <p className={styles.note}>Official qualified count: {ms.qualifiedReferrals.toLocaleString('en-US')}. Reached thresholds and next-step remaining counts come directly from the backend. They do not establish ledger awards.</p>
      <div className={detail.ladder}>{ladder.map(({ count, kind, configured }) => {
        const reached = ms.reached.some((item) => item.milestoneCount === count && item.rewardKind === kind);
        const next = ms.nextMilestone?.milestoneCount === count && ms.nextMilestone.rewardKind === kind ? ms.nextMilestone : null;
        return <section key={count}><h3>{count} referrals</h3><p>{rewardNames[kind]}</p><strong>{reached ? 'Reached · backend reported' : next ? `${next.remaining} remaining · backend reported` : configured === count ? 'Later threshold · remaining not provided' : 'Roadmap target · not configured at this threshold'}</strong></section>;
      })}</div>
      {ms.nextMilestone && <p className={styles.note} data-next-milestone>Next official milestone: {ms.nextMilestone.milestoneCount} referrals · {rewardNames[ms.nextMilestone.rewardKind]} · {ms.nextMilestone.remaining} remaining.</p>}
      {!ms.nextMilestone && <p className={styles.note}>No next milestone was reported. This does not establish fulfillment or a lifetime entitlement.</p>}
      <details className={detail.disclosure}><summary>All backend-reported reached thresholds</summary>{ms.reached.length ? <ul>{ms.reached.map((item, i) => <li key={`${item.rewardKind}:${item.milestoneCount}:${i}`}>{item.milestoneCount} referrals · {rewardNames[item.rewardKind]}</li>)}</ul> : <p>No reached thresholds were returned.</p>}</details>
    </section>
    {s.hold && <details className={`${base.panel} ${detail.disclosure}`}><summary>Confidential HQ leaderboard review</summary><p>Reason: {stateName(s.hold.reasonCode)} · placed {utc(s.hold.placedAt)}.</p><p className={styles.note}>A hold is a review state, not a finding of fraud. It does not itself reverse referrals or void rewards. No hold commands are available here.</p></details>}
    <section className={base.panel}><h2>Qualified referrals by month</h2><p className={styles.note}>The backend returns the last 12 UTC months, including the current month. These are not independently calculated rankings.</p><dl className={detail.months}>{s.monthlyQualified.map((item) => <div key={item.month}><dt>{item.month}</dt><dd>{item.qualified.toLocaleString('en-US')}</dd></div>)}</dl></section>
    <section className={base.panel}><h2>Referral history</h2><p className={styles.note}>Newest {s.historyLimit} state-transition events at most · not complete referral history. Several events may describe the same referral. Official totals above are independent aggregates.</p>
      {!s.history.length && <p>No referral history events were returned for this school.</p>}
      <ol className={detail.records}>{s.history.map((item, index) => <li key={`${item.attributionId}:${item.occurredAt}:${index}`}><div className={base.sectionHeader}><h3 dir="auto">{item.referredOrganizationName}</h3><span className={base.badge}>{stateName(item.toState)}</span></div><p>{item.fromState ? stateName(item.fromState) : 'New referral'} → {stateName(item.toState)} · {stateName(item.reason)}</p><p className={styles.note}>{utc(item.occurredAt)} · Referral {item.attributionId}</p></li>)}</ol>
    </section>
    <section className={base.panel}><h2>Complete school reward history unavailable</h2><p className={styles.note}>The current HQ ledger returns a limited global history. A separately authorized, paginated HQ per-school reward-history contract is being coordinated with the backend owner. No school reward records, earned amounts, approvals or fulfillment are inferred from that global window.</p><Link className={styles.link} href="/hq/growth/rewards">Review global reward accounting →</Link></section>
  </div>;
}

export function HqSchoolReferrals(): React.ReactElement {
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const directory = useChampionsDetailRead(`directory:${directoryRevision}`, directoryRead);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ schoolId: string; revision: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const schoolId = directory.kind === 'ready' && selected?.revision === directoryRevision
    && directory.data.schools.some((s) => s.schoolId === selected.schoolId) ? selected.schoolId : null;
  const load = useCallback((signal: AbortSignal) => loadHqSchoolReferrals(schoolId!, signal), [schoolId]);
  const state = useChampionsDetailRead(`${directoryRevision}:${schoolId}:${revision}`, schoolId ? load : null);
  const schools = directory.kind === 'ready' ? directory.data.schools.filter((s) => `${s.schoolDisplayName} ${s.organizationDisplayName}`.toLocaleLowerCase('en-US').includes(query.trim().toLocaleLowerCase('en-US'))) : [];
  return <div className={styles.management}>
    <section className={`${base.panel} ${styles.intro}`}><span className={base.badge}>Champions Club · HQ</span><h2>School referral details</h2><p>Choose a verified school identity to retrieve independently authorized referral records. Financial activation and fulfillment remain disabled.</p></section>
    <ChampionsDetailNav/>
    <section className={base.panel}><div className={styles.introHeading}><h2>Find a school</h2><button type="button" disabled={directory.kind === 'loading'} onClick={() => { setSelected(null); setQuery(''); setDirectoryRevision((r) => r + 1); }}>Refresh school directory</button></div>
      <DetailState state={directory}/>
      {directory.kind === 'ready' && <>
        <p className={styles.note}>Search only the returned authorized directory. Selection is not impersonation, school access or Champions Club authority. URL parameters never select a school.</p>
        {directory.data.schools.length === 0 ? <p role="status">No authorized school identities were returned.</p> : <div className={detail.selection}>
          <label>Search school or organization<input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setSelected(null); }} autoComplete="off"/></label>
          <div><label htmlFor="champions-school-selection">Choose school</label><select id="champions-school-selection" value={schoolId ?? ''} onChange={(e) => setSelected(e.target.value ? { schoolId: e.target.value, revision: directoryRevision } : null)}><option value="">Select a school…</option>{schools.map((s) => <option key={s.schoolId} value={s.schoolId}>{s.schoolDisplayName} — {s.organizationDisplayName}</option>)}</select></div>
          {!schools.length && <p role="status">No matching schools in the returned directory.</p>}
        </div>}
      </>}
    </section>
    {schoolId && <button className={detail.refresh} type="button" disabled={state.kind === 'loading'} onClick={() => setRevision((r) => r + 1)}>Refresh school referrals</button>}
    <div aria-live="polite" aria-busy={state.kind === 'loading'} className={styles.results}><DetailState state={state}/>{state.kind === 'ready' && <><Retrieved at={state.retrievedAt}/><SchoolReferralResults data={state.data}/></>}{state.kind === 'idle' && directory.kind === 'ready' && <p className={styles.note}>Select a school to load its referral statistics. No school is selected automatically.</p>}</div>
  </div>;
}
