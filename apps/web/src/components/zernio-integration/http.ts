import { validateZernioConfiguration, validateZernioVerification, ZERNIO_VERIFY_CONFIRMATION } from '@hon/contracts';
export class ZernioAccessError extends Error {
  constructor(readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE') { super(code); }
}
async function request(verify: boolean, signal: AbortSignal) {
  const response = await fetch(`/api/v1/hq/integrations/zernio/${verify ? 'verify' : 'configuration'}`, {
    method: verify ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: verify ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'zernio-credential-verify' } : { Accept: 'application/json' },
    ...(verify ? { body: JSON.stringify({ confirmation: ZERNIO_VERIFY_CONFIRMATION }) } : {}),
  });
  if (!response.ok) throw new ZernioAccessError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) throw new ZernioAccessError('INVALID_RESPONSE');
  const root: unknown = await response.json();
  if (!root || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).length !== 1 || !Object.hasOwn(root, 'data')) throw new ZernioAccessError('INVALID_RESPONSE');
  return (root as { data: unknown }).data;
}
export async function loadZernioConfiguration(signal: AbortSignal) { return validateZernioConfiguration(await request(false, signal)); }
export async function verifyZernioCredential(signal: AbortSignal) { return validateZernioVerification(await request(true, signal)); }
