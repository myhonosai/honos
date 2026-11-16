import {
  PERSON_MEMBERSHIP_START_BLOCKERS, PERSON_MEMBERSHIP_START_COMMAND, validatePersonMembershipStartInput, verifyPersonMembershipStartOptions,
  verifyPersonMembershipStartReceipt, type PersonMembershipStartBlocker, type PersonMembershipStartInput, type PersonMembershipStartOptions,
  type PersonMembershipStartReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/** New membership and Renew on the contact card (0398). The server decides every rule; this only sends what staff chose. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PersonScope = Readonly<{ organizationId: string; schoolId: string; personId: string }>;
/** The exact request, kept so an unknown outcome can be retried as the same request (it never makes two). */
export type NewMembershipRequest = Readonly<{ path: string; body: string; key: string }>;
export type NewMembershipProblem = 'BLOCKED' | 'STALE' | 'DENIED' | 'SESSION' | 'REFUSED' | 'UNKNOWN' | 'CONFLICT';
export class NewMembershipError extends Error {
  constructor(readonly problem: NewMembershipProblem, readonly status: number, readonly blockers: readonly PersonMembershipStartBlocker[] = []) { super(problem); }
}
function invalid(): never { throw new Error('Unverified membership start response.'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
  return value as Record<string, unknown>;
}
export function personMembershipPath(s: PersonScope): string {
  return `/api/v1/organizations/${uuid(s.organizationId)}/schools/${uuid(s.schoolId)}/billing/people/${uuid(s.personId)}`;
}
const fetchOptions = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const known = new Set<string>(PERSON_MEMBERSHIP_START_BLOCKERS);

async function refusal(response: Response): Promise<never> {
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new NewMembershipError('SESSION', 401); }
  let code = '', blockers: PersonMembershipStartBlocker[] = [];
  try {
    const raw = await response.text();
    if (raw.length < 4000) {
      const e = JSON.parse(raw);
      if (typeof e?.code === 'string') code = e.code;
      if (Array.isArray(e?.blockers)) blockers = e.blockers.filter((b: unknown) => typeof b === 'string' && known.has(b));
    }
  } catch { /* Never show raw backend text. */ }
  if (response.status === 403) throw new NewMembershipError('DENIED', 403);
  if (code === 'PERSON_MEMBERSHIP_BLOCKED') throw new NewMembershipError('BLOCKED', response.status, blockers);
  if (code === 'MEMBERSHIP_PLAN_VERSION_STALE') throw new NewMembershipError('STALE', response.status);
  if (code === 'PERSON_MEMBERSHIP_CONFLICT') throw new NewMembershipError('CONFLICT', response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new NewMembershipError('REFUSED', response.status);
  throw new NewMembershipError('UNKNOWN', response.status);
}
async function envelope(response: Response, okStatus: readonly number[], metaKeys: string[]): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  if (!okStatus.includes(response.status)) return refusal(response);
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const raw = await response.text(); if (raw.length > 500_000) invalid();
  const e = closed(JSON.parse(raw), ['data', 'meta']), meta = closed(e.meta, metaKeys);
  uuid(meta.requestId);
  return { data: e.data, meta };
}

export async function readNewMembershipOptions(scope: PersonScope, signal?: AbortSignal): Promise<PersonMembershipStartOptions> {
  const timeout = AbortSignal.timeout(15_000);
  const { data } = await envelope(await fetch(`${personMembershipPath(scope)}/membership-start`, {
    ...fetchOptions, method: 'GET', headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }), [200], ['requestId']);
  return verifyPersonMembershipStartOptions(data, uuid(scope.personId));
}

export function prepareNewMembership(scope: PersonScope, input: Omit<PersonMembershipStartInput, 'personId'>, key: string): NewMembershipRequest {
  validatePersonMembershipStartInput({ ...input, personId: uuid(scope.personId) });
  return Object.freeze({ path: `${personMembershipPath(scope)}/memberships/from-plan`, body: JSON.stringify(input), key: uuid(key) });
}

export async function sendNewMembership(request: NewMembershipRequest): Promise<{ receipt: PersonMembershipStartReceipt; replayed: boolean }> {
  closed(request, ['path', 'body', 'key']);
  const match = /^\/api\/v1\/organizations\/[^/]+\/schools\/[^/]+\/billing\/people\/([^/]+)\/memberships\/from-plan$/.exec(request.path);
  if (!match) invalid();
  const input = validatePersonMembershipStartInput({ ...JSON.parse(request.body), personId: uuid(match[1]) });
  try {
    const { data, meta } = await envelope(await fetch(request.path, {
      ...fetchOptions, method: 'POST', body: request.body, signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': PERSON_MEMBERSHIP_START_COMMAND, 'Idempotency-Key': request.key },
    }), [200, 201], ['requestId', 'replayed']);
    if (typeof meta.replayed !== 'boolean') invalid();
    return { receipt: verifyPersonMembershipStartReceipt(data, input), replayed: meta.replayed };
  } catch (error) {
    if (error instanceof NewMembershipError) throw error;
    throw new NewMembershipError('UNKNOWN', 0);
  }
}
