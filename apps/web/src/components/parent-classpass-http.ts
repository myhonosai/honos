import { verifyParentClassPassView, type ParentClassPassView } from '@hon/contracts';
/** No URL, tenant, child, pass or family selector may be supplied. */
export async function loadParentClassPass(signal?: AbortSignal): Promise<ParentClassPassView> {
  const response = await fetch('/api/v1/parent/classpass', {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: signal ?? null,
  });
  if (!response.ok) throw new Error(response.status === 409 ? 'Current family unavailable. No family has been selected automatically.' : 'Guardian ClassPass access unavailable. No previous result is shown.');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Parent ClassPass response could not be verified.');
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'data,meta') throw new Error('Parent ClassPass response could not be verified.');
  const { data, meta } = envelope as { data: unknown; meta: unknown };
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).sort().join(',') !== 'correlationId,requestId') throw new Error('Parent ClassPass response could not be verified.');
  const m = meta as { requestId: unknown; correlationId: unknown };
  if (typeof m.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.requestId) || m.requestId !== m.correlationId) throw new Error('Parent ClassPass response could not be verified.');
  return verifyParentClassPassView(data);
}
