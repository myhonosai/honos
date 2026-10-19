import { useLocale } from '../localization/provider';
import React from 'react';
import type { SaasSchoolCredits } from '@hon/contracts';
import type { SchoolAccount } from './http';
import styles from './subscription.module.css';

/** Presentation of independent B5/B3 facts, never an effective-access decision or a new backend state. */
export function SchoolAccessStatus({ account }: { account: SchoolAccount }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale,statusText } = useLocale();
  const { subscription: sub, entitlementTier: tier, checkout, paymentVerification } = account.plan;
  const verified = sub?.paymentStatus === 'PAID' && paymentVerification === 'PROVIDER_VERIFIED';
  const suspended = sub?.status === 'SUSPENDED';
  const pending = sub?.status === 'PENDING_ACTIVATION' || verified && sub?.status !== 'VOIDED' && !suspended;
  const title = suspended ? t("Subscription suspended") : sub?.status === 'VOIDED' ? t("Subscription voided")
    : pending ? t("Pending Account Activation") : sub?.status === 'IN_SERVICE' ? t("Service recorded; access unconfirmed") : t("Activation not confirmed");
  return <section className={styles.activation} aria-label={t("Account activation")} role="status">
    <strong>{verified ? checkout?.provider === 'STRIPE_SIMULATED' ? t("Simulator-verified test payment") : t("Provider-verified test payment") : t("PAYMENT AND ACCOUNT ACCESS ARE SEPARATE")}</strong>
    <h3>{title}</h3>
    <p>{suspended ? t("The billing service reports this subscription as suspended. A paid record does not prove reactivation. No account changes are made here.")
      : pending ? t("Payment verification does not activate or change your school’s features. Purchase-based account activation is awaiting confirmation.")
      : t("Subscription service records and payment evidence do not confirm effective feature access. No account changes are made here.")}</p>
    <p className={styles.small}>{t("Reported provisioned tier:")}{" "}<strong>{tier ?? t("Unavailable")}</strong>{" "}{t("· Recorded subscription plan:")}{" "}<strong>{sub?.planCode ?? t("None returned")}</strong>.</p>
    {sub && tier !== sub.planCode && <p className={styles.error}>{t("The reported tier and subscription plan differ. Contact HON support; this page cannot change either record.")}</p>}
    <p className={styles.small}>{t("Effective feature access: unavailable in this billing response. Existing permissions remain enforced independently.")}</p>
  </section>;
}

export function SchoolCreditStatus({ account, credits, error }: { account: SchoolAccount; credits: SaasSchoolCredits | null; error: string | null }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale,statusText } = useLocale();
  const sub = account.plan.subscription, allowance = credits?.currentAllowance;
  let label: string, detail: string;
  if (!credits) { label = error ? t("AI allowance status unavailable") : t("Checking AI allowance status…"); detail = error ? t("The independently authorized credit response could not be verified. No balance or suspension state is assumed.") : t("Waiting for the independently authorized credit service."); }
  else if (sub?.status === 'SUSPENDED') { label = t("Subscription suspended"); detail = t("Any balance below is a recorded balance, not permission to spend credits or proof of reactivation."); }
  else if (sub?.status !== 'IN_SERVICE') { label = t("No in-service subscription confirmed"); detail = t("A planning allowance or payment record does not grant premium usage."); }
  else if (credits.programStatus === 'INACTIVE') { label = t("Premium credit program inactive"); detail = t("Any recorded balance is not a usable spending authorization while the program is inactive."); }
  else if (!allowance) { label = t("Allowance not issued"); detail = t("No current allowance was returned. Expected plan credits are not a granted balance."); }
  else if (allowance.status === 'EXPIRED') { label = t("Allowance expired"); detail = t("Expired records do not authorize premium usage. Refresh for a current allowance."); }
  else if (allowance.balance.availableCredits === 0) { label = t("No remaining ledger credits"); detail = t("The ledger reports zero available credits. Top-ups remain unavailable."); }
  else { label = t("Allowance recorded"); detail = t("Ledger balance only. Each premium request still requires independent server authorization; no provider or feature availability is promised."); }
  return <div className={styles.readinessStatus} role="status" aria-label={t("AI allowance readiness")}><strong>{label}</strong><p>{detail}</p>{credits && <p className={styles.small}>{t("Credit program: {program} · Subscription: {subscription} · Allowance: {allowance}.",{program:statusText(credits.programStatus),subscription:credits.subscriptionStatus ? statusText(credits.subscriptionStatus) : t("None returned"),allowance:allowance ? statusText(allowance.status) : t("None returned")})}</p>}</div>;
}

export function SchoolReadinessNextSteps({ account }: { account: SchoolAccount }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale,statusText } = useLocale();
  const sub = account.plan.subscription;
  return <details className={styles.invoice}>
    <summary>{t("Account readiness and next steps")}</summary>
    <dl className={styles.facts}>
      <div><dt>{t("Payment and service")}</dt><dd>{sub ? t("Payment: {payment} · Subscription: {subscription}. Refresh to verify changes.",{payment:statusText(sub.paymentStatus),subscription:statusText(sub.status)}) : t("No current subscription returned")}</dd></div>
      <div><dt>{t("Feature activation and reactivation")}</dt><dd>{t("Unavailable here. HON must confirm effective access separately; payment does not activate features or clear a suspension.")}</dd></div>
      <div><dt>{t("School invoice history and detail")}</dt><dd>{t("Unavailable until the independently school-authorized invoice service is available. An invoice reference is not a receipt.")}</dd></div>
      <div><dt>{t("Purchasing for another school")}</dt><dd>{t("Unavailable here. This page uses only the current server-resolved school; reporting selections and URL identifiers do not authorize purchasing.")}</dd></div>
    </dl>
    <p className={styles.small}>{t("Contact HON support about activation or mismatched records. Do not make another purchase to resolve access, a disputed payment or an unresolved checkout.")}</p>
  </details>;
}
