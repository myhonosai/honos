import { CURRICULUM_PROGRESS_STATUSES, CURRICULUM_REQUIREMENT_KINDS } from './curriculum-progress.js';
import type { ParentFamilyAccessLevel } from './index.js';

export const PARENT_JOURNEY_UNAVAILABLE = ['READ_API_UNAVAILABLE', 'READ_UNAVAILABLE', 'CHILD_PROFILE_UNAVAILABLE', 'CHILD_MATCH_UNAVAILABLE'] as const;
export type JourneyList<T> = { status: 'AVAILABLE'; items: T[]; limited: boolean } | { status: 'UNAVAILABLE'; reason: (typeof PARENT_JOURNEY_UNAVAILABLE)[number] };
export interface JourneyRequirement { label: string; kind: (typeof CURRICULUM_REQUIREMENT_KINDS)[number]; required: boolean; status: (typeof CURRICULUM_PROGRESS_STATUSES)[number] | null; recordedAt: string | null }
export interface JourneyProgram { name: string; rank: string | null; requirements: JourneyList<JourneyRequirement> }
export interface JourneyBooking { name: string; program: string; startsAt: string; endsAt: string; room: string | null; bookingStatus: 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'CHECKED_IN' | 'NO_SHOW'; sessionStatus: 'DRAFT' | 'SCHEDULED' | 'CANCELLED' | 'COMPLETED'; kind: 'REGULAR' | 'TRIAL' | 'MAKEUP' | 'PRIVATE_LESSON' | 'EVENT' }
export interface JourneyAchievement { name: string; description: string; awardedOn: string }
export interface JourneyDocument { title: string; publishedAt: string }
export interface JourneyChild { name: string; profileAvailable: boolean; programs: JourneyProgram[]; schedule: JourneyList<JourneyBooking>; achievements: JourneyList<JourneyAchievement> }
/** Display only: no tenant, family, child, actor, history, receipt, or action identifiers. */
export interface ParentJourneyView {
  generatedAt: string; from: string; to: string; accessLevel: ParentFamilyAccessLevel; children: JourneyChild[];
  documents: JourneyList<JourneyDocument>; documentReceipts: { status: 'UNAVAILABLE'; reason: 'READ_API_UNAVAILABLE' };
  plannedAbsences: { status: 'UNAVAILABLE'; reason: 'READ_API_UNAVAILABLE' };
}
function invalid(): never { throw new Error('Parent Journey response could not be verified.'); }
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) invalid();
  return r;
}
function text(v: unknown, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || [...v].length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(v)) invalid();
  return v;
}
function bool(v: unknown): boolean { if (typeof v !== 'boolean') invalid(); return v; }
function values<const T extends readonly string[]>(v: unknown, options: T): T[number] { if (typeof v !== 'string' || !options.includes(v)) invalid(); return v as T[number]; }
function array<T>(v: unknown, verify: (x: unknown) => T, max = 100): T[] { if (!Array.isArray(v) || v.length > max) invalid(); return v.map(verify); }
function timestamp(v: unknown): string {
  const s = text(v, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)
    || !Number.isFinite(Date.parse(s)) || Number(s.slice(11, 13)) > 23 || Number(s.slice(14, 16)) > 59 || Number(s.slice(17, 19)) > 59
    || new Date(s.slice(0, 10)).toISOString().slice(0, 10) !== s.slice(0, 10)) invalid();
  return new Date(s).toISOString();
}
function nullable<T>(v: unknown, verify: (x: unknown) => T): T | null { return v === null ? null : verify(v); }
function list<T>(v: unknown, verify: (x: unknown) => T, max = 100): JourneyList<T> {
  if (v && typeof v === 'object' && (v as { status?: string }).status === 'UNAVAILABLE') {
    const r = object(v, ['status', 'reason']); return { status: 'UNAVAILABLE', reason: values(r.reason, PARENT_JOURNEY_UNAVAILABLE) };
  }
  const r = object(v, ['status', 'items', 'limited']);
  values(r.status, ['AVAILABLE']); return { status: 'AVAILABLE', items: array(r.items, verify, max), limited: bool(r.limited) };
}
function requirement(v: unknown): JourneyRequirement {
  const r = object(v, ['label', 'kind', 'required', 'status', 'recordedAt']);
  const status = nullable(r.status, x => values(x, CURRICULUM_PROGRESS_STATUSES)); const recordedAt = nullable(r.recordedAt, timestamp);
  if ((status === null) !== (recordedAt === null)) invalid();
  return { label: text(r.label, 160), kind: values(r.kind, CURRICULUM_REQUIREMENT_KINDS), required: bool(r.required), status, recordedAt };
}
function program(v: unknown): JourneyProgram {
  const r = object(v, ['name', 'rank', 'requirements']); return { name: text(r.name, 200), rank: nullable(r.rank, x => text(x, 200)), requirements: list(r.requirements, requirement, 500) };
}
function booking(v: unknown): JourneyBooking {
  const r = object(v, ['name', 'program', 'startsAt', 'endsAt', 'room', 'bookingStatus', 'sessionStatus', 'kind']);
  const startsAt = timestamp(r.startsAt), endsAt = timestamp(r.endsAt); if (Date.parse(endsAt) <= Date.parse(startsAt)) invalid();
  return { name: text(r.name, 200), program: text(r.program, 200), startsAt, endsAt, room: nullable(r.room, x => text(x, 200)),
    bookingStatus: values(r.bookingStatus, ['BOOKED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'NO_SHOW']),
    sessionStatus: values(r.sessionStatus, ['DRAFT', 'SCHEDULED', 'CANCELLED', 'COMPLETED']), kind: values(r.kind, ['REGULAR', 'TRIAL', 'MAKEUP', 'PRIVATE_LESSON', 'EVENT']) };
}
function achievement(v: unknown): JourneyAchievement {
  const r = object(v, ['name', 'description', 'awardedOn']); const awardedOn = text(r.awardedOn, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(awardedOn) || new Date(awardedOn).toISOString().slice(0, 10) !== awardedOn) invalid();
  return { name: text(r.name, 120), description: r.description === '' ? '' : text(r.description, 1200), awardedOn };
}
function child(v: unknown): JourneyChild {
  const r = object(v, ['name', 'profileAvailable', 'programs', 'schedule', 'achievements']);
  const result = { name: text(r.name, 400), profileAvailable: bool(r.profileAvailable), programs: array(r.programs, program), schedule: list(r.schedule, booking, 1000), achievements: list(r.achievements, achievement, 30) };
  if (!result.profileAvailable && (result.programs.length || result.schedule.status === 'AVAILABLE' || result.achievements.status === 'AVAILABLE')) invalid();
  return result;
}
export function verifyParentJourneyView(v: unknown): ParentJourneyView {
  const r = object(v, ['generatedAt', 'from', 'to', 'accessLevel', 'children', 'documents', 'documentReceipts', 'plannedAbsences']);
  const from = timestamp(r.from), to = timestamp(r.to);
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 31 * 86400000) invalid();
  const children = array(r.children, child);
  for (const c of children) if (c.schedule.status === 'AVAILABLE' && c.schedule.items.some(b => Date.parse(b.startsAt) < Date.parse(from) || Date.parse(b.startsAt) >= Date.parse(to))) invalid();
  for (const v of [r.documentReceipts, r.plannedAbsences]) { const x = object(v, ['status', 'reason']); values(x.status, ['UNAVAILABLE']); values(x.reason, ['READ_API_UNAVAILABLE']); }
  return { generatedAt: timestamp(r.generatedAt), from, to, accessLevel: values(r.accessLevel, ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER']), children,
    documents: list(r.documents, v => { const d = object(v, ['title', 'publishedAt']); return { title: text(d.title, 200), publishedAt: timestamp(d.publishedAt) }; }, 50),
    documentReceipts: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' }, plannedAbsences: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' } };
}
