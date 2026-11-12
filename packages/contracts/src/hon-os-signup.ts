/** HON OS public sign-up (B-ID-5, 0241): a verified OIDC identity creates its own school, REGISTERED with no access. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const SIGNUP_CONFIRMATION = 'CREATE_HON_OS_SCHOOL_ACCOUNT' as const;
export const SIGNUP_HUMAN_COMMAND = 'hon-os-sign-up' as const;

function signupName(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length < 1 || v.length > 120 || v.trim() !== v || /[\u0000-\u001f\u007f]/.test(v)) throw new Error('ACCOUNT_INPUT_INVALID');
  return v;
}
function timezone(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(v) || /^(posix|right)\//.test(v)) throw new Error('ACCOUNT_INPUT_INVALID');
  return v;
}

export interface SignupInput { ownerName: string; schoolName: string; legalName: string; timezone: string; termsVersionId: string; confirmation: typeof SIGNUP_CONFIRMATION }
export function validateSignupInput(v: unknown): SignupInput {
  const o = accountClosed(v, ['ownerName', 'schoolName', 'legalName', 'timezone', 'termsVersionId', 'confirmation']);
  if (o.confirmation !== SIGNUP_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ ownerName: signupName(o.ownerName), schoolName: signupName(o.schoolName), legalName: signupName(o.legalName),
    timezone: timezone(o.timezone), termsVersionId: accountUuid(o.termsVersionId), confirmation: SIGNUP_CONFIRMATION });
}

export interface SignupRegistration {
  registrationId: string; organizationId: string; schoolId: string; schoolName: string; timezone: string; registeredAt: string;
  lifecycle: 'REGISTERED'; accessGranted: false; billingActivated: false; aiCreditsGranted: false;
}
export function validateSignupRegistration(v: unknown): SignupRegistration {
  const o = accountClosed(v, ['registrationId', 'organizationId', 'schoolId', 'schoolName', 'timezone', 'registeredAt', 'lifecycle', 'accessGranted', 'billingActivated', 'aiCreditsGranted']);
  if (o.lifecycle !== 'REGISTERED' || o.accessGranted !== false || o.billingActivated !== false || o.aiCreditsGranted !== false
    || typeof o.registeredAt !== 'string' || !Number.isFinite(Date.parse(o.registeredAt))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  let schoolName: string, tz: string;
  try { schoolName = signupName(o.schoolName); tz = timezone(o.timezone); } catch { throw new Error('ACCOUNT_RESPONSE_INVALID'); }
  return Object.freeze({ registrationId: accountUuid(o.registrationId), organizationId: accountUuid(o.organizationId), schoolId: accountUuid(o.schoolId),
    schoolName, timezone: tz, registeredAt: o.registeredAt, lifecycle: 'REGISTERED', accessGranted: false, billingActivated: false, aiCreditsGranted: false });
}

export type SignupEligibility = 'ELIGIBLE' | 'ALREADY_REGISTERED' | 'HAS_OTHER_ACCESS' | 'VERIFIED_SIGN_IN_REQUIRED';
export interface SignupTerms { termsVersionId: string; version: number; status: 'TEST_ONLY_DRAFT'; title: string; documentDigest: string }
export interface SignupStatus { signupStatus: 'CLOSED' | 'TEST_MODE'; terms: SignupTerms | null; eligibility: SignupEligibility; registration: SignupRegistration | null }
export function validateSignupStatus(v: unknown): SignupStatus {
  const o = accountClosed(v, ['signupStatus', 'terms', 'eligibility', 'registration']);
  if (!['CLOSED', 'TEST_MODE'].includes(String(o.signupStatus)) || !['ELIGIBLE', 'ALREADY_REGISTERED', 'HAS_OTHER_ACCESS', 'VERIFIED_SIGN_IN_REQUIRED'].includes(String(o.eligibility)))
    throw new Error('ACCOUNT_RESPONSE_INVALID');
  let terms: SignupTerms | null = null;
  if (o.terms !== null) {
    const t = accountClosed(o.terms, ['termsVersionId', 'version', 'status', 'title', 'documentDigest']);
    if (!Number.isInteger(t.version) || (t.version as number) < 1 || t.status !== 'TEST_ONLY_DRAFT' || typeof t.title !== 'string' || t.title.length < 1 || t.title.length > 200
      || typeof t.documentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(t.documentDigest)) throw new Error('ACCOUNT_RESPONSE_INVALID');
    terms = Object.freeze({ termsVersionId: accountUuid(t.termsVersionId), version: t.version as number, status: 'TEST_ONLY_DRAFT', title: t.title, documentDigest: t.documentDigest });
  }
  const registration = o.registration === null ? null : validateSignupRegistration(o.registration);
  if ((registration !== null) !== (o.eligibility === 'ALREADY_REGISTERED')) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return Object.freeze({ signupStatus: o.signupStatus as SignupStatus['signupStatus'], terms, eligibility: o.eligibility as SignupEligibility, registration });
}
