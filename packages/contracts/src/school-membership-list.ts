/**
 * U6 school-wide membership list (GET /v1/organizations/:org/schools/:school/billing/memberships, migration 0220).
 * Read-only: every membership of the verified school, newest first (created, then id), with its lifecycle state and
 * its reporting status. effectiveStatus is the lifecycle state for every non-ACTIVE membership; an ACTIVE membership
 * is SCHEDULED, IN_EFFECT or ENDED from its confirmed period, or UNDATED when it has none (legacy stored instants are
 * returned as hints only). No money, payer, agreement or reason facts.
 */
export const SCHOOL_MEMBERSHIP_LIST_STATES = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
export type SchoolMembershipListState = (typeof SCHOOL_MEMBERSHIP_LIST_STATES)[number];
export const SCHOOL_MEMBERSHIP_EFFECTIVE_STATUSES = ['SCHEDULED', 'IN_EFFECT', 'ENDED', 'UNDATED', 'DRAFT', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
export type SchoolMembershipEffectiveStatus = (typeof SCHOOL_MEMBERSHIP_EFFECTIVE_STATUSES)[number];

export interface SchoolMembershipListItem {
  membershipId: string;
  state: SchoolMembershipListState;
  version: number;
  planCode: string;
  billingAccountId: string;
  participant: { personId: string; givenName: string; familyName: string } | null;
  effectiveStatus: SchoolMembershipEffectiveStatus;
  datesConfirmed: boolean;
  /** School-local inclusive dates of the current confirmed period; null when dates are not confirmed. */
  currentPeriod: { periodVersion: number; changeKind: string; startDate: string; endDate: string | null } | null;
  /** Legacy stored instants (hints, not confirmed dates); null when dates are confirmed. */
  legacyStoredTerm: { termStartedAt: string | null; termEndsAt: string | null } | null;
  createdAt: string;
}

/** Response meta: { requestId, correlationId, limit, nextCursor, schoolTimezone, localToday }. */
export interface SchoolMembershipListMeta {
  requestId: string;
  correlationId: string;
  limit: number;
  nextCursor: string | null;
  schoolTimezone: string;
  localToday: string;
}

/** The database page as returned by hon.read_school_membership_list (cursorCreatedAt is internal to the API). */
export interface SchoolMembershipListDatabasePage {
  items: Array<SchoolMembershipListItem & { cursorCreatedAt: string }>;
  hasMore: boolean;
  limit: number;
  schoolTimezone: string;
  localToday: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INSTANT_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ITEM_KEYS = ['billingAccountId', 'createdAt', 'currentPeriod', 'cursorCreatedAt', 'datesConfirmed', 'effectiveStatus', 'legacyStoredTerm', 'membershipId',
  'participant', 'planCode', 'state', 'version'].join(',');

function fail(): never { throw new Error('Unverified school membership list.'); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
const keys = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');
const nullableInstant = (value: unknown) => value === null || (typeof value === 'string' && INSTANT_MS.test(value));

/** Strict verifier of the 0220 projection: closed shapes, known codes, coherent confirmed/legacy dates. */
export function verifySchoolMembershipListDatabasePage(value: unknown, expectedLimit: number): SchoolMembershipListDatabasePage {
  const page = record(value);
  if (keys(page) !== 'hasMore,items,limit,localToday,schoolTimezone' || page.limit !== expectedLimit || typeof page.hasMore !== 'boolean'
    || typeof page.schoolTimezone !== 'string' || !page.schoolTimezone || typeof page.localToday !== 'string' || !DATE.test(page.localToday)
    || !Array.isArray(page.items) || page.items.length > expectedLimit) fail();
  for (const raw of page.items) {
    const item = record(raw);
    if (keys(item) !== ITEM_KEYS || typeof item.membershipId !== 'string' || !UUID.test(item.membershipId)
      || !SCHOOL_MEMBERSHIP_LIST_STATES.includes(item.state as SchoolMembershipListState)
      || !Number.isSafeInteger(item.version) || (item.version as number) < 1 || typeof item.planCode !== 'string'
      || typeof item.billingAccountId !== 'string' || !UUID.test(item.billingAccountId)
      || !SCHOOL_MEMBERSHIP_EFFECTIVE_STATUSES.includes(item.effectiveStatus as SchoolMembershipEffectiveStatus)
      || typeof item.datesConfirmed !== 'boolean' || typeof item.createdAt !== 'string' || !INSTANT_MS.test(item.createdAt)
      || typeof item.cursorCreatedAt !== 'string' || !INSTANT_US.test(item.cursorCreatedAt)) fail();
    // Reporting status is the lifecycle state except for ACTIVE, which is always one of the four date statuses.
    const dateStatus = ['SCHEDULED', 'IN_EFFECT', 'ENDED', 'UNDATED'].includes(item.effectiveStatus as string);
    if (item.state === 'ACTIVE' ? !dateStatus : item.effectiveStatus !== item.state) fail();
    if (item.state === 'ACTIVE' && (item.effectiveStatus === 'UNDATED') === item.datesConfirmed) fail();
    if (item.participant !== null) {
      const person = record(item.participant);
      if (keys(person) !== 'familyName,givenName,personId' || typeof person.personId !== 'string' || !UUID.test(person.personId)
        || typeof person.givenName !== 'string' || typeof person.familyName !== 'string') fail();
    }
    if (item.datesConfirmed) {
      const period = record(item.currentPeriod);
      if (item.legacyStoredTerm !== null || keys(period) !== 'changeKind,endDate,periodVersion,startDate' || !Number.isSafeInteger(period.periodVersion)
        || typeof period.changeKind !== 'string' || typeof period.startDate !== 'string' || !DATE.test(period.startDate)
        || !(period.endDate === null || (typeof period.endDate === 'string' && DATE.test(period.endDate)))) fail();
    } else {
      const legacy = record(item.legacyStoredTerm);
      if (item.currentPeriod !== null || keys(legacy) !== 'termEndsAt,termStartedAt' || !nullableInstant(legacy.termStartedAt) || !nullableInstant(legacy.termEndsAt)) fail();
    }
  }
  if (page.hasMore && page.items.length !== expectedLimit) fail();
  return page as unknown as SchoolMembershipListDatabasePage;
}
