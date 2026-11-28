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

/**
 * 0714 one-click invitation email. The staff browser hands the private code it just made to the API for one send; the
 * recipient is always the invitation's own address, decided by the database, never a value from this body.
 */
export const FAMILY_INVITATION_EMAIL_LANGUAGES = ['en', 'ko', 'es'] as const;
export type FamilyInvitationEmailLanguage = typeof FAMILY_INVITATION_EMAIL_LANGUAGES[number];
export interface FamilyInvitationEmailInput { schoolId: string; invitationId: string; token: string; language: FamilyInvitationEmailLanguage }
export function validateFamilyInvitationEmailInput(v: unknown): FamilyInvitationEmailInput {
  const o = accountClosed(v, ['schoolId', 'invitationId', 'token', 'language']);
  if (typeof o.language !== 'string' || !(FAMILY_INVITATION_EMAIL_LANGUAGES as readonly string[]).includes(o.language)) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), invitationId: accountUuid(o.invitationId), token: accountToken(o.token), language: o.language as FamilyInvitationEmailLanguage });
}
/** What the database allows to be sent (0714). `replayed` true means this exact request was already recorded: send nothing. */
export interface FamilyInvitationEmailGrant { invitationId: string; organizationId: string; schoolId: string; email: string; schoolName: string; familyName: string; expiresAt: string; emailNumber: number; replayed: boolean }
export function validateFamilyInvitationEmailGrant(v: unknown): FamilyInvitationEmailGrant {
  const o = accountClosed(v, ['invitationId', 'organizationId', 'schoolId', 'email', 'schoolName', 'familyName', 'expiresAt', 'emailNumber', 'replayed']);
  if (typeof o.schoolName !== 'string' || !o.schoolName || typeof o.familyName !== 'string' || typeof o.expiresAt !== 'string' || Number.isNaN(Date.parse(o.expiresAt))
    || !Number.isInteger(o.emailNumber) || (o.emailNumber as number) < 1 || (o.emailNumber as number) > 3 || typeof o.replayed !== 'boolean') throw new Error('ACCOUNT_RESPONSE_INVALID');
  return Object.freeze({ invitationId: accountUuid(o.invitationId), organizationId: accountUuid(o.organizationId), schoolId: accountUuid(o.schoolId), email: accountEmail(o.email),
    schoolName: o.schoolName, familyName: o.familyName, expiresAt: o.expiresAt, emailNumber: o.emailNumber as number, replayed: o.replayed });
}
/** SENT: the provider accepted it. NOT_SENT: definitely not sent. UNKNOWN: it may have been. ALREADY_REQUESTED: a repeat of an earlier request, nothing sent now. */
export const FAMILY_INVITATION_EMAIL_DELIVERIES = ['SENT', 'NOT_SENT', 'UNKNOWN', 'ALREADY_REQUESTED'] as const;
export type FamilyInvitationEmailDelivery = typeof FAMILY_INVITATION_EMAIL_DELIVERIES[number];
export interface FamilyInvitationEmailReceipt { invitationId: string; email: string; emailNumber: number; delivery: FamilyInvitationEmailDelivery }
export function validateFamilyInvitationEmailReceipt(v: unknown): FamilyInvitationEmailReceipt {
  const o = accountClosed(v, ['invitationId', 'email', 'emailNumber', 'delivery']);
  if (!Number.isInteger(o.emailNumber) || (o.emailNumber as number) < 1 || (o.emailNumber as number) > 3
    || typeof o.delivery !== 'string' || !(FAMILY_INVITATION_EMAIL_DELIVERIES as readonly string[]).includes(o.delivery)) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return Object.freeze({ invitationId: accountUuid(o.invitationId), email: accountEmail(o.email), emailNumber: o.emailNumber as number, delivery: o.delivery as FamilyInvitationEmailDelivery });
}
/** The public page the emailed button opens. The ID and code ride in the fragment, which browsers never send to a server. */
export const FAMILY_INVITE_LINK_PATH = '/family-invite' as const;
export function familyInviteLink(origin: string, invitationId: string, token: string): string {
  return `${origin}${FAMILY_INVITE_LINK_PATH}#i=${accountUuid(invitationId)}&c=${accountToken(token)}`;
}
/** Reads `#i=<id>&c=<code>` exactly; anything else is no invitation. */
export function parseFamilyInviteFragment(hash: string): { invitationId: string; token: string } | null {
  const m = /^#?i=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&c=([A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? { invitationId: m[1]!, token: m[2]! } : null;
}
