import 'server-only';
import { HON_SESSION_COOKIE } from '@hon/auth';
import { verifyStaffReportingSchools } from '../components/staff-reporting-schools-http';

export type PostLoginDestination = '/hq' | '/staff/entry' | '/auth/access' | '/auth/login';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HQ_ROLES = ['HON_HQ_OWNER', 'HON_HQ_OPERATOR', 'HON_HQ_SUPPORT'];

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Unverified access response.');
  return value as Record<string, unknown>;
}

/** The deployment-owned API base is the only network destination input. */
function apiBase(): string {
  const configured = process.env.HON_API_BASE_URL ?? 'http://127.0.0.1:3001';
  const parsed = new URL(configured);
  if (configured !== configured.trim() || !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Access verification unavailable.');
  return parsed.href.replace(/\/$/, '');
}

type ReadResult = { kind: 'data'; body: unknown } | { kind: 'denied' } | { kind: 'signedout' };
// Twenty canonical school choices may contain two 120-codepoint names each,
// including valid escaped Unicode. Keep the stream bounded without rejecting them.
const MAX_RESPONSE_BYTES = 64 * 1024;
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) throw new Error('Unverified access response.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Unverified access response.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

async function read(base: string, path: '/v1/hq/session' | '/v1/staff/current-reporting-school' | '/v1/staff/reporting-schools', token: string, signal: AbortSignal): Promise<ReadResult> {
  signal.throwIfAborted();
  const url = `${base}${path}`;
  const response = await fetch(url, {
    method: 'GET', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json', Cookie: `${HON_SESSION_COOKIE}=${encodeURIComponent(token)}` }, signal,
  });
  signal.throwIfAborted();
  if (response.redirected || response.url && response.url !== url) throw new Error('Unverified access response.');
  if (response.status === 401) return { kind: 'signedout' };
  if (response.status === 403) return { kind: 'denied' };
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Access verification unavailable.');
  const body = await boundedJson(response, signal);
  signal.throwIfAborted();
  return { kind: 'data', body };
}

/** Navigation hints only. Every call independently authorizes the same verified session. */
export async function resolvePostLoginDestination(token: string): Promise<PostLoginDestination> {
  try {
    const base = apiBase(), signal = AbortSignal.timeout(8000);
    const hq = await read(base, '/v1/hq/session', token, signal);
    if (hq.kind === 'signedout') return '/auth/login';
    if (hq.kind === 'data') {
      const scope = record(record(hq.body, ['data']).data, ['principalId', 'hqRole']);
      if (typeof scope.principalId !== 'string' || !UUID.test(scope.principalId)
        || typeof scope.hqRole !== 'string' || !HQ_ROLES.includes(scope.hqRole)) throw new Error('Unverified HQ access.');
      return '/hq';
    }
    const staff = await read(base, '/v1/staff/current-reporting-school', token, signal);
    if (staff.kind === 'signedout') return '/auth/login';
    if (staff.kind === 'denied') return '/auth/access';
    const data = record(staff.body, ['data']).data;
    if (data && typeof data === 'object' && 'state' in data && data.state === 'MANUAL_ENTRY_REQUIRED') {
      record(data, ['state']);
      const choices = await read(base, '/v1/staff/reporting-schools', token, signal);
      if (choices.kind === 'signedout') return '/auth/login';
      if (choices.kind !== 'data') return '/auth/access';
      return verifyStaffReportingSchools(choices.body).state === 'SELECTION_REQUIRED' ? '/staff/entry' : '/auth/access';
    }
    const scope = record(data, ['state', 'organizationId', 'schoolId']);
    if (scope.state !== 'RESOLVED' || typeof scope.organizationId !== 'string' || !UUID.test(scope.organizationId)
      || typeof scope.schoolId !== 'string' || !UUID.test(scope.schoolId)) throw new Error('Unverified school access.');
    return '/staff/entry';
  } catch {
    // Ambiguity, transport failures and unsupported contracts do not prove absent roles.
    return '/auth/access';
  }
}
