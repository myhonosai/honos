/** Sprint 2 parent/guardian linking: one email, one existing active family, one exact school, one access level. Never commercial access. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';
import { accountEmail, accountToken } from './school-staff-invitations.js';
export const FAMILY_ACCESS_INVITATION_CONFIRMATION = 'ACCEPT_FAMILY_ACCESS_INVITATION' as const;
export const FAMILY_ACCESS_END_CONFIRMATION = 'END_FAMILY_ACCESS' as const;
export const FAMILY_ACCOUNT_HUMAN_COMMAND = 'school-family-account' as const;
export const FAMILY_ACCESS_LEVELS = ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER'] as const;
export type FamilyAccessLevel = typeof FAMILY_ACCESS_LEVELS[number];
function level(v: unknown, error: string): FamilyAccessLevel {
  if (typeof v !== 'string' || !(FAMILY_ACCESS_LEVELS as readonly string[]).includes(v)) throw new Error(error);
  return v as FamilyAccessLevel;
}
export interface FamilyAccessInvitationInput { schoolId: string; familyId: string; accessLevel: FamilyAccessLevel; email: string; ttlHours: number; token: string }
export function validateFamilyAccessInvitationInput(v: unknown): FamilyAccessInvitationInput {
  const o = accountClosed(v, ['schoolId', 'familyId', 'accessLevel', 'email', 'ttlHours', 'token']);
  if (!Number.isInteger(o.ttlHours) || (o.ttlHours as number) < 1 || (o.ttlHours as number) > 168) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), familyId: accountUuid(o.familyId), accessLevel: level(o.accessLevel, 'ACCOUNT_INPUT_INVALID'),
    email: accountEmail(o.email), ttlHours: o.ttlHours as number, token: accountToken(o.token) });
}
export function validateFamilyAccessInvitationRevoke(v: unknown) {
  const o = accountClosed(v, ['schoolId', 'invitationId']);
  return Object.freeze({ schoolId: accountUuid(o.schoolId), invitationId: accountUuid(o.invitationId) });
}
export function validateFamilyAccessEnd(v: unknown) {
  const o = accountClosed(v, ['schoolId', 'invitationId', 'confirmation']);
  if (o.confirmation !== FAMILY_ACCESS_END_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), invitationId: accountUuid(o.invitationId), confirmation: FAMILY_ACCESS_END_CONFIRMATION });
}
export function validateFamilyAccessInvitationAcceptance(v: unknown) {
  const o = accountClosed(v, ['invitationId', 'token', 'confirmation']);
  if (o.confirmation !== FAMILY_ACCESS_INVITATION_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ invitationId: accountUuid(o.invitationId), token: accountToken(o.token), confirmation: FAMILY_ACCESS_INVITATION_CONFIRMATION });
}
export type FamilyAccessInvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED' | 'ENDED';
export interface FamilyAccessInvitation { invitationId: string; schoolId: string; familyId: string; familyName: string; accessLevel: FamilyAccessLevel; email: string; expiresAt: string; status: FamilyAccessInvitationStatus }
export function validateFamilyAccessInvitation(v: unknown): FamilyAccessInvitation {
  const o = accountClosed(v, ['invitationId', 'schoolId', 'familyId', 'familyName', 'accessLevel', 'email', 'expiresAt', 'status']);
  if (typeof o.email !== 'string' || o.email.length > 254 || typeof o.familyName !== 'string' || o.familyName.length < 1 || o.familyName.length > 200
    || typeof o.expiresAt !== 'string' || !Number.isFinite(Date.parse(o.expiresAt))
    || !['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'ENDED'].includes(String(o.status))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return { invitationId: accountUuid(o.invitationId), schoolId: accountUuid(o.schoolId), familyId: accountUuid(o.familyId), familyName: o.familyName,
    accessLevel: level(o.accessLevel, 'ACCOUNT_RESPONSE_INVALID'), email: o.email, expiresAt: o.expiresAt, status: o.status as FamilyAccessInvitationStatus };
}
export interface FamilyAccountReceipt { invitationId: string; schoolId: string; familyId: string; accessLevel: FamilyAccessLevel; accountStatus: 'FAMILY_ACCESS_BOUND'; accessGranted: false; billingActivated: false; aiCreditsGranted: false }
export function validateFamilyAccountReceipt(v: unknown): FamilyAccountReceipt {
  const o = accountClosed(v, ['invitationId', 'schoolId', 'familyId', 'accessLevel', 'accountStatus', 'accessGranted', 'billingActivated', 'aiCreditsGranted']);
  if (o.accountStatus !== 'FAMILY_ACCESS_BOUND' || o.accessGranted !== false || o.billingActivated !== false || o.aiCreditsGranted !== false) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return { invitationId: accountUuid(o.invitationId), schoolId: accountUuid(o.schoolId), familyId: accountUuid(o.familyId), accessLevel: level(o.accessLevel, 'ACCOUNT_RESPONSE_INVALID'),
    accountStatus: 'FAMILY_ACCESS_BOUND', accessGranted: false, billingActivated: false, aiCreditsGranted: false };
}
