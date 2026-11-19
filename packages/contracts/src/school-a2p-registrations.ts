// School A2P 10DLC registrations (0553, docs/architecture/SCHOOL_OWN_SENDERS.md §4.3 step 6-7, §5). A school OWNER
// submits the A2P draft they confirmed in the 0190 assistant plus the business facts Twilio registers; a human HON HQ
// owner approves each submission; the communication worker registers the brand and campaign on the school's own
// subaccount only behind HON_TWILIO_A2P_SUBMIT_APPROVED. Only an approved campaign switches the school's number on.
// The school pays the one-time brand and vetting fees and HON the monthly campaign fee (David 2026-11-14); nothing is
// charged here.

export const SCHOOL_A2P_STATUSES = ['REQUESTED', 'SUBMIT_APPROVED', 'SUBMITTING', 'BRAND_PENDING', 'CAMPAIGN_PENDING', 'APPROVED', 'FAILED', 'REJECTED', 'CANCELLED'] as const;
export type SchoolA2pStatus = typeof SCHOOL_A2P_STATUSES[number];
export const SCHOOL_A2P_REQUEST_COMMAND = 'communication.a2p.request';
export const SCHOOL_A2P_CANCEL_COMMAND = 'communication.a2p.cancel';
export const SCHOOL_A2P_BRAND_TYPES = ['STANDARD', 'LOW_VOLUME_STANDARD'] as const;
export type SchoolA2pBrandType = typeof SCHOOL_A2P_BRAND_TYPES[number];
export const SCHOOL_A2P_BUSINESS_TYPES = ['CORPORATION', 'LLC', 'PARTNERSHIP', 'NON_PROFIT', 'CO_OPERATIVE'] as const;
export type SchoolA2pBusinessType = typeof SCHOOL_A2P_BUSINESS_TYPES[number];

/** What the owner types for the brand. Sole proprietors are not offered (one number cap, OTP to a personal phone). */
export interface SchoolA2pBusiness {
  legalName: string; ein: string; businessType: SchoolA2pBusinessType; street: string; city: string; region: string; postalCode: string;
  contactFirstName: string; contactLastName: string; contactTitle: string; contactEmail: string; contactPhone: string;
}
/** As read back: the EIN shows only its last four digits. */
export type SchoolA2pBusinessView = Omit<SchoolA2pBusiness, 'ein'> & { einLast4: string };

export interface SchoolA2pRegistration {
  registrationId: string; schoolId: string; status: SchoolA2pStatus; brandType: SchoolA2pBrandType;
  useCase: 'ACCOUNT_NOTIFICATION' | 'MARKETING' | 'MIXED'; draftDigest: string;
  answers: Record<string, string>; sampleMessages: { template: string; content: string }[]; helpResponse: string; stopResponse: string;
  business: SchoolA2pBusinessView; decisionNote: string | null; decidedAt: string | null; failureCode: string | null; outcomeUnknown: boolean;
  brandRegistered: boolean; campaignRegistered: boolean; version: number; createdAt: string; updatedAt: string;
}
export interface HqSchoolA2pRegistration extends SchoolA2pRegistration { schoolName: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = ['registrationId', 'schoolId', 'status', 'brandType', 'useCase', 'draftDigest', 'answers', 'sampleMessages', 'helpResponse', 'stopResponse',
  'business', 'decisionNote', 'decidedAt', 'failureCode', 'outcomeUnknown', 'brandRegistered', 'campaignRegistered', 'version', 'createdAt', 'updatedAt'].sort().join(',');
const BUSINESS_VIEW_KEYS = ['legalName', 'einLast4', 'businessType', 'street', 'city', 'region', 'postalCode', 'contactFirstName', 'contactLastName',
  'contactTitle', 'contactEmail', 'contactPhone'].sort().join(',');
const BUSINESS_KEYS = ['legalName', 'ein', 'businessType', 'street', 'city', 'region', 'postalCode', 'contactFirstName', 'contactLastName',
  'contactTitle', 'contactEmail', 'contactPhone'].sort().join(',');
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strict shape check of one registration as the database returns it; anything else is refused. */
export function verifySchoolA2pRegistration(value: unknown): SchoolA2pRegistration {
  const o = value as Record<string, unknown> | null;
  if (!isObject(o) || Object.keys(o).sort().join(',') !== KEYS
    || typeof o.registrationId !== 'string' || !UUID.test(o.registrationId) || typeof o.schoolId !== 'string' || !UUID.test(o.schoolId)
    || !SCHOOL_A2P_STATUSES.includes(o.status as SchoolA2pStatus) || !SCHOOL_A2P_BRAND_TYPES.includes(o.brandType as SchoolA2pBrandType)
    || !['ACCOUNT_NOTIFICATION', 'MARKETING', 'MIXED'].includes(o.useCase as string) || typeof o.draftDigest !== 'string' || !/^[0-9a-f]{64}$/.test(o.draftDigest)
    || !isObject(o.answers) || Object.values(o.answers).some((v) => typeof v !== 'string')
    || !Array.isArray(o.sampleMessages) || o.sampleMessages.length > 10
    || o.sampleMessages.some((m) => !isObject(m) || typeof m.template !== 'string' || typeof m.content !== 'string')
    || typeof o.helpResponse !== 'string' || typeof o.stopResponse !== 'string'
    || !isObject(o.business) || Object.keys(o.business).sort().join(',') !== BUSINESS_VIEW_KEYS
    || Object.values(o.business).some((v) => typeof v !== 'string') || !/^[0-9]{4}$/.test(o.business.einLast4 as string)
    || !nullableString(o.decisionNote) || !nullableString(o.decidedAt) || !nullableString(o.failureCode)
    || typeof o.outcomeUnknown !== 'boolean' || typeof o.brandRegistered !== 'boolean' || typeof o.campaignRegistered !== 'boolean'
    || !Number.isSafeInteger(o.version) || (o.version as number) < 1 || typeof o.createdAt !== 'string' || typeof o.updatedAt !== 'string') {
    throw new Error('Unverified school A2P registration.');
  }
  return o as unknown as SchoolA2pRegistration;
}
export function verifySchoolA2pRegistrationList(value: unknown): SchoolA2pRegistration[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Unverified school A2P registration list.');
  return value.map(verifySchoolA2pRegistration);
}
export function verifyHqSchoolA2pRegistration(value: unknown): HqSchoolA2pRegistration {
  if (!isObject(value) || typeof value.schoolName !== 'string' || value.schoolName.length < 1 || value.schoolName.length > 200) {
    throw new Error('Unverified HQ school A2P registration.');
  }
  const { schoolName, ...registration } = value;
  return { ...verifySchoolA2pRegistration(registration), schoolName };
}
export function verifyHqSchoolA2pRegistrationList(value: unknown): HqSchoolA2pRegistration[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Unverified HQ school A2P registration list.');
  return value.map(verifyHqSchoolA2pRegistration);
}

/** The owner's submission: the 0190 draft input (with the owner confirmation), its digest as shown, the brand type and
 * the business facts. The API regenerates the draft from the input and refuses it unless the digest still matches. */
export interface SchoolA2pRegistrationRequest { draftInput: unknown; expectedDigest: string; brandType: SchoolA2pBrandType; business: SchoolA2pBusiness }
const text = (value: unknown, max = 120) => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
export function validateSchoolA2pRegistrationRequest(body: unknown): SchoolA2pRegistrationRequest {
  if (!isObject(body) || Object.keys(body).sort().join(',') !== 'brandType,business,draftInput,expectedDigest'
    || typeof body.expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedDigest)
    || !SCHOOL_A2P_BRAND_TYPES.includes(body.brandType as SchoolA2pBrandType) || !isObject(body.draftInput)) throw new Error('INVALID_A2P_REGISTRATION');
  const b = body.business;
  if (!isObject(b) || Object.keys(b).sort().join(',') !== BUSINESS_KEYS || !Object.values(b).every((v) => text(v))
    || !SCHOOL_A2P_BUSINESS_TYPES.includes(b.businessType as SchoolA2pBusinessType) || !/^[0-9]{2}-?[0-9]{7}$/.test(b.ein as string)
    || /^(.)\1{8}$/.test((b.ein as string).replace('-', '')) || !/^[A-Z]{2}$/.test(b.region as string) || !/^[0-9]{5}(-[0-9]{4})?$/.test(b.postalCode as string)
    || !/^\+1[2-9][0-9]{9}$/.test(b.contactPhone as string) || !/^[^@\s]{1,64}@[^@\s]+\.[A-Za-z]{2,}$/.test(b.contactEmail as string)) {
    throw new Error('INVALID_A2P_REGISTRATION');
  }
  return { draftInput: body.draftInput, expectedDigest: body.expectedDigest, brandType: body.brandType as SchoolA2pBrandType, business: b as unknown as SchoolA2pBusiness };
}
