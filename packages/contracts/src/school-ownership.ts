/**
 * B-ID-4 school ownership (0223 proposed; owner decisions H-4, H-5 and "keep HQ owner seats", 2026-11-08).
 * HQ-owner read and command for school owners and the primary owner (HQ seats are shown, never ended here), and the
 * school owner's own ownership view with notices. Closed shapes: every response key is exact, every derived field is
 * re-checked against the facts it is derived from. Never commercial access, billing or AI credits.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const SCHOOL_OWNERSHIP_NOTICE_KINDS = ['OWNER_INVITED', 'OWNER_ADDED', 'PRIMARY_OWNER_CHANGED'] as const;
export type SchoolOwnershipNoticeKind = typeof SCHOOL_OWNERSHIP_NOTICE_KINDS[number];

const bad = (): never => { throw new Error('OWNERSHIP_RESPONSE_INVALID'); };
const ts = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : bad());
const id = (v: unknown): string => { try { return accountUuid(v); } catch { return bad(); } };
const closed = (v: unknown, keys: readonly string[]) => { try { return accountClosed(v, keys); } catch { return bad(); } };
const text = (v: unknown, max: number): string => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : bad());
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : bad());
const ids = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max) bad();
  const out = (v as unknown[]).map(id);
  if (out.some((x, i) => i > 0 && out[i - 1]! >= x)) bad(); // sorted, unique (the database orders by uuid)
  return out;
};

export interface SchoolOwner { ownerGrantId: string; displayName: string; email: string; since: string; primary: boolean; viaInvitation: boolean }
export interface SchoolOwnershipNotice { noticeId: string; kind: SchoolOwnershipNoticeKind; occurredAt: string; invitedEmail: string | null }

function owner(v: unknown): SchoolOwner {
  const o = closed(v, ['ownerGrantId', 'displayName', 'email', 'since', 'primary', 'viaInvitation']);
  return { ownerGrantId: id(o.ownerGrantId), displayName: text(o.displayName, 120), email: text(o.email, 254), since: ts(o.since), primary: bool(o.primary), viaInvitation: bool(o.viaInvitation) };
}
function notice(v: unknown): SchoolOwnershipNotice {
  const o = closed(v, ['noticeId', 'kind', 'occurredAt', 'invitedEmail']);
  const kind = SCHOOL_OWNERSHIP_NOTICE_KINDS.includes(o.kind as SchoolOwnershipNoticeKind) ? o.kind as SchoolOwnershipNoticeKind : bad();
  const invitedEmail = o.invitedEmail === null ? null : text(o.invitedEmail, 254);
  if ((kind === 'OWNER_INVITED' || kind === 'OWNER_ADDED') !== (invitedEmail !== null)) bad();
  return { noticeId: id(o.noticeId), kind, occurredAt: ts(o.occurredAt), invitedEmail };
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
  /** OWNER grants held by HQ people at this school (HQ seats). Kept by owner decision; never listed as owners. */
  hqOwnerGrantIds: string[];
  notices: SchoolOwnershipNotice[]; asOf: string;
}
export function validateHqSchoolOwnership(v: unknown): HqSchoolOwnership {
  const o = closed(v, ['schoolId', 'organizationId', 'owners', 'primaryOwnerGrantId', 'primaryNeeded', 'hqOwnerGrantIds', 'notices', 'asOf']);
  const primaryOwnerGrantId = o.primaryOwnerGrantId === null ? null : id(o.primaryOwnerGrantId);
  const list = owners(o.owners, primaryOwnerGrantId);
  const primaryNeeded = bool(o.primaryNeeded);
  if (primaryNeeded !== (list.length > 0 && primaryOwnerGrantId === null)) bad();
  const hqOwnerGrantIds = ids(o.hqOwnerGrantIds, 50);
  if (hqOwnerGrantIds.some(g => list.some(x => x.ownerGrantId === g))) bad();
  return { schoolId: id(o.schoolId), organizationId: id(o.organizationId), owners: list, primaryOwnerGrantId, primaryNeeded, hqOwnerGrantIds,
    notices: notices(o.notices), asOf: ts(o.asOf) };
}

export function validateSetPrimaryOwnerInput(v: unknown): { schoolId: string; ownerGrantId: string } {
  const o = accountClosed(v, ['schoolId', 'ownerGrantId']);
  return { schoolId: accountUuid(o.schoolId), ownerGrantId: accountUuid(o.ownerGrantId) };
}
export interface SchoolOwnershipReceipt { operation: 'SET_PRIMARY'; schoolId: string; organizationId: string; primaryOwnerGrantId: string; changed: boolean }
export function validateSchoolOwnershipReceipt(v: unknown): SchoolOwnershipReceipt {
  const o = closed(v, ['operation', 'schoolId', 'organizationId', 'primaryOwnerGrantId', 'changed']);
  if (o.operation !== 'SET_PRIMARY') bad();
  return { operation: 'SET_PRIMARY', schoolId: id(o.schoolId), organizationId: id(o.organizationId), primaryOwnerGrantId: id(o.primaryOwnerGrantId), changed: bool(o.changed) };
}

export interface SchoolOwnerOwnershipView { schoolId: string; owners: SchoolOwner[]; yourOwnerGrantId: string; primaryOwnerGrantId: string | null; notices: SchoolOwnershipNotice[]; asOf: string }
export function validateSchoolOwnerOwnershipView(v: unknown): SchoolOwnerOwnershipView {
  const o = closed(v, ['schoolId', 'owners', 'yourOwnerGrantId', 'primaryOwnerGrantId', 'notices', 'asOf']);
  const primaryOwnerGrantId = o.primaryOwnerGrantId === null ? null : id(o.primaryOwnerGrantId);
  const list = owners(o.owners, primaryOwnerGrantId), yourOwnerGrantId = id(o.yourOwnerGrantId);
  if (!list.some(x => x.ownerGrantId === yourOwnerGrantId)) bad();
  return { schoolId: id(o.schoolId), owners: list, yourOwnerGrantId, primaryOwnerGrantId, notices: notices(o.notices), asOf: ts(o.asOf) };
}
