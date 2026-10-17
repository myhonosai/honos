import { currentSchoolClassSessionsUuid, verifyCurrentSchoolClassSessions, type CurrentSchoolClassSession } from '@hon/contracts';

const RESPONSE_MAX = 64_000;
export class ClassSessionsReadAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current verified human session, exact school permission, or active scheduling entitlement is unavailable. The session list was cleared.'); }
}
export class ClassSessionsReadRejectedError extends Error { constructor() { super('The exact current-school session read was rejected. No session list was retained.'); } }
function invalid(): never { throw new Error('The bounded Class Sessions result could not be verified. No session is selected.'); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}
export function classSessionsReadPath(organizationId: string, schoolId: string): string {
  return `/api/v1/organizations/${currentSchoolClassSessionsUuid(organizationId)}/schools/${currentSchoolClassSessionsUuid(schoolId)}/schedule/sessions`;
}
export function parseClassSessionsRead(value: unknown): CurrentSchoolClassSession[] {
  closed(value, ['data', 'meta']);
  closed(value.meta, ['requestId', 'correlationId']);
  const requestId = currentSchoolClassSessionsUuid(value.meta.requestId);
  if (value.meta.correlationId !== requestId) invalid();
  return verifyCurrentSchoolClassSessions(value.data);
}
/** Explicit GET only; path selectors are untrusted and authorization is repeated server- and database-side. */
export async function loadCurrentSchoolClassSessions(organizationId: string, schoolId: string): Promise<CurrentSchoolClassSession[]> {
  const path = classSessionsReadPath(organizationId, schoolId);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'X-HON-Human-Read': 'class-sessions' },
    });
  } catch { throw new Error('Class Sessions is unavailable. No session list was retained or retried automatically.'); }
  if (response.status === 401 || response.status === 403) throw new ClassSessionsReadAccessError(response.status);
  if ([400,404,405,413,415,422].includes(response.status)) throw new ClassSessionsReadRejectedError();
  try {
    if (!response.ok || response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    const text = await response.text(); if (text.length > RESPONSE_MAX) invalid();
    return parseClassSessionsRead(JSON.parse(text));
  } catch { throw new Error('Class Sessions returned no verified bounded result. No session is selected.'); }
}
