/** C2 (0374): one contact's card. Each section is either denied for this viewer or carries its rows; nothing else is shown. */
import type { SchoolContactRowSegment } from './school-contacts.js';

export type Denied = Readonly<{ allowed: false }>;
export type Section<T> = Denied | (Readonly<{ allowed: true }> & T);
export interface SchoolContactCardRank { curriculum: string; rank: string; color: string | null }
export interface SchoolContactCard {
  generatedAt: string;
  person: { personId: string; version: number; givenName: string; familyName: string; email: string | null; phoneE164: string | null; createdAt: string };
  overview: { segment: SchoolContactRowSegment; planName: string | null; programName: string | null; membershipEndsAt: string | null; ranks: SchoolContactCardRank[]; openLead: boolean };
  family: Section<{ families: { familyId: string; name: string; members: { personId: string; givenName: string; familyName: string; role: string; billingContact: boolean }[] }[] }>;
  appointments: Section<{ items: { type: string; status: string; startsAt: string; endsAt: string }[] }>;
  tasks: Section<{ items: { title: string; status: string; priority: string; dueAt: string | null }[] }>;
  membership: Section<{ items: { membershipId: string; state: string; planCode: string; planName: string | null; startedAt: string | null; endsAt: string | null }[] }>;
  billing: Section<{ open: { currency: string; dueMinor: number }[]; invoices: { status: string; currency: string; totalMinor: number; paidMinor: number; dueAt: string | null; createdAt: string }[] }>;
  messages: Section<{ direct: number; family: number }>;
  timeline: { kind: SchoolContactTimelineKind; at: string; detail: string | null }[];
}
export const SCHOOL_CONTACT_TIMELINE_KINDS = ['PERSON_ADDED', 'LEAD_OPENED', 'LEAD_WON', 'LEAD_LOST', 'APPOINTMENT', 'MEMBERSHIP_STARTED', 'MEMBERSHIP_ENDED', 'PAYMENT', 'ATTENDANCE'] as const;
export type SchoolContactTimelineKind = typeof SCHOOL_CONTACT_TIMELINE_KINDS[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const CURRENCY = /^[A-Z]{3}$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;
function fail(): never { throw new Error('Unverified contact card.'); }
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
const maybeInstant = (v: unknown) => v === null ? null : instant(v);
const code = (v: unknown) => { const s = text(v, 60); if (!CODE.test(s)) fail(); return s; };
const bool = (v: unknown) => { if (typeof v !== 'boolean') fail(); return v; };
const list = <T>(v: unknown, max: number, each: (x: unknown) => T): T[] => { if (!Array.isArray(v) || v.length > max) fail(); return v.map(each); };
function section<T>(v: unknown, keys: readonly string[], read: (s: Record<string, unknown>) => T): Section<T> {
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { allowed?: unknown }).allowed === false) { exact(v, ['allowed']); return { allowed: false }; }
  const s = exact(v, ['allowed', ...keys]);
  if (s.allowed !== true) fail();
  return { allowed: true, ...read(s) };
}

/** Path input: one person id. */
export function validateSchoolContactCardInput(personId: unknown): { personId: string } {
  if (typeof personId !== 'string' || !UUID.test(personId)) throw new Error('VALIDATION_FAILED');
  return { personId: personId.toLowerCase() };
}

export function verifySchoolContactCard(value: unknown, personId: string): SchoolContactCard {
  const s = exact(value, ['generatedAt', 'person', 'overview', 'family', 'appointments', 'tasks', 'membership', 'billing', 'messages', 'timeline']);
  const p = exact(s.person, ['personId', 'version', 'givenName', 'familyName', 'email', 'phoneE164', 'createdAt']);
  const person = { personId: uuid(p.personId), version: count(p.version), givenName: text(p.givenName, 200), familyName: text(p.familyName, 200),
    email: maybe(p.email, 320), phoneE164: maybe(p.phoneE164, 20), createdAt: instant(p.createdAt) };
  if (person.personId !== personId.toLowerCase()) fail();
  const o = exact(s.overview, ['segment', 'planName', 'programName', 'membershipEndsAt', 'ranks', 'openLead']);
  if (!['STUDENT', 'TRIAL', 'PROSPECT', 'INACTIVE', 'OTHER'].includes(o.segment as string)) fail();
  const overview = { segment: o.segment as SchoolContactRowSegment, planName: maybe(o.planName, 200), programName: maybe(o.programName, 200),
    membershipEndsAt: maybeInstant(o.membershipEndsAt), openLead: bool(o.openLead),
    ranks: list(o.ranks, 20, x => { const r = exact(x, ['curriculum', 'rank', 'color']); const color = maybe(r.color, 9); if (color !== null && !COLOR.test(color)) fail();
      return { curriculum: text(r.curriculum, 200), rank: text(r.rank, 200), color }; }) };
  const family = section(s.family, ['families'], f => ({ families: list(f.families, 5, x => { const y = exact(x, ['familyId', 'name', 'members']);
    return { familyId: uuid(y.familyId), name: text(y.name, 200), members: list(y.members, 20, m => { const z = exact(m, ['personId', 'givenName', 'familyName', 'role', 'billingContact']);
      return { personId: uuid(z.personId), givenName: text(z.givenName, 200), familyName: text(z.familyName, 200), role: code(z.role), billingContact: bool(z.billingContact) }; }) }; }) }));
  const appointments = section(s.appointments, ['items'], a => ({ items: list(a.items, 20, x => { const y = exact(x, ['type', 'status', 'startsAt', 'endsAt']);
    return { type: code(y.type), status: code(y.status), startsAt: instant(y.startsAt), endsAt: instant(y.endsAt) }; }) }));
  const tasks = section(s.tasks, ['items'], a => ({ items: list(a.items, 20, x => { const y = exact(x, ['title', 'status', 'priority', 'dueAt']);
    return { title: text(y.title, 200), status: code(y.status), priority: code(y.priority), dueAt: maybeInstant(y.dueAt) }; }) }));
  const membership = section(s.membership, ['items'], a => ({ items: list(a.items, 20, x => { const y = exact(x, ['membershipId', 'state', 'planCode', 'planName', 'startedAt', 'endsAt']);
    return { membershipId: uuid(y.membershipId), state: code(y.state), planCode: text(y.planCode, 100), planName: maybe(y.planName, 200), startedAt: maybeInstant(y.startedAt), endsAt: maybeInstant(y.endsAt) }; }) }));
  const money = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(); return v; };
  const currency = (v: unknown) => { const c = text(v, 3); if (!CURRENCY.test(c)) fail(); return c; };
  const billing = section(s.billing, ['open', 'invoices'], b => ({
    open: list(b.open, 20, x => { const y = exact(x, ['currency', 'dueMinor']); return { currency: currency(y.currency), dueMinor: money(y.dueMinor) }; }),
    invoices: list(b.invoices, 20, x => { const y = exact(x, ['status', 'currency', 'totalMinor', 'paidMinor', 'dueAt', 'createdAt']);
      return { status: code(y.status), currency: currency(y.currency), totalMinor: money(y.totalMinor), paidMinor: money(y.paidMinor), dueAt: maybeInstant(y.dueAt), createdAt: instant(y.createdAt) }; }) }));
  const messages = section(s.messages, ['direct', 'family'], m => ({ direct: count(m.direct), family: count(m.family) }));
  const timeline = list(s.timeline, 30, x => { const y = exact(x, ['kind', 'at', 'detail']);
    if (!(SCHOOL_CONTACT_TIMELINE_KINDS as readonly string[]).includes(y.kind as string)) fail();
    return { kind: y.kind as SchoolContactTimelineKind, at: instant(y.at), detail: maybe(y.detail, 200) }; });
  return { generatedAt: instant(s.generatedAt), person, overview, family, appointments, tasks, membership, billing, messages, timeline };
}
