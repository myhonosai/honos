import { validateSaasPriceScheduleTermsV1 } from '@hon/contracts';

/** NON-OPERATIONAL arithmetic preview. The ordinal is hypothetical, never an official payment counter. */
export function previewSaasScheduledPeriodPrice(value: unknown, hypotheticalPaidPeriodNumber: unknown) {
  const terms = validateSaasPriceScheduleTermsV1(value);
  if (!Number.isSafeInteger(hypotheticalPaidPeriodNumber) || (hypotheticalPaidPeriodNumber as number) < 1
    || (hypotheticalPaidPeriodNumber as number) > 999_999_999) throw new Error('INVALID_PAID_PERIOD_PREVIEW');
  const ordinal = hypotheticalPaidPeriodNumber as number;
  const introductory = terms.introductoryPaidPeriods > 0 && ordinal <= terms.introductoryPaidPeriods;
  return Object.freeze({
    scenario: 'HYPOTHETICAL_PAID_PERIOD' as const, hypotheticalPaidPeriodNumber: ordinal,
    phase: introductory ? 'INTRODUCTORY' as const : 'STANDARD' as const,
    priceMinor: introductory ? terms.initialPriceMinor : terms.renewalPriceMinor, currency: terms.currency,
    billingInterval: terms.billingInterval, introductoryPaidPeriods: terms.introductoryPaidPeriods,
    standardPriceBeginsAtPaidPeriod: terms.introductoryPaidPeriods + 1,
    purchaseAvailable: false as const, paymentAuthorized: false as const, accessGranted: false as const,
    effect: 'NO_SIDE_EFFECTS' as const,
    unavailableReason: 'DATABASE_ACCEPTANCE_AND_PROVIDER_SCHEDULE_BINDING_NOT_IMPLEMENTED' as const,
  });
}

/** Integer display arithmetic only. The configured annual price is never recomputed from a discount percentage. */
export function previewSaasPriceScheduleSavings(value: unknown) {
  const terms = validateSaasPriceScheduleTermsV1(value);
  const listReferenceMinor = terms.monthlyListReferenceMinor * (terms.billingInterval === 'ANNUAL' ? 12 : 1);
  const initialSavingsMinor = listReferenceMinor - terms.initialPriceMinor;
  const renewalSavingsMinor = listReferenceMinor - terms.renewalPriceMinor;
  // Basis points rounded to nearest, ties away from zero; retained ratios are exact for other display formats.
  const basisPoints = (amount: number) => Math.sign(amount)
    * Math.floor((Math.abs(amount) * 10_000 + listReferenceMinor / 2) / listReferenceMinor);
  return Object.freeze({
    listReferenceMinor, initialPriceMinor: terms.initialPriceMinor, renewalPriceMinor: terms.renewalPriceMinor,
    initialSavingsMinor, renewalSavingsMinor, initialSavingsBasisPoints: basisPoints(initialSavingsMinor),
    renewalSavingsBasisPoints: basisPoints(renewalSavingsMinor), currency: terms.currency,
    comparisonBasis: terms.billingInterval === 'ANNUAL' ? 'TWELVE_MONTHLY_LIST_PAYMENTS' as const : 'ONE_MONTHLY_LIST_PAYMENT' as const,
    priceAuthority: 'EXPLICIT_MINOR_UNIT_AMOUNTS' as const, purchaseAvailable: false as const,
  });
}
