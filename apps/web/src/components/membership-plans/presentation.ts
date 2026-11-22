import { MEMBERSHIP_PLAN_MAX_PRICE_MINOR, type MembershipPlanVersionSummary, type MembershipPlanBillingFrequency, type MembershipPaymentOption, type MembershipPaymentOptionFrequency } from '@hon/contracts';

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

export const OPTION_FREQUENCY_LABELS: Record<MembershipPaymentOptionFrequency, string> = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUAL: 'Annual', PAID_IN_FULL: 'Paid in full' };
const PER: Record<MembershipPaymentOptionFrequency, string> = { WEEKLY: '/ week', MONTHLY: '/ month', QUARTERLY: '/ quarter', ANNUAL: '/ year', PAID_IN_FULL: 'paid in full' };
/** "$149.00 / month · 6 payments · 6 months · $99.00 down" for one payment option. */
export function optionSummary(option: Pick<MembershipPaymentOption, 'priceMinor' | 'billingFrequency' | 'payments' | 'termMonths' | 'downPaymentMinor'>, currency: string,
  money: (minor: number, currency: string) => string): string {
  const parts = [`${money(option.priceMinor, currency)} ${PER[option.billingFrequency]}`];
  if (option.payments !== null) parts.push(`${option.payments} payment${option.payments === 1 ? '' : 's'}`);
  parts.push(option.termMonths === null ? 'ongoing' : `${option.termMonths} months`);
  if (option.downPaymentMinor !== null) parts.push(`${money(option.downPaymentMinor, currency)} down`);
  return parts.join(' · ');
}
/** A permanent plan code suggested from the plan name: "Little Tigers 6 mo" -> "LITTLE-TIGERS-6-MO". */
export function planCodeFromName(name: string): string {
  return name.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
