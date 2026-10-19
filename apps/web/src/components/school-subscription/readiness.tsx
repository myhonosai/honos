import React from 'react';
import type { SaasSchoolCredits } from '@hon/contracts';
import type { SchoolAccount } from './http';
import styles from './subscription.module.css';

/** Presentation of independent B5/B3 facts, never an effective-access decision or a new backend state. */
export function SchoolAccessStatus({ account }: { account: SchoolAccount }): React.ReactElement {
  const { subscription: sub, entitlementTier: tier, checkout, paymentVerification } = account.plan;
  const verified = sub?.paymentStatus === 'PAID' && paymentVerification === 'PROVIDER_VERIFIED';
  const suspended = sub?.status === 'SUSPENDED';
  const pending = sub?.status === 'PENDING_ACTIVATION' || verified && sub?.status !== 'VOIDED' && !suspended;
  const title = suspended ? 'Subscription suspended' : sub?.status === 'VOIDED' ? 'Subscription voided'
    : pending ? 'Pending Account Activation' : sub?.status === 'IN_SERVICE' ? 'Service recorded; access unconfirmed' : 'Activation not confirmed';
  return <section className={styles.activation} aria-label="Account activation" role="status">
    <strong>{verified ? checkout?.provider === 'STRIPE_SIMULATED' ? 'Simulator-verified test payment' : 'Provider-verified test payment' : 'PAYMENT AND ACCOUNT ACCESS ARE SEPARATE'}</strong>
    <h3>{title}</h3>
    <p>{suspended ? 'The billing service reports this subscription as suspended. A paid record does not prove reactivation. No account changes are made here.'
      : pending ? 'Payment verification does not activate or change your school’s features. Purchase-based account activation is awaiting confirmation.'
      : 'Subscription service records and payment evidence do not confirm effective feature access. No account changes are made here.'}</p>
    <p className={styles.small}>Reported provisioned tier: <strong>{tier ?? 'Unavailable'}</strong> · Recorded subscription plan: <strong>{sub?.planCode ?? 'None returned'}</strong>.</p>
    {sub && tier !== sub.planCode && <p className={styles.error}>The reported tier and subscription plan differ. Contact HON support; this page cannot change either record.</p>}
    <p className={styles.small}>Effective feature access: unavailable in this billing response. Existing permissions remain enforced independently.</p>
  </section>;
}

export function SchoolCreditStatus({ account, credits, error }: { account: SchoolAccount; credits: SaasSchoolCredits | null; error: string | null }): React.ReactElement {
  const sub = account.plan.subscription, allowance = credits?.currentAllowance;
  let label: string, detail: string;
  if (!credits) { label = error ? 'AI allowance status unavailable' : 'Checking AI allowance status…'; detail = error ? 'The independently authorized credit response could not be verified. No balance or suspension state is assumed.' : 'Waiting for the independently authorized credit service.'; }
  else if (sub?.status === 'SUSPENDED') { label = 'Subscription suspended'; detail = 'Any balance below is a recorded balance, not permission to spend credits or proof of reactivation.'; }
  else if (sub?.status !== 'IN_SERVICE') { label = 'No in-service subscription confirmed'; detail = 'A planning allowance or payment record does not grant premium usage.'; }
  else if (credits.programStatus === 'INACTIVE') { label = 'Premium credit program inactive'; detail = 'Any recorded balance is not a usable spending authorization while the program is inactive.'; }
  else if (!allowance) { label = 'Allowance not issued'; detail = 'No current allowance was returned. Expected plan credits are not a granted balance.'; }
  else if (allowance.status === 'EXPIRED') { label = 'Allowance expired'; detail = 'Expired records do not authorize premium usage. Refresh for a current allowance.'; }
  else if (allowance.balance.availableCredits === 0) { label = 'No remaining ledger credits'; detail = 'The ledger reports zero available credits. Top-ups remain unavailable.'; }
  else { label = 'Allowance recorded'; detail = 'Ledger balance only. Each premium request still requires independent server authorization; no provider or feature availability is promised.'; }
  return <div className={styles.readinessStatus} role="status" aria-label="AI allowance readiness"><strong>{label}</strong><p>{detail}</p>{credits && <p className={styles.small}>Credit program: {credits.programStatus} · Subscription: {credits.subscriptionStatus ?? 'None returned'} · Allowance: {allowance?.status ?? 'None returned'}.</p>}</div>;
}

export function SchoolReadinessNextSteps({ account }: { account: SchoolAccount }): React.ReactElement {
  const sub = account.plan.subscription;
  return <details className={styles.invoice}>
    <summary>Account readiness and next steps</summary>
    <dl className={styles.facts}>
      <div><dt>Payment and service</dt><dd>{sub ? `${sub.paymentStatus.replaceAll('_', ' ')} payment record · ${sub.status.replaceAll('_', ' ')} subscription` : 'No current subscription returned'}. Refresh payment status to verify changes.</dd></div>
      <div><dt>Feature activation and reactivation</dt><dd>Unavailable here. HON must confirm effective access separately; payment does not activate features or clear a suspension.</dd></div>
      <div><dt>School invoice history and detail</dt><dd>Unavailable until the independently school-authorized invoice service is available. An invoice reference is not a receipt.</dd></div>
      <div><dt>Purchasing for another school</dt><dd>Unavailable here. This page uses only the current server-resolved school; reporting selections and URL identifiers do not authorize purchasing.</dd></div>
    </dl>
    <p className={styles.small}>Contact HON support about activation or mismatched records. Do not make another purchase to resolve access, a disputed payment or an unresolved checkout.</p>
  </details>;
}
