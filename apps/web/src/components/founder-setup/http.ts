import { verifyOwnerLaunchProjection } from '@hon/contracts';
import { verifyHqSchoolDirectorySnapshot } from '../hq-school-directory-http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export class FounderReadError extends Error {
  constructor(readonly status: number, readonly kind: 'ACCESS' | 'INVALID' | 'IDENTITY' = 'ACCESS') { super('Founder setup read unavailable.'); }
}
export type SetupEvidence = Readonly<{ schoolName: string; program: boolean; classSession: boolean; registration: boolean }>;
export type DirectoryEvidence = ReadonlyArray<Readonly<{ schoolName: string; organizationName: string }>>;

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  signal.throwIfAborted();
  if (response.status === 401) reportConfirmedSessionInvalidation();
  if (!response.ok) throw new FounderReadError(response.status);
  const body: unknown = await response.json();
  signal.throwIfAborted();
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'data') || Object.keys(body).some(k => !['data','meta'].includes(k))) throw new FounderReadError(503, 'INVALID');
  return (body as { data: unknown }).data;
}
async function identity(signal: AbortSignal): Promise<string> {
  const data = await read('/api/identity/me', signal);
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['externalSubject','displayName','email'].includes(k))) throw new FounderReadError(503, 'INVALID');
  const subject = (data as { externalSubject?: unknown }).externalSubject;
  if (typeof subject !== 'string' || !subject || subject.length > 1024 || /[\x00-\x20\x7f<>]/.test(subject)) throw new FounderReadError(503, 'INVALID');
  return subject;
}
/** Closed selector-free read, bracketed by verified identity. No command, price, account or activation. */
export async function readFounderEvidence(plane: 'school', signal: AbortSignal): Promise<SetupEvidence>;
export async function readFounderEvidence(plane: 'hq', signal: AbortSignal): Promise<DirectoryEvidence>;
export async function readFounderEvidence(plane: 'school' | 'hq', signal: AbortSignal): Promise<SetupEvidence | DirectoryEvidence> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const before = await identity(bounded);
  let result: SetupEvidence | DirectoryEvidence;
  if (plane === 'school') {
    const v = verifyOwnerLaunchProjection(await read('/api/v1/owner-launch', bounded));
    // Do not retain student/family/receipt IDs, tier or complete response objects in React state.
    result = Object.freeze({ schoolName: v.schoolName, program: v.program !== null, classSession: v.classSession !== null, registration: v.registration !== null || v.guardianChildRegistration !== null });
  } else {
    const data = await read('/api/v1/hq/schools', bounded);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'directory')) throw new FounderReadError(503, 'INVALID');
    const directory = verifyHqSchoolDirectorySnapshot((data as { directory: unknown }).directory);
    result = Object.freeze(directory.schools.slice(0, 50).map(s => Object.freeze({ schoolName: s.schoolDisplayName, organizationName: s.organizationDisplayName })));
  }
  if (await identity(bounded) !== before) throw new FounderReadError(401, 'IDENTITY');
  if (bounded.aborted) throw new DOMException('Read cancelled.', 'AbortError');
  return result;
}
