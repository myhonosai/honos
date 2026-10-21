import { MEMBERSHIP_PLAN_MAX_PRICE_MINOR, type MembershipPlanVersionSummary, type MembershipPlanBillingFrequency } from '@hon/contracts';

/** Presentation/input conversion only. No price, tax, schedule or invoice calculation. */
export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter a three-letter uppercase currency code.');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
export function priceMinorFromText(value: string, currency: string): number {
  const digits = currencyDigits(currency);
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(value.trim())) throw new Error('Enter a non-negative price using digits and a decimal point.');
  const [whole, fraction = ''] = value.trim().split('.');
  if (fraction.length > digits) throw new Error(`This currency supports ${digits} decimal places.`);
  const minor = BigInt(whole!) * (10n ** BigInt(digits)) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > BigInt(MEMBERSHIP_PLAN_MAX_PRICE_MINOR)) throw new Error('The price exceeds the supported limit.');
  return Number(minor);
}
export function priceTextFromMinor(minor: number, currency: string): string {
  const digits = currencyDigits(currency), scale = 10n ** BigInt(digits), value = BigInt(minor);
  return `${value / scale}${digits ? '.' + String(value % scale).padStart(digits, '0') : ''}`;
}
export const FREQUENCY_LABELS: Record<MembershipPlanBillingFrequency, string> = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', ANNUAL: 'Annual', PAID_IN_FULL: 'Paid in full' };
export function planTerm(plan: Pick<MembershipPlanVersionSummary, 'termKind' | 'termMonths'>): string {
  return plan.termKind === 'FIXED_MONTHS' ? `${plan.termMonths} months` : 'Open ended';
}
