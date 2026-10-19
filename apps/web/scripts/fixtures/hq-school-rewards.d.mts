import type { ChampionsHqSchoolStatistics, ChampionsRewardLedger, ChampionsRewardProgram, ChampionsRewardStatus, HqSchoolDirectory } from '@hon/contracts';
export function fixtureId(id: number): string;
export function schoolDirectoryFixture(options?: { empty?: boolean }): HqSchoolDirectory;
export function rewardProgramFixture(options?: { empty?: boolean }): ChampionsRewardProgram;
export function schoolReferralFixture(options?: { schoolId?: string; empty?: boolean; updated?: boolean }): ChampionsHqSchoolStatistics;
export function rewardLedgerFixture(options?: { status?: ChampionsRewardStatus | null; empty?: boolean; updated?: boolean }): ChampionsRewardLedger;
