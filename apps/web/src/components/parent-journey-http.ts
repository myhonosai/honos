import { verifyParentJourneyView, type ParentJourneyView } from '@hon/contracts';
export class ParentJourneyAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** No client-supplied IDs, URL, query, actor, scope, source, or mutation options. */
export async function loadParentJourney(signal?: AbortSignal): Promise<ParentJourneyView> {
  const response = await fetch('/api/v1/parent/journey', { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again to view your family.'
      : response.status === 403 ? 'Family permission was lost or is not available. All Journey content has been cleared.'
        : response.status === 409 ? 'A verified current-family selector is unavailable for this account. No family has been selected automatically.'
          : 'Student Journey is unavailable. No verified family result is shown.';
    if ([401, 403].includes(response.status)) throw new ParentJourneyAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('The Student Journey response could not be verified.');
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The Student Journey response could not be verified.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'meta')) throw new Error('The Student Journey response could not be verified.');
  const root = envelope as { data: unknown; meta: unknown };
  if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta) || Object.keys(root.meta).sort().join(',') !== 'correlationId,requestId') throw new Error('The Student Journey response could not be verified.');
  const meta = root.meta as { requestId: unknown; correlationId: unknown };
  if (typeof meta.requestId !== 'string' || typeof meta.correlationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.requestId) || meta.correlationId !== meta.requestId) throw new Error('The Student Journey response could not be verified.');
  return verifyParentJourneyView(root.data);
}
