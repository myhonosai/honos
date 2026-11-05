import { validateSaasSchoolBillingAccount, validateSaasSchoolAccessStanding, validateSaasCreativeSchoolWallet } from '@hon/contracts';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const scope = { organizationId: id(1), schoolId: id(2) }, at = '2026-11-05T12:00:00.000Z';
const facts = () => ({ firstPaidAt: null, paidThroughAt: null, lifetimePaid: false, paidInvoiceCount: 0, refundedInvoiceCount: 0, chargebackInvoiceCount: 0 });
export function rawAccount(suspended = false) {
  return validateSaasSchoolBillingAccount({ ...scope, organizationName: 'PRIVATE organization', billingScope: 'ORGANIZATION', schoolCount: 1,
    entitlement: { tier: 'COMPLETE', status: suspended ? 'SUSPENDED' : 'ACTIVE', effectiveFrom: at, effectiveUntil: null, version: 1, inEffect: !suspended },
    access: { source: 'PROVISIONED', paymentActivated: false, state: 'PROVISIONED', paidAccessProgram: 'INACTIVE', activation: suspended ? 'UNAVAILABLE' : 'READY', alignment: 'NO_SUBSCRIPTION' },
    subscription: null, subscriptionHistory: [], subscriptions: [], payment: { status: 'NOT_BILLED', verification: 'NONE', paidThroughAt: null, unpaidSince: null,
      verified: facts(), recorded: facts(), evidenceCounts: { hqAttested: 0, providerVerified: 0 }, providerVerification: 'NOT_CONFIGURED' },
    allowance: { state: suspended ? 'ACCESS_NOT_ACTIVE' : 'NO_SUBSCRIPTION', programStatus: 'INACTIVE', plannedMonthlyCredits: null, period: null, basis: null,
      grantedCredits: null, consumedCredits: null, reservedCredits: null, remainingCredits: null, usedPercent: null, suspensionPolicy: 'UNDECIDED', topUps: 'UNAVAILABLE' },
    refunds: [], cardDataStored: false, asOf: at });
}
export function rawStanding() { return validateSaasSchoolAccessStanding({ ...scope, state: 'CRM_LOCKED_BILLING_RECOVERY_OPEN', paymentIssue: false,
  paymentStatus: 'NOT_BILLED', renewalDueAt: null, graceEndsAt: null, suspendedAt: at, ownerReadOnlyUntil: at,
  billingRecoveryOpen: true, dataDeletion: 'NEVER', policyVersion: 2, policyStatus: 'PROPOSED', paidAccessProgram: 'INACTIVE', asOf: at }); }
export function rawWallet() { return validateSaasCreativeSchoolWallet({ schoolId: scope.schoolId, walletVersion: null,
  program: { status: 'INACTIVE', monthlyIncludedCredits: 12000 }, eligibility: { eligible: false, reason: 'PROGRAM_INACTIVE', window: null },
  balance: { availableCredits: 0, heldCredits: 0, byKind: ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'].map(kind => ({ kind, grantedCredits: 0, availableCredits: 0, heldCredits: 0, consumedCredits: 0, expiredCredits: 0, debitedCredits: 0 })) },
  lots: [], history: [], reservations: [], adjustments: [], purchases: [], rates: null,
  packages: [['STARTER', 3000, 0, 3000], ['GROWTH', 6000, 1200, 6000], ['CREATOR', 12000, 4800, 12000]].map(([packageCode, base, bonus, price]) => ({ packageCode, packageVersion: 1, baseCredits: base, bonusCredits: bonus, totalCredits: Number(base) + Number(bonus), priceMinor: price, currency: 'usd' })),
  agentConversationsDeductCredits: false, paymentsActive: false }); }
export const reply = (data: unknown, status = 200) => Response.json({ data }, { status, headers: { 'Cache-Control': 'private, no-store' } });
