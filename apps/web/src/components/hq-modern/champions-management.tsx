'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { HQ_GROWTH } from './catalog';
import {
  HqChampionsManagementError, loadHqChampionsManagement,
  type ChampionsManagementFailure, type ChampionsManagementSnapshot,
} from './champions-management-http';
import base from './hq-modern.module.css';
import styles from './champions-management.module.css';

type ReadState = { key: string; kind: 'loading' }
  | { key: string; kind: 'ready'; data: ChampionsManagementSnapshot; retrievedAt: string }
  | { key: string; kind: 'failed'; failure: ChampionsManagementFailure };

const failures: Record<ChampionsManagementFailure, { title: string; detail: string }> = {
  UNAUTHORIZED: { title: 'Sign in to view Champions Club', detail: 'Please sign in again to see referrals and rewards.' },
  FORBIDDEN: { title: 'Champions Club access denied', detail: 'Your HQ role can’t see Champions Club. Ask the HQ owner for access.' },
  UNAVAILABLE: { title: 'Champions Club overview unavailable', detail: 'Champions Club couldn’t load right now. Press Refresh to try again.' },
  INVALID_RESPONSE: { title: 'Champions Club overview could not be verified', detail: 'Something changed while loading. Press Refresh to see the latest.' },
};

/** USD is fixed by the closed backend contract. Integer formatting preserves every minor unit. */
export function formatChampionsLiability(minor: number): string {
  const value = BigInt(minor);
  return `USD ${(value / 100n).toLocaleString('en-US')}.${(value % 100n).toString().padStart(2, '0')}`;
}
const number = (value: number) => value.toLocaleString('en-US');
const entries = (value: number) => `${number(value)} ${value === 1 ? 'entry' : 'entries'}`;
const referralTotal = (data: ChampionsManagementSnapshot) => Object.values(data.overview.attributions).reduce((sum, value) => sum + BigInt(value), 0n);
const paymentSources = { UNDECIDED: 'Undecided', HON_BILLING: 'HON billing evidence', HQ_OWNER_ATTESTATION: 'HQ owner attestation' };
const clawbackRules = { UNDECIDED: 'Undecided', VOID_UNFULFILLED: 'Void unfulfilled rewards', RETAIN_EARNED: 'Retain earned rewards' };

export function ChampionsManagementSummary({ data }: { data: ChampionsManagementSnapshot }): React.ReactElement {
  const o = data.overview;
  // Exhaustive server aggregate states, never the length/sum of a limited record list.
  return <div className={styles.metrics}>
      <section><h3>Total referrals</h3><strong data-champions-total>{referralTotal(data).toLocaleString('en-US')}</strong><p>All five referral states</p></section>
      <section><h3>Qualified referrals</h3><strong>{number(o.attributions.qualified)}</strong><p>Verified by Champions Club</p></section>
      <section><h3>Ranked schools</h3><strong>{number(o.rankedSchools)}</strong><p>Official eligible standings</p></section>
      <section><h3>Recorded reward entries</h3><strong>{number(o.rewardLiabilities.entries)}</strong><p>Owed, not paid yet</p></section>
    </div>;
}

export function ChampionsManagementResults({ data, includeSummary = true }: { data: ChampionsManagementSnapshot; includeSummary?: boolean }): React.ReactElement {
  const { overview: o, program } = data;
  const policy = program.published;
  const states = [
    ['Qualified', o.attributions.qualified, 'Counts toward rewards'],
    ['Pending', o.attributions.pending, 'Waiting for a decision'],
    ['Rejected', o.attributions.rejected, 'Didn’t qualify'],
    ['Refunded', o.attributions.refunded, 'Referrals recorded as refunded'],
    ['Reversed', o.attributions.reversed, 'Qualified, then reversed'],
  ] as const;
  return <>
    {includeSummary && <ChampionsManagementSummary data={data}/>}
    {referralTotal(data) === 0n && <section className={base.panel}><h2>No referrals recorded</h2><p>No referrals yet. Program settings and anything owed are below.</p></section>}
    <section className={base.panel} aria-labelledby="champions-state-heading">
      <div className={base.sectionHeader}><h2 id="champions-state-heading">Referral status</h2><span className={base.badge}>All time · verified totals</span></div>
      <dl className={styles.states}>{states.map(([label, count, detail]) => <div key={label}><dt>{label}</dt><dd>{number(count)}<p>{detail}</p></dd></div>)}</dl>
      <p className={styles.note}>Only qualified referrals earn rewards. Pending, rejected, refunded and reversed ones don’t.</p>
    </section>
    <div className={styles.columns}>
      <section className={base.panel} aria-labelledby="champions-configuration-heading">
        <div className={base.sectionHeader}><h2 id="champions-configuration-heading">Program configuration</h2><span className={base.badge}>{policy ? `Published · v${policy.policyVersion}` : 'Policy undecided'}</span></div>
        <dl className={styles.facts}>
          <div><dt>How a referral qualifies</dt><dd>{o.program.paymentVerificationSource === null ? 'Not set until the program is published' : paymentSources[o.program.paymentVerificationSource]}</dd></div>
          <div><dt>Active referral codes</dt><dd>{number(o.referralCodes.active)}</dd></div>
          <div><dt>Schools with an active code</dt><dd>{number(o.referralCodes.schoolsWithCode)}</dd></div>
          <div><dt>Returned policy drafts</dt><dd>{number(program.drafts.length)}<small>Drafts (up to 10) · not live yet</small></dd></div>
          {policy && <>
            <div><dt>Attribution window</dt><dd>{policy.attributionWindowDays === null ? 'Undecided' : `${number(policy.attributionWindowDays)} days`}</dd></div>
            <div><dt>Refund window</dt><dd>{policy.refundWindowDays === null ? 'Undecided' : `${number(policy.refundWindowDays)} days`}</dd></div>
            <div><dt>Minimum paid days</dt><dd>{policy.minimumPaidDays === null ? 'Undecided' : number(policy.minimumPaidDays)}</dd></div>
            <div><dt>Minimum paid invoices</dt><dd>{policy.minimumPaidInvoices === null ? 'Undecided' : number(policy.minimumPaidInvoices)}</dd></div>
            <div><dt>Configured welcome credit</dt><dd>{policy.welcomeCreditMinor === null ? 'Undecided' : formatChampionsLiability(policy.welcomeCreditMinor)}<small>Program amount · not given out yet</small></dd></div>
            <div><dt>Terms reference</dt><dd dir="auto">{policy.termsReference ?? 'Not provided'}</dd></div>
          </>}
        </dl>
        {!policy && <p className={styles.note}>The program isn’t published yet, so no rewards are earned.</p>}
        <p className={styles.note}>View only. Program changes aren’t made on this page.</p>
      </section>
      <section className={base.panel} aria-labelledby="champions-liabilities-heading">
        <div className={base.sectionHeader}><h2 id="champions-liabilities-heading">Rewards owed</h2><span className={base.badge}>Payouts off</span></div>
        <p className={styles.note}>Rewards earned, approved or under review. None have been paid or given out yet.</p>
        <dl className={styles.facts}>
          <div><dt>Subscription account credits</dt><dd>{formatChampionsLiability(o.rewardLiabilities.creditMinor)}<small>Credit on a school’s HON bill · not AI credits</small></dd></div>
          <div><dt>Free-month rewards</dt><dd>{number(o.rewardLiabilities.freeMonths)} {o.rewardLiabilities.freeMonths === 1 ? 'month' : 'months'}</dd></div>
          <div><dt>Physical / experience prizes</dt><dd>{entries(o.rewardLiabilities.prizes)}<small>Prizes owed · not bought or sent</small></dd></div>
          <div><dt>Lifetime membership milestones</dt><dd>{entries(o.rewardLiabilities.lifetimeMemberships)}<small>Owed · not switched on</small></dd></div>
          <div><dt>Approved for future fulfillment</dt><dd>{entries(o.rewardLiabilities.approved)}<small>Approved, not paid yet</small></dd></div>
          <div><dt>Reversal review required</dt><dd>{entries(o.rewardLiabilities.inReview)}</dd></div>
          <div><dt>Reward policy</dt><dd>{o.rewardProgram.status === 'PUBLISHED' ? `Published · v${o.rewardProgram.policyVersion}` : 'Policy undecided'}</dd></div>
          <div><dt>Clawback rule</dt><dd>{o.rewardProgram.clawbackRule === null ? 'Not set until the program is published' : clawbackRules[o.rewardProgram.clawbackRule]}</dd></div>
        </dl>
        {o.rewardLiabilities.entries === 0 && <p className={styles.note}>No rewards owed right now.</p>}
      </section>
    </div>
    <details className={`${base.panel} ${styles.review}`}>
      <summary>Private HQ reviews and contest prizes</summary>
      <dl className={styles.facts}>
        <div><dt>Active leaderboard holds</dt><dd>{number(o.leaderboardHolds)}<small>Under review · not an accusation</small></dd></div>
        <div><dt>Contest winner costs awaiting review</dt><dd>{formatChampionsLiability(o.contestLiabilities.pendingWinnerCostMinor)}</dd></div>
        <div><dt>Approved contest winner cost estimates</dt><dd>{formatChampionsLiability(o.contestLiabilities.approvedWinnerCostMinor)}<small>Separate from Champions Club rewards · not paid</small></dd></div>
      </dl>
      <p className={styles.note}>HQ only. Contests are started and finished on the Referral Contests page.</p>
    </details>
  </>;
}

export function HqChampionsManagement({ pagePath }: { pagePath: '/hq/growth' | '/hq/growth/champions-club' }): React.ReactElement {
  const [revision, setRevision] = useState(0);
  const key = `${pagePath}:${revision}`;
  const [state, setState] = useState<ReadState>({ key: '', kind: 'loading' });
  const visible: ReadState = state.key === key ? state : { key, kind: 'loading' };
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setState({ key, kind: 'loading' });
    loadHqChampionsManagement(controller.signal).then(
      (data) => { if (current) setState({ key, kind: 'ready', data, retrievedAt: new Date().toISOString() }); },
      (error: unknown) => { if (current) setState({ key, kind: 'failed', failure: error instanceof HqChampionsManagementError ? error.kind : 'UNAVAILABLE' }); },
    );
    return () => { current = false; controller.abort(); };
  }, [key]);
  return <div className={styles.management}>
    <section className={`${base.panel} ${base.moduleIntro} ${styles.intro}`}><span className={base.badge}>Champions Club · HQ</span><div className={styles.introHeading}><h2>Champions Club overview</h2><button type="button" disabled={visible.kind === 'loading'} onClick={() => setRevision((value) => value + 1)}>Refresh Champions Club</button></div><p>Referrals, program settings and rewards owed. Payouts are off for now.</p></section>
    <div className={styles.summary} aria-live="polite" aria-busy={visible.kind === 'loading'}>{visible.kind === 'ready' && <ChampionsManagementSummary data={visible.data}/>}</div>
    <nav className={base.moduleLinks} aria-label="Growth modules"><Link href="/hq/growth" aria-current={pagePath === '/hq/growth' ? 'page' : undefined}>Growth overview</Link>{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path} aria-current={pagePath === item.path ? 'page' : undefined}>{item.title}</Link>)}</nav>
    <div className={styles.results} aria-busy={visible.kind === 'loading'} aria-live="polite">
      {visible.kind === 'loading' && <section className={base.panel}><h2>Loading Champions Club…</h2><p role="status">Getting the latest numbers.</p></section>}
      {visible.kind === 'failed' && <section className={base.panel}><h2>{failures[visible.failure].title}</h2><p role="status">{failures[visible.failure].detail}</p>{visible.failure === 'UNAUTHORIZED' && <Link className={base.primary} href="/auth/login">Sign in to HON</Link>}</section>}
      {visible.kind === 'ready' && <><p className={styles.note} role="status">Retrieved {new Date(visible.retrievedAt).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC · refresh to recheck current records.</p><ChampionsManagementResults data={visible.data} includeSummary={false}/></>}
    </div>
    <section className={base.panel}><h2>More Champions Club tools</h2><p className={styles.note}>See each school’s referrals and progress, or all rewards owed.</p><div className={base.moduleLinks}><Link href="/hq/growth/champions-club/schools" className={styles.link}>School referral details →</Link><Link href="/hq/growth/rewards" className={styles.link}>All rewards owed →</Link><Link href="/hq/growth/leaderboard" className={styles.link}>Referral leaderboard →</Link></div></section>
  </div>;
}
