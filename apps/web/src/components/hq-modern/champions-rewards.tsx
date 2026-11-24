'use client';

import React, { useCallback, useState } from 'react';
import { CHAMPIONS_REWARD_STATUSES, type ChampionsRewardEntry, type ChampionsRewardStatus } from '@hon/contracts';
import { loadHqRewardLedger, type RewardLedgerSnapshot } from './champions-school-rewards-http';
import { ChampionsDetailNav, DetailState, Retrieved, rewardNames, rewardStatuses, useChampionsDetailRead, utc } from './champions-detail-shared';
import { formatChampionsLiability as money } from './champions-management';
import base from './hq-modern.module.css';
import styles from './champions-management.module.css';
import detail from './champions-school-rewards.module.css';

function RewardRecord({ entry: e }: { entry: ChampionsRewardEntry }): React.ReactElement {
  return <li><div className={base.sectionHeader}><h3>{rewardNames[e.rewardKind]}</h3><span className={base.badge}>{rewardStatuses[e.status]}</span></div>
    <dl className={styles.facts}>
      {e.creditMinor !== null && <div><dt>Recorded subscription account credit</dt><dd>{money(e.creditMinor)}<small>Not AI credits · not applied yet</small></dd></div>}
      {e.freeMonths !== null && <div><dt>Recorded free subscription months</dt><dd>{e.freeMonths.toLocaleString('en-US')}<small>Not started yet</small></dd></div>}
      {e.lifetimeTier !== null && <div><dt>Recorded lifetime tier</dt><dd>{e.lifetimeTier}<small>Not switched on yet</small></dd></div>}
      {e.rewardKind === 'PRIZE' && <div><dt>Prize selection</dt><dd>{e.prize ? `${e.prize.kind === 'EXPERIENCE' ? 'Experience' : 'Physical electronics'} · ${e.prize.description}` : 'Not recorded'}<small>{e.prize ? `${money(e.prize.costMinor)} recorded cost · no procurement or delivery` : 'Cost and delivery not recorded'}</small></dd></div>}
      {e.substitute && <div><dt>Owner substitute liability</dt><dd dir="auto">{e.substitute.description}<small>{money(e.substitute.valueMinor)} · not delivered</small></dd></div>}
      <div><dt>Beneficiary</dt><dd>{e.beneficiaryRole === 'REFERRER' ? 'Referring organization' : 'Referred organization'}<small>{e.beneficiaryOrganizationId}</small></dd></div>
      <div><dt>Basis qualified count</dt><dd>{e.basisQualifiedCount.toLocaleString('en-US')}<small>Amount when earned · not today’s total</small></dd></div>
      {e.milestoneCount !== null && <div><dt>Recorded milestone</dt><dd>{e.milestoneCount} referrals</dd></div>}
      <div><dt>Accrued</dt><dd>{utc(e.accruedAt)}</dd></div>
      {e.approvedAt !== null && <div><dt>Approval recorded</dt><dd>{utc(e.approvedAt)}<small>Approval for future fulfillment only · {e.planBasis}</small></dd></div>}
      {e.status === 'REVERSAL_REVIEW' && <div><dt>Review state</dt><dd>Requires reversal review<small>Not cancelled automatically</small></dd></div>}
      {e.voidedAt !== null && <div><dt>Voided</dt><dd>{utc(e.voidedAt)}<small>{e.voidReason?.replaceAll('_', ' ')} · no payment reversal implied</small></dd></div>}
      {e.retained && <div><dt>Owner retention decision</dt><dd>Retained in accounting<small>Not evidence of fulfillment</small></dd></div>}
      {e.aiAllowance && <div><dt>Included AI allowance policy</dt><dd>Full plan allowance<small>Program setting · no credit given</small></dd></div>}
    </dl>
    <details className={detail.disclosure}><summary>Record details</summary><p>Entry {e.entryId} · policy v{e.policyVersion} · record v{e.version}</p><p>Referrer school {e.referrerSchoolId} · referrer organization {e.referrerOrganizationId}</p>{e.attributionId && <p>Referral {e.attributionId}</p>}<p>Fulfillment form: {e.fulfillmentForm ?? 'Not decided'} · no applied or fulfilled state exists in this contract.</p></details>
  </li>;
}

export function RewardLedgerResults({ data }: { data: RewardLedgerSnapshot }): React.ReactElement {
  const { ledger, program } = data;
  const policy = program.published;
  return <>
    <section className={base.panel}><h2>Total rewards owed</h2><p className={styles.note}>Backend aggregates across every non-voided reward record, grouped by state and reward kind. These totals do not change scope with the recent-record status filter. Recorded liabilities are not payments, applied benefits or fulfilled rewards. Voided records are excluded.</p>
      {!ledger.liabilities.length && <p className={detail.empty}>No rewards owed.</p>}
      <div className={detail.aggregates}>{ledger.liabilities.map((group) => <section key={`${group.status}:${group.rewardKind}`}><h3>{rewardNames[group.rewardKind]}</h3><p className={styles.note}>{rewardStatuses[group.status]}</p><dl className={styles.facts}>
        <div><dt>Recorded entries</dt><dd>{group.entries.toLocaleString('en-US')}<small>Total across all records</small></dd></div>
        <div><dt>Account-credit liability</dt><dd>{money(group.creditMinor)}</dd></div>
        <div><dt>Free-month liability</dt><dd>{group.freeMonths.toLocaleString('en-US')} months</dd></div>
        <div><dt>Prize cost recorded</dt><dd>{money(group.prizeCostMinor)}</dd></div>
        <div><dt>Substitute value recorded</dt><dd>{money(group.substituteValueMinor)}</dd></div>
      </dl><p className={styles.note}>{group.rewardKind === 'LIFETIME_MEMBERSHIP' ? 'Lifetime rewards are counted, not given a dollar value.' : 'A cost of zero means no cost recorded yet.'}</p></section>)}</div>
    </section>
    <section className={base.panel}><div className={base.sectionHeader}><h2>Reward settings</h2><span className={base.badge}>{policy ? `Policy v${policy.policyVersion}` : 'Policy undecided'}</span></div>
      {policy ? <dl className={styles.facts}>
        <div><dt>Configured referrer account credit</dt><dd>{policy.referrerCreditMinor === null ? 'Undecided' : money(policy.referrerCreditMinor)}<small>Policy amount · not issued</small></dd></div>
        <div><dt>Configured welcome account credit</dt><dd>{policy.welcomeCreditMinor === null ? 'Undecided' : money(policy.welcomeCreditMinor)}</dd></div>
        <div><dt>First free-month milestone</dt><dd>{policy.firstFreeMonthsCount ?? 'Undecided'} referrals · {policy.firstFreeMonthsTotal ?? 'Undecided'} months</dd></div>
        <div><dt>Second free-month milestone</dt><dd>{policy.secondFreeMonthsCount ?? 'Undecided'} referrals · {policy.secondFreeMonthsTotal ?? 'Undecided'} cumulative months<small>Not added to the first amount</small></dd></div>
        <div><dt>Prize milestone / budget</dt><dd>{policy.prizeCount ?? 'Undecided'} referrals · {policy.prizeBudgetMinor === null ? 'Undecided' : money(policy.prizeBudgetMinor)}<small>Budget only · not a purchase</small></dd></div>
        <div><dt>Lifetime milestone</dt><dd>{policy.lifetimeCount ?? 'Undecided'} referrals</dd></div>
        <div><dt>Clawback / paid-lifetime rule</dt><dd>{policy.clawbackRule} / {policy.paidLifetimeRule}</dd></div>
        <div><dt>Terms reference</dt><dd dir="auto">{policy.termsReference ?? 'Not provided'}</dd></div>
      </dl> : <p className={detail.empty}>No reward settings published yet. Past records keep the settings they were earned under.</p>}
    </section>
    <section className={base.panel}><h2>Recent global reward records</h2><p className={styles.note}>Newest {ledger.limit} matching records at most, across all schools. This is not a complete ledger or any school's complete reward history. Status filtering retrieves a new authorized server window; no totals are derived from these entries.</p>
      {!ledger.entries.length && <p role="status" className={detail.empty}>No recent rewards match this filter.</p>}
      <ol className={detail.records}>{ledger.entries.map((entry) => <RewardRecord key={entry.entryId} entry={entry}/>)}</ol>
    </section>
  </>;
}

export function HqChampionsRewards(): React.ReactElement {
  const [status, setStatus] = useState<ChampionsRewardStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useCallback((signal: AbortSignal) => loadHqRewardLedger(status, signal), [status]);
  const state = useChampionsDetailRead(`${status}:${revision}`, load);
  return <div className={styles.management}>
    <section className={`${base.panel} ${styles.intro}`}><span className={base.badge}>Champions Club · HQ</span><div className={styles.introHeading}><h2>Reward management</h2><button type="button" disabled={state.kind === 'loading'} onClick={() => setRevision((r) => r + 1)}>Refresh reward records</button></div><p>View only. Approving and paying rewards isn’t switched on yet.</p></section>
    <ChampionsDetailNav/>
    <section className={base.panel}><div className={detail.selection}><label>Recent-record status<select value={status ?? ''} onChange={(e) => setStatus(e.target.value ? e.target.value as ChampionsRewardStatus : null)}><option value="">All recorded states</option>{CHAMPIONS_REWARD_STATUSES.map((value) => <option key={value} value={value}>{rewardStatuses[value]}</option>)}</select></label></div><p className={styles.note}>The filter changes the recent list only. Totals above always include everything.</p></section>
    <div className={styles.results} aria-live="polite" aria-busy={state.kind === 'loading'}><DetailState state={state}/>{state.kind === 'ready' && <><Retrieved at={state.retrievedAt}/><RewardLedgerResults data={state.data}/></>}</div>
  </div>;
}
