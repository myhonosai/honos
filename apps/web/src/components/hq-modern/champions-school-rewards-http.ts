import {
  championsUuid, validateChampionsHqSchoolStatistics, validateChampionsRewardLedger,
  validateChampionsRewardProgram, validateChampionsRewardStatusFilter,
  type ChampionsHqSchoolStatistics, type ChampionsRewardLedger, type ChampionsRewardProgram,
  type ChampionsRewardStatus,
} from '@hon/contracts';

export type ChampionsDetailFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'INVALID_SELECTION';
export class HqChampionsDetailError extends Error {
  constructor(readonly kind: ChampionsDetailFailure) { super('The authorized Champions Club records could not be verified.'); }
}

/** Private to these fixed read functions. No caller-supplied URL, identity or command headers. */
async function read<T>(path: string, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/champions/${path}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HqChampionsDetailError('UNAVAILABLE');
  }
  // Error bodies are not authorized projections and must never be read or echoed.
  if (!response.ok) throw new HqChampionsDetailError(response.status === 401 ? 'UNAUTHORIZED'
    : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw new Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new HqChampionsDetailError('INVALID_RESPONSE'); }
}

export type SchoolReferralSnapshot = { statistics: ChampionsHqSchoolStatistics; program: ChampionsRewardProgram };
export async function loadHqSchoolReferrals(schoolId: string, signal?: AbortSignal): Promise<SchoolReferralSnapshot> {
  let school: string;
  try { school = championsUuid(schoolId); } catch { throw new HqChampionsDetailError('INVALID_SELECTION'); }
  const [statistics, program] = await Promise.all([
    read(`schools/${school}/statistics`, validateChampionsHqSchoolStatistics, signal),
    read('rewards/program', validateChampionsRewardProgram, signal),
  ]);
  // Selector binding is not authorization: the API independently resolves current HQ authority.
  // Separate reads may race publication; fail closed instead of mixing policy versions.
  if (statistics.schoolId !== school || statistics.milestones.program.policyVersion !== (program.published?.policyVersion ?? null)
    || (statistics.milestones.program.status === 'PUBLISHED') !== (program.published !== null)) {
    throw new HqChampionsDetailError('INVALID_RESPONSE');
  }
  return { statistics, program };
}

export type RewardLedgerSnapshot = { ledger: ChampionsRewardLedger; program: ChampionsRewardProgram };
export async function loadHqRewardLedger(status: ChampionsRewardStatus | null, signal?: AbortSignal): Promise<RewardLedgerSnapshot> {
  let filter: ChampionsRewardStatus | null;
  try { filter = validateChampionsRewardStatusFilter(status === null ? undefined : status); }
  catch { throw new HqChampionsDetailError('INVALID_SELECTION'); }
  const [ledger, program] = await Promise.all([
    read(`rewards/ledger${filter ? `?status=${filter}` : ''}`, validateChampionsRewardLedger, signal),
    read('rewards/program', validateChampionsRewardProgram, signal),
  ]);
  if (filter && ledger.entries.some((entry) => entry.status !== filter)) throw new HqChampionsDetailError('INVALID_RESPONSE');
  // Liability groups deliberately cover ALL non-voided records regardless of the entry filter.
  // Historical entries retain their own policyVersion; do not bind them to today's policy.
  return { ledger, program };
}
