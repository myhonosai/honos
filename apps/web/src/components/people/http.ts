import { PERSON_RECORD_HUMAN_COMMAND, accountClosed, accountUuid, validatePersonRecord, validatePersonRecordUpdateInput, validatePersonRecordUpdateResult,
  validateStudentBirthDateUpdateInput, validateStudentBirthDateUpdateResult, type PersonRecord, type PersonRecordUpdateInput, type PersonRecordUpdateResult,
  type StudentBirthDateUpdateInput, type StudentBirthDateUpdateResult } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School person records (B-CRM-1a/1b). The server resolves the person, school and authority from the verified session;
 * the browser only names the selected school and person, and sends the closed edit bodies.
 */
export type PersonErrorKind =
  /** Session ended: nothing more is shown. */ 'SESSION'
  /** This person cannot read or edit people at this school. */ | 'DENIED'
  /** A birth date that makes a known minor an adult needs the school owner. */ | 'OWNER_REQUIRED'
  /** The request was not accepted as sent (format or length). */ | 'INVALID'
  /** Nothing differs from the saved record. */ | 'UNCHANGED'
  /** The person is not at this school (or no longer exists). */ | 'MISSING'
  /** The record changed since it was read: reload before editing. */ | 'CONFLICT'
  /** The address has active consent: the opt-out must be recorded first. */ | 'CONSENT'
  /** The record was busy; nothing was saved. The same request may be sent again. */ | 'BUSY'
  /** The outcome is not known. */ | 'UNKNOWN';
export class PersonRecordError extends Error {
  constructor(readonly kind: PersonErrorKind, readonly code: string | null = null) { super(kind); }
}
export type PeopleScope = Readonly<{ organizationId: string; schoolId: string }>;
export type PersonSummary = Readonly<{ personId: string; givenName: string; familyName: string; email: string | null; phoneE164: string | null }>;
export const PEOPLE_LIST_LIMIT = 50;
export const PEOPLE_QUERY_MAX = 160;
const RESPONSE_MAX_BYTES = 131072;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

type Sent = Readonly<{ path: string; body: string; key: string; owned: () => boolean }>;
/** A bounded, same-origin, no-redirect JSON exchange. Returns the status and the parsed body (null when not JSON). */
async function exchange(path: string, signal: AbortSignal, command?: Sent): Promise<{ status: number; value: unknown }> {
  signal.throwIfAborted();
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': PERSON_RECORD_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired read or command must not invalidate the newer session that replaced it. A command has no abort signal of its
  // own (cancelling it would not prove it was not saved), so its caller says whether it is still the one being shown.
  signal.throwIfAborted();
  if (r.status === 401) { if (!command || command.owned()) reportConfirmedSessionInvalidation(); throw new PersonRecordError('SESSION'); }
  if (r.redirected || r.url && (typeof location === 'undefined' || r.url !== new URL(path, location.origin).href)) throw new PersonRecordError('UNKNOWN');
  if (!JSON_TYPE.test(r.headers.get('content-type') ?? '') || !r.body) return { status: r.status, value: null };
  const reader = r.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted(); const c = await reader.read(); signal.throwIfAborted(); if (c.done) break;
      bytes += c.value.byteLength; if (bytes > RESPONSE_MAX_BYTES) throw new PersonRecordError('UNKNOWN');
      text += decoder.decode(c.value, { stream: true });
    }
    try { return { status: r.status, value: JSON.parse(text + decoder.decode()) as unknown }; } catch { return { status: r.status, value: null }; }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/**
 * Email addresses compare without case: the request is sent lowercase, and the server keeps the stored spelling when the
 * address is unchanged apart from case. A clear (null) matches only null.
 */
export const sameEmail = (a: string | null, b: string | null) => a === null || b === null ? a === b : same(a, b);
const codeOf = (value: unknown): string | null =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : null;

/** What a refused read or command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function personErrorFor(status: number, code: string | null): PersonRecordError {
  if (status === 403) return new PersonRecordError(code === 'PERSON_BIRTH_DATE_OWNER_REQUIRED' ? 'OWNER_REQUIRED' : 'DENIED', code);
  if (status === 400 && code === 'PERSON_UNCHANGED') return new PersonRecordError('UNCHANGED', code);
  if (status === 400 && (code === 'PERSON_INPUT_INVALID' || code === 'ACCOUNT_INPUT_INVALID')) return new PersonRecordError('INVALID', code);
  if (status === 404 && code === 'PERSON_UNAVAILABLE') return new PersonRecordError('MISSING', code);
  if (status === 409 && code === 'PERSON_VERSION_CONFLICT') return new PersonRecordError('CONFLICT', code);
  if (status === 409 && code === 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED') return new PersonRecordError('CONSENT', code);
  if (status === 503 && code === 'PERSON_BUSY') return new PersonRecordError('BUSY', code);
  return new PersonRecordError('UNKNOWN', code);
}

const people = (scope: PeopleScope, query: string) =>
  `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/people${query ? `?query=${encodeURIComponent(query)}` : ''}`;
function summary(v: unknown): PersonSummary {
  const o = accountClosed(v, ['id', 'givenName', 'familyName', 'email', 'phoneE164', 'version', 'createdAt']);
  const text = (x: unknown, max: number) => { if (typeof x !== 'string' || x.length < 1 || x.length > max) throw new Error('shape'); return x; };
  if (!Number.isInteger(o.version) || (o.version as number) < 1) throw new Error('shape');
  return { personId: accountUuid(o.id), givenName: text(o.givenName, 500), familyName: text(o.familyName, 500),
    email: o.email === null ? null : text(o.email, 320), phoneE164: o.phoneE164 === null ? null : text(o.phoneE164, 32) };
}

export const peopleApi = {
  /** At most 50 people at this school, optionally filtered by name, email or phone. */
  async search(scope: PeopleScope, query: string, signal: AbortSignal): Promise<readonly PersonSummary[]> {
    const q = query.trim().slice(0, PEOPLE_QUERY_MAX);
    const { status, value } = await exchange(people(scope, q), signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      const data = accountClosed(value, ['data', 'meta']).data;
      if (!Array.isArray(data) || data.length > PEOPLE_LIST_LIMIT) throw new Error('shape');
      const items = data.map(summary);
      if (new Set(items.map(x => x.personId)).size !== items.length) throw new Error('duplicate');
      return items;
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
  async read(schoolId: string, personId: string, signal: AbortSignal): Promise<PersonRecord> {
    const { status, value } = await exchange(`/api/v1/school/schools/${accountUuid(schoolId)}/people/${accountUuid(personId)}`, signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    let record: PersonRecord;
    try { record = validatePersonRecord(accountClosed(value, ['data']).data); } catch { throw new PersonRecordError('UNKNOWN'); }
    if (!same(record.schoolId, schoolId) || !same(record.personId, personId)) throw new PersonRecordError('UNKNOWN');
    return record;
  },
  /** One edit attempt. The same key and body replay the saved answer; nothing is ever applied twice. */
  async update(input: PersonRecordUpdateInput, key: string, signal: AbortSignal, owned: () => boolean): Promise<PersonRecordUpdateResult> {
    const body = validatePersonRecordUpdateInput(input);
    const { status, value } = await send('/api/v1/school/people/update', body, key, signal, owned);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      const result = validatePersonRecordUpdateResult(accountClosed(value, ['data']).data), p = result.person;
      if (!same(p.schoolId, body.schoolId) || !same(p.personId, body.personId) || p.version <= body.expectedVersion || p.givenName !== body.givenName
        || p.familyName !== body.familyName || !sameEmail(p.email, body.email) || p.phoneE164 !== body.phoneE164) throw new Error('mismatch');
      return result;
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
  async updateBirthDate(input: StudentBirthDateUpdateInput, key: string, signal: AbortSignal, owned: () => boolean): Promise<StudentBirthDateUpdateResult> {
    const body = validateStudentBirthDateUpdateInput(input);
    const { status, value } = await send('/api/v1/school/people/birth-date', body, key, signal, owned);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      const result = validateStudentBirthDateUpdateResult(accountClosed(value, ['data']).data), p = result.person;
      if (!same(p.schoolId, body.schoolId) || !same(p.personId, body.personId) || p.student?.birthDate !== body.birthDate
        || (p.student.version ?? 0) <= body.expectedVersion) throw new Error('mismatch');
      return result;
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
};
async function send(path: string, body: object, key: string, signal: AbortSignal, owned: () => boolean) {
  const k = accountUuid(key);
  try { return await exchange(path, signal, { path, body: JSON.stringify(body), key: k, owned }); }
  catch (error) { if (error instanceof PersonRecordError) throw error; throw new PersonRecordError('UNKNOWN'); }
}
export type PeopleApi = typeof peopleApi;
