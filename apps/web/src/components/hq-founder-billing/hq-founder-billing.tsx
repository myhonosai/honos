'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SAAS_FOUNDER_POOL_CAPACITY, type SaasPaidReviewItem } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import styles from '../hq-trials/hq-trials.module.css';
import { FounderBillingError, founderBillingApi, type FounderBillingApi, type FounderBillingErrorKind, type FounderBillingView } from './http';

export type FounderBillingRead = { state: 'LOADING' } | { state: 'READY'; view: FounderBillingView } | { state: FounderBillingErrorKind };
const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const utc = (iso: string | null) => iso === null ? 'Not recorded' : `${new Date(iso).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
const OFFER: Record<string, string> = { FOUNDER_MONTHLY: 'Founder monthly', FOUNDER_ANNUAL: 'Founder annual' };
const REASON: Record<string, string> = { FOUNDER_SPOT_UNAVAILABLE: 'Paid after all 50 founder spots were taken' };
const BLOCKER: Record<string, string> = {
  NO_HELD_PAYMENT: 'No held payment is recorded', HELD_PAYMENT_CONFLICT: 'Held payments conflict; needs a provider follow-up',
  DISPUTE_POLICY_REQUIRED: 'A dispute needs an owner policy', REVERSAL_POLICY_REQUIRED: 'A reversal needs an owner policy',
  PAYMENT_REFERENCE_MISSING: 'The payment reference is missing',
};
const NOTICE: Record<Exclude<FounderBillingRead['state'], 'READY'>, string> = {
  LOADING: 'Loading founder billing records…', SESSION: 'Your session ended. Sign in again to review founder billing.',
  DENIED: 'Founder billing is visible only to the HQ owner and billing operators.',
  UNAVAILABLE: 'Founder billing records are unavailable right now. Nothing is assumed.',
  INVALID: 'Founder billing records could not be verified. Nothing is shown.',
};

function reviewState(item: SaasPaidReviewItem): string {
  const r = item.openResolution;
  if (item.blocker) return `Cannot be resolved yet: ${BLOCKER[item.blocker] ?? item.blocker}`;
  if (!r) return 'Waiting for the HQ owner to record a refund owed';
  return r.status === 'REFUND_VERIFIED' ? `Refund verified ${utc(r.refundVerifiedAt)}` : 'Refund owed is recorded; waiting for the provider refund evidence';
}

export function ReviewItem({ item }: { item: SaasPaidReviewItem }): React.ReactElement {
  return <li data-review={item.subjectId}>
    <strong>{REASON[item.reason] ?? item.reason.replaceAll('_', ' ').toLowerCase()}</strong>
    <span className={styles.meta}>{item.subjectKind === 'SCHEDULE_BINDING' ? 'HON OS sign-up' : 'v1 checkout'} · organization {item.organizationId}{item.schoolId ? ` · school ${item.schoolId}` : ''}</span>
    <span className={styles.meta}>Held {usd(item.heldAmountMinor)} in {item.heldItemCount} payment{item.heldItemCount === 1 ? '' : 's'} · refunded {usd(item.refundedAmountMinor)}{item.fullyRefunded ? ' (fully refunded)' : ''} · received {utc(item.receivedAt)}</span>
    <span className={styles.meta}>{reviewState(item)}</span>
  </li>;
}

export function FounderBillingScreen({ read, onRefresh }: { read: FounderBillingRead; onRefresh: () => void }): React.ReactElement {
  const head = <div className={styles.head}>
    <div><h1>Founder billing</h1><p className={styles.intro}>The 50 HON OS founder spots and the payments HON is holding for review. A spot is counted only when a school&apos;s first payment is verified. A payment that arrives after the last spot is taken is held for an HQ refund; it is never refunded automatically.</p></div>
    <button type="button" className={styles.secondary} onClick={onRefresh} disabled={read.state === 'LOADING'}>Refresh</button>
  </div>;
  if (read.state !== 'READY') return <main className={styles.page} data-hq-founder-billing={read.state}>{head}<p className={styles.notice} role="status">{NOTICE[read.state]}</p></main>;
  const { pool, reviews } = read.view;
  return <main className={styles.page} data-hq-founder-billing="READY">
    {head}
    <p className={styles.meta}>As of {utc(pool.asOf)}. Two separate reads, not one snapshot. Checkout is not open; this page cannot refund, charge or reserve a spot.</p>
    <section className={styles.card} data-founder-pool>
      <div className={styles.cardHead}><h2>Founder spots</h2><span className={styles.chip} data-kind={pool.remaining === 0 ? undefined : 'open'}>{pool.remaining === 0 ? 'sold out' : `${pool.remaining} left`}</span></div>
      <dl className={styles.grid}>
        <div><dt>Counted</dt><dd>{pool.allocated} of {SAAS_FOUNDER_POOL_CAPACITY}</dd></div>
        <div><dt>Left</dt><dd>{pool.remaining}</dd></div>
        <div><dt>Held without a spot</dt><dd>{pool.heldWithoutSpot}</dd></div>
      </dl>
      <p className={styles.meta}>Counts only HON OS schedule founder sales. Older v1 checkouts and legacy founder reservations are not part of these 50. A refund never returns a spot.</p>
      {pool.spots.length === 0 ? <p>No founder spot has been counted yet.</p> : <ol className={styles.list}>{pool.spots.map((s) =>
        <li key={s.spotNumber} data-spot={s.spotNumber}><strong>Spot {s.spotNumber} · {OFFER[s.offerKind]} · {usd(s.lockedPriceMinor)}{s.offerKind === 'FOUNDER_ANNUAL' ? ' / year' : ' / month'}</strong>
          <span className={styles.meta}>Organization {s.organizationId} · school {s.schoolId} · counted {utc(s.allocatedAt)}</span></li>)}</ol>}
    </section>
    <section className={styles.card} data-paid-reviews>
      <div className={styles.cardHead}><h2>Payments held for review</h2><span className={styles.chip}>{reviews.items.length}{reviews.nextCursor ? '+' : ''}</span></div>
      {reviews.items.length === 0 ? <p>No payment is held for review.</p> : <ul className={styles.list}>{reviews.items.map((i) => <ReviewItem key={`${i.subjectKind}:${i.subjectId}`} item={i}/>)}</ul>}
      <p className={styles.meta}>{reviews.nextCursor ? 'More items exist than this first page shows. ' : ''}Recording a refund owed and verifying the provider&apos;s refund are HQ owner steps; no provider refund is ever executed from HON.</p>
    </section>
  </main>;
}

export function HqFounderBilling({ api = founderBillingApi }: { api?: FounderBillingApi }): React.ReactElement {
  const [read, setRead] = useState<FounderBillingRead>({ state: 'LOADING' });
  const [revision, setRevision] = useState(0);
  const owned = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    // A session that ended elsewhere wins over a load still in flight: that load can never resolve to READY.
    const end = () => { owned.current = false; inFlight.current?.abort(); setRead({ state: 'SESSION' }); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, end);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, end);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); inFlight.current = controller; owned.current = true; setRead({ state: 'LOADING' });
    api.load(controller.signal, () => owned.current).then((view) => { if (!controller.signal.aborted) setRead({ state: 'READY', view }); },
      (error: unknown) => { if (!controller.signal.aborted) setRead({ state: error instanceof FounderBillingError ? error.kind : 'UNAVAILABLE' }); });
    return () => { owned.current = false; controller.abort(); };
  }, [api, revision]);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  return <FounderBillingScreen read={read} onRefresh={refresh}/>;
}
