import { verifyParentTestingStatusView, type ParentTestingStatusView } from '@hon/contracts';

export class ParentTestingStatusAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function invalid(): never { throw new Error('The family testing status response could not be verified. No status is assumed.'); }

/** Fixed same-origin GET only: no family, child, school, candidate, event, staff, or action selector. */
export async function loadParentTestingStatus(signal?: AbortSignal): Promise<ParentTestingStatusView> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = await fetch('/api/v1/parent/testing/status', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null,
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again to view family testing status.'
      : response.status === 403 ? 'Current family permission is unavailable. Family testing status has been cleared.'
        : response.status === 409 ? 'A verified current-family selector is unavailable. No family has been selected automatically.'
          : 'Family testing status is unavailable. No result is shown.';
    if ([401, 403].includes(response.status)) throw new ParentTestingStatusAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  let envelope: unknown;
  try { envelope = await response.json(); } catch { invalid(); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'meta')) invalid();
  const root = envelope as { data: unknown; meta: unknown };
  if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta) || Object.keys(root.meta).sort().join(',') !== 'correlationId,requestId') invalid();
  const meta = root.meta as { requestId: unknown; correlationId: unknown };
  if (typeof meta.requestId !== 'string' || typeof meta.correlationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.requestId) || meta.correlationId !== meta.requestId) invalid();
  return verifyParentTestingStatusView(root.data);
}
