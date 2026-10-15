import { verifyParentMessageHistoryView, type ParentMessageHistoryView } from '@hon/contracts';

export class ParentMessageHistoryAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function invalid(): never { throw new Error('The school message-history response could not be verified. No message history is shown.'); }

/** Fixed same-origin GET only: no family, child, recipient, message, staff, date, delivery, channel, or action selector. */
export async function loadParentMessageHistory(signal?: AbortSignal): Promise<ParentMessageHistoryView> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = await fetch('/api/v1/parent/messages', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null,
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again to view school message history.'
      : response.status === 403 ? 'Current guardian family permission is unavailable. School message history has been cleared.'
        : response.status === 409 ? 'A verified current-family selector is unavailable. No family has been selected automatically.'
          : 'School message history is unavailable. No message history is shown.';
    if ([401, 403].includes(response.status)) throw new ParentMessageHistoryAccessError(message, response.status);
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
  return verifyParentMessageHistoryView(root.data);
}
