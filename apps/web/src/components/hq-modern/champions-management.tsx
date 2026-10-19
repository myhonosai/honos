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
  UNAUTHORIZED: { title: 'Sign in to view Champions Club', detail: 'A current authenticated HQ session is required. No previous referral or reward information is displayed.' },
  FORBIDDEN: { title: 'Champions Club access denied', detail: 'This account does not have independent Champions Club HQ authority. School, family and support access cannot grant it.' },
  UNAVAILABLE: { title: 'Champions Club overview unavailable', detail: 'The authorized overview or program service is unavailable. Refresh to check again; unavailable information is never treated as zero.' },
  INVALID_RESPONSE: { title: 'Champions Club overview could not be verified', detail: 'Program data could not be verified, or configuration changed during retrieval. Refresh to check current records.' },
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
      <section><h3>Recorded reward entries</h3><strong>{number(o.rewardLiabilities.entries)}</strong><p>Non-voided liabilities · not paid</p></section>
    </div>;
}

export function ChampionsManagementResults({ data, includeSummary = true }: { data: ChampionsManagementSnapshot; includeSummary?: boolean }): React.ReactElement {
  const { overview: o, program } = data;
  const policy = program.published;
  const states = [
    ['Qualified', o.attributions.qualified, 'Meets verified program qualification rules'],
    ['Pending', o.attributions.pending, 'Awaiting a qualification decision'],
    ['Rejected', o.attributions.rejected, 'Referrals rejected by the program'],
    ['Refunded', o.attributions.refunded, 'Referrals recorded as refunded'],
    ['Reversed', o.attributions.reversed, 'Referrals whose qualification was reversed'],
  ] as const;
  return <>
    {includeSummary && <ChampionsManagementSummary data={data}/>}
    {referralTotal(data) === 0n && <section className={base.panel}><h2>No referrals recorded</h2><p>The authorized service returned zero across every referral state. Program configuration and any recorded liabilities are shown independently below.</p></section>}
    <section className={base.panel} aria-labelledby="champions-state-heading">
      <div className={base.sectionHeader}><h2 id="champions-state-heading">Referral status</h2><span className={base.badge}>All time · verified totals</span></div>
      <dl className={styles.states}>{states.map(([label, count, detail]) => <div key={label}><dt>{label}</dt><dd>{number(count)}<p>{detail}</p></dd></div>)}</dl>
      <p className={styles.note}>Qualification, ranking and reward accounting are separate. Rejected, pending, refunded and reversed referrals do not establish a qualified award.</p>
    </section>
    <div className={styles.columns}>
      <section className={base.panel} aria-labelledby="champions-configuration-heading">
        <div className={base.sectionHeader}><h2 id="champions-configuration-heading">Program configuration</h2><span className={base.badge}>{policy ? `Published · v${policy.policyVersion}` : 'Policy undecided'}</span></div>
        <dl className={styles.facts}>
          <div><dt>Qualification evidence source</dt><dd>{o.program.paymentVerificationSource === null ? 'Unavailable until policy publication' : paymentSources[o.program.paymentVerificationSource]}</dd></div>
          <div><dt>Active referral codes</dt><dd>{number(o.referralCodes.active)}</dd></div>
          <div><dt>Schools with an active code</dt><dd>{number(o.referralCodes.schoolsWithCode)}</dd></div>
          <div><dt>Returned policy drafts</dt><dd>{number(program.drafts.length)}<small>Up to 10 returned drafts · not active program terms</small></dd></div>
          {policy && <>
            <div><dt>Attribution window</dt><dd>{policy.attributionWindowDays === null ? 'Undecided' : `${number(policy.attributionWindowDays)} days`}</dd></div>
            <div><dt>Refund window</dt><dd>{policy.refundWindowDays === null ? 'Undecided' : `${number(policy.refundWindowDays)} days`}</dd></div>
            <div><dt>Minimum paid days</dt><dd>{policy.minimumPaidDays === null ? 'Undecided' : number(policy.minimumPaidDays)}</dd></div>
            <div><dt>Minimum paid invoices</dt><dd>{policy.minimumPaidInvoices === null ? 'Undecided' : number(policy.minimumPaidInvoices)}</dd></div>
            <div><dt>Configured welcome credit</dt><dd>{policy.welcomeCreditMinor === null ? 'Undecided' : formatChampionsLiability(policy.welcomeCreditMinor)}<small>Policy amount only · not an issued credit</small></dd></div>
            <div><dt>Terms reference</dt><dd dir="auto">{policy.termsReference ?? 'Not provided'}</dd></div>
          </>}
        </dl>
        {!policy && <p className={styles.note}>No published qualification policy was returned. Drafts and roadmap milestones do not establish earned rewards.</p>}
        <p className={styles.note}>Read-only configuration. Publication and policy changes are unavailable from this interface.</p>
      </section>
      <section className={base.panel} aria-labelledby="champions-liabilities-heading">
        <div className={base.sectionHeader}><h2 id="champions-liabilities-heading">Outstanding reward liabilities</h2><span className={base.badge}>Financial activation disabled</span></div>
        <p className={styles.note}>Recorded non-voided liabilities include accrued, approved and reversal-review entries. They are not issued credits, paid rewards or fulfilled benefits.</p>
        <dl className={styles.facts}>
          <div><dt>Subscription account credits</dt><dd>{formatChampionsLiability(o.rewardLiabilities.creditMinor)}<small>HON account-credit liabilities · not AI credits</small></dd></div>
          <div><dt>Free-month rewards</dt><dd>{number(o.rewardLiabilities.freeMonths)} {o.rewardLiabilities.freeMonths === 1 ? 'month' : 'months'}</dd></div>
          <div><dt>Physical / experience prizes</dt><dd>{entries(o.rewardLiabilities.prizes)}<small>Prize liabilities · no purchase or delivery</small></dd></div>
          <div><dt>Lifetime membership milestones</dt><dd>{entries(o.rewardLiabilities.lifetimeMemberships)}<small>Recorded liabilities · no membership activation</small></dd></div>
          <div><dt>Approved for future fulfillment</dt><dd>{entries(o.rewardLiabilities.approved)}<small>Approval does not mean payment or fulfillment</small></dd></div>
          <div><dt>Reversal review required</dt><dd>{entries(o.rewardLiabilities.inReview)}</dd></div>
          <div><dt>Reward policy</dt><dd>{o.rewardProgram.status === 'PUBLISHED' ? `Published · v${o.rewardProgram.policyVersion}` : 'Policy undecided'}</dd></div>
          <div><dt>Clawback rule</dt><dd>{o.rewardProgram.clawbackRule === null ? 'Unavailable until policy publication' : clawbackRules[o.rewardProgram.clawbackRule]}</dd></div>
        </dl>
        {o.rewardLiabilities.entries === 0 && <p className={styles.note}>No non-voided reward liabilities were returned. This is not a payment or fulfillment history.</p>}
      </section>
    </div>
    <details className={`${base.panel} ${styles.review}`}>
      <summary>Confidential HQ review and contest liabilities</summary>
      <dl className={styles.facts}>
        <div><dt>Active leaderboard holds</dt><dd>{number(o.leaderboardHolds)}<small>Review state only · not a finding of fraud</small></dd></div>
        <div><dt>Contest winner costs awaiting review</dt><dd>{formatChampionsLiability(o.contestLiabilities.pendingWinnerCostMinor)}</dd></div>
        <div><dt>Approved contest winner cost estimates</dt><dd>{formatChampionsLiability(o.contestLiabilities.approvedWinnerCostMinor)}<small>Separate from permanent program rewards · not paid</small></dd></div>
      </dl>
      <p className={styles.note}>HQ-only aggregates. Automatic contest transitions are not configured. This page cannot publish contests, approve winners or fulfill rewards.</p>
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
    <section className={`${base.panel} ${base.moduleIntro} ${styles.intro}`}><span className={base.badge}>Champions Club · HQ</span><div className={styles.introHeading}><h2>Champions Club overview</h2><button type="button" disabled={visible.kind === 'loading'} onClick={() => setRevision((value) => value + 1)}>Refresh Champions Club</button></div><p>Verified referrals, program terms and recorded liabilities. Financial activation and fulfillment remain disabled.</p></section>
    <div className={styles.summary} aria-live="polite" aria-busy={visible.kind === 'loading'}>{visible.kind === 'ready' && <ChampionsManagementSummary data={visible.data}/>}</div>
    <nav className={base.moduleLinks} aria-label="Growth modules"><Link href="/hq/growth" aria-current={pagePath === '/hq/growth' ? 'page' : undefined}>Growth overview</Link>{HQ_GROWTH.map((item) => <Link key={item.path} href={item.path} aria-current={pagePath === item.path ? 'page' : undefined}>{item.title}</Link>)}</nav>
    <div className={styles.results} aria-busy={visible.kind === 'loading'} aria-live="polite">
      {visible.kind === 'loading' && <section className={base.panel}><h2>Loading authorized Champions Club…</h2><p role="status">Verifying overview and program configuration. Previous facts are cleared.</p></section>}
      {visible.kind === 'failed' && <section className={base.panel}><h2>{failures[visible.failure].title}</h2><p role="status">{failures[visible.failure].detail}</p>{visible.failure === 'UNAUTHORIZED' && <Link className={base.primary} href="/auth/login">Sign in to HON</Link>}</section>}
      {visible.kind === 'ready' && <><p className={styles.note} role="status">Retrieved {new Date(visible.retrievedAt).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC · refresh to recheck current records.</p><ChampionsManagementResults data={visible.data} includeSummary={false}/></>}
    </div>
    <section className={base.panel}><h2>More Champions Club tools</h2><p className={styles.note}>Review authorized school referral statistics, backend milestone progress and bounded history, or global reward accounting. Complete per-school reward history requires a separate HQ backend contract. Reward and contest actions remain disabled.</p><div className={base.moduleLinks}><Link href="/hq/growth/champions-club/schools" className={styles.link}>School referral details →</Link><Link href="/hq/growth/rewards" className={styles.link}>Global reward accounting →</Link><Link href="/hq/growth/leaderboard" className={styles.link}>Official referral leaderboard →</Link></div></section>
  </div>;
}
