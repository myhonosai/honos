/** Sprint 2 staff provisioning: one email, one existing custom role, one exact school. Never commercial access. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';
export const STAFF_INVITATION_CONFIRMATION = 'ACCEPT_SCHOOL_STAFF_INVITATION' as const;
export const STAFF_ACCOUNT_HUMAN_COMMAND = 'school-staff-account' as const;
function token(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID'); return v; }
function email(v: unknown): string {
  if (typeof v !== 'string' || v !== v.toLowerCase().trim() || v.length < 3 || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID');
  return v;
}
export interface StaffInvitationInput { schoolId: string; roleId: string; email: string; ttlHours: number; token: string }
export function validateStaffInvitationInput(v: unknown): StaffInvitationInput {
  const o = accountClosed(v, ['schoolId', 'roleId', 'email', 'ttlHours', 'token']);
  if (!Number.isInteger(o.ttlHours) || (o.ttlHours as number) < 1 || (o.ttlHours as number) > 168) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), roleId: accountUuid(o.roleId), email: email(o.email), ttlHours: o.ttlHours as number, token: token(o.token) });
}
export function validateStaffInvitationRevoke(v: unknown) {
  const o = accountClosed(v, ['schoolId', 'invitationId']);
  return Object.freeze({ schoolId: accountUuid(o.schoolId), invitationId: accountUuid(o.invitationId) });
}
export function validateStaffInvitationAcceptance(v: unknown) {
  const o = accountClosed(v, ['invitationId', 'token', 'confirmation']);
  if (o.confirmation !== STAFF_INVITATION_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ invitationId: accountUuid(o.invitationId), token: token(o.token), confirmation: STAFF_INVITATION_CONFIRMATION });
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
