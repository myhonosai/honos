import {
  validateChampionsHqLeaderboard,
  validateChampionsLeaderboardQuery,
  type ChampionsHqLeaderboard,
} from '@hon/contracts';

const PATH = '/api/v1/hq/champions/leaderboard';
export type LeaderboardSelection = { period: 'ALL_TIME' } | { period: 'MONTH'; month: string };
export type ChampionsReadFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'INVALID_FILTER' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

export class HqChampionsReadError extends Error {
  constructor(readonly kind: ChampionsReadFailure) {
    super('The authorized Champions Club leaderboard could not be verified.');
  }
}

/** Fixed HQ read only. A selection never supplies a principal, school scope or permission. */
export async function loadHqChampionsLeaderboard(selection: LeaderboardSelection, signal?: AbortSignal): Promise<ChampionsHqLeaderboard> {
  let query;
  try { query = validateChampionsLeaderboardQuery(selection); }
  catch { throw new HqChampionsReadError('INVALID_FILTER'); }
  const params = new URLSearchParams({ period: query.period });
  if (query.month !== null) params.set('month', query.month);
  let response: Response;
  try {
    response = await fetch(`${PATH}?${params}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HqChampionsReadError('UNAVAILABLE');
  }
  // Do not read or echo error bodies: they are never an authorized projection.
  if (!response.ok) throw new HqChampionsReadError(response.status === 401 ? 'UNAUTHORIZED'
    : response.status === 403 ? 'FORBIDDEN' : response.status === 400 ? 'INVALID_FILTER' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw new Error();
    const board = validateChampionsHqLeaderboard((envelope as { data: unknown }).data);
    if (board.period !== query.period || board.month !== query.month) throw new Error();
    return board;
  } catch { throw new HqChampionsReadError('INVALID_RESPONSE'); }
}
