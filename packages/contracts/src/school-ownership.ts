/**
 * B-ID-4 school ownership handoff (0223 proposed; owner decisions H-1..H-5, 2026-11-08).
 * HQ-owner reads and commands for school owners, the primary owner and the cleanup of HQ-held OWNER grants, and the
 * school owner's own ownership view with notices. Closed shapes: every response key is exact, every derived field is
 * re-checked against the facts it is derived from. Never commercial access, billing or AI credits.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const SCHOOL_OWNERSHIP_NOTICE_KINDS = ['OWNER_INVITED', 'OWNER_ADDED', 'PRIMARY_OWNER_CHANGED', 'HQ_OWNER_ACCESS_ENDED'] as const;
export type SchoolOwnershipNoticeKind = typeof SCHOOL_OWNERSHIP_NOTICE_KINDS[number];
export const HQ_OWNER_CLEANUP_BLOCKERS = ['NONE_TO_END', 'SCHOOL_OWNER_REQUIRED'] as const;

const bad = (): never => { throw new Error('OWNERSHIP_RESPONSE_INVALID'); };
const ts = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : bad());
const id = (v: unknown): string => { try { return accountUuid(v); } catch { return bad(); } };
const closed = (v: unknown, keys: readonly string[]) => { try { return accountClosed(v, keys); } catch { return bad(); } };
const text = (v: unknown, max: number): string => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : bad());
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : bad());
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? v as number : bad());
const ids = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max) bad();
  const out = (v as unknown[]).map(id);
  if (out.some((x, i) => i > 0 && out[i - 1]! >= x)) bad(); // sorted, unique (the database orders by uuid)
  return out;
};

export interface SchoolOwner { ownerGrantId: string; displayName: string; email: string; since: string; primary: boolean; viaInvitation: boolean }
export interface SchoolOwnershipNotice { noticeId: string; kind: SchoolOwnershipNoticeKind; occurredAt: string; invitedEmail: string | null; endedGrantCount: number | null }

function owner(v: unknown): SchoolOwner {
  const o = closed(v, ['ownerGrantId', 'displayName', 'email', 'since', 'primary', 'viaInvitation']);
  return { ownerGrantId: id(o.ownerGrantId), displayName: text(o.displayName, 120), email: text(o.email, 254), since: ts(o.since), primary: bool(o.primary), viaInvitation: bool(o.viaInvitation) };
}
function notice(v: unknown): SchoolOwnershipNotice {
  const o = closed(v, ['noticeId', 'kind', 'occurredAt', 'invitedEmail', 'endedGrantCount']);
  const kind = SCHOOL_OWNERSHIP_NOTICE_KINDS.includes(o.kind as SchoolOwnershipNoticeKind) ? o.kind as SchoolOwnershipNoticeKind : bad();
  const invitedEmail = o.invitedEmail === null ? null : text(o.invitedEmail, 254);
  const endedGrantCount = o.endedGrantCount === null ? null : count(o.endedGrantCount);
  const invitedKinds = kind === 'OWNER_INVITED' || kind === 'OWNER_ADDED';
  if (invitedKinds !== (invitedEmail !== null) || (kind === 'HQ_OWNER_ACCESS_ENDED') !== (endedGrantCount !== null && endedGrantCount > 0)) bad();
  return { noticeId: id(o.noticeId), kind, occurredAt: ts(o.occurredAt), invitedEmail, endedGrantCount };
}
function owners(v: unknown, primary: string | null): SchoolOwner[] {
  if (!Array.isArray(v) || v.length > 100) bad();
  const list = (v as unknown[]).map(owner);
  if (new Set(list.map(o => o.ownerGrantId)).size !== list.length) bad();
  // "primary" is exactly the designated live primary; a primary id must be one of the listed owners.
  if (list.some(o => o.primary !== (o.ownerGrantId === primary)) || (primary !== null && !list.some(o => o.ownerGrantId === primary))) bad();
  return list;
}
function notices(v: unknown): SchoolOwnershipNotice[] {
  if (!Array.isArray(v) || v.length > 50) bad();
  const list = (v as unknown[]).map(notice);
  if (list.some((n, i) => i > 0 && list[i - 1]!.occurredAt < n.occurredAt)) bad(); // newest first
  return list;
}

export interface HqSchoolOwnership {
  schoolId: string; organizationId: string; owners: SchoolOwner[]; primaryOwnerGrantId: string | null; primaryNeeded: boolean;
  hqOwnerGrantIds: string[];
  hqOwnerCleanup: { eligible: boolean; blocker: typeof HQ_OWNER_CLEANUP_BLOCKERS[number] | null; expectedGrantIds: string[] };
  notices: SchoolOwnershipNotice[]; asOf: string;
}
export function validateHqSchoolOwnership(v: unknown): HqSchoolOwnership {
  const o = closed(v, ['schoolId', 'organizationId', 'owners', 'primaryOwnerGrantId', 'primaryNeeded', 'hqOwnerGrantIds', 'hqOwnerCleanup', 'notices', 'asOf']);
  const primaryOwnerGrantId = o.primaryOwnerGrantId === null ? null : id(o.primaryOwnerGrantId);
  const list = owners(o.owners, primaryOwnerGrantId);
  const primaryNeeded = bool(o.primaryNeeded);
  if (primaryNeeded !== (list.length > 0 && primaryOwnerGrantId === null)) bad();
  const hqOwnerGrantIds = ids(o.hqOwnerGrantIds, 50);
  const c = closed(o.hqOwnerCleanup, ['eligible', 'blocker', 'expectedGrantIds']);
  const eligible = bool(c.eligible), expectedGrantIds = ids(c.expectedGrantIds, 50);
  const blocker = hqOwnerGrantIds.length === 0 ? 'NONE_TO_END' : list.length === 0 ? 'SCHOOL_OWNER_REQUIRED' : null;
  if (c.blocker !== blocker || eligible !== (blocker === null) || expectedGrantIds.join() !== hqOwnerGrantIds.join()) bad();
  return { schoolId: id(o.schoolId), organizationId: id(o.organizationId), owners: list, primaryOwnerGrantId, primaryNeeded, hqOwnerGrantIds,
    hqOwnerCleanup: { eligible, blocker, expectedGrantIds }, notices: notices(o.notices), asOf: ts(o.asOf) };
}

export interface HqOwnerGrantCleanupSchool {
  schoolId: string; organizationId: string; schoolDisplayName: string; organizationDisplayName: string; schoolOwnerCount: number;
  hqOwnerGrantIds: string[]; eligible: boolean; blocker: 'SCHOOL_OWNER_REQUIRED' | null;
}
export interface HqOwnerGrantCleanup { schools: HqOwnerGrantCleanupSchool[]; total: number; truncated: boolean; summary: { eligible: number; needsOwner: number }; asOf: string }
export function validateHqOwnerGrantCleanup(v: unknown): HqOwnerGrantCleanup {
  const o = closed(v, ['schools', 'total', 'truncated', 'summary', 'asOf']);
  if (!Array.isArray(o.schools) || o.schools.length > 200) bad();
  const schools = (o.schools as unknown[]).map(x => {
    const s = closed(x, ['schoolId', 'organizationId', 'schoolDisplayName', 'organizationDisplayName', 'schoolOwnerCount', 'hqOwnerGrantIds', 'eligible', 'blocker']);
    const schoolOwnerCount = count(s.schoolOwnerCount), hqOwnerGrantIds = ids(s.hqOwnerGrantIds, 50), eligible = bool(s.eligible);
    if (hqOwnerGrantIds.length === 0 || eligible !== (schoolOwnerCount > 0) || s.blocker !== (eligible ? null : 'SCHOOL_OWNER_REQUIRED')) bad();
    return { schoolId: id(s.schoolId), organizationId: id(s.organizationId), schoolDisplayName: text(s.schoolDisplayName, 300),
      organizationDisplayName: text(s.organizationDisplayName, 300), schoolOwnerCount, hqOwnerGrantIds, eligible, blocker: s.blocker as 'SCHOOL_OWNER_REQUIRED' | null };
  });
  if (new Set(schools.map(s => s.schoolId)).size !== schools.length) bad();
  const total = count(o.total), truncated = bool(o.truncated);
  if (truncated !== (total > 200) || schools.length !== Math.min(total, 200)) bad();
  const sm = closed(o.summary, ['eligible', 'needsOwner']);
  const summary = { eligible: count(sm.eligible), needsOwner: count(sm.needsOwner) };
  if (summary.eligible !== schools.filter(s => s.eligible).length || summary.needsOwner !== schools.filter(s => !s.eligible).length) bad();
  return { schools, total, truncated, summary, asOf: ts(o.asOf) };
}

export type SchoolOwnershipCommand =
  | { operation: 'SET_PRIMARY'; schoolId: string; ownerGrantId: string }
  | { operation: 'END_HQ_OWNER_GRANTS'; schoolId: string; expectedGrantIds: string[] };
export function validateSetPrimaryOwnerInput(v: unknown): { schoolId: string; ownerGrantId: string } {
  const o = accountClosed(v, ['schoolId', 'ownerGrantId']);
  return { schoolId: accountUuid(o.schoolId), ownerGrantId: accountUuid(o.ownerGrantId) };
}
export function validateEndHqOwnerGrantsInput(v: unknown): { schoolId: string; expectedGrantIds: string[] } {
  const o = accountClosed(v, ['schoolId', 'expectedGrantIds']);
  if (!Array.isArray(o.expectedGrantIds) || o.expectedGrantIds.length < 1 || o.expectedGrantIds.length > 50) throw new Error('ACCOUNT_INPUT_INVALID');
  const list = (o.expectedGrantIds as unknown[]).map(accountUuid);
  if (new Set(list).size !== list.length) throw new Error('ACCOUNT_INPUT_INVALID');
  return { schoolId: accountUuid(o.schoolId), expectedGrantIds: list };
}
export interface SchoolOwnershipReceipt { operation: 'SET_PRIMARY' | 'END_HQ_OWNER_GRANTS'; schoolId: string; organizationId: string; primaryOwnerGrantId: string | null; changed: boolean; endedGrantIds: string[] }
export function validateSchoolOwnershipReceipt(v: unknown, operation: SchoolOwnershipReceipt['operation']): SchoolOwnershipReceipt {
  const o = closed(v, ['operation', 'schoolId', 'organizationId', 'primaryOwnerGrantId', 'changed', 'endedGrantIds']);
  if (o.operation !== operation) bad();
  const primaryOwnerGrantId = o.primaryOwnerGrantId === null ? null : id(o.primaryOwnerGrantId);
  const changed = bool(o.changed), endedGrantIds = ids(o.endedGrantIds, 50);
  if (operation === 'SET_PRIMARY' ? (primaryOwnerGrantId === null || endedGrantIds.length > 0) : (!changed || endedGrantIds.length === 0)) bad();
  return { operation, schoolId: id(o.schoolId), organizationId: id(o.organizationId), primaryOwnerGrantId, changed, endedGrantIds };
}

export interface SchoolOwnerOwnershipView { schoolId: string; owners: SchoolOwner[]; yourOwnerGrantId: string; primaryOwnerGrantId: string | null; notices: SchoolOwnershipNotice[]; asOf: string }
export function validateSchoolOwnerOwnershipView(v: unknown): SchoolOwnerOwnershipView {
  const o = closed(v, ['schoolId', 'owners', 'yourOwnerGrantId', 'primaryOwnerGrantId', 'notices', 'asOf']);
  const primaryOwnerGrantId = o.primaryOwnerGrantId === null ? null : id(o.primaryOwnerGrantId);
  const list = owners(o.owners, primaryOwnerGrantId), yourOwnerGrantId = id(o.yourOwnerGrantId);
  if (!list.some(x => x.ownerGrantId === yourOwnerGrantId)) bad();
  return { schoolId: id(o.schoolId), owners: list, yourOwnerGrantId, primaryOwnerGrantId, notices: notices(o.notices), asOf: ts(o.asOf) };
}
