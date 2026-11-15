/**
 * C1 (0373): the contacts list with segments and filters for one school. Names, email and phone as in the people
 * directory (people.read), plus segment, ranks, current plan and when it ends. Staff live on the Team page.
 * C3 (0387): archived and merged contacts are segment ARCHIVED, counted on their own and left out of ALL.
 */
export const SCHOOL_CONTACT_SEGMENTS = ['ALL', 'STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'ARCHIVED'] as const;
export type SchoolContactSegment = typeof SCHOOL_CONTACT_SEGMENTS[number];
export type SchoolContactRowSegment = Exclude<SchoolContactSegment, 'ALL'> | 'OTHER';
export const SCHOOL_CONTACT_ENDS_WITHIN = [7, 30, 60, 90] as const;
export const SCHOOL_CONTACT_PAGE = 50;

export interface SchoolContactQuery {
  segment?: SchoolContactSegment; query?: string; rankId?: string; programId?: string; planId?: string;
  endsWithinDays?: typeof SCHOOL_CONTACT_ENDS_WITHIN[number]; options?: boolean;
}
export interface SchoolContactRow {
  personId: string; version: number; givenName: string; familyName: string; email: string | null; phoneE164: string | null;
  segment: SchoolContactRowSegment; planName: string | null; planCode: string | null; programName: string | null; membershipEndsAt: string | null;
  ranks: { rank: string; color: string | null }[];
}
export interface SchoolContactOptions {
  ranks: { rankId: string; curriculum: string; rank: string }[]; programs: { programId: string; name: string }[]; plans: { planId: string; name: string }[];
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
    else throw new Error('VALIDATION_FAILED');
  }
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
    const r = exact(item, ['personId', 'version', 'givenName', 'familyName', 'email', 'phoneE164', 'segment', 'planName', 'planCode', 'programName', 'membershipEndsAt', 'ranks']);
    const personId = uuid(r.personId);
    if (seen.has(personId)) fail();
    seen.add(personId);
    const segment = r.segment;
    if (!['STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'OTHER', 'ARCHIVED'].includes(segment as string) || (query.segment && query.segment !== 'ALL' && segment !== query.segment)
      || ((query.segment ?? 'ALL') === 'ALL' && segment === 'ARCHIVED')) fail();
    if (!Array.isArray(r.ranks) || r.ranks.length > 20) fail();
    const ranks = r.ranks.map(x => { const k = exact(x, ['rank', 'color']); const color = maybe(k.color, 9); if (color !== null && !COLOR.test(color)) fail(); return { rank: text(k.rank, 200), color }; });
    return { personId, version: count(r.version), givenName: text(r.givenName, 200), familyName: text(r.familyName, 200), email: maybe(r.email, 320),
      phoneE164: maybe(r.phoneE164, 20), segment: segment as SchoolContactRowSegment, planName: maybe(r.planName, 200), planCode: maybe(r.planCode, 100),
      programName: maybe(r.programName, 200), membershipEndsAt: r.membershipEndsAt === null ? null : instant(r.membershipEndsAt), ranks };
  });
  let options: SchoolContactOptions | null = null;
  if (source.options !== null) {
    if (!query.options) fail();
    const o = exact(source.options, ['ranks', 'programs', 'plans']);
    const list = (v: unknown, max: number) => { if (!Array.isArray(v) || v.length > max) fail(); return v; };
    options = {
      ranks: list(o.ranks, 200).map(x => { const k = exact(x, ['rankId', 'curriculum', 'rank']); return { rankId: uuid(k.rankId), curriculum: text(k.curriculum, 200), rank: text(k.rank, 200) }; }),
      programs: list(o.programs, 100).map(x => { const k = exact(x, ['programId', 'name']); return { programId: uuid(k.programId), name: text(k.name, 200) }; }),
      plans: list(o.plans, 100).map(x => { const k = exact(x, ['planId', 'name']); return { planId: uuid(k.planId), name: text(k.name, 200) }; }),
    };
  } else if (query.options) fail();
  return { generatedAt: instant(source.generatedAt), segment: source.segment as SchoolContactSegment, counts, rows, hasMore: source.hasMore, options };
}
