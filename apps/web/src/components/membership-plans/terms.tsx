'use client';
import React from 'react';
import type { MembershipPlanVersionSummary } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { FREQUENCY_LABELS, planTerm } from './presentation';
import styles from './plans.module.css';

export function MembershipPlanTerms({ plan, programName }: { plan: MembershipPlanVersionSummary; programName?: string | null }): React.ReactElement {
  const { money, date } = useLocale();
  return <div className={styles.terms}>
    <p className={styles.price}><strong>{money(plan.priceMinor, plan.currency)}</strong> <span>{plan.currency} · {FREQUENCY_LABELS[plan.billingFrequency]}{plan.billingFrequency === 'PAID_IN_FULL' ? ' for the fixed term' : ' per billing period'}</span></p>
    {plan.description && <p>{plan.description}</p>}
    <dl><div><dt>Plan code</dt><dd>{plan.planCode}</dd></div><div><dt>Published version</dt><dd>{plan.version}</dd></div>
      <div><dt>Membership term</dt><dd>{planTerm(plan)}</dd></div><div><dt>Availability</dt><dd>{plan.availability === 'AVAILABLE' ? 'Available' : 'Unavailable'}</dd></div>
      <div><dt>Program</dt><dd>{programName ?? (plan.programId ? 'Selected school program; name unavailable in this receipt' : 'No program assigned')}</dd></div><div><dt>Published</dt><dd>{date(plan.publishedAt)}</dd></div></dl>
  </div>;
}
