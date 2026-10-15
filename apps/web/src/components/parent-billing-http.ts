import { verifyParentBillingView, type ParentBillingView } from '@hon/contracts';

export class ParentBillingAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Fixed same-origin GET: family, child, account, invoice, payment and payer inputs are never client-supplied. */
export async function loadParentBilling(signal?: AbortSignal): Promise<ParentBillingView> {
  const response = await fetch('/api/v1/parent/billing', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null,
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Your session has ended. Sign in again to view family billing observations.'
      : response.status === 403 ? 'Guardian billing access is unavailable. Family billing content has been cleared.'
        : response.status === 409 ? 'A verified current-family selector is unavailable. No family has been selected automatically.'
          : 'Family billing observations are unavailable. No previous billing content is shown.';
    if ([401, 403].includes(response.status)) throw new ParentBillingAccessError(message, response.status);
    throw new Error(message);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('The family billing response could not be verified.');
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The family billing response could not be verified.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'meta')) throw new Error('The family billing response could not be verified.');
  const root = envelope as { data: unknown; meta: unknown };
  if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta) || Object.keys(root.meta).sort().join(',') !== 'correlationId,requestId') throw new Error('The family billing response could not be verified.');
  const meta = root.meta as { requestId: unknown; correlationId: unknown };
  if (typeof meta.requestId !== 'string' || typeof meta.correlationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.requestId) || meta.correlationId !== meta.requestId) throw new Error('The family billing response could not be verified.');
  return verifyParentBillingView(root.data);
}
