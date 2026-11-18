import type { ParentBillingInvoice, ParentBillingMembership } from '@hon/contracts/parent-billing-view';
import type { ParentClassPass } from '@hon/contracts/parent-classpass-view';
import type { ParentTestingCandidateStatus, ParentTestingInterestStatus } from '@hon/contracts/parent-testing-status';

/** Formats an amount in minor units using the currency's own number of decimals. */
export function formatMoney(amountMinor: number, currency: string): string {
  let format: Intl.NumberFormat;
  try { format = new Intl.NumberFormat('en-US', { style: 'currency', currency }); } catch { return `${amountMinor} ${currency}`; }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amountMinor / 10 ** digits);
}

export function formatDay(iso: string, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return new Intl.DateTimeFormat('en-US', timeZone ? { ...options, timeZone } : options).format(new Date(iso));
}

export const MEMBERSHIP_LABEL: Record<ParentBillingMembership['state'], { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  DRAFT: { text: 'Being set up', tone: 'neutral' }, ACTIVE: { text: 'Active', tone: 'good' }, FROZEN: { text: 'Paused', tone: 'warn' },
  CANCELLATION_PENDING: { text: 'Ending soon', tone: 'warn' }, CANCELLED: { text: 'Cancelled', tone: 'neutral' }, EXPIRED: { text: 'Ended', tone: 'neutral' },
};

/** "Paid" is shown only when HON's invoice record says PAID; a payment attempt alone never makes an invoice paid. */
export const INVOICE_LABEL: Record<ParentBillingInvoice['status'], { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  DRAFT: { text: 'Not issued yet', tone: 'neutral' }, ISSUED: { text: 'Open', tone: 'warn' }, PAID: { text: 'Paid', tone: 'good' },
  VOID: { text: 'Void', tone: 'neutral' }, UNCOLLECTIBLE: { text: 'Contact your school', tone: 'bad' },
};

export const PASS_LABEL: Record<ParentClassPass['status'], string> = { ACTIVE: 'Active', EXHAUSTED: 'All used', REVERSED: 'Reversed', EXPIRED: 'Expired' };

export const CANDIDATE_LABEL: Record<ParentTestingCandidateStatus, string> = {
  PENDING: 'Testing, result pending', PASSED: 'Passed', DEFERRED: 'Deferred', NOT_PASSED: 'Not passed this time', WITHDRAWN: 'Withdrawn',
};
export const INTEREST_LABEL: Record<ParentTestingInterestStatus, string> = {
  SUBMITTED: 'Registration sent, waiting for the school', ACCEPTED: 'Registration accepted', DECLINED: 'Registration declined', WAITLISTED: 'Registration waitlisted',
};

/** Open invoices, for Home and Eian: issued and not paid, void or uncollectible. */
export function openInvoices(invoices: ParentBillingInvoice[]): ParentBillingInvoice[] {
  return invoices.filter(i => i.status === 'ISSUED');
}
