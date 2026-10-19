/** Synthetic authorized localhost fixtures only. Never import from application source. */
export const fixtureId = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
export function schoolDirectoryFixture({ empty = false } = {}) {
  return { schools: empty ? [] : [1, 2].map((id) => ({
    schoolId: fixtureId(id), schoolDisplayName: `${id === 1 ? 'Zeta' : 'Alpha'} School · fixture`,
    organizationDisplayName: `${id === 1 ? 'Zeta' : 'Alpha'} Organization · fixture`,
    organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'CORE',
    createdAt: `2026-08-0${id}T00:00:00.000Z`,
  })) };
}
export function rewardProgramFixture({ empty = false } = {}) {
  return { published: empty ? null : {
    policyId: fixtureId(210), policyVersion: 2, status: 'PUBLISHED',
    referrerCreditMinor: 10000, referrerCreditMaxRank: 4, welcomeCreditMinor: 10000,
    firstFreeMonthsCount: 5, firstFreeMonthsTotal: 6, secondFreeMonthsCount: 10, secondFreeMonthsTotal: 12,
    prizeCount: 20, prizeBudgetMinor: 100000, lifetimeCount: 30, clawbackRule: 'UNDECIDED',
    monthlyRule: 'AS_EARNED', annualRule: 'AS_EARNED', founderRule: 'UNDECIDED', paidLifetimeRule: 'UNDECIDED',
    termsReference: 'Synthetic reward terms · not published customer terms', aiAllowance: 'FULL_PLAN_ALLOWANCE',
    currency: 'USD', financialActivation: 'DISABLED', createdAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-02T00:00:00.000Z',
  }, drafts: [], financialActivation: 'DISABLED' };
}
export function schoolReferralFixture({ schoolId = fixtureId(1), empty = false, updated = false } = {}) {
  const second = schoolId === fixtureId(2);
  const qualified = empty ? 0 : updated ? 9 : 8;
  return {
    schoolId, schoolName: `${second ? 'Alpha' : 'Zeta'} School · fixture`, organizationId: fixtureId(second ? 102 : 101),
    referrals: { pending: empty ? 0 : 2, qualified, rejected: empty ? 0 : 3, refunded: empty ? 0 : 1, reversed: empty ? 0 : 2 },
    allTimeRank: empty || second ? null : 1, historyLimit: 50, displayMode: 'ANONYMOUS',
    monthlyQualified: Array.from({ length: 12 }, (_, i) => ({ month: new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 7), qualified: i === 11 ? qualified : 0 })),
    milestones: { program: { status: empty ? 'POLICY_UNDECIDED' : 'PUBLISHED', policyVersion: empty ? null : 2 },
      qualifiedReferrals: qualified, reached: empty ? [] : [1, 2, 3, 4, 5].map((n) => ({ rewardKind: n === 5 ? 'FREE_MONTHS' : 'REFERRER_CREDIT', milestoneCount: n })),
      nextMilestone: empty ? null : { rewardKind: 'FREE_MONTHS', milestoneCount: 10, remaining: updated ? 1 : 2 } },
    hold: second && !empty ? { reasonCode: 'OWNER_REVIEW', placedAt: '2026-09-30T00:00:00.000Z' } : null,
    history: empty ? [] : [{ occurredAt: '2026-10-01T00:00:00.000Z', fromState: 'PENDING', toState: 'QUALIFIED', reason: 'QUALIFICATION_VERIFIED',
      attributionId: fixtureId(501), referredOrganizationId: fixtureId(601), referredOrganizationName: 'Referred School Organization · fixture' }],
  };
}
export function rewardLedgerFixture({ status = null, empty = false, updated = false } = {}) {
  const entry = (id, kind, state) => ({
    entryId: fixtureId(700 + id), rewardKind: kind, beneficiaryRole: kind === 'WELCOME_CREDIT' ? 'REFERRED' : 'REFERRER',
    beneficiaryOrganizationId: fixtureId(kind === 'WELCOME_CREDIT' ? 601 : 101), referrerOrganizationId: fixtureId(101),
    referrerSchoolId: fixtureId(1), attributionId: kind.includes('CREDIT') ? fixtureId(501) : null,
    milestoneOrdinal: kind.includes('CREDIT') ? 1 : null, milestoneCount: kind === 'FREE_MONTHS' ? 5 : kind === 'PRIZE' ? 20 : kind === 'LIFETIME_MEMBERSHIP' ? 30 : null,
    creditMinor: kind.includes('CREDIT') ? updated ? 20000 : 10000 : null,
    freeMonths: kind === 'FREE_MONTHS' ? 6 : null, lifetimeTier: kind === 'LIFETIME_MEMBERSHIP' ? 'CORE' : null,
    aiAllowance: ['FREE_MONTHS', 'LIFETIME_MEMBERSHIP'].includes(kind) ? 'FULL_PLAN_ALLOWANCE' : null,
    basisQualifiedCount: kind === 'LIFETIME_MEMBERSHIP' ? 30 : kind === 'PRIZE' ? 20 : 8,
    status: state, retained: false, version: 1, policyVersion: 2,
    planBasis: state === 'APPROVED' ? 'MONTHLY' : null, fulfillmentForm: state === 'APPROVED' ? 'AS_EARNED' : null,
    substitute: null, prize: kind === 'PRIZE' ? { kind: 'EXPERIENCE', description: 'Family experience · fixture', costMinor: 85000 } : null,
    voidReason: state === 'VOIDED' ? 'BASIS_REVERSED' : null, accruedAt: '2026-10-01T00:00:00.000Z',
    approvedAt: state === 'APPROVED' ? '2026-10-02T00:00:00.000Z' : null, voidedAt: state === 'VOIDED' ? '2026-10-03T00:00:00.000Z' : null,
  });
  const all = [entry(1, 'REFERRER_CREDIT', 'ACCRUED'), entry(2, 'FREE_MONTHS', 'APPROVED'), entry(3, 'PRIZE', 'REVERSAL_REVIEW'),
    entry(4, 'LIFETIME_MEMBERSHIP', 'ACCRUED'), entry(5, 'WELCOME_CREDIT', 'VOIDED')];
  return { entries: empty ? [] : all.filter((e) => !status || e.status === status), limit: 200,
    // Deliberately exceeds the recent-list length. Mirrors canonical ALL non-voided scope.
    liabilities: empty ? [] : [
      { status: 'ACCRUED', rewardKind: 'REFERRER_CREDIT', entries: 450, creditMinor: updated ? 4510000 : 4500000, freeMonths: 0, prizeCostMinor: 0, substituteValueMinor: 0 },
      { status: 'APPROVED', rewardKind: 'FREE_MONTHS', entries: 2, creditMinor: 0, freeMonths: 12, prizeCostMinor: 0, substituteValueMinor: 0 },
      { status: 'REVERSAL_REVIEW', rewardKind: 'PRIZE', entries: 1, creditMinor: 0, freeMonths: 0, prizeCostMinor: 85000, substituteValueMinor: 0 },
      { status: 'ACCRUED', rewardKind: 'LIFETIME_MEMBERSHIP', entries: 1, creditMinor: 0, freeMonths: 0, prizeCostMinor: 0, substituteValueMinor: 0 },
    ], currency: 'USD', financialActivation: 'DISABLED' };
}
