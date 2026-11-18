import { accountUuid, validateSchoolContactArchiveInput, validateSchoolContactMergeInput, validateSchoolContactQuery, verifySchoolContactArchiveReceipt,
  verifySchoolContactArchiveState, verifySchoolContactCard, verifySchoolContactList, verifySchoolContactMergePreview, verifySchoolContactMergeReceipt,
  SCHOOL_CONTACT_ARCHIVE_BLOCKERS, SCHOOL_CONTACT_MERGE_BLOCKERS, SCHOOL_CONTACT_RESTORE_BLOCKERS,
  type SchoolContactArchiveReceipt, type SchoolContactArchiveState, type SchoolContactCard, type SchoolContactList, type SchoolContactMergePreview,
  type SchoolContactMergeReceipt, type SchoolContactQuery, type SchoolContactSegment } from '@hon/contracts';
import { PersonRecordError, codeOf, exchange, personErrorFor, type PeopleScope } from './http';

/**
 * C1 (0513): the contacts list for the school the shell verified. One same-origin GET with no key and no command header;
 * the server re-proves people.read and signs the page cursor to this school and these filters.
 */
export type ContactFilters = Readonly<{ segment: SchoolContactSegment; query: string; rankId: string; programId: string; planId: string; endsWithinDays: '' | '7' | '30' | '60' | '90' }>;
export const NO_CONTACT_FILTERS: ContactFilters = { segment: 'ALL', query: '', rankId: '', programId: '', planId: '', endsWithinDays: '' };
export const CONTACT_QUERY_MAX = 100;

/** The closed query the server accepts; empty filters are left out. */
export function contactQuery(filters: ContactFilters, options: boolean): SchoolContactQuery {
  const q = filters.query.trim().slice(0, CONTACT_QUERY_MAX);
  return validateSchoolContactQuery({
    ...(filters.segment !== 'ALL' ? { segment: filters.segment } : {}), ...(q ? { query: q } : {}),
    ...(filters.rankId ? { rankId: filters.rankId } : {}), ...(filters.programId ? { programId: filters.programId } : {}),
    ...(filters.planId ? { planId: filters.planId } : {}), ...(filters.endsWithinDays ? { endsWithinDays: filters.endsWithinDays } : {}),
    ...(options ? { options: true } : {}),
  });
}

export const contactsApi = {
  async list(scope: PeopleScope, filters: ContactFilters, cursor: string | null, options: boolean, signal: AbortSignal): Promise<SchoolContactList> {
    let query: SchoolContactQuery;
    try { query = contactQuery(filters, options); } catch { throw new PersonRecordError('INVALID'); }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    if (cursor) params.set('cursor', cursor);
    const search = params.toString();
    const path = `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/contacts${search ? `?${search}` : ''}`;
    const { status, value } = await exchange(path, signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new Error('shape');
      const data = (value as { data: unknown }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'nextCursor')) throw new Error('shape');
      const { nextCursor: next, ...rest } = data as { nextCursor: unknown };
      const list = verifySchoolContactList(rest, query);
      if (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > 2000)) throw new Error('cursor');
      if ((next !== null) !== list.hasMore) throw new Error('cursor');
      return { ...list, nextCursor: next };
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
  /** C2 (0514): one contact's card; sections the viewer's role does not include come back as not allowed. */
  async card(scope: PeopleScope, personId: string, signal: AbortSignal): Promise<SchoolContactCard> {
    const path = `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/contacts/${accountUuid(personId)}`;
    const { status, value } = await exchange(path, signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new Error('shape');
      return verifySchoolContactCard((value as { data: unknown }).data, personId);
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
};
export type ContactsApi = typeof contactsApi;

/**
 * C3 (0515): delete (archive), restore and merge. The reads are same-origin GETs; each command is a POST with its own
 * human-command header and a fresh idempotency key, repeating the exact versions (and the plan hash) the read showed.
 */
export type ContactAdminFailure = Readonly<{ kind: 'DENIED' | 'MISSING' | 'BLOCKED' | 'STALE' | 'SESSION' | 'UNKNOWN'; blockers: readonly string[] }>;
export class ContactAdminError extends Error {
  constructor(readonly failure: ContactAdminFailure) { super(failure.kind); }
}
const KNOWN = new Set<string>([...SCHOOL_CONTACT_ARCHIVE_BLOCKERS, ...SCHOOL_CONTACT_RESTORE_BLOCKERS, ...SCHOOL_CONTACT_MERGE_BLOCKERS]);
function adminError(status: number, value: unknown): ContactAdminError {
  const code = codeOf(value);
  const raw = value && typeof value === 'object' && Array.isArray((value as { blockers?: unknown }).blockers) ? (value as { blockers: unknown[] }).blockers : [];
  const blockers = raw.filter((x): x is string => typeof x === 'string' && KNOWN.has(x));
  if (status === 403) return new ContactAdminError({ kind: 'DENIED', blockers: [] });
  if (status === 404) return new ContactAdminError({ kind: 'MISSING', blockers: [] });
  if (status === 409 && code === 'SCHOOL_CONTACT_BLOCKED') return new ContactAdminError({ kind: 'BLOCKED', blockers });
  if (status === 409 && (code === 'SCHOOL_CONTACT_VERSION_CONFLICT' || code === 'SCHOOL_CONTACT_PREVIEW_STALE')) return new ContactAdminError({ kind: 'STALE', blockers: [] });
  return new ContactAdminError({ kind: 'UNKNOWN', blockers: [] });
}
const contactPath = (scope: PeopleScope, personId: string, tail: string) =>
  `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/contacts/${accountUuid(personId)}/${tail}`;
const dataOf = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
};
async function adminExchange<T>(path: string, signal: AbortSignal, verify: (data: unknown) => T, command?: { name: string; body: object; key: string }): Promise<T> {
  let answer: { status: number; value: unknown };
  try {
    answer = await exchange(path, signal, command ? { path, body: JSON.stringify(command.body), key: command.key, owned: () => true, command: command.name } : undefined);
  } catch (error) {
    if (error instanceof PersonRecordError && error.kind === 'SESSION') throw new ContactAdminError({ kind: 'SESSION', blockers: [] });
    throw new ContactAdminError({ kind: 'UNKNOWN', blockers: [] });
  }
  const ok = command ? answer.status === 200 || answer.status === 201 : answer.status === 200;
  if (!ok) throw adminError(answer.status, answer.value);
  try { return verify(dataOf(answer.value)); } catch { throw new ContactAdminError({ kind: 'UNKNOWN', blockers: [] }); }
}
const newKey = () => `contact-${crypto.randomUUID()}`;

export const contactAdminApi = {
  archiveState(scope: PeopleScope, personId: string, signal: AbortSignal): Promise<SchoolContactArchiveState> {
    return adminExchange(contactPath(scope, personId, 'archive'), signal, data => verifySchoolContactArchiveState(data, accountUuid(personId)));
  },
  archive(scope: PeopleScope, personId: string, version: number, restore: boolean, signal: AbortSignal): Promise<SchoolContactArchiveReceipt> {
    const input = validateSchoolContactArchiveInput({ personId: accountUuid(personId), version });
    return adminExchange(contactPath(scope, personId, restore ? 'restore' : 'archive'), signal, data => verifySchoolContactArchiveReceipt(data, input, !restore),
      { name: restore ? 'people.contact.restore' : 'people.contact.archive', body: { version }, key: newKey() });
  },
  mergePreview(scope: PeopleScope, keepPersonId: string, mergePersonId: string, signal: AbortSignal): Promise<SchoolContactMergePreview> {
    const keep = accountUuid(keepPersonId), merge = accountUuid(mergePersonId);
    return adminExchange(`${contactPath(scope, keep, 'merge')}?mergePersonId=${merge}`, signal, data => verifySchoolContactMergePreview(data, keep, merge));
  },
  merge(scope: PeopleScope, preview: SchoolContactMergePreview, signal: AbortSignal): Promise<SchoolContactMergeReceipt> {
    const input = validateSchoolContactMergeInput({ keepPersonId: preview.keep.personId, keepVersion: preview.keep.version, mergePersonId: preview.merge.personId,
      mergeVersion: preview.merge.version, planHash: preview.planHash });
    const { keepPersonId: _keep, ...body } = input;
    return adminExchange(contactPath(scope, input.keepPersonId, 'merge'), signal, data => verifySchoolContactMergeReceipt(data, input),
      { name: 'people.contact.merge', body, key: newKey() });
  },
};
export type ContactAdminApi = typeof contactAdminApi;
