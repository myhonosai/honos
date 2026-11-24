/**
 * C1 (0521): the contacts list with segments and filters for one school. Names, email and phone as in the people
 * directory (people.read), plus segment, ranks, current plan and when it ends. Staff live on the Team page.
 * C3 (0523): archived and merged contacts are segment ARCHIVED, counted on their own and left out of ALL.
 */
export const SCHOOL_CONTACT_SEGMENTS = ['ALL', 'STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'ARCHIVED'] as const;
export type SchoolContactSegment = typeof SCHOOL_CONTACT_SEGMENTS[number];
export type SchoolContactRowSegment = Exclude<SchoolContactSegment, 'ALL'> | 'OTHER';
export const SCHOOL_CONTACT_ENDS_WITHIN = [7, 30, 60, 90] as const;
export const SCHOOL_CONTACT_PAGE = 50;
/** C4 (0623): list order, membership groups, age bound and the tag shape (as the blasts audience tags). */
export const SCHOOL_CONTACT_SORTS = ['NAME', 'ENDS_SOONEST', 'BELT_HIGH', 'BELT_LOW', 'AGE_YOUNGEST', 'AGE_OLDEST', 'NEWEST'] as const;
export type SchoolContactSort = typeof SCHOOL_CONTACT_SORTS[number];
export const SCHOOL_CONTACT_MEMBERSHIP_FILTERS = ['HAS', 'NONE', 'ACTIVE', 'PAUSED', 'CANCELLING'] as const;
export type SchoolContactMembershipFilter = typeof SCHOOL_CONTACT_MEMBERSHIP_FILTERS[number];
export type SchoolContactMembershipState = 'ACTIVE' | 'PAUSED' | 'CANCELLING';
export const SCHOOL_CONTACT_AGE_MAX = 120;
export const SCHOOL_CONTACT_TAG = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$/;

export interface SchoolContactQuery {
  segment?: SchoolContactSegment; query?: string; rankId?: string; programId?: string; planId?: string;
  endsWithinDays?: typeof SCHOOL_CONTACT_ENDS_WITHIN[number]; options?: boolean;
  sort?: SchoolContactSort; membership?: SchoolContactMembershipFilter; noBelt?: true; endsFrom?: string; endsTo?: string;
  ageMin?: number; ageMax?: number; tag?: string;
}
export interface SchoolContactRow {
  personId: string; version: number; givenName: string; familyName: string; email: string | null; phoneE164: string | null;
  segment: SchoolContactRowSegment; planName: string | null; planCode: string | null; programName: string | null; membershipEndsAt: string | null;
  membershipState: SchoolContactMembershipState | null; age: number | null;
  ranks: { rank: string; color: string | null }[];
}
export interface SchoolContactOptions {
  ranks: { rankId: string; curriculum: string; rank: string }[]; programs: { programId: string; name: string }[]; plans: { planId: string; name: string }[];
  tags: string[];
}
export interface SchoolContactList {
  generatedAt: string; segment: SchoolContactSegment; counts: Record<SchoolContactSegment, number>; rows: SchoolContactRow[]; hasMore: boolean;
  options: SchoolContactOptions | null; nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;
function fail(): never { throw new Error('Unverified contact list.'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) fail();
  return source;
}
const count = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(); return v; };
const text = (v: unknown, max: number) => { if (typeof v !== 'string' || !v || v.length > max || UNSAFE.test(v)) fail(); return v; };
const maybe = (v: unknown, max: number) => v === null ? null : text(v, max);
const uuid = (v: unknown) => { const s = text(v, 36).toLowerCase(); if (!UUID.test(s)) fail(); return s; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as YYYY-MM-DD. */
export function isContactDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const instant = (v: unknown) => { const s = text(v, 30); if (!UTC.test(s) || new Date(s).toISOString() !== s) fail(); return s; };

/** Query string to input. Unknown keys, repeated keys and malformed values are refused. */
export function validateSchoolContactQuery(value: unknown): SchoolContactQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_FAILED');
  const source = value as Record<string, unknown>, out: SchoolContactQuery = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw === undefined) continue;
    if (key === 'segment' && typeof raw === 'string' && (SCHOOL_CONTACT_SEGMENTS as readonly string[]).includes(raw)) out.segment = raw as SchoolContactSegment;
    else if (key === 'query' && typeof raw === 'string' && raw.trim().length >= 1 && raw.length <= 100 && !UNSAFE.test(raw)) out.query = raw.trim();
    else if ((key === 'rankId' || key === 'programId' || key === 'planId') && typeof raw === 'string' && UUID.test(raw)) out[key] = raw.toLowerCase();
    else if (key === 'endsWithinDays' && (typeof raw === 'string' || typeof raw === 'number') && SCHOOL_CONTACT_ENDS_WITHIN.some(d => String(d) === String(raw))) out.endsWithinDays = Number(raw) as typeof SCHOOL_CONTACT_ENDS_WITHIN[number];
    else if (key === 'options' && (raw === true || raw === '1' || raw === 'true')) out.options = true;
    else if (key === 'sort' && typeof raw === 'string' && (SCHOOL_CONTACT_SORTS as readonly string[]).includes(raw)) { if (raw !== 'NAME') out.sort = raw as SchoolContactSort; }
    else if (key === 'membership' && typeof raw === 'string' && (SCHOOL_CONTACT_MEMBERSHIP_FILTERS as readonly string[]).includes(raw)) out.membership = raw as SchoolContactMembershipFilter;
    else if (key === 'noBelt' && (raw === true || raw === '1' || raw === 'true')) out.noBelt = true;
    else if ((key === 'endsFrom' || key === 'endsTo') && isContactDay(raw)) out[key] = raw;
    else if ((key === 'ageMin' || key === 'ageMax') && (typeof raw === 'string' || typeof raw === 'number') && /^(0|[1-9]\d{0,2})$/.test(String(raw))
      && Number(raw) <= SCHOOL_CONTACT_AGE_MAX) out[key] = Number(raw);
    else if (key === 'tag' && typeof raw === 'string' && SCHOOL_CONTACT_TAG.test(raw)) out.tag = raw;
    else throw new Error('VALIDATION_FAILED');
  }
  // C4-5: closed combinations.
  if ((out.noBelt && out.rankId) || ((out.endsFrom || out.endsTo) && out.endsWithinDays) || (out.endsFrom && out.endsTo && out.endsFrom > out.endsTo)
    || (out.ageMin !== undefined && out.ageMax !== undefined && out.ageMin > out.ageMax)) throw new Error('VALIDATION_FAILED');
  return out;
}

export function verifySchoolContactList(value: unknown, query: SchoolContactQuery): Omit<SchoolContactList, 'nextCursor'> {
  const source = exact(value, ['generatedAt', 'segment', 'counts', 'rows', 'hasMore', 'options']);
  if (source.segment !== (query.segment ?? 'ALL') || typeof source.hasMore !== 'boolean') fail();
  const c = exact(source.counts, ['ALL', 'STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'ARCHIVED']);
  const counts = { ALL: count(c.ALL), STUDENT: count(c.STUDENT), TRIAL: count(c.TRIAL), PROSPECT: count(c.PROSPECT), INACTIVE: count(c.INACTIVE), ARCHIVED: count(c.ARCHIVED) };
  if (counts.STUDENT + counts.TRIAL + counts.PROSPECT + counts.INACTIVE > counts.ALL) fail();
  if (!Array.isArray(source.rows) || source.rows.length > SCHOOL_CONTACT_PAGE) fail();
  const seen = new Set<string>();
  const rows = source.rows.map(item => {
    const r = exact(item, ['personId', 'version', 'givenName', 'familyName', 'email', 'phoneE164', 'segment', 'planName', 'planCode', 'programName', 'membershipEndsAt',
      'membershipState', 'age', 'ranks']);
    const personId = uuid(r.personId);
    if (seen.has(personId)) fail();
    seen.add(personId);
    const segment = r.segment;
    if (!['STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'OTHER', 'ARCHIVED'].includes(segment as string) || (query.segment && query.segment !== 'ALL' && segment !== query.segment)
      || ((query.segment ?? 'ALL') === 'ALL' && segment === 'ARCHIVED')) fail();
    if (!Array.isArray(r.ranks) || r.ranks.length > 20) fail();
    const membershipState = r.membershipState;
    if (membershipState !== null && membershipState !== 'ACTIVE' && membershipState !== 'PAUSED' && membershipState !== 'CANCELLING') fail();
    const age = r.age === null ? null : count(r.age);
    if (age !== null && age > SCHOOL_CONTACT_AGE_MAX) fail();
    const ranks = r.ranks.map(x => { const k = exact(x, ['rank', 'color']); const color = maybe(k.color, 9); if (color !== null && !COLOR.test(color)) fail(); return { rank: text(k.rank, 200), color }; });
    return { personId, version: count(r.version), givenName: text(r.givenName, 200), familyName: text(r.familyName, 200), email: maybe(r.email, 320),
      phoneE164: maybe(r.phoneE164, 20), segment: segment as SchoolContactRowSegment, planName: maybe(r.planName, 200), planCode: maybe(r.planCode, 100),
      programName: maybe(r.programName, 200), membershipEndsAt: r.membershipEndsAt === null ? null : instant(r.membershipEndsAt),
      membershipState: membershipState as SchoolContactMembershipState | null, age, ranks };
  });
  let options: SchoolContactOptions | null = null;
  if (source.options !== null) {
    if (!query.options) fail();
    const o = exact(source.options, ['ranks', 'programs', 'plans', 'tags']);
    const list = (v: unknown, max: number) => { if (!Array.isArray(v) || v.length > max) fail(); return v; };
    options = {
      ranks: list(o.ranks, 200).map(x => { const k = exact(x, ['rankId', 'curriculum', 'rank']); return { rankId: uuid(k.rankId), curriculum: text(k.curriculum, 200), rank: text(k.rank, 200) }; }),
      programs: list(o.programs, 100).map(x => { const k = exact(x, ['programId', 'name']); return { programId: uuid(k.programId), name: text(k.name, 200) }; }),
      plans: list(o.plans, 100).map(x => { const k = exact(x, ['planId', 'name']); return { planId: uuid(k.planId), name: text(k.name, 200) }; }),
      tags: list(o.tags, 100).map(x => { const tag = text(x, 40); if (!SCHOOL_CONTACT_TAG.test(tag)) fail(); return tag; }),
    };
  } else if (query.options) fail();
  return { generatedAt: instant(source.generatedAt), segment: source.segment as SchoolContactSegment, counts, rows, hasMore: source.hasMore, options };
}
