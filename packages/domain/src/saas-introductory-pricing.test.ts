import { describe, expect, it } from 'vitest';
import { HON_OS_LAUNCH_PRICING_REFERENCE, SAAS_SCHEDULED_OFFER_KINDS, SAAS_PRICE_SCHEDULE_CONFIRMATION,
  proposedHonOsLaunchPriceSchedule, validateSaasPriceScheduleTermsV1, validateSaasPriceScheduleAcknowledgementInput } from '@hon/contracts';
import { previewSaasScheduledPeriodPrice, previewSaasPriceScheduleSavings } from './saas-introductory-pricing.js';

describe('HON OS introductory-price contract foundation (not a purchasing runtime)', () => {
  it.each([
    ['REGULAR_MONTHLY', 24_900, 0, 24_900, 'MONTHLY'], ['REGULAR_ANNUAL', 209_700, 0, 209_700, 'ANNUAL'],
    ['FOUNDER_MONTHLY', 19_920, 12, 24_900, 'MONTHLY'], ['FOUNDER_ANNUAL', 149_400, 1, 209_700, 'ANNUAL'],
  ])('represents explicit launch terms for %s', (kind, initial, periods, renewal, interval) => {
    const terms = proposedHonOsLaunchPriceSchedule(kind);
    expect(terms).toMatchObject({ productCode: 'HON_OS', currency: 'USD', initialPriceMinor: initial,
      introductoryPaidPeriods: periods, renewalPriceMinor: renewal, billingInterval: interval,
      periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS', discountStacking: 'FORBIDDEN', existingCustomerPrices: 'UNCHANGED' });
    expect(Object.isFrozen(terms)).toBe(true);
  });

  it.each([null, undefined, 'ESSENTIAL', 'CORE', 'COMPLETE', 'LIFETIME', 'FOUNDER_LIFETIME', 'founder_monthly'])('refuses new-sale selector %s', kind => {
    expect(() => proposedHonOsLaunchPriceSchedule(kind)).toThrow('INVALID_SAAS_PRICE_SCHEDULE');
  });

  it.each([
    { schemaVersion: 2 }, { productCode: 'COMPLETE' }, { currency: 'KRW' }, { offerKind: 'FOUNDER_LIFETIME' },
    { billingInterval: 'ANNUAL' }, { introductoryPaidPeriods: 11 }, { introductoryPaidPeriods: 13 },
    { introductoryPaidPeriods: '12' }, { initialPriceMinor: 19_920.5 }, { initialPriceMinor: 0 },
    { initialPriceMinor: -1 }, { initialPriceMinor: '19920' }, { initialPriceMinor: 10_000_001 },
    { renewalPriceMinor: null }, { renewalPriceMinor: Infinity }, { renewalPriceMinor: 19_920 },
    { monthlyListReferenceMinor: 19_920 }, { monthlyListReferenceMinor: NaN },
    { renewalPriceRule: 'AUTO_RENEW_AT_CURRENT_PRICE' }, { periodCountingRule: 'ELAPSED_CALENDAR_MONTHS' },
    { discountStacking: 'ALLOWED' }, { promotionReuse: 'RESET_ON_RESUBSCRIPTION' }, { existingCustomerPrices: 'REPRICE' },
    { paidPeriods: 12 }, { priceMinor: 19_920 }, { trialApproved: true }, { creditsGranted: 12_000 }, { paymentVerified: true },
  ])('refuses unsupported/unsafe terms %j', patch => {
    expect(() => validateSaasPriceScheduleTermsV1({ ...proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY'), ...patch })).toThrow();
  });

  it('requires exact non-promotional terms and the correct annual introductory count', () => {
    const regular = proposedHonOsLaunchPriceSchedule('REGULAR_MONTHLY');
    expect(() => validateSaasPriceScheduleTermsV1({ ...regular, renewalPriceMinor: 25_000 })).toThrow();
    expect(() => validateSaasPriceScheduleTermsV1({ ...regular, monthlyListReferenceMinor: 25_000 })).toThrow();
    expect(() => validateSaasPriceScheduleTermsV1({ ...regular, introductoryPaidPeriods: 1 })).toThrow();
    expect(() => validateSaasPriceScheduleTermsV1({ ...proposedHonOsLaunchPriceSchedule('FOUNDER_ANNUAL'), introductoryPaidPeriods: 12 })).toThrow();
  });

  it('copies terms defensively; a later configuration cannot alter an earlier normalized schedule', () => {
    const source = { ...proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY') };
    const original = validateSaasPriceScheduleTermsV1(source);
    source.initialPriceMinor = 18_000;
    expect(original.initialPriceMinor).toBe(19_920);
    const changed = validateSaasPriceScheduleTermsV1({ ...source, renewalPriceMinor: 25_000 });
    expect(changed.initialPriceMinor).toBe(18_000); expect(changed.renewalPriceMinor).toBe(25_000);
    expect(original.renewalPriceMinor).toBe(24_900);
    expect(Object.isFrozen(HON_OS_LAUNCH_PRICING_REFERENCE)).toBe(true);
    expect(Object.isFrozen(SAAS_SCHEDULED_OFFER_KINDS)).toBe(true);
  });

  it.each([[1, 19_920, 'INTRODUCTORY'], [11, 19_920, 'INTRODUCTORY'], [12, 19_920, 'INTRODUCTORY'],
    [13, 24_900, 'STANDARD'], [14, 24_900, 'STANDARD']])('forecasts monthly paid-period %i without advancing a counter', (ordinal, price, phase) => {
    const terms = proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY');
    const first = previewSaasScheduledPeriodPrice(terms, ordinal);
    expect(first).toMatchObject({ priceMinor: price, phase, standardPriceBeginsAtPaidPeriod: 13,
      scenario: 'HYPOTHETICAL_PAID_PERIOD', effect: 'NO_SIDE_EFFECTS', purchaseAvailable: false, paymentAuthorized: false, accessGranted: false });
    expect(previewSaasScheduledPeriodPrice(terms, ordinal)).toEqual(first);
    expect(terms.introductoryPaidPeriods).toBe(12);
  });

  it.each([[1, 149_400], [2, 209_700], [3, 209_700]])('forecasts founder annual paid-period %i at the explicit price', (ordinal, price) => {
    expect(previewSaasScheduledPeriodPrice(proposedHonOsLaunchPriceSchedule('FOUNDER_ANNUAL'), ordinal))
      .toMatchObject({ priceMinor: price, standardPriceBeginsAtPaidPeriod: 2, purchaseAvailable: false });
  });

  it.each([null, undefined, 0, -1, 1.5, '13', true, Infinity, NaN, 1_000_000_000, { verifiedPaidPeriods: 12 }, { successUrl: true }])('rejects invented or malformed period input %j', ordinal => {
    expect(() => previewSaasScheduledPeriodPrice(proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY'), ordinal)).toThrow('INVALID_PAID_PERIOD_PREVIEW');
  });

  it('keeps $2,097 authoritative and the 50% founder reference distinct from standard annual pricing', () => {
    const annual = previewSaasPriceScheduleSavings(proposedHonOsLaunchPriceSchedule('REGULAR_ANNUAL'));
    expect(annual).toMatchObject({ listReferenceMinor: 298_800, initialPriceMinor: 209_700,
      initialSavingsMinor: 89_100, initialSavingsBasisPoints: 2982, comparisonBasis: 'TWELVE_MONTHLY_LIST_PAYMENTS' });
    expect(annual.initialPriceMinor).not.toBe(298_800 * 0.7);
    expect(previewSaasPriceScheduleSavings(proposedHonOsLaunchPriceSchedule('FOUNDER_ANNUAL')))
      .toMatchObject({ listReferenceMinor: 298_800, initialPriceMinor: 149_400, initialSavingsBasisPoints: 5000,
        renewalPriceMinor: 209_700, renewalSavingsBasisPoints: 2982 });
    expect(previewSaasPriceScheduleSavings(proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY')).initialSavingsBasisPoints).toBe(2000);
  });

  it('does not disguise an HQ-configured annual premium as savings or alter configured cents', () => {
    const terms = validateSaasPriceScheduleTermsV1({ ...proposedHonOsLaunchPriceSchedule('REGULAR_ANNUAL'),
      initialPriceMinor: 300_001, renewalPriceMinor: 300_001 });
    expect(previewSaasPriceScheduleSavings(terms)).toMatchObject({ initialPriceMinor: 300_001, initialSavingsMinor: -1201,
      initialSavingsBasisPoints: -40, purchaseAvailable: false });
  });

  it('represents an explicit acknowledgement intention, never a payment or consent receipt', () => {
    const input = { scheduleDigest: 'a'.repeat(64), confirmation: SAAS_PRICE_SCHEDULE_CONFIRMATION };
    const checked = validateSaasPriceScheduleAcknowledgementInput(input);
    input.scheduleDigest = 'b'.repeat(64);
    expect(checked.scheduleDigest).toBe('a'.repeat(64)); expect(Object.isFrozen(checked)).toBe(true);
    for (const patch of [{ scheduleDigest: 'bad' }, { confirmation: 'I_ACCEPT' }, { paid: true }, { consentRecorded: true }, { schoolId: 'selected-school' }]) {
      expect(() => validateSaasPriceScheduleAcknowledgementInput({ ...checked, ...patch })).toThrow();
    }
    expect(HON_OS_LAUNCH_PRICING_REFERENCE).toMatchObject({ proposedTrialDays: 14, founderOrganizationLimit: 50,
      newLifetimeSales: false, published: false, purchasingEnabled: false });
  });
});
