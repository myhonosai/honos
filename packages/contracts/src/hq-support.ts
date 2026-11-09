// B-HQ-2 HQ support records (migration 0232 proposed): HQ-internal support cases per customer organization (optionally
// one school) with an immutable history of notes and changes. HQ owner, or an HQ operator / HQ support person holding
// hq.support.manage. Nothing here sends a message, opens school access or touches billing.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const HQ_SUPPORT_CATEGORIES = ['ACCOUNT_ACCESS','BILLING','ONBOARDING','PRODUCT_ISSUE','DATA_REQUEST','FEEDBACK','OTHER'] as const;
export const HQ_SUPPORT_PRIORITIES = ['LOW','NORMAL','HIGH','URGENT'] as const;
export const HQ_SUPPORT_STATUSES = ['OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED'] as const;
export const HQ_SUPPORT_LIST_FILTERS = ['ACTIVE', ...HQ_SUPPORT_STATUSES] as const;
export type HqSupportCategory = typeof HQ_SUPPORT_CATEGORIES[number];
export type HqSupportPriority = typeof HQ_SUPPORT_PRIORITIES[number];
export type HqSupportStatus = typeof HQ_SUPPORT_STATUSES[number];
export type HqSupportListFilter = typeof HQ_SUPPORT_LIST_FILTERS[number];
/** Human-command header values, one per support command route. */
export const HQ_SUPPORT_COMMANDS = { open: 'hq-support-case-open', note: 'hq-support-case-note', change: 'hq-support-case-change' } as const;
export const HQ_SUPPORT_SUBJECT_MAX = 200;
export const HQ_SUPPORT_NOTE_MAX = 4000;

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v) && !v.includes('\u0000');
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const uuid = (v: unknown): string => (isUuid(v) ? (v as string).toLowerCase() : invalid());

// ---------- inputs ----------
export interface HqSupportOpenInput { organizationId: string; schoolId: string | null; subject: string; category: HqSupportCategory; priority: HqSupportPriority; note: string }
export interface HqSupportNoteInput { expectedVersion: number; note: string }
export interface HqSupportChangeInput { expectedVersion: number; status?: HqSupportStatus; priority?: HqSupportPriority; assigneePrincipalId?: string | null; note?: string }
const version = (v: unknown): number => (isInt(v, 1, 999_999_999) ? v as number : invalid());

export function validateHqSupportOpenInput(value: unknown): HqSupportOpenInput {
  const r = record(value, invalid); exactKeys(r, ['organizationId','schoolId','subject','category','priority','note'], invalid);
  if (!text(r.subject, 3, HQ_SUPPORT_SUBJECT_MAX) || !text(r.note, 1, HQ_SUPPORT_NOTE_MAX) || !has(HQ_SUPPORT_CATEGORIES, r.category)
    || !has(HQ_SUPPORT_PRIORITIES, r.priority)) invalid();
  return { organizationId: uuid(r.organizationId), schoolId: r.schoolId === null ? null : uuid(r.schoolId), subject: r.subject as string,
    category: r.category as HqSupportCategory, priority: r.priority as HqSupportPriority, note: r.note as string };
}
export function validateHqSupportNoteInput(value: unknown): HqSupportNoteInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion','note'], invalid);
  if (!text(r.note, 1, HQ_SUPPORT_NOTE_MAX)) invalid();
  return { expectedVersion: version(r.expectedVersion), note: r.note as string };
}
export function validateHqSupportChangeInput(value: unknown): HqSupportChangeInput {
  const r = record(value, invalid);
  if (!Object.hasOwn(r, 'expectedVersion') || Object.keys(r).some(k => !['expectedVersion','status','priority','assigneePrincipalId','note'].includes(k))) invalid();
  const out: HqSupportChangeInput = { expectedVersion: version(r.expectedVersion) };
  if (Object.hasOwn(r, 'status')) { if (!has(HQ_SUPPORT_STATUSES, r.status)) invalid(); out.status = r.status as HqSupportStatus; }
  if (Object.hasOwn(r, 'priority')) { if (!has(HQ_SUPPORT_PRIORITIES, r.priority)) invalid(); out.priority = r.priority as HqSupportPriority; }
  if (Object.hasOwn(r, 'assigneePrincipalId')) out.assigneePrincipalId = r.assigneePrincipalId === null ? null : uuid(r.assigneePrincipalId);
  if (Object.hasOwn(r, 'note')) { if (!text(r.note, 1, HQ_SUPPORT_NOTE_MAX)) invalid(); out.note = r.note as string; }
  if (out.status === undefined && out.priority === undefined && !Object.hasOwn(out, 'assigneePrincipalId')) invalid();
  return out;
}

// ---------- list query ----------
export interface HqSupportCursor { openedAt: string; caseId: string }
export interface HqSupportListQuery { status: HqSupportListFilter | null; organizationId: string | null; cursor: HqSupportCursor | null; limit: number }
export function encodeHqSupportCursor(c: HqSupportCursor): string { return `${c.openedAt}~${c.caseId}`; }
export function validateHqSupportListQuery(value: unknown): HqSupportListQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status','organizationId','cursor','limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), org = one(q.organizationId), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(HQ_SUPPORT_LIST_FILTERS, status)) || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: HqSupportCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [openedAt, caseId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(openedAt) || !isUuid(caseId)) invalid();
    decoded = { openedAt: openedAt as string, caseId: (caseId as string).toLowerCase() };
  }
  return { status: status as HqSupportListFilter | null, organizationId: org === null ? null : uuid(org), cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

// ---------- responses ----------
export interface HqSupportPerson { principalId: string; displayName: string }
export interface HqSupportCase {
  caseId: string; organizationId: string; organizationDisplayName: string; schoolId: string | null; schoolDisplayName: string | null;
  subject: string; category: HqSupportCategory; priority: HqSupportPriority; status: HqSupportStatus;
  assignee: HqSupportPerson | null; openedBy: HqSupportPerson; openedAt: string; updatedAt: string; closedAt: string | null; version: number; noteCount: number;
}
export interface HqSupportEvent {
  seq: number; kind: 'OPENED' | 'NOTE' | 'CHANGED'; actor: HqSupportPerson; note: string | null;
  statusFrom: HqSupportStatus | null; statusTo: HqSupportStatus | null; priorityFrom: HqSupportPriority | null; priorityTo: HqSupportPriority | null;
  assigneeChanged: boolean; assigneeTo: HqSupportPerson | null; occurredAt: string;
}
export interface HqSupportSummary { OPEN: number; WAITING_ON_SCHOOL: number; RESOLVED: number; CLOSED: number; urgentActive: number; unassignedActive: number }
export interface HqSupportCaseList { cases: HqSupportCase[]; limit: number; nextCursor: HqSupportCursor | null; summary: HqSupportSummary; viewer: HqSupportPerson; asOf: string }
export interface HqSupportCaseDetail { case: HqSupportCase; events: HqSupportEvent[]; assignees: HqSupportPerson[]; viewer: HqSupportPerson; asOf: string }
export interface HqSupportReceipt { operation: 'OPEN' | 'NOTE' | 'CHANGE'; case: HqSupportCase; replayed: boolean }

const COUNT_MAX = 100_000_000;
function person(value: unknown): HqSupportPerson {
  const p = record(value, drift); exactKeys(p, ['principalId','displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120) || (p.displayName as string).length === 0) drift();
  return p as unknown as HqSupportPerson;
}
function supportCase(value: unknown): HqSupportCase {
  const c = record(value, drift);
  exactKeys(c, ['caseId','organizationId','organizationDisplayName','schoolId','schoolDisplayName','subject','category','priority','status',
    'assignee','openedBy','openedAt','updatedAt','closedAt','version','noteCount'], drift);
  if (!isUuid(c.caseId) || !isUuid(c.organizationId) || !label(c.organizationDisplayName, 300) || !nullable(c.schoolId, isUuid)
    || (c.schoolId === null) !== (c.schoolDisplayName === null) || (c.schoolDisplayName !== null && !label(c.schoolDisplayName, 300))
    || !text(c.subject, 3, HQ_SUPPORT_SUBJECT_MAX) || !has(HQ_SUPPORT_CATEGORIES, c.category) || !has(HQ_SUPPORT_PRIORITIES, c.priority)
    || !has(HQ_SUPPORT_STATUSES, c.status) || !isTimestamp(c.openedAt) || !isTimestamp(c.updatedAt) || !nullable(c.closedAt, isTimestamp)
    || (c.status === 'CLOSED') !== (c.closedAt !== null) || Date.parse(c.updatedAt as string) < Date.parse(c.openedAt as string)
    || !isInt(c.version, 1, 999_999_999) || !isInt(c.noteCount, 0, COUNT_MAX)) drift();
  if (c.assignee !== null) person(c.assignee);
  person(c.openedBy);
  return c as unknown as HqSupportCase;
}
function event(value: unknown): HqSupportEvent {
  const e = record(value, drift);
  exactKeys(e, ['seq','kind','actor','note','statusFrom','statusTo','priorityFrom','priorityTo','assigneeChanged','assigneeTo','occurredAt'], drift);
  person(e.actor);
  const st = (v: unknown) => v === null || has(HQ_SUPPORT_STATUSES, v), pr = (v: unknown) => v === null || has(HQ_SUPPORT_PRIORITIES, v);
  if (!isInt(e.seq, 1, COUNT_MAX) || !has(['OPENED','NOTE','CHANGED'], e.kind) || !isTimestamp(e.occurredAt) || typeof e.assigneeChanged !== 'boolean'
    || (e.note !== null && !text(e.note, 1, HQ_SUPPORT_NOTE_MAX)) || !st(e.statusFrom) || !st(e.statusTo) || !pr(e.priorityFrom) || !pr(e.priorityTo)
    || (e.statusFrom === null) !== (e.statusTo === null) || (e.priorityFrom === null) !== (e.priorityTo === null)
    || (!e.assigneeChanged && e.assigneeTo !== null) || (e.kind === 'NOTE' && e.note === null)
    || (e.kind === 'CHANGED' && e.statusTo === null && e.priorityTo === null && !e.assigneeChanged)
    || (e.kind !== 'CHANGED' && (e.statusTo !== null || e.priorityTo !== null || e.assigneeChanged))) drift();
  if (e.assigneeTo !== null) person(e.assigneeTo);
  return e as unknown as HqSupportEvent;
}
export function validateHqSupportCaseList(value: unknown): HqSupportCaseList {
  const r = record(value, drift); exactKeys(r, ['cases','limit','nextCursor','summary','viewer','asOf'], drift);
  if (!Array.isArray(r.cases) || !isInt(r.limit, 1, 100) || r.cases.length > (r.limit as number) || !isTimestamp(r.asOf)) drift();
  const cases = (r.cases as unknown[]).map(supportCase);
  for (let i = 1; i < cases.length; i++) {
    const a = cases[i - 1]!, b = cases[i]!;
    if (a.openedAt < b.openedAt || (a.openedAt === b.openedAt && a.caseId <= b.caseId)) drift();
  }
  const s = record(r.summary, drift); exactKeys(s, ['OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED','urgentActive','unassignedActive'], drift);
  if (Object.values(s).some(n => !isInt(n, 0, COUNT_MAX)) || (s.urgentActive as number) > (s.OPEN as number) + (s.WAITING_ON_SCHOOL as number)
    || (s.unassignedActive as number) > (s.OPEN as number) + (s.WAITING_ON_SCHOOL as number)) drift();
  person(r.viewer);
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['openedAt','caseId'], drift);
    const last = cases.at(-1);
    if (!last || cases.length !== r.limit || c.openedAt !== last.openedAt || c.caseId !== last.caseId) drift();
  }
  return r as unknown as HqSupportCaseList;
}
export function validateHqSupportCaseDetail(value: unknown): HqSupportCaseDetail {
  const r = record(value, drift); exactKeys(r, ['case','events','assignees','viewer','asOf'], drift);
  const c = supportCase(r.case);
  if (!Array.isArray(r.events) || r.events.length === 0 || !Array.isArray(r.assignees) || !isTimestamp(r.asOf)) drift();
  const events = (r.events as unknown[]).map(event);
  if (events.some((e, i) => e.seq !== i + 1) || events[0]!.kind !== 'OPENED' || events.slice(1).some(e => e.kind === 'OPENED')
    || events.filter(e => e.note !== null).length !== c.noteCount) drift();
  (r.assignees as unknown[]).forEach(person); person(r.viewer);
  return r as unknown as HqSupportCaseDetail;
}
export function validateHqSupportReceipt(value: unknown): HqSupportReceipt {
  const r = record(value, drift); exactKeys(r, ['operation','case','replayed'], drift);
  if (!has(['OPEN','NOTE','CHANGE'], r.operation) || typeof r.replayed !== 'boolean') drift();
  supportCase(r.case);
  return r as unknown as HqSupportReceipt;
}

export interface HqSupportSchoolChoice { schoolId: string; schoolDisplayName: string; organizationId: string; organizationDisplayName: string }
export interface HqSupportSchools { schools: HqSupportSchoolChoice[]; truncated: boolean; asOf: string }
export function validateHqSupportSchools(value: unknown): HqSupportSchools {
  const r = record(value, drift); exactKeys(r, ['schools','truncated','asOf'], drift);
  if (!Array.isArray(r.schools) || r.schools.length > 2000 || typeof r.truncated !== 'boolean' || !isTimestamp(r.asOf)) drift();
  for (const value of r.schools as unknown[]) {
    const s = record(value, drift); exactKeys(s, ['schoolId','schoolDisplayName','organizationId','organizationDisplayName'], drift);
    if (!isUuid(s.schoolId) || !isUuid(s.organizationId) || !label(s.schoolDisplayName, 300) || !label(s.organizationDisplayName, 300)) drift();
  }
  return r as unknown as HqSupportSchools;
}
