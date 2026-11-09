import { id } from './account-status-fixtures';

/** Synthetic HQ creative wallet answers (no real school). One promotional lot, one finished and one unknown-outcome generation. */
export const org = id(1), school = id(2), school2 = id(3), lot = id(60), adj = id(61), res1 = id(62), res2 = id(63), usage = id(64), purchase = id(65), actor = id(9);
const kinds = (promo: Record<string, number>) => ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'].map((kind) => ({ kind, grantedCredits: 0, availableCredits: 0,
  heldCredits: 0, consumedCredits: 0, expiredCredits: 0, debitedCredits: 0, ...(kind === 'PROMOTIONAL' ? promo : {}) }));
export const packages = () => [['STARTER', 3000, 0, 3000], ['GROWTH', 6000, 1200, 6000], ['CREATOR', 12000, 4800, 12000]].map(([packageCode, base, bonus, price]) => ({
  packageCode, packageVersion: 1, baseCredits: base, bonusCredits: bonus, totalCredits: Number(base) + Number(bonus), priceMinor: price, currency: 'usd' }));
export const rates = () => ({ rateVersionId: id(70), rateVersion: 1, termsReference: 'hon-creative-rates/v1', publishedAt: '2026-11-04T10:00:00.000Z',
  rates: [{ operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 20, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL', costEvidenceId: null }] });
export const row = (over: Record<string, unknown> = {}) => ({ schoolId: school, schoolName: 'Synthetic Dojo North', organizationId: org, organizationName: 'Synthetic Martial Arts LLC',
  availableCredits: 440, heldCredits: 20, consumedCredits: 40, actualProviderCostMicrounits: 80_000, outcomeUnknown: 1, unknownCostGenerations: 0,
  updatedAt: '2026-11-08T12:00:00.000Z', ...over });
export const list = (over: Record<string, unknown> = {}) => ({ program: { status: 'INACTIVE', version: 1, monthlyIncludedCredits: 12000 }, rates: rates(), packages: packages(),
  wallets: [row(), row({ schoolId: school2, schoolName: 'Synthetic Dojo South', availableCredits: 0, heldCredits: 0, consumedCredits: 0, actualProviderCostMicrounits: 0, outcomeUnknown: 0 })], ...over });
const reservation = (over: Record<string, unknown>) => ({ schoolId: school, organizationId: org, operationCode: 'image.standard', mediaKind: 'IMAGE', rateBasis: 'PROVISIONAL',
  creditsPerUnit: 20, providerId: 'synthetic-provider', modelCode: 'synthetic-image-1', resolutionReference: null, ...over });
export const wallet = (over: Record<string, unknown> = {}) => ({ schoolId: school, organizationId: org, walletVersion: 3,
  program: { status: 'INACTIVE', monthlyIncludedCredits: 12000 }, eligibility: { eligible: false, reason: 'PROGRAM_INACTIVE', window: null },
  balance: { availableCredits: 440, heldCredits: 20, byKind: kinds({ grantedCredits: 500, availableCredits: 440, heldCredits: 20, consumedCredits: 40 }) },
  lots: [{ lotId: lot, kind: 'PROMOTIONAL', credits: 500, baseCredits: null, bonusCredits: null, window: null, purchaseId: null, adjustmentId: adj, expiresAt: null, expired: false,
    availableCredits: 440, heldCredits: 20, consumedCredits: 40, expiredCredits: 0, debitedCredits: 0, grantedAt: '2026-11-05T10:00:00.000Z' }],
  history: [
    { entryId: id(80), lotId: lot, lotKind: 'PROMOTIONAL', entryKind: 'GRANT', credits: 500, reservationId: null, adjustmentId: adj, occurredAt: '2026-11-05T10:00:00.000Z' },
    { entryId: id(81), lotId: lot, lotKind: 'PROMOTIONAL', entryKind: 'FINALIZE', credits: 40, reservationId: res1, adjustmentId: null, occurredAt: '2026-11-06T10:01:00.000Z' }],
  reservations: [
    reservation({ reservationId: res1, units: 2, reservedCredits: 40, status: 'FINALIZED', statusReason: 'PROVIDER_SUCCEEDED', version: 2, finalUnits: 2, finalCredits: 40,
      lots: [{ lotId: lot, reservedCredits: 40 }], reservedAt: '2026-11-06T10:00:00.000Z', settledAt: '2026-11-06T10:01:00.000Z', costStatus: 'RECORDED',
      providerCostMicrounits: 80_000, costReference: 'synthetic-receipt-1', costRecordedAt: '2026-11-06T10:01:00.000Z', usageId: usage }),
    reservation({ reservationId: res2, units: 1, reservedCredits: 20, status: 'OUTCOME_UNKNOWN', statusReason: 'PROVIDER_OUTCOME_UNKNOWN', version: 2, finalUnits: null, finalCredits: null,
      lots: [{ lotId: lot, reservedCredits: 20 }], reservedAt: '2026-11-07T10:00:00.000Z', settledAt: null, costStatus: 'PENDING', providerCostMicrounits: null, costReference: null,
      costRecordedAt: null, usageId: null })],
  adjustments: [{ adjustmentId: adj, kind: 'PROMOTIONAL_GRANT', credits: 500, lotId: lot, reasonCode: 'PROMOTION', occurredAt: '2026-11-05T10:00:00.000Z',
    note: 'Synthetic launch promotion', actorPrincipalId: actor }],
  purchases: [{ purchaseId: purchase, schoolId: school, packageCode: 'STARTER', packageVersion: 1, baseCredits: 3000, bonusCredits: 0, priceMinor: 3000, currency: 'usd',
    status: 'PENDING_PAYMENT', statusReason: 'AWAITING_VERIFIED_PAYMENT', version: 1, lotId: null, payment: 'NOT_CONNECTED', createdAt: '2026-11-08T09:00:00.000Z', fulfilledAt: null,
    paymentProvider: null, providerPaymentRef: null, paidAmountMinor: null, paidCurrency: null }],
  rates: rates(), packages: packages(), agentConversationsDeductCredits: false, paymentsActive: false,
  providerExpense: { actualProviderCostMicrounits: 80_000, finalizedProviderCostMicrounits: 80_000, failedOrNotChargedProviderCostMicrounits: 0, consumedCredits: 40,
    unknownCostGenerations: 0, pendingCostGenerations: 1, spendClass: 'CREATIVE_MEDIA', generations: { finalized: 1, released: 0, reserved: 0, outcomeUnknown: 1 } }, ...over });
