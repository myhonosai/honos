'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { SAAS_FOUNDER_POOL_CAPACITY, type SaasPaidReviewItem } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import styles from './hq-founder-billing.module.css';
import { FounderBillingError, founderBillingApi, keepForRetry, type FounderBillingApi, type FounderBillingErrorKind, type FounderBillingView } from './http';

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
  CHANGED: 'Founder billing records changed. Refresh to see the current records.',
  REFUSED: 'Founder billing records are unavailable right now. Nothing is assumed.',
  UNKNOWN: 'Founder billing records are unavailable right now. Nothing is assumed.',
};
/** What a failed command means for the owner. Only UNKNOWN keeps the same key for an identical retry. */
const COMMAND_ERROR: Record<FounderBillingErrorKind, string> = {
  SESSION: 'Your session ended. Nothing was recorded by this page.',
  DENIED: 'Only the HQ owner can record or verify a refund. Nothing changed.',
  INVALID: 'That request was not accepted as sent. Nothing changed.',
  CHANGED: 'This item changed since it was loaded. Nothing changed; refresh and review it again.',
  REFUSED: 'A billing rule refused this step. Nothing changed.',
  UNAVAILABLE: 'The outcome is not known. Send the same request again; it will not be recorded twice.',
  UNKNOWN: 'The outcome is not known. Send the same request again; it will not be recorded twice.',
};
const REFUSAL: Record<string, string> = {
  SAAS_REFUND_EVIDENCE_MISSING: 'The provider refund has not been stored yet. Refund the payment in the payment provider first; HON records its refund event.',
  SAAS_REFUND_INCOMPLETE: 'The stored refund does not cover the full held amount yet.',
  SAAS_REVIEW_NOT_RESOLVABLE: 'This item cannot be resolved now.',
  SAAS_REVIEW_REFUND_RECORDED: 'A refund owed is already recorded for this item.',
  SAAS_BILLING_POLICY_UNAVAILABLE: 'That decision needs an owner policy that has not been made.',
};
const newKey = () => crypto.randomUUID();

function reviewState(item: SaasPaidReviewItem): string {
  const r = item.openResolution;
  if (item.blocker) return `Cannot be resolved yet: ${BLOCKER[item.blocker] ?? item.blocker}`;
  if (!r) return item.allowedDecisions.length ? 'Waiting for the HQ owner to record a refund owed' : 'No decision is available for this item';
  return r.status === 'REFUND_VERIFIED' ? `Refund verified ${utc(r.refundVerifiedAt)}` : 'Refund owed is recorded; waiting for the provider refund evidence';
}

type Busy = { key: string } | null;
/** HQ owner steps for one held payment. The database decides authority again; this page only sends the request. */
export function ReviewActions({ item, api, onChanged }: { item: SaasPaidReviewItem; api: FounderBillingApi; onChanged: () => void }): React.ReactElement | null {
  const id = useId();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retry = useRef<Busy>(null);
  const owned = useRef(true);
  useEffect(() => () => { owned.current = false; }, []);
  const canRecord = item.allowedDecisions.includes('REFUND_OWED') && item.blocker === null && item.openResolution === null;
  const canVerify = item.openResolution?.status === 'AWAITING_REFUND_EVIDENCE';
  if (!canRecord && !canVerify) return null;
  const run = async (send: (key: string, signal: AbortSignal) => Promise<unknown>, done: string) => {
    const key = retry.current?.key ?? newKey(); retry.current = { key };
    setBusy(true); setMessage(null);
    const controller = new AbortController();
    try { await send(key, controller.signal); retry.current = null; if (owned.current) { setMessage(done); onChanged(); } }
    catch (error) {
      if (!keepForRetry(error)) retry.current = null;
      if (owned.current) {
        const kind = error instanceof FounderBillingError ? error.kind : 'UNKNOWN';
        const code = error instanceof FounderBillingError ? error.code : null;
        setMessage(kind === 'REFUSED' && code && REFUSAL[code] ? REFUSAL[code]! : COMMAND_ERROR[kind]);
      }
    } finally { if (owned.current) setBusy(false); }
  };
  const reasonOk = reason.trim().length >= 10 && reason.trim().length <= 500;
  if (canRecord) return <form className={styles.form} data-action="record" onSubmit={(e) => { e.preventDefault(); if (reasonOk && confirmed && !busy)
    void run((key, signal) => api.recordRefundOwed(item, reason, key, signal, () => owned.current), 'Refund owed recorded. Refund the payment in the payment provider; HON verifies the stored refund next.'); }}>
    <h3>Record a refund owed</h3>
    <p className={styles.meta}>HQ owner only. This records that {usd(item.heldAmountMinor)} is owed back. It does not send a refund; the refund is made in the payment provider.</p>
    <label className={styles.field} htmlFor={`${id}-reason`}>Reason (10 to 500 characters)
      <textarea id={`${id}-reason`} rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => { setReason(e.target.value); retry.current = null; }}/></label>
    <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => { setConfirmed(e.target.checked); retry.current = null; }}/>
      <span>I understand HON does not refund anything from this page.</span></label>
    <button type="submit" className={styles.primary} disabled={busy || !reasonOk || !confirmed}>{busy ? 'Recording…' : retry.current ? 'Send the same request again' : 'Record refund owed'}</button>
    {message && <p className={styles.error} role="status">{message}</p>}
  </form>;
  return <form className={styles.form} data-action="verify" onSubmit={(e) => { e.preventDefault(); if (confirmed && !busy)
    void run((key, signal) => api.verifyRefund(item, key, signal, () => owned.current), 'Refund verified from the stored provider evidence.'); }}>
    <h3>Verify the refund</h3>
    <p className={styles.meta}>HQ owner only. HON checks the provider refund it has already stored against the {usd(item.heldAmountMinor)} held. Nothing is sent to the provider.</p>
    <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => { setConfirmed(e.target.checked); retry.current = null; }}/>
      <span>I confirm the refund was made in the payment provider.</span></label>
    <button type="submit" className={styles.primary} disabled={busy || !confirmed}>{busy ? 'Verifying…' : retry.current ? 'Send the same request again' : 'Verify refund'}</button>
    {message && <p className={styles.error} role="status">{message}</p>}
  </form>;
}

export function ReviewItem({ item, actions }: { item: SaasPaidReviewItem; actions?: React.ReactNode }): React.ReactElement {
  return <li data-review={item.subjectId}>
    <strong>{REASON[item.reason] ?? item.reason.replaceAll('_', ' ').toLowerCase()}</strong>
    <span className={styles.meta}>{item.subjectKind === 'SCHEDULE_BINDING' ? 'HON OS sign-up' : 'v1 checkout'} · organization {item.organizationId}{item.schoolId ? ` · school ${item.schoolId}` : ''}</span>
    <span className={styles.meta}>Held {usd(item.heldAmountMinor)} in {item.heldItemCount} payment{item.heldItemCount === 1 ? '' : 's'} · refunded {usd(item.refundedAmountMinor)}{item.fullyRefunded ? ' (fully refunded)' : ''} · received {utc(item.receivedAt)}</span>
    <span className={styles.meta}>{reviewState(item)}</span>
    {actions}
  </li>;
}

type ScreenProps = { read: FounderBillingRead; onRefresh: () => void; more?: SaasPaidReviewItem[]; cursor?: string | null; onMore?: () => void; moreState?: string | null;
  renderActions?: (item: SaasPaidReviewItem) => React.ReactNode };
export function FounderBillingScreen({ read, onRefresh, more = [], cursor, onMore, moreState = null, renderActions }: ScreenProps): React.ReactElement {
  const head = <div className={styles.head}>
    <div><h1>Founder billing</h1><p className={styles.intro}>The 50 HON OS founder spots and the payments HON is holding for review. A spot is counted only when a school&apos;s first payment is verified. A payment that arrives after the last spot is taken is held for an HQ refund; it is never refunded automatically.</p></div>
    <button type="button" className={styles.secondary} onClick={onRefresh} disabled={read.state === 'LOADING'}>Refresh</button>
  </div>;
  if (read.state !== 'READY') return <main className={styles.page} data-hq-founder-billing={read.state}>{head}<p className={styles.notice} role="status">{NOTICE[read.state]}</p></main>;
  const { pool, reviews } = read.view;
  const items = [...reviews.items, ...more];
  const next = cursor === undefined ? reviews.nextCursor : cursor;
  return <main className={styles.page} data-hq-founder-billing="READY">
    {head}
    <p className={styles.meta}>As of {utc(pool.asOf)}. Two separate reads, not one snapshot. Checkout is not open; this page cannot charge or reserve a spot, and no refund is ever sent from HON.</p>
    <section className={styles.card} data-founder-pool>
      <div className={styles.cardHead}><h2>Founder spots</h2><span className={styles.chip} data-kind={pool.remaining === 0 ? 'warn' : 'ok'}>{pool.remaining === 0 ? 'sold out' : `${pool.remaining} left`}</span></div>
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
      <div className={styles.cardHead}><h2>Payments held for review</h2><span className={styles.chip}>{items.length}{next ? '+' : ''}</span></div>
      {items.length === 0 ? <p>No payment is held for review.</p> : <ul className={styles.list}>{items.map((i) =>
        <ReviewItem key={`${i.subjectKind}:${i.subjectId}`} item={i} actions={renderActions?.(i)}/>)}</ul>}
      {next && onMore && <button type="button" className={`${styles.secondary} ${styles.more}`} onClick={onMore} disabled={moreState === 'LOADING'}>{moreState === 'LOADING' ? 'Loading…' : 'Show more'}</button>}
      {moreState && moreState !== 'LOADING' && <p className={styles.error} role="status">{moreState}</p>}
      <p className={styles.meta}>Recording a refund owed and verifying the provider&apos;s refund are HQ owner steps. The refund itself is made in the payment provider; HON never sends one.</p>
    </section>
  </main>;
}

export function HqFounderBilling({ api = founderBillingApi }: { api?: FounderBillingApi }): React.ReactElement {
  const [read, setRead] = useState<FounderBillingRead>({ state: 'LOADING' });
  const [revision, setRevision] = useState(0);
  const [more, setMore] = useState<{ items: SaasPaidReviewItem[]; cursor: string | null } | null>(null);
  const [moreState, setMoreState] = useState<string | null>(null);
  const owned = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    // A session that ended elsewhere wins over a load still in flight: that load can never resolve to READY.
    const end = () => { owned.current = false; inFlight.current?.abort(); setRead({ state: 'SESSION' }); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, end);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, end);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); inFlight.current = controller; owned.current = true;
    setRead({ state: 'LOADING' }); setMore(null); setMoreState(null);
    api.load(controller.signal, () => owned.current).then((view) => { if (!controller.signal.aborted) setRead({ state: 'READY', view }); },
      (error: unknown) => { if (!controller.signal.aborted) setRead({ state: error instanceof FounderBillingError ? error.kind : 'UNAVAILABLE' }); });
    return () => { owned.current = false; controller.abort(); };
  }, [api, revision]);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  const cursor = more ? more.cursor : read.state === 'READY' ? read.view.reviews.nextCursor : null;
  const loadMore = useCallback(() => {
    if (!cursor) return;
    const controller = inFlight.current ?? new AbortController();
    setMoreState('LOADING');
    api.more(cursor, controller.signal, () => owned.current).then((page) => {
      if (controller.signal.aborted) return;
      setMore((m) => ({ items: [...(m?.items ?? []), ...page.items], cursor: page.nextCursor })); setMoreState(null);
    }, () => { if (!controller.signal.aborted) setMoreState('The next page could not be loaded. Refresh to start again.'); });
  }, [api, cursor]);
  return <FounderBillingScreen read={read} onRefresh={refresh} more={more?.items ?? []} cursor={cursor} onMore={loadMore} moreState={moreState}
    renderActions={(item) => <ReviewActions item={item} api={api} onChanged={refresh}/>}/>;
}
