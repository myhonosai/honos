const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const c = require('@hon/contracts');
const { SaasPaymentsService } = require('../dist/payments/saas-payments.service.js');

test('Commercial A1: existing offer drafts cannot silently accept scheduled-price fields', () => {
  const oldOffer = { offerCode: 'FOUNDER_MONTHLY', offerKind: 'FOUNDER_MONTHLY', displayName: 'Synthetic fixture only',
    priceMinor: 19920, salesOpensAt: null, salesClosesAt: null, eligibility: 'NEW_ORGANIZATIONS_ONLY', saleLimit: 50,
    priceLock: 'FIXED_MONTHS', priceLockMonths: 12, annualRenewal: null, plannedMonthlyPremiumCredits: null,
    aiFairUseReference: null, refundWindowDays: 30, cancellationTiming: 'END_OF_PAID_PERIOD' };
  const input = { basedOnSetId: null, termsReference: 'SYNTHETIC_REFERENCE', founderTotalLimit: 50, offers: [oldOffer] };
  assert(c.validateSaasHonOsOfferSetDraftInput(input)); // Historical v1 remains unchanged, NOT an intro schedule.
  const schedule = c.proposedHonOsLaunchPriceSchedule('FOUNDER_MONTHLY');
  for (const extra of [{ priceSchedule: schedule }, { renewalPriceMinor: 24900 }, { introductoryPaidPeriods: 12 }]) {
    assert.throws(() => c.validateSaasHonOsOfferSetDraftInput({ ...input, offers: [{ ...oldOffer, ...extra }] }));
    assert.throws(() => c.validateSaasHonOsOfferSetDraftInput({ ...input, ...extra }));
  }
  assert.throws(() => c.validateSaasHonOsOfferSetDraftInput({ ...input, offers: [schedule] }));
});

test('Commercial A1: checkout rejects schedule, acknowledgement and payment claims before DB or provider calls', async () => {
  let databaseCalls = 0, providerCalls = 0;
  const billing = { call() { databaseCalls++; throw Error('Must not reach database'); } };
  const provider = { createCheckoutSession() { providerCalls++; throw Error('Must not reach provider'); } };
  const payments = new SaasPaymentsService(billing, {}, provider);
  const body = { offerId: randomUUID() };
  for (const extra of [{ priceSchedule: c.proposedHonOsLaunchPriceSchedule('FOUNDER_ANNUAL') },
    { renewalPriceMinor: 209700 }, { priceMinor: 149400 }, { introductoryPaidPeriods: 1 },
    { scheduleDigest: 'a'.repeat(64), confirmation: c.SAAS_PRICE_SCHEDULE_CONFIRMATION },
    { providerScheduleVerified: true }, { paid: true }, { entitlementActive: true }, { founderSlotReserved: true }]) {
    await assert.rejects(payments.startSchoolHonOsCheckout('synthetic-subject', randomUUID(), { ...body, ...extra }, randomUUID()),
      error => error.getStatus() === 400);
  }
  assert.equal(databaseCalls, 0); assert.equal(providerCalls, 0);
});

test('Commercial A1: proposal contracts create no new purchase capability or legacy product selection', () => {
  assert.deepEqual([...c.SAAS_SCHEDULED_OFFER_KINDS], ['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL']);
  for (const kind of c.SAAS_SCHEDULED_OFFER_KINDS) {
    const terms = c.proposedHonOsLaunchPriceSchedule(kind);
    assert.equal(terms.productCode, 'HON_OS'); assert.equal(terms.discountStacking, 'FORBIDDEN');
    assert.equal(terms.periodCountingRule, 'DISTINCT_VERIFIED_PAID_PERIODS');
    assert.equal(terms.existingCustomerPrices, 'UNCHANGED');
  }
  // Historical API kinds and original lifetime receipts are intentionally still readable.
  assert(c.SAAS_HON_OS_OFFER_KINDS.includes('LIFETIME'));
  assert(c.SAAS_HON_OS_OFFER_KINDS.includes('FOUNDER_LIFETIME'));
  assert.equal(c.HON_OS_LAUNCH_PRICING_REFERENCE.purchasingEnabled, false);
});
