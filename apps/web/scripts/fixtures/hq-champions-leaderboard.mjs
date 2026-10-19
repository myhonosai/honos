/** Synthetic transport fixtures only. Never imported by application code. */
export function leaderboardFixture({ period = 'ALL_TIME', month = null, updated = false, empty = false } = {}) {
  const row = (rank, position, id, schoolName, organizationName, qualifiedReferrals, pendingReferrals, displayMode = 'ANONYMOUS') => ({
    rank, position, schoolId: `00000000-0000-4000-8000-00000000000${id}`, schoolName,
    organizationId: `00000000-0000-4000-8000-00000000010${id}`, organizationName,
    qualifiedReferrals, pendingReferrals, reachedAt: `${period === 'MONTH' ? month : '2026-08'}-0${id}T00:00:00.000Z`, displayMode,
  });
  return {
    period, month, totalRanked: empty ? 0 : period === 'MONTH' ? 2 : 3, limit: 100, countsOnly: 'QUALIFIED', timeZone: 'UTC',
    standings: empty ? [] : period === 'MONTH'
      ? [row(1, 1, 3, 'Cedar School · fixture', 'Cedar Organization · fixture', 3, 1), row(2, 2, 1, 'Zeta School · fixture', 'Zeta Organization · fixture', 1, 2)]
      : [row(1, 1, 1, 'Zeta School · fixture', 'Zeta Organization · fixture', updated ? 9 : 8, 2), row(updated ? 2 : 1, 2, 2, 'Alpha School · fixture', 'Alpha Organization · fixture', 8, 0, 'SCHOOL_NAME'), row(3, 3, 3, 'Cedar School · fixture', 'Cedar Organization · fixture', 4, 1)],
    held: empty ? [] : [{ schoolId: '00000000-0000-4000-8000-000000000004', schoolName: 'Hold Review School · fixture', reasonCode: 'FRAUD_REVIEW', placedAt: '2026-08-04T00:00:00.000Z', qualifiedReferrals: 12 }],
  };
}
