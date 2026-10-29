/** P0-1 account binding; never commercial access or a client-selected role. */
export const OWNER_INVITATION_CONFIRMATION = 'ACCEPT_SCHOOL_OWNER_INVITATION' as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function accountUuid(v: unknown): string { if (typeof v !== 'string' || !uuid.test(v)) throw new Error('ACCOUNT_INPUT_INVALID'); return v; }
export function accountClosed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) throw new Error('ACCOUNT_INPUT_INVALID');
  return v as Record<string,unknown>;
}
function token(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID'); return v; }
export interface OwnerInvitationInput { schoolId: string; email: string; ttlHours: number; token: string }
export function validateOwnerInvitationInput(v: unknown): OwnerInvitationInput {
  const o = accountClosed(v,['schoolId','email','ttlHours','token']);
  if (typeof o.email !== 'string' || o.email !== o.email.toLowerCase().trim() || o.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)
    || !Number.isInteger(o.ttlHours) || (o.ttlHours as number)<1 || (o.ttlHours as number)>168) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({schoolId:accountUuid(o.schoolId),email:o.email,ttlHours:o.ttlHours as number,token:token(o.token)});
}
export function validateOwnerInvitationAcceptance(v: unknown) {
  const o=accountClosed(v,['invitationId','token','confirmation']);
  if(o.confirmation!==OWNER_INVITATION_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({invitationId:accountUuid(o.invitationId),token:token(o.token),confirmation:OWNER_INVITATION_CONFIRMATION});
}
export interface OwnerInvitation { invitationId: string; organizationId: string; schoolId: string; email: string; expiresAt: string; status: 'PENDING'|'ACCEPTED'|'EXPIRED'|'REVOKED' }
export function validateOwnerInvitation(v: unknown): OwnerInvitation {
  const o=accountClosed(v,['invitationId','organizationId','schoolId','email','expiresAt','status']);
  if(typeof o.email!=='string' || o.email.length>254 || typeof o.expiresAt!=='string' || !Number.isFinite(Date.parse(o.expiresAt))
    || !['PENDING','ACCEPTED','EXPIRED','REVOKED'].includes(String(o.status))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return {invitationId:accountUuid(o.invitationId),organizationId:accountUuid(o.organizationId),schoolId:accountUuid(o.schoolId),email:o.email,expiresAt:o.expiresAt,status:o.status as OwnerInvitation['status']};
}
export interface OwnerAccountReceipt { invitationId: string; organizationId: string; schoolId: string; accountStatus: 'OWNER_BOUND'; accessGranted: false; billingActivated: false; aiCreditsGranted: false }
export function validateOwnerAccountReceipt(v: unknown): OwnerAccountReceipt {
  const o=accountClosed(v,['invitationId','organizationId','schoolId','accountStatus','accessGranted','billingActivated','aiCreditsGranted']);
  if(o.accountStatus!=='OWNER_BOUND'||o.accessGranted!==false||o.billingActivated!==false||o.aiCreditsGranted!==false) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return {invitationId:accountUuid(o.invitationId),organizationId:accountUuid(o.organizationId),schoolId:accountUuid(o.schoolId),accountStatus:'OWNER_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
}
