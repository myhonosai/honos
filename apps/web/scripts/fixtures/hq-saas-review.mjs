/** Synthetic authorized localhost fixtures only. Never imported by application code. */
import { SAAS_PLAN_CAPABILITIES, SAAS_POLICY_CODES } from '@hon/contracts';
export const saasId = (id) => `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const at = '2026-10-01T00:00:00.000Z';
const program = { status: 'INACTIVE', version: 3, authorizationReference: 'Synthetic prior deactivation', changedAt: at, topUps: 'UNAVAILABLE', overage: 'DISABLED', purchases: 'DISABLED' };
export function subscriptionFixture(id = 1) {
  const planCode = id === 2 ? 'COMPLETE' : id === 4 ? 'ESSENTIAL' : 'CORE';
  const offerKind = id === 4 ? null : id === 3 ? 'FOUNDER_LIFETIME' : id === 2 ? 'FOUNDER_MONTHLY' : 'REGULAR_MONTHLY';
  const pending = id === 4;
  return { subscriptionId: saasId(100 + id), organizationId: saasId(id), organizationName: `HON ${['Cedar', 'Summit', 'Harbor', 'Legacy'][id - 1]} Organization · fixture`,
    source: pending ? 'LEGACY_ENTITLEMENT' : 'CATALOG_OFFER', catalogVersion: pending ? null : 1,
    offerId: pending ? null : saasId(200 + id), planCode, entitlementTier: planCode, offerKind,
    billingInterval: pending ? 'NONE' : id === 3 ? 'LIFETIME' : 'MONTHLY', priceMinor: pending ? null : id === 3 ? 189600 : 14900,
    currency: 'USD', founderReservationId: id === 2 || id === 3 ? saasId(300 + id) : null,
    status: pending ? 'PENDING_ACTIVATION' : id === 3 ? 'SUSPENDED' : 'IN_SERVICE', statusReason: pending ? 'RECORDED' : id === 3 ? 'OWNER_HOLD' : 'SERVICE_STARTED',
    version: 1, serviceStartedAt: pending ? null : at,
    currentPeriod: pending ? null : { index: id === 3 ? null : 0, startsAt: at, endsAt: id === 3 ? null : '2026-11-01T00:00:00.000Z' },
    paymentStatus: 'NOT_BILLED', paidThroughAt: null, chargesEnabled: false,
    premiumCredits: { plannedMonthlyAllowance: pending ? null : id === 2 ? 12000 : 5000, status: 'NOT_GRANTED' }, createdAt: at, updatedAt: at };
}
export function saasOverviewFixture({ status = null, empty = false, updated = false } = {}) {
  return {
    catalog: { published: empty ? null : { catalogId: saasId(400), catalogVersion: 1, status: 'PUBLISHED', currency: 'USD', termsReference: 'Synthetic terms · not customer terms',
      plans: ['ESSENTIAL', 'CORE', 'COMPLETE'].map((code) => ({ planCode: code, entitlementTier: code, availability: code === 'ESSENTIAL' ? 'LEGACY_ONLY' : 'PUBLIC',
        displayName: `HON ${code}`, plannedMonthlyPremiumCredits: code === 'ESSENTIAL' ? null : code === 'CORE' ? 5000 : 12000,
        capabilities: [...SAAS_PLAN_CAPABILITIES[code]], ordinaryUseConsumesCredits: false })),
      offers: [...[1, 2, 3].map((id) => { const s = subscriptionFixture(id); return { offerId: s.offerId, planCode: s.planCode, offerKind: s.offerKind,
        billingInterval: s.billingInterval, priceMinor: s.priceMinor, founder: id !== 1, allowance: 'FULL_MONTHLY_PLAN_ALLOWANCE' }; }),
        { offerId: saasId(204), planCode: 'CORE', offerKind: 'FOUNDER_MONTHLY', billingInterval: 'MONTHLY', priceMinor: 7900, founder: true, allowance: 'FULL_MONTHLY_PLAN_ALLOWANCE' },
        { offerId: saasId(205), planCode: 'COMPLETE', offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', priceMinor: 24900, founder: false, allowance: 'FULL_MONTHLY_PLAN_ALLOWANCE' },
        { offerId: saasId(206), planCode: 'COMPLETE', offerKind: 'FOUNDER_LIFETIME', billingInterval: 'LIFETIME', priceMinor: 357600, founder: true, allowance: 'FULL_MONTHLY_PLAN_ALLOWANCE' }],
      founderProgram: { totalLimit: 50, lifetimeLimit: 20, monthlyLimit: 30, eligibility: 'NO_PRIOR_CATALOG_SUBSCRIPTION', reservationHoldDays: 1, opensAt: at, closesAt: '2026-12-01T00:00:00.000Z' },
      chargesEnabled: false, creditGrantsEnabled: false, createdAt: at, publishedAt: at, retiredAt: null },
      drafts: [], policies: SAAS_POLICY_CODES.map((code) => ({ policyCode: code, status: 'UNDECIDED', decision: null, summary: null, blocks: 'Synthetic unresolved commercial policy', actionsEnabled: false, version: 1 })),
      founderInventory: { status: empty ? 'NOT_PUBLISHED' : 'CONFIGURED', totalLimit: empty ? null : 50, lifetimeLimit: empty ? null : 20, monthlyLimit: empty ? null : 30,
        lifetime: { allocated: empty ? 0 : 2, held: empty ? 0 : 1 }, monthly: { allocated: empty ? 0 : 3, held: empty ? 0 : updated ? 2 : 1 },
        remaining: { total: empty ? null : updated ? 42 : 43, lifetime: empty ? null : 17, monthly: empty ? null : updated ? 25 : 26 } },
      chargesEnabled: false, creditGrantsEnabled: false, paymentProvider: 'NOT_CONFIGURED' },
    subscriptions: { subscriptions: empty ? [] : [1, 2, 3, 4].map(subscriptionFixture).filter((s) => !status || s.status === status), limit: 200, chargesEnabled: false },
    credits: { program: { ...program }, publishedPricing: null, pricingDrafts: [], premiumCreditsFromOrdinaryUse: false,
      costEvidence: empty ? [] : [{ costEvidenceId: saasId(500), providerId: 'HIGGSFIELD', modelCode: 'fixture-image', costUnit: 'IMAGE', measuredUnits: 1000,
        billedCostMicrounits: 40000000, fullyLoadedCostMicrounits: 50000000, fullyLoadedCostMicrounitsPerUnit: 50000,
        source: 'HQ_OWNER_VERIFIED_PROVIDER_BILLING', evidenceReference: 'SYNTHETIC-COST-ONLY', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: at, note: null, verifiedAt: at }] },
  };
}
export function saasAccountFixture({ organizationId = saasId(1), empty = false, updated = false, mismatch = false } = {}) {
  const id = [1, 2, 3, 4].find((n) => saasId(n) === organizationId) ?? 1;
  const s = subscriptionFixture(id);
  const noUsage = empty || id === 4;
  const facts = { firstPaidAt: null, paidThroughAt: null, lifetimePaid: false, paidInvoiceCount: 0, refundedInvoiceCount: 0, chargebackInvoiceCount: 0 };
  const allowanceCredits = id === 2 ? 12000 : 5000;
  return {
    subscription: { organizationId, organizationName: s.organizationName, organizationStatus: 'ACTIVE',
      entitlement: empty ? null : { tier: mismatch ? 'COMPLETE' : s.planCode, status: 'ACTIVE', version: 1, effectiveFrom: at, effectiveUntil: null },
      current: empty ? null : s, alignment: empty ? 'NO_ENTITLEMENT' : mismatch ? 'MISMATCH' : 'ALIGNED', founderReservations: [], chargesEnabled: false,
      history: empty ? [] : [{ subscriptionId: s.subscriptionId, version: 1, status: s.status, statusReason: s.statusReason, periodIndex: null, periodStartsAt: null, periodEndsAt: null, occurredAt: at }] },
    standing: { organizationId, subscriptionId: empty ? null : s.subscriptionId, verified: { ...facts },
      recorded: noUsage ? { ...facts } : { ...facts, firstPaidAt: at, paidInvoiceCount: updated ? 3 : 2 }, evidence: { hqAttested: noUsage ? 0 : 3, providerVerified: 0 },
      championsPaymentSource: 'NOT_CONNECTED', providerVerification: 'NOT_CONFIGURED' },
    credits: { organizationId, subscriptionId: empty ? null : s.subscriptionId, program: { ...program },
      allowances: noUsage ? [] : [{ allowanceId: saasId(600 + id), subscriptionId: s.subscriptionId, organizationId, periodIndex: 0,
        periodStart: at, periodEnd: '2026-11-01T00:00:00.000Z', planCode: s.planCode, allowanceBasis: id === 3 ? 'LIFETIME' : id === 2 ? 'FOUNDER' : 'REGULAR', status: 'OPEN', version: 1,
        balance: { allowanceCredits, consumedCredits: updated ? 1100 : 1000, heldCredits: 200, expiredCredits: 0, availableCredits: allowanceCredits - (updated ? 1300 : 1200), usedPercent: 24 },
        thresholds: [], rollover: 'NONE', topUps: 'UNAVAILABLE', openedAt: at, expiredAt: null }],
      reservations: noUsage ? [] : [{ reservationId: saasId(700 + id), allowanceId: saasId(600 + id), organizationId, schoolId: saasId(800 + id), subscriptionId: s.subscriptionId,
        operationCode: 'image.generate', category: 'IMAGE_GENERATION', creditsPerUnit: 100, estimatedUnits: 2, reservedCredits: 200,
        status: 'OUTCOME_UNKNOWN', statusReason: 'PROVIDER_OUTCOME_UNKNOWN', version: 1, employeeKey: null, actionRequestId: null, workItemId: null,
        finalUnits: null, finalCredits: null, reservedAt: at, settledAt: null, providerId: 'HIGGSFIELD', modelCode: 'fixture-image', providerCostMicrounits: null, usageId: null, resolutionReference: null }],
      ordinaryUsageThisMonth: { events: noUsage ? 0 : 12, providerCostMicrounits: noUsage ? 0 : 1234567, premiumDeduction: 'NONE' } },
  };
}
