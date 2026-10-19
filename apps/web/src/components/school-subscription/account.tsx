'use client';
import { useLocale } from '../localization/provider';
import React from 'react';
import { hostedCheckoutUrl } from './http';
import { SchoolAccessStatus, SchoolCreditStatus, SchoolReadinessNextSteps } from './readiness';
import { displayUsd, OFFER_CHOICES } from './catalog';
import type { useSchoolCheckout } from './use-checkout';
import styles from './subscription.module.css';

export function billingDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC';
}
export function SchoolAccountStatus({ billing }: { billing: ReturnType<typeof useSchoolCheckout> }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale,statusText } = useLocale();
  const { account, credits, error, creditError, commandError, checkedAt } = billing;
  const sub = account?.plan.subscription, checkout = account?.plan.checkout;
  const verified = sub?.paymentStatus === 'PAID' && account?.plan.paymentVerification === 'PROVIDER_VERIFIED';
  const simulated = checkout?.provider === 'STRIPE_SIMULATED';
  const hosted = checkout && account?.plan.payments.status === 'TEST_MODE' && account.plan.payments.mode === 'TEST' ? hostedCheckoutUrl(checkout) : null;
  const status = checkout?.status;
  const labels = { CREATED: t("Checkout pending provider connection"), OPEN: t("Checkout open — payment pending"), COMPLETED: t("Checkout completed"), EXPIRED: t("Checkout expired"), CANCELLED: t("Checkout canceled"), FAILED: t("Checkout failed"), PAID_NEEDS_REVIEW: t("Payment requires HON review") };
  const balance = credits?.currentAllowance;
  return <aside id="school-account" className={styles.account} aria-label={t("Current HON subscription")} aria-busy={billing.loading || billing.posting}>
    <div className={styles.accountHeader}><div><span className={styles.tag}>{t("YOUR SCHOOL ACCOUNT")}</span><h2 id="school-account-title" tabIndex={-1}>{billing.loading ? t("Checking school billing…") : account ? t("Your HON subscription") : t("School billing unavailable")}</h2></div><button type="button" className={styles.secondary} disabled={billing.loading || billing.posting} onClick={() => void billing.refresh()}>{t("Refresh payment status")}</button></div>
    {(error || commandError) && <p role="alert" className={styles.error}>{text(commandError ?? error ?? '')}</p>}
    {billing.pendingAttempt && <p className={styles.small}>{t("An unresolved request keeps its original retry key on this page. Refresh before explicitly retrying the same offer. Do not start a second purchase.")}</p>}
    {!billing.loading && !account && <p>{t("Account facts were cleared. No subscription, payment, access or balance is assumed.")}</p>}
    {account && <>
      <p><span className={styles.unavailable}>{account.plan.payments.status === 'TEST_MODE' ? t("TEST MODE • No live payments") : t("Checkout disabled")}</span></p>
      <SchoolAccessStatus account={account}/>
      {status && <div className={styles.checkoutStatus} role="status"><strong>{labels[status]}</strong><p>{t("Reason code")}: <code>{checkout!.statusReason}</code> · {t("Test mode")}{simulated ? t(" · Deterministic simulator, not Stripe sandbox") : t(" · Stripe provider")}</p>
        {status === 'OPEN' && <>
          <p>{t("Returning here or opening a hosted session does not confirm payment. Refresh after checkout.")}</p>
          {hosted ? <a className={styles.primary} href={hosted} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t("Continue on Stripe test checkout ↗")}</a> : <p>{simulated ? t("Simulator session recorded. No real Stripe checkout is connected for this session.") : t("Test checkout is unavailable while payments are disabled. Refresh to verify the current payment program.")}</p>}
          <p className={styles.small}>{t("Recorded expiry: {date}. Only HON can confirm expiry or payment.",{date:date(checkout!.expiresAt)})}</p>
        </>}
        {status === 'CREATED' && <p>{t("The provider session is not confirmed. Refresh and use an explicit same-request retry if available. If this page was reloaded and the retry key is unavailable, contact HON support.")}</p>}
        {status === 'PAID_NEEDS_REVIEW' && <p>{t("Do not purchase again. HON must review this payment before any outcome is assumed.")}</p>}
        {['CANCELLED', 'EXPIRED', 'FAILED'].includes(status) && <p>{t("This checkout did not establish a verified purchase. Review refreshed offers before starting another test checkout.")}</p>}
      </div>}
      {sub ? <dl className={styles.facts}>
        <div><dt>{t("Recorded subscription")}</dt><dd>HON {sub.planCode} · {statusText(sub.status)}</dd></div>
        <div><dt>{t("Payment status")}</dt><dd>{statusText(sub.paymentStatus)} · {account.plan.paymentVerification === 'HQ_ATTESTED' ? t("Manual HON attestation; not provider verified") : account.plan.paymentVerification === 'PROVIDER_VERIFIED' ? t("Provider verified · test mode") : t("No current paid verification")}</dd></div>
        <div><dt>{t("Recorded price")}</dt><dd>{sub.priceMinor === null ? t("Unavailable") : `${money(sub.priceMinor)} USD`} · {sub.billingInterval === 'LIFETIME' ? t("One-time lifetime purchase") : sub.billingInterval === 'MONTHLY' ? t("Monthly") : t("Legacy interval")}</dd></div>
        <div><dt>{t("Founder status")}</dt><dd>{text(OFFER_CHOICES.find((o) => o.kind === sub.offerKind)?.label ?? 'Legacy subscription')}{sub.founderReservationId ? t(" · Reservation recorded") : ''}</dd></div>
        <div><dt>{t("Current service period")}</dt><dd>{sub.currentPeriod ? `${date(sub.currentPeriod.startsAt)} → ${sub.currentPeriod.endsAt ? date(sub.currentPeriod.endsAt) : t("No period end recorded (lifetime)")}` : t("Not started")}</dd></div>
        <div><dt>{t("Paid through")}</dt><dd>{sub.paidThroughAt ? date(sub.paidThroughAt) : sub.billingInterval === 'LIFETIME' && verified ? t("Verified one-time test payment; no monthly paid-through date") : t("Unavailable")}</dd></div>
      </dl> : <p>{t("No current subscription was returned by the authorized billing service.")}</p>}
      <section className={styles.creditPanel} aria-labelledby="credit-title"><h3 id="credit-title">{t("Monthly AI allowance")}</h3>
        <SchoolCreditStatus account={account} credits={credits} error={creditError}/>
        {balance ? <><p>{statusText(balance.status)} · {t("Credit program")}: {statusText(credits!.programStatus)} · {date(balance.periodStart)} → {date(balance.periodEnd)}</p><dl className={styles.facts}><div><dt>{t("Allowance")}</dt><dd>{balance.balance.allowanceCredits.toLocaleString(formattingLocale)}</dd></div><div><dt>{t("Consumed")}</dt><dd>{balance.balance.consumedCredits.toLocaleString(formattingLocale)}</dd></div><div><dt>{t("Reserved")}</dt><dd>{balance.balance.heldCredits.toLocaleString(formattingLocale)}</dd></div><div><dt>{t("Remaining per ledger")}</dt><dd>{balance.balance.availableCredits.toLocaleString(formattingLocale)}</dd></div></dl><p className={styles.small}>{t("Credit records do not prove account activation. Top-ups remain unavailable.")}</p></> : <p>{creditError ? text(creditError) : credits ? t("No current allowance returned · {program} program. Planned plan credits are not a granted balance.",{program:statusText(credits.programStatus)}) : t("Checking independently authorized allowance…")}</p>}
      </section>
      <SchoolReadinessNextSteps account={account}/>
      <details className={styles.invoice}><summary>{t("Invoice access and school identity")}</summary>{checkout?.invoiceId && <p>{t("Recorded HON invoice reference:")}{" "}<code>{checkout.invoiceId}</code></p>}<p>{t("School invoice details and download are unavailable here. A recorded invoice ID is not a receipt or a proof of payment. School-to-family billing is separate.")}</p><p>{t("Verified school reference:")}{" "}<code>{account.context.schoolId}</code></p></details>
      {checkedAt && <p className={styles.small}>{t("Last checked in this browser: {date}",{date:date(checkedAt)})}</p>}
    </>}
  </aside>;
}
