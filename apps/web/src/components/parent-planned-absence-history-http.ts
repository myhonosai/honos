import { verifyParentPlannedAbsenceHistoryView, type ParentPlannedAbsenceHistoryView } from '@hon/contracts';

export class ParentPlannedAbsenceHistoryAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function invalid(): never { throw new Error('The planned-absence history response could not be verified. No history is shown.'); }

/** Fixed same-origin GET only: no family, child, request, school, staff, date, review, schedule, or action selector. */
export async function loadParentPlannedAbsenceHistory(signal?: AbortSignal): Promise<ParentPlannedAbsenceHistoryView> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = await fetch('/api/v1/parent/planned-absences/history', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null,
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again to view planned-absence history.'
      : response.status === 403 ? 'Current guardian family permission is unavailable. Planned-absence history has been cleared.'
        : response.status === 409 ? 'A verified current-family selector is unavailable. No family has been selected automatically.'
          : 'Planned-absence history is unavailable. No history is shown.';
    if ([401, 403].includes(response.status)) throw new ParentPlannedAbsenceHistoryAccessError(message, response.status);
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
  return verifyParentPlannedAbsenceHistoryView(root.data);
}
