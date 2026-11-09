import { id } from './account-status-fixtures';

export const school = id(2), at = '2026-11-05T12:00:00.000Z';
export const months = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, qualified: i === 10 ? 2 : 0 }));
export const summary = (over: Record<string, unknown> = {}) => ({ schoolId: school, referralCode: { code: 'K7M2Q9X4PA', status: 'ACTIVE', issuedAt: at },
  program: { status: 'PUBLISHED', policyVersion: 3, financialRewards: 'DISABLED' }, referrals: { pending: 1, qualified: 4, rejected: 1, refunded: 0, reversed: 0 }, ...over });
export const statistics = () => ({ schoolId: school, referrals: { pending: 1, qualified: 4, rejected: 1, refunded: 0, reversed: 0 }, monthlyQualified: months,
  milestones: { program: { status: 'PUBLISHED', policyVersion: 3 }, reached: [{ rewardKind: 'FREE_MONTHS', milestoneCount: 3 }], nextMilestone: { rewardKind: 'LIFETIME_MEMBERSHIP', milestoneCount: 10, remaining: 6 }, qualifiedReferrals: 4 },
  allTimeRank: 2, history: [{ occurredAt: at, fromState: 'PENDING', toState: 'QUALIFIED', reason: 'QUALIFICATION_VERIFIED' }, { occurredAt: '2026-11-01T09:00:00.000Z', fromState: null, toState: 'PENDING', reason: 'CAPTURED' }],
  historyLimit: 50, displayMode: 'ANONYMOUS' });
export const rewards = () => ({ schoolId: school, qualifiedReferrals: 4, program: { status: 'PUBLISHED', policyVersion: 3 },
  nextMilestone: { rewardKind: 'LIFETIME_MEMBERSHIP', milestoneCount: 10, remaining: 6 },
  rewards: [{ rewardKind: 'REFERRER_CREDIT', beneficiaryRole: 'REFERRER', milestoneCount: null, creditMinor: 10000, freeMonths: null, lifetimeTier: null, aiAllowance: null, status: 'APPROVED', accruedAt: at },
    { rewardKind: 'FREE_MONTHS', beneficiaryRole: 'REFERRER', milestoneCount: 3, creditMinor: null, freeMonths: 2, lifetimeTier: null, aiAllowance: null, status: 'ACCRUED', accruedAt: at }],
  financialActivation: 'DISABLED' });
export const board = (period: 'ALL_TIME' | 'MONTH' = 'ALL_TIME', month: string | null = null, displayMode = 'ANONYMOUS') => ({ period, month,
  standings: [{ rank: 1, displayName: 'Tiger Rock Dojang', anonymous: false, qualifiedReferrals: period === 'MONTH' ? 3 : 9, isYou: false },
    { rank: 2, displayName: 'Our Test School', anonymous: false, qualifiedReferrals: period === 'MONTH' ? 2 : 4, isYou: true },
    { rank: 3, displayName: null, anonymous: true, qualifiedReferrals: 1, isYou: false }],
  limit: 25, you: { schoolId: school, status: 'RANKED', rank: 2, qualifiedReferrals: period === 'MONTH' ? 2 : 4, displayMode }, countsOnly: 'QUALIFIED', timeZone: 'UTC' });
export const contests = (list: unknown[] = [contest()]) => ({ schoolId: school, contests: list, countsOnly: 'QUALIFIED' });
export const contest = () => ({ contestId: id(90), name: 'Winter referral sprint', description: 'Most qualified referrals between November and January.', termsReference: null,
  status: 'ACTIVE', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2027-01-31T23:59:59.000Z', minimumQualified: 2,
  prizes: [{ placeFrom: 1, placeTo: 1, kind: 'ELECTRONICS', description: 'Tablet for the front desk', quantity: 1 }],
  standings: [{ rank: 1, displayName: 'Our Test School', anonymous: false, qualifiedReferrals: 2, isYou: true }], you: { qualifiedReferrals: 2, status: 'RANKED', rank: 1 }, won: false });
export const codeReceipt = (created = true, replayed = false) => ({ schoolId: school, code: 'K7M2Q9X4PA', status: 'ACTIVE', issuedAt: at, created, replayed });
export const preferenceReceipt = (displayMode = 'SCHOOL_NAME', replayed = false) => ({ schoolId: school, displayMode, version: 2, updatedAt: at, replayed });
