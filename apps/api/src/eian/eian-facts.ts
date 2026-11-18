import { EIAN_LIMITS, type FamilyMessage, type ParentBillingView, type ParentClassBookingChoices, type ParentClassPassView,
  type ParentFamilyKnowledge, type ParentSchoolBookings, type ParentTestingStatusView } from '@hon/contracts';

/**
 * E-AI1 facts (design review 2026-11-18, item 2 and condition A). Each source is the verified output of an existing
 * guarded parent read, called with the signed-in subject under one resolved family scope. Nothing is forwarded whole:
 * every section is projected through an explicit allow-list into a closed shape that hon.eian_facts_ok (0474) checks
 * again. Children appear by display name only. Ids, contact emails, waivers, booking questions, payment attempts and
 * provider outcomes, payer linkage, certificates and registration interests never leave this file. Any email address
 * or uuid inside free text (a message body, an article) is masked, because the database refuses facts that contain one.
 */
export interface EianFactSources {
  timezone: string | null;
  schoolName: string | null;
  now: Date;
  classes: ParentClassBookingChoices | null;
  bookings: ParentSchoolBookings | null;
  testing: ParentTestingStatusView | null;
  billing: ParentBillingView | null;
  classPasses: ParentClassPassView | null;
  messages: FamilyMessage[] | null;
  knowledge: ParentFamilyKnowledge | null;
}
type Item = Record<string, string | number>;
export interface EianFacts {
  today?: string; timezone?: string; schoolName?: string;
  children?: Item[]; classes?: Item[]; bookings?: Item[]; testing?: Item[]; invoices?: Item[]; memberships?: Item[];
  classPasses?: Item[]; messages?: Item[]; knowledge?: Item[]; unavailable?: string[];
}

const SECTION_MAX = { children: 10, classes: 12, bookings: 10, testing: 10, invoices: 10, memberships: 10, classPasses: 10, messages: 5, knowledge: 5 } as const;
type Section = keyof typeof SECTION_MAX;
/** Trimming order when the facts are over the byte cap: the longest, least specific text goes first. */
const TRIM_ORDER: readonly Section[] = ['knowledge', 'messages', 'classes', 'bookings', 'classPasses', 'memberships', 'testing', 'invoices', 'children'];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_TEXT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A lone surrogate cannot be stored as jsonb text, so it becomes the replacement character. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The facts exactly as PostgreSQL prints them as jsonb text (`p::text`), which is what hon.eian_facts_ok measures and
 * what the prompt carries: ", " between items and ": " after each key. Key order differs in jsonb, the length does not.
 * Strings and numbers print as JSON.stringify prints them (the facts hold no lone surrogate and no control character).
 */
export function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}
export const jsonbTextBytes = (value: unknown): number => Buffer.byteLength(jsonbText(value), 'utf8');

/** Plain, bounded, masked text; null when nothing is left. */
export function eianText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replace(CONTROL, ' ').replace(LONE_SURROGATE, '\uFFFD').replace(EMAIL, '[email hidden]').replace(UUID_TEXT, '[id hidden]').replace(/\s+/g, ' ').trim();
  if ([...text].length > max) text = [...text].slice(0, max - 1).join('').trimEnd() + '…';
  return text.length ? text : null;
}
function item(fields: Record<string, unknown>): Item | null {
  const out: Item = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) < 1e9) out[key] = value;
    else {
      const text = eianText(value, key === 'text' ? 600 : 120);
      if (text) out[key] = text;
    }
  }
  return Object.keys(out).length ? out : null;
}
function list(rows: Array<Record<string, unknown>>, section: Section): Item[] {
  return rows.map(item).filter((x): x is Item => x !== null).slice(0, SECTION_MAX[section]);
}

function zoned(at: string | Date, zone: string, withTime: boolean): string | null {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(date);
  } catch { return null; }
}
function money(minor: number, currency: string): string | null {
  if (!Number.isSafeInteger(minor) || !/^[A-Z]{3}$/.test(currency)) return null;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100); } catch { return null; }
}

/** The closed facts object, never larger than the database cap. Sources that could not be read are listed as unavailable. */
export function buildEianFacts(s: EianFactSources): EianFacts {
  const zone = s.timezone ?? 'UTC';
  const facts: EianFacts = {};
  const unavailable: Section[] = [];
  const today = zoned(s.now, zone, false);
  if (today) facts.today = today;
  if (s.timezone && eianText(s.timezone)) facts.timezone = eianText(s.timezone)!;
  if (s.schoolName && eianText(s.schoolName)) facts.schoolName = eianText(s.schoolName)!;

  const names = new Set<string>();
  s.classes?.children.forEach((c) => names.add(c.displayName));
  s.testing?.children.items.forEach((c) => names.add(c.displayName));
  s.classPasses?.children.items.forEach((c) => names.add(c.displayName));
  facts.children = list([...names].map((name) => ({ name })), 'children');

  if (s.classes) {
    const horizon = s.now.getTime() + 14 * 86400000;
    const rows = s.classes.children.flatMap((c) => c.sessions
      .filter((x) => new Date(x.startsAt).getTime() <= horizon)
      .map((x) => ({ at: x.startsAt, booked: x.booking !== null, row: { child: c.displayName, name: `${x.name} (${x.programName})`,
        when: zoned(x.startsAt, zone, true), status: x.booking ? x.booking.status : x.spotsLeft > 0 ? 'OPEN' : 'FULL' } })));
    // Booked classes first, then the soonest open ones.
    rows.sort((a, b) => Number(b.booked) - Number(a.booked) || a.at.localeCompare(b.at));
    facts.classes = list(rows.map((r) => r.row), 'classes');
  } else unavailable.push('classes');

  if (s.bookings) {
    facts.bookings = list(s.bookings.bookings.map((b) => ({ title: b.title, when: `${b.localDate} ${b.localStart}-${b.localEnd}`, status: b.status })), 'bookings');
  } else unavailable.push('bookings');

  if (s.testing) {
    facts.testing = list(s.testing.children.items.map((c) => {
      const latest = c.candidates.items[0];
      return { child: c.displayName,
        status: c.upcomingEvent ? 'UPCOMING_TEST' : latest ? latest.overallStatus : 'NO_TEST_SCHEDULED',
        detail: c.upcomingEvent ? `${c.upcomingEvent.label}, ${zoned(c.upcomingEvent.startsAt, zone, true) ?? ''}`
          : latest ? `${latest.event.label}, ${zoned(latest.event.startsAt, zone, false) ?? ''}` : undefined };
    }), 'testing');
  } else unavailable.push('testing');

  const invoices = s.billing?.invoices, memberships = s.billing?.memberships;
  if (invoices?.status === 'AVAILABLE') {
    facts.invoices = list(invoices.items.map((i) => ({ child: i.participant.displayName, status: i.status,
      amount: money(i.totalMinor, i.currency), due: i.dueAt ? zoned(i.dueAt, zone, false) : undefined })), 'invoices');
  } else unavailable.push('invoices');
  if (memberships?.status === 'AVAILABLE') {
    facts.memberships = list(memberships.items.map((m) => ({ child: m.participant.displayName, state: m.state,
      ends: m.termEndsAt ? zoned(m.termEndsAt, zone, false) : undefined })), 'memberships');
  } else unavailable.push('memberships');

  if (s.classPasses) {
    facts.classPasses = list(s.classPasses.children.items.flatMap((c) => c.passes.items.map((p) => ({ child: c.displayName,
      pass: p.productDisplayName, remaining: p.remainingUses, expires: zoned(p.expiresAt, zone, false), status: p.status }))), 'classPasses');
  } else unavailable.push('classPasses');

  if (s.messages) {
    facts.messages = list(s.messages.slice(-SECTION_MAX.messages).map((m) => ({ from: m.from === 'FAMILY' ? 'family' : 'school',
      when: zoned(m.sentAt, zone, true), text: eianText(m.body, 300) })), 'messages');
  } else unavailable.push('messages');

  if (s.knowledge) {
    facts.knowledge = list(s.knowledge.articles.map((a) => ({ title: a.title, text: eianText(a.body, 400) })), 'knowledge');
  } else unavailable.push('knowledge');

  if (unavailable.length) facts.unavailable = unavailable;
  for (const key of Object.keys(facts) as (keyof EianFacts)[]) if (Array.isArray(facts[key]) && (facts[key] as unknown[]).length === 0 && key !== 'unavailable') delete facts[key];
  // Over the byte cap, measured as the database measures it (jsonb text): drop the last item of the first non-empty
  // section in trim order until it fits, with a margin.
  while (jsonbTextBytes(facts) > EIAN_LIMITS.factsBytes - 200) {
    const section = TRIM_ORDER.find((k) => (facts[k]?.length ?? 0) > 0);
    if (!section) break;
    facts[section]!.pop();
    if (!facts[section]!.length) delete facts[section];
  }
  return facts;
}
