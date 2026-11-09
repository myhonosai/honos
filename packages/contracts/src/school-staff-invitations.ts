/** Sprint 2 staff provisioning: one email, one existing custom role, one exact school. Never commercial access. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';
export const STAFF_INVITATION_CONFIRMATION = 'ACCEPT_SCHOOL_STAFF_INVITATION' as const;
export const STAFF_ACCOUNT_HUMAN_COMMAND = 'school-staff-account' as const;
export function accountToken(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID'); return v; }
export function accountEmail(v: unknown): string {
  if (typeof v !== 'string' || v !== v.toLowerCase().trim() || v.length < 3 || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID');
  return v;
}
export interface StaffInvitationInput { schoolId: string; roleId: string; email: string; ttlHours: number; token: string }
export function validateStaffInvitationInput(v: unknown): StaffInvitationInput {
  const o = accountClosed(v, ['schoolId', 'roleId', 'email', 'ttlHours', 'token']);
  if (!Number.isInteger(o.ttlHours) || (o.ttlHours as number) < 1 || (o.ttlHours as number) > 168) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), roleId: accountUuid(o.roleId), email: accountEmail(o.email), ttlHours: o.ttlHours as number, token: accountToken(o.token) });
}
export function validateStaffInvitationRevoke(v: unknown) {
  const o = accountClosed(v, ['schoolId', 'invitationId']);
  return Object.freeze({ schoolId: accountUuid(o.schoolId), invitationId: accountUuid(o.invitationId) });
}
export function validateStaffInvitationAcceptance(v: unknown) {
  const o = accountClosed(v, ['invitationId', 'token', 'confirmation']);
  if (o.confirmation !== STAFF_INVITATION_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ invitationId: accountUuid(o.invitationId), token: accountToken(o.token), confirmation: STAFF_INVITATION_CONFIRMATION });
}
export type StaffInvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export interface StaffInvitation { invitationId: string; schoolId: string; roleId: string; roleName: string; email: string; expiresAt: string; status: StaffInvitationStatus }
export function validateStaffInvitation(v: unknown): StaffInvitation {
  const o = accountClosed(v, ['invitationId', 'schoolId', 'roleId', 'roleName', 'email', 'expiresAt', 'status']);
  if (typeof o.email !== 'string' || o.email.length > 254 || typeof o.roleName !== 'string' || o.roleName.length < 1 || o.roleName.length > 100
    || typeof o.expiresAt !== 'string' || !Number.isFinite(Date.parse(o.expiresAt))
    || !['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'].includes(String(o.status))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return { invitationId: accountUuid(o.invitationId), schoolId: accountUuid(o.schoolId), roleId: accountUuid(o.roleId), roleName: o.roleName,
    email: o.email, expiresAt: o.expiresAt, status: o.status as StaffInvitationStatus };
}
export interface StaffAccountReceipt { invitationId: string; schoolId: string; roleId: string; accountStatus: 'STAFF_ROLE_BOUND'; accessGranted: false; billingActivated: false; aiCreditsGranted: false }
export function validateStaffAccountReceipt(v: unknown): StaffAccountReceipt {
  const o = accountClosed(v, ['invitationId', 'schoolId', 'roleId', 'accountStatus', 'accessGranted', 'billingActivated', 'aiCreditsGranted']);
  if (o.accountStatus !== 'STAFF_ROLE_BOUND' || o.accessGranted !== false || o.billingActivated !== false || o.aiCreditsGranted !== false) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return { invitationId: accountUuid(o.invitationId), schoolId: accountUuid(o.schoolId), roleId: accountUuid(o.roleId), accountStatus: 'STAFF_ROLE_BOUND', accessGranted: false, billingActivated: false, aiCreditsGranted: false };
}
/** Roles the signed-in staff manager may invite someone into at one exact school (read-only, at most 100). */
export interface StaffInvitationRole { roleId: string; roleName: string; permissionCodes: string[] }
export interface StaffInvitationRoles { roles: StaffInvitationRole[]; truncated: boolean }
export function validateStaffInvitationRoles(v: unknown): StaffInvitationRoles {
  const o = accountClosed(v, ['roles', 'truncated']);
  if (!Array.isArray(o.roles) || o.roles.length > 100 || typeof o.truncated !== 'boolean') throw new Error('ACCOUNT_RESPONSE_INVALID');
  const seen = new Set<string>();
  const roles = o.roles.map((raw) => {
    const r = accountClosed(raw, ['roleId', 'roleName', 'permissionCodes']);
    const roleId = accountUuid(r.roleId);
    if (seen.has(roleId) || typeof r.roleName !== 'string' || r.roleName.length < 1 || r.roleName.length > 100
      || !Array.isArray(r.permissionCodes) || r.permissionCodes.length < 1 || r.permissionCodes.length > 200
      || r.permissionCodes.some((p) => typeof p !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(p))
      || new Set(r.permissionCodes).size !== r.permissionCodes.length) throw new Error('ACCOUNT_RESPONSE_INVALID');
    seen.add(roleId);
    return Object.freeze({ roleId, roleName: r.roleName, permissionCodes: Object.freeze([...(r.permissionCodes as string[])]) as string[] });
  });
  return Object.freeze({ roles: Object.freeze(roles) as StaffInvitationRole[], truncated: o.truncated });
}
