/** Synthetic localhost transport fixtures only; never imported by application code. */
export function championsManagementFixture({ empty = false, updated = false } = {}) {
  return {
    overview: {
      program: empty ? { status: 'POLICY_UNDECIDED', policyVersion: null, paymentVerificationSource: null }
        : { status: 'PUBLISHED', policyVersion: 1, paymentVerificationSource: 'HQ_OWNER_ATTESTATION' },
      rewardProgram: empty ? { status: 'POLICY_UNDECIDED', policyVersion: null, clawbackRule: null }
        : { status: 'PUBLISHED', policyVersion: 2, clawbackRule: 'UNDECIDED' },
      referralCodes: { active: empty ? 0 : 3, schoolsWithCode: empty ? 0 : 3 },
      attributions: { pending: empty ? 0 : 4, qualified: empty ? 0 : updated ? 13 : 12, rejected: empty ? 0 : 3, refunded: empty ? 0 : 2, reversed: empty ? 0 : 1 },
      rankedSchools: empty ? 0 : 2, leaderboardHolds: empty ? 0 : 1,
      rewardLiabilities: { entries: empty ? 0 : 8, creditMinor: empty ? 0 : 200000, freeMonths: empty ? 0 : 18, prizes: empty ? 0 : 1, lifetimeMemberships: 0, inReview: empty ? 0 : 2, approved: empty ? 0 : 1 },
      contests: { draft: 0, scheduled: 0, active: 0, paused: 0, ended: 0, pendingWinnerApproval: 0, completed: 0, cancelled: 0, startDue: 0, endDue: 0 },
      contestLiabilities: { pendingWinnerCostMinor: empty ? 0 : 25000, approvedWinnerCostMinor: empty ? 0 : 10000 },
      currency: 'USD', financialActivation: 'DISABLED', automaticTransitions: 'NOT_CONFIGURED',
    },
    program: {
      published: empty ? null : {
        policyId: '00000000-0000-4000-8000-000000000201', policyVersion: 1, status: 'PUBLISHED',
        attributionWindowDays: 90, refundWindowDays: 30, minimumPaidDays: 60, minimumPaidInvoices: 2,
        paymentVerificationSource: 'HQ_OWNER_ATTESTATION', welcomeCreditMinor: 10000,
        termsReference: 'Synthetic program terms · no live or legal terms', currency: 'USD', financialRewards: 'DISABLED',
        createdAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-02T00:00:00.000Z',
      }, drafts: [], financialRewards: 'DISABLED',
    },
  };
}
