import { SCHOOL_MEMBERSHIP_EFFECTIVE_STATUSES, SCHOOL_MEMBERSHIP_LIST_STATES, type SchoolMembershipListItem, type SchoolMembershipListState } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * U6 membership list: read-only. One page of the verified school's memberships, newest first, optionally narrowed to one
 * lifecycle state. The API and the database each re-decide access on every page; the browser names only the verified
 * school. Nothing here activates, dates, freezes, cancels or charges a membership.
 */
export type MembershipListErrorKind = 'SESSION' | 'DENIED' | 'CURSOR' | 'TIMEZONE' | 'UNAVAILABLE';
export class MembershipListError extends Error { constructor(readonly kind: MembershipListErrorKind) { super(kind); } }
export type Owned = () => boolean;
export type MembershipListScope = Readonly<{ organizationId: string; schoolId: string }>;
export type MembershipListFilter = SchoolMembershipListState | null;
export type MembershipListPage = Readonly<{ items: readonly SchoolMembershipListItem[]; nextCursor: string | null; schoolTimezone: string; localToday: string }>;
export const MEMBERSHIP_PAGE = 50;
const CURSOR_MAX = 512;
const RESPONSE_MAX = 524_288;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_STATUSES = ['SCHEDULED', 'IN_EFFECT', 'ENDED', 'UNDATED'];

const fail = (): never => { throw new Error('shape'); };
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((k) => !own.includes(k))) fail();
  return value as Record<string, unknown>;
}
const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const instant = (v: unknown) => typeof v === 'string' && INSTANT.test(v) && Number.isFinite(Date.parse(v));
const nullableInstant = (v: unknown) => v === null || instant(v);
const date = (v: unknown) => typeof v === 'string' && DATE.test(v);

function item(value: unknown, filter: MembershipListFilter): SchoolMembershipListItem {
  const m = closed(value, ['membershipId', 'state', 'version', 'planCode', 'billingAccountId', 'participant', 'effectiveStatus', 'datesConfirmed', 'currentPeriod', 'legacyStoredTerm', 'createdAt']);
  if (!uuid(m.membershipId) || !(SCHOOL_MEMBERSHIP_LIST_STATES as readonly unknown[]).includes(m.state) || !Number.isSafeInteger(m.version) || (m.version as number) < 1
    || !text(m.planCode, 200) || !uuid(m.billingAccountId) || !(SCHOOL_MEMBERSHIP_EFFECTIVE_STATUSES as readonly unknown[]).includes(m.effectiveStatus)
    || typeof m.datesConfirmed !== 'boolean' || !instant(m.createdAt) || (filter !== null && m.state !== filter)) fail();
  // ACTIVE reports a date status; every other state reports itself. UNDATED exactly when dates are not confirmed.
  if (m.state === 'ACTIVE' ? !DATE_STATUSES.includes(m.effectiveStatus as string) : m.effectiveStatus !== m.state) fail();
  if (m.state === 'ACTIVE' && (m.effectiveStatus === 'UNDATED') === m.datesConfirmed) fail();
  if (m.participant !== null) {
    const p = closed(m.participant, ['personId', 'givenName', 'familyName']);
    if (!uuid(p.personId) || typeof p.givenName !== 'string' || typeof p.familyName !== 'string' || p.givenName.length > 500 || p.familyName.length > 500) fail();
  }
  if (m.datesConfirmed) {
    const period = closed(m.currentPeriod, ['periodVersion', 'changeKind', 'startDate', 'endDate']);
    if (m.legacyStoredTerm !== null || !Number.isSafeInteger(period.periodVersion) || !text(period.changeKind, 64) || !date(period.startDate)
      || !(period.endDate === null || date(period.endDate)) || (period.endDate !== null && (period.endDate as string) < (period.startDate as string))) fail();
  } else {
    const legacy = closed(m.legacyStoredTerm, ['termStartedAt', 'termEndsAt']);
    if (m.currentPeriod !== null || !nullableInstant(legacy.termStartedAt) || !nullableInstant(legacy.termEndsAt)) fail();
  }
  return m as unknown as SchoolMembershipListItem;
}
/** One list page, closed and newest first; rows of another state than the filter, or repeated rows, fail. */
export function verifyMembershipListPage(value: unknown, filter: MembershipListFilter): MembershipListPage {
  const body = closed(value, ['data', 'meta']), meta = closed(body.meta, ['requestId', 'correlationId', 'limit', 'nextCursor', 'schoolTimezone', 'localToday']);
  if (!uuid(meta.requestId) || meta.correlationId !== meta.requestId || meta.limit !== MEMBERSHIP_PAGE || !text(meta.schoolTimezone, 64) || !date(meta.localToday)
    || (meta.nextCursor !== null && (typeof meta.nextCursor !== 'string' || meta.nextCursor.length < 1 || meta.nextCursor.length > CURSOR_MAX))) fail();
  if (!Array.isArray(body.data) || body.data.length > MEMBERSHIP_PAGE || (meta.nextCursor !== null && body.data.length !== MEMBERSHIP_PAGE)) fail();
  const items = (body.data as unknown[]).map((v) => item(v, filter));
  if (new Set(items.map((m) => m.membershipId.toLowerCase())).size !== items.length) fail();
  for (let n = 1; n < items.length; n++) if (items[n - 1]!.createdAt < items[n]!.createdAt) fail();
  return { items, nextCursor: meta.nextCursor as string | null, schoolTimezone: meta.schoolTimezone as string, localToday: meta.localToday as string };
}

const codeOf = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
export interface MembershipListApi {
  page(scope: MembershipListScope, filter: MembershipListFilter, cursor: string | null, signal: AbortSignal, owned: Owned): Promise<MembershipListPage>;
}
export const membershipListApi: MembershipListApi = {
  async page(scope, filter, cursor, signal, owned) {
    if (!uuid(scope.organizationId) || !uuid(scope.schoolId) || (cursor !== null && (cursor.length < 1 || cursor.length > CURSOR_MAX))) throw new MembershipListError('UNAVAILABLE');
    const query = new URLSearchParams({ limit: String(MEMBERSHIP_PAGE), ...(filter === null ? {} : { state: filter }), ...(cursor === null ? {} : { cursor }) });
    const path = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/billing/memberships?${query}`;
    let response: Response;
    try {
      response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' }, signal });
    } catch (error) { if (signal.aborted) throw error; throw new MembershipListError('UNAVAILABLE'); }
    // A retired read (aborted, or no longer the one shown) never ends a newer session.
    signal.throwIfAborted();
    if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MembershipListError('SESSION'); }
    if (response.status === 403) throw new MembershipListError('DENIED');
    if (response.redirected || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new MembershipListError('UNAVAILABLE');
    let value: unknown;
    try {
      const raw = await response.text();
      if (raw.length > RESPONSE_MAX) throw new MembershipListError('UNAVAILABLE');
      value = JSON.parse(raw) as unknown;
    } catch (error) { if (signal.aborted) throw error; throw new MembershipListError('UNAVAILABLE'); }
    if (response.status === 400 && codeOf(value) === 'INVALID_CURSOR') throw new MembershipListError('CURSOR');
    if (response.status === 409 && codeOf(value) === 'SCHOOL_TIMEZONE_INVALID') throw new MembershipListError('TIMEZONE');
    if (response.status !== 200) throw new MembershipListError('UNAVAILABLE');
    try { return verifyMembershipListPage(value, filter); } catch { throw new MembershipListError('UNAVAILABLE'); }
  },
};

/** Counts over the rows read so far only; the view says when more rows exist. */
export function membershipCounts(items: readonly SchoolMembershipListItem[]): Readonly<Record<'inEffect' | 'scheduled' | 'undated' | 'draft' | 'other', number>> {
  let inEffect = 0, scheduled = 0, undated = 0, draft = 0, other = 0;
  for (const m of items) {
    if (m.effectiveStatus === 'IN_EFFECT') inEffect++;
    else if (m.effectiveStatus === 'SCHEDULED') scheduled++;
    else if (m.effectiveStatus === 'UNDATED') undated++;
    else if (m.effectiveStatus === 'DRAFT') draft++;
    else other++;
  }
  return { inEffect, scheduled, undated, draft, other };
}
