import { communityUuid, verifyRetentionReviewSignals, type RetentionReviewSignals } from '@hon/contracts';

const base = '/api/v1/staff/retention/review';
export class RetentionReviewUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function id(value: unknown): asserts value is string { try { communityUuid(value); } catch { throw new Error('Use an already-known school and membership UUID.'); } }

/** Known selectors only; server-derived scope and SQL independently authorize every read. */
export function retentionReviewPath(schoolId: string, membershipId: string): string {
  id(schoolId); id(membershipId);
  return `${base}?schoolId=${encodeURIComponent(schoolId)}&membershipId=${encodeURIComponent(membershipId)}`;
}
export async function loadRetentionReviewSignals(schoolId: string, membershipId: string): Promise<RetentionReviewSignals> {
  const path = retentionReviewPath(schoolId, membershipId);
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission or active entitlement is unavailable.' : response.status === 404 ? 'The known membership is unavailable in the current authorized school.' : 'No verified Retention Review Signals result is available.';
    throw new RetentionReviewUiError(message, response.status);
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The Retention Review Signals response could not be verified.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'meta')) throw new Error('The Retention Review Signals response could not be verified.');
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'retentionReviewSignals')) throw new Error('The Retention Review Signals response could not be verified.');
  return verifyRetentionReviewSignals((data as { retentionReviewSignals: unknown }).retentionReviewSignals, membershipId);
}
