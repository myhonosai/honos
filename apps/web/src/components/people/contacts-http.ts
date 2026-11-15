import { accountUuid, validateSchoolContactQuery, verifySchoolContactCard, verifySchoolContactList, type SchoolContactCard, type SchoolContactList, type SchoolContactQuery,
  type SchoolContactSegment } from '@hon/contracts';
import { PersonRecordError, codeOf, exchange, personErrorFor, type PeopleScope } from './http';

/**
 * C1 (0373): the contacts list for the school the shell verified. One same-origin GET with no key and no command header;
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
  /** C2 (0374): one contact's card; sections the viewer's role does not include come back as not allowed. */
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
