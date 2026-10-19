'use client';
import React from 'react';
import { hostedCheckoutUrl } from './http';
import { displayUsd, OFFER_CHOICES } from './catalog';
import type { useSchoolCheckout } from './use-checkout';
import styles from './subscription.module.css';

export function billingDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}
export function SchoolAccountStatus({ billing }: { billing: ReturnType<typeof useSchoolCheckout> }): React.ReactElement {
  const { account, credits, error, creditError, commandError, checkedAt } = billing;
  const sub = account?.plan.subscription, checkout = account?.plan.checkout;
  const verified = sub?.paymentStatus === 'PAID' && account?.plan.paymentVerification === 'PROVIDER_VERIFIED';
  const simulated = checkout?.provider === 'STRIPE_SIMULATED';
  const hosted = checkout ? hostedCheckoutUrl(checkout) : null;
  const status = checkout?.status;
  const labels = { CREATED: 'Checkout pending provider connection', OPEN: 'Checkout open — payment pending', COMPLETED: 'Checkout completed', EXPIRED: 'Checkout expired', CANCELLED: 'Checkout canceled', FAILED: 'Checkout failed', PAID_NEEDS_REVIEW: 'Payment requires HON review' };
  const balance = credits?.currentAllowance;
  return <aside id="school-account" className={styles.account} aria-label="Current HON subscription" aria-busy={billing.loading || billing.posting}>
    <div className={styles.accountHeader}><div><span className={styles.tag}>YOUR SCHOOL ACCOUNT</span><h2 id="school-account-title" tabIndex={-1}>{billing.loading ? 'Checking school billing…' : account ? 'Your HON subscription' : 'School billing unavailable'}</h2></div><button type="button" className={styles.secondary} disabled={billing.loading || billing.posting} onClick={() => void billing.refresh()}>Refresh payment status</button></div>
    {(error || commandError) && <p role="alert" className={styles.error}>{commandError ?? error}</p>}
    {billing.pendingAttempt && <p className={styles.small}>An unresolved request keeps its original retry key on this page. Refresh before explicitly retrying the same offer. Do not start a second purchase.</p>}
    {!billing.loading && !account && <p>Account facts were cleared. No subscription, payment, access or balance is assumed.</p>}
    {account && <>
      <p><span className={styles.unavailable}>{account.plan.payments.status === 'TEST_MODE' ? 'TEST MODE • No live payments' : 'Checkout disabled'}</span></p>
      <p className={styles.small}>Currently authorized tier: <strong>{account.plan.entitlementTier ?? 'Unavailable'}</strong>. Purchasing another tier is unavailable. This does not confirm purchase-based activation.</p>
      {status && <div className={styles.checkoutStatus} role="status"><strong>{labels[status]}</strong><p>{checkout!.statusReason.replaceAll('_', ' ')} · Test mode{simulated ? ' · Deterministic simulator, not Stripe sandbox' : ' · Stripe provider'}</p>
        {status === 'OPEN' && <>
          <p>Returning here or opening a hosted session does not confirm payment. Refresh after checkout.</p>
          {hosted ? <a className={styles.primary} href={hosted} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Continue on Stripe test checkout ↗</a> : <p>Simulator session recorded. No real Stripe checkout is connected for this session.</p>}
          <p className={styles.small}>Recorded expiry: {billingDate(checkout!.expiresAt)}. Only HON’s backend can confirm an expired or paid result.</p>
        </>}
        {status === 'CREATED' && <p>The provider session is not confirmed. Refresh and use an explicit same-request retry if available. If this page was reloaded and the retry key is unavailable, contact HON support.</p>}
        {status === 'PAID_NEEDS_REVIEW' && <p>Do not purchase again. HON must review this payment before any outcome is assumed.</p>}
        {['CANCELLED', 'EXPIRED', 'FAILED'].includes(status) && <p>This checkout did not establish a verified purchase. Review refreshed offers before starting another test checkout.</p>}
      </div>}
      {verified && <div className={styles.activation} role="status"><strong>{simulated ? 'Simulator-verified test payment' : 'Provider-verified test payment'}</strong><h3>Pending Account Activation</h3><p>Payment verification does not activate or change your school’s features. Purchase-based account activation is awaiting confirmation. Your existing authorized tier remains separate.</p></div>}
      {sub ? <dl className={styles.facts}>
        <div><dt>Recorded subscription</dt><dd>HON {sub.planCode} · {sub.status.replaceAll('_', ' ')}</dd></div>
        <div><dt>Payment status</dt><dd>{sub.paymentStatus.replaceAll('_', ' ')} · {account.plan.paymentVerification === 'HQ_ATTESTED' ? 'Manual HON attestation; not provider verified' : account.plan.paymentVerification === 'PROVIDER_VERIFIED' ? 'Provider verified · test mode' : 'No current paid verification'}</dd></div>
        <div><dt>Recorded price</dt><dd>{sub.priceMinor === null ? 'Unavailable' : `${displayUsd(sub.priceMinor)} USD`} · {sub.billingInterval === 'LIFETIME' ? 'One-time lifetime purchase' : sub.billingInterval === 'MONTHLY' ? 'Monthly' : 'Legacy interval'}</dd></div>
        <div><dt>Founder status</dt><dd>{OFFER_CHOICES.find((o) => o.kind === sub.offerKind)?.label ?? 'Legacy subscription'}{sub.founderReservationId ? ' · Reservation recorded' : ''}</dd></div>
        <div><dt>Current service period</dt><dd>{sub.currentPeriod ? `${billingDate(sub.currentPeriod.startsAt)} → ${sub.currentPeriod.endsAt ? billingDate(sub.currentPeriod.endsAt) : 'No period end recorded (lifetime)'}` : 'Not started'}</dd></div>
        <div><dt>Paid through</dt><dd>{sub.paidThroughAt ? billingDate(sub.paidThroughAt) : sub.billingInterval === 'LIFETIME' && verified ? 'Verified one-time test payment; no monthly paid-through date' : 'Unavailable'}</dd></div>
      </dl> : <p>No current subscription was returned by the authorized billing service.</p>}
      <section className={styles.creditPanel} aria-labelledby="credit-title"><h3 id="credit-title">Monthly AI allowance</h3>
        {balance ? <><p>{balance.status} · {credits!.programStatus} credit program · {billingDate(balance.periodStart)} → {billingDate(balance.periodEnd)}</p><dl className={styles.facts}><div><dt>Allowance</dt><dd>{balance.balance.allowanceCredits.toLocaleString('en-US')}</dd></div><div><dt>Consumed</dt><dd>{balance.balance.consumedCredits.toLocaleString('en-US')}</dd></div><div><dt>Reserved</dt><dd>{balance.balance.heldCredits.toLocaleString('en-US')}</dd></div><div><dt>Remaining per ledger</dt><dd>{balance.balance.availableCredits.toLocaleString('en-US')}</dd></div></dl><p className={styles.small}>Credit records do not prove account activation. Top-ups remain unavailable.</p></> : <p>{creditError ?? (credits ? `No current allowance returned · ${credits.programStatus} program. Planned plan credits are not a granted balance.` : 'Checking independently authorized allowance…')}</p>}
      </section>
      <details className={styles.invoice}><summary>Invoice access and school identity</summary>{checkout?.invoiceId && <p>Recorded HON invoice reference: <code>{checkout.invoiceId}</code></p>}<p>School invoice details and download are unavailable here. A recorded invoice ID is not a receipt or a proof of payment. School-to-family billing is separate.</p><p>Verified school reference: <code>{account.context.schoolId}</code></p></details>
      {checkedAt && <p className={styles.small}>Last checked in this browser: {billingDate(checkedAt)}</p>}
    </>}
  </aside>;
}
