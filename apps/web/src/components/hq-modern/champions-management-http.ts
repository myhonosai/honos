import {
  validateChampionsOverview, validateChampionsProgram,
  type ChampionsOverview, type ChampionsProgram,
} from '@hon/contracts';

export type ChampionsManagementFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
export class HqChampionsManagementError extends Error {
  constructor(readonly kind: ChampionsManagementFailure) {
    super('The authorized Champions Club overview could not be verified.');
  }
}

/** Private, fixed read paths only. No client identity, school selector or command transport. */
async function read<T>(resource: 'overview' | 'program', validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/champions/${resource}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HqChampionsManagementError('UNAVAILABLE');
  }
  // An error response is not an authorized projection. Never read or echo its body.
  if (!response.ok) throw new HqChampionsManagementError(response.status === 401 ? 'UNAUTHORIZED'
    : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw new Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new HqChampionsManagementError('INVALID_RESPONSE'); }
}

export type ChampionsManagementSnapshot = { overview: ChampionsOverview; program: ChampionsProgram };

export async function loadHqChampionsManagement(signal?: AbortSignal): Promise<ChampionsManagementSnapshot> {
  const [overview, program] = await Promise.all([
    read('overview', validateChampionsOverview, signal), read('program', validateChampionsProgram, signal),
  ]);
  // These are separate reads, not an atomic snapshot. A changed policy must be refreshed,
  // rather than presenting mismatched configuration as the basis of the current overview.
  if (overview.program.policyVersion !== (program.published?.policyVersion ?? null)
    || overview.program.paymentVerificationSource !== (program.published?.paymentVerificationSource ?? null)
    || (overview.program.status === 'PUBLISHED') !== (program.published !== null)) {
    throw new HqChampionsManagementError('INVALID_RESPONSE');
  }
  return { overview, program };
}
