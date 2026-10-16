import type { CommandContext, HonTier } from './index.js';
export interface OwnerLaunchContext extends CommandContext { externalSubject: string; }
export interface RegisterStudentInput {
  programId: string; expectedProgramVersion: number; classSessionId: string; expectedClassSessionVersion: number;
  givenName: string; familyName: string; birthDate: string; attestation: 'NEW_ADULT_NO_GUARDIAN_REQUIRED';
}
export interface StudentRegistrationReceipt {
  registrationId: string; studentProfileId: string; enrollmentId: string; programId: string; classSessionId: string;
  status: 'REGISTERED_NO_BOOKING'; createdAt: string;
}
/** Exact immutable owner-launch receipt only; no student, family, program, class or school selector exists. */
export interface BookOwnerLaunchFirstClassInput {
  registrationId: string; expectedReceiptVersion: 1; expectedClassSessionVersion: number;
}
/** Redacted proof of the canonical booking decision, deliberately not an eligibility/payment/attendance result. */
export interface OwnerLaunchFirstClassBookingReceipt {
  registrationId: string; bookingId: string; classSessionId: string; status: 'BOOKED' | 'WAITLISTED'; bookingVersion: number; recordedAt: string;
}
export type OwnerLaunchRegistrationKind = 'NEW_ADULT_NO_GUARDIAN' | 'NEW_CHILD_WITH_NEW_GUARDIAN';
export interface OwnerLaunchSavedStudentConfirmation {
  registrationId: string; studentProfileId: string; displayName: string; createdAt: string;
  registrationKind: OwnerLaunchRegistrationKind; status: 'REGISTERED_NO_BOOKING';
}
export interface OwnerLaunchSavedStudentsProjection {
  organizationId: string; schoolId: string;
  state: 'NO_RECORDED_REGISTRATIONS' | 'RECORDED_REGISTRATIONS';
  registrations: OwnerLaunchSavedStudentConfirmation[];
}
export interface LaunchProgramReceipt { id: string; version: number; status: 'DRAFT' | 'SCHEDULED' | 'CANCELLED' | 'COMPLETED'; }
export interface LaunchClassReceipt extends LaunchProgramReceipt { programId: string; }
export interface OwnerLaunchProjection {
  organizationId: string; schoolId: string; schoolName: string; tier: HonTier;
  program: LaunchProgramReceipt | null; classSession: LaunchClassReceipt | null; registration: StudentRegistrationReceipt | null; guardianChildRegistration: GuardianChildRegistrationReceipt | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('Unverified owner launch data.'); }
export function ownerLaunchRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
export function ownerLaunchId(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999999999) invalid(); return value; }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\x00-\x1f\x7f<>]/.test(value)) invalid(); return value;
}
export function verifyRegisterStudentInput(value: unknown): RegisterStudentInput {
  const row = ownerLaunchRecord(value, ['programId','expectedProgramVersion','classSessionId','expectedClassSessionVersion','givenName','familyName','birthDate','attestation']);
  const birthDate = text(row.birthDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0,10) !== birthDate || row.attestation !== 'NEW_ADULT_NO_GUARDIAN_REQUIRED') invalid();
  return { programId: ownerLaunchId(row.programId), expectedProgramVersion: version(row.expectedProgramVersion), classSessionId: ownerLaunchId(row.classSessionId), expectedClassSessionVersion: version(row.expectedClassSessionVersion), givenName: text(row.givenName,100), familyName: text(row.familyName,100), birthDate, attestation: 'NEW_ADULT_NO_GUARDIAN_REQUIRED' };
}
export function verifyStudentRegistrationReceipt(value: unknown, input?: Pick<RegisterStudentInput,'programId'|'classSessionId'>): StudentRegistrationReceipt {
  const row = ownerLaunchRecord(value, ['registrationId','studentProfileId','enrollmentId','programId','classSessionId','status','createdAt']);
  const createdAt = text(row.createdAt, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || row.status !== 'REGISTERED_NO_BOOKING') invalid();
  const receipt: StudentRegistrationReceipt = { registrationId: ownerLaunchId(row.registrationId), studentProfileId: ownerLaunchId(row.studentProfileId), enrollmentId: ownerLaunchId(row.enrollmentId), programId: ownerLaunchId(row.programId), classSessionId: ownerLaunchId(row.classSessionId), status: 'REGISTERED_NO_BOOKING', createdAt };
  if (input && (receipt.programId !== input.programId || receipt.classSessionId !== input.classSessionId)) invalid();
  return receipt;
}
export function verifyBookOwnerLaunchFirstClassInput(value: unknown): BookOwnerLaunchFirstClassInput {
  const row = ownerLaunchRecord(value, ['registrationId','expectedReceiptVersion','expectedClassSessionVersion']);
  if (row.expectedReceiptVersion !== 1) invalid();
  return { registrationId: ownerLaunchId(row.registrationId), expectedReceiptVersion: 1, expectedClassSessionVersion: version(row.expectedClassSessionVersion) };
}
export function verifyOwnerLaunchFirstClassBookingReceipt(value: unknown, input?: Pick<BookOwnerLaunchFirstClassInput,'registrationId'>): OwnerLaunchFirstClassBookingReceipt {
  const row = ownerLaunchRecord(value, ['registrationId','bookingId','classSessionId','status','bookingVersion','recordedAt']);
  const recordedAt = text(row.recordedAt, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt)) || !['BOOKED','WAITLISTED'].includes(String(row.status))) invalid();
  const receipt = { registrationId: ownerLaunchId(row.registrationId), bookingId: ownerLaunchId(row.bookingId), classSessionId: ownerLaunchId(row.classSessionId), status: row.status as 'BOOKED' | 'WAITLISTED', bookingVersion: version(row.bookingVersion), recordedAt };
  if (input && receipt.registrationId !== input.registrationId) invalid();
  return receipt;
}
export function verifyOwnerLaunchSavedStudentsProjection(value: unknown): OwnerLaunchSavedStudentsProjection {
  const row = ownerLaunchRecord(value, ['organizationId','schoolId','state','registrations']);
  if (!Array.isArray(row.registrations) || row.registrations.length > 5) invalid();
  const registrations = row.registrations.map((value) => {
    const registration = ownerLaunchRecord(value, ['registrationId','studentProfileId','displayName','createdAt','registrationKind','status']);
    const createdAt = text(registration.createdAt, 24);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || registration.status !== 'REGISTERED_NO_BOOKING'
      || !['NEW_ADULT_NO_GUARDIAN','NEW_CHILD_WITH_NEW_GUARDIAN'].includes(String(registration.registrationKind))) invalid();
    return {
      registrationId: ownerLaunchId(registration.registrationId), studentProfileId: ownerLaunchId(registration.studentProfileId),
      displayName: text(registration.displayName, 160), createdAt,
      registrationKind: registration.registrationKind as OwnerLaunchRegistrationKind, status: 'REGISTERED_NO_BOOKING' as const,
    };
  });
  if ((registrations.length === 0 && row.state !== 'NO_RECORDED_REGISTRATIONS') || (registrations.length > 0 && row.state !== 'RECORDED_REGISTRATIONS')) invalid();
  for (let index = 1; index < registrations.length; index++) {
    const prior = registrations[index - 1]!; const current = registrations[index]!;
    if (Date.parse(prior.createdAt) < Date.parse(current.createdAt) || (prior.createdAt === current.createdAt && prior.registrationId <= current.registrationId)) invalid();
  }
  return {
    organizationId: ownerLaunchId(row.organizationId), schoolId: ownerLaunchId(row.schoolId),
    state: row.state as OwnerLaunchSavedStudentsProjection['state'], registrations,
  };
}
export function verifyLaunchProgramReceipt(value: unknown): LaunchProgramReceipt {
  const row = ownerLaunchRecord(value, ['id','version','status']);
  if (!['DRAFT','SCHEDULED','CANCELLED','COMPLETED'].includes(String(row.status))) invalid();
  return { id: ownerLaunchId(row.id), version: version(row.version), status: row.status as LaunchProgramReceipt['status'] };
}
export function verifyLaunchClassReceipt(value: unknown): LaunchClassReceipt {
  const row = ownerLaunchRecord(value, ['id','programId','version','status']);
  return { ...verifyLaunchProgramReceipt({id:row.id,version:row.version,status:row.status}), programId: ownerLaunchId(row.programId) };
}
export function verifyOwnerLaunchProjection(value: unknown): OwnerLaunchProjection {
  const row = ownerLaunchRecord(value, ['organizationId','schoolId','schoolName','tier','program','classSession','registration','guardianChildRegistration']);
  if (!['ESSENTIAL','CORE','COMPLETE'].includes(String(row.tier))) invalid();
  const program = row.program === null ? null : verifyLaunchProgramReceipt(row.program);
  const classSession = row.classSession === null ? null : verifyLaunchClassReceipt(row.classSession);
  if (classSession && (!program || classSession.programId !== program.id)) invalid();
  const registration = row.registration === null ? null : verifyStudentRegistrationReceipt(row.registration);
  if (registration && (!program || !classSession || registration.programId !== program.id || registration.classSessionId !== classSession.id)) invalid();
  const guardianChildRegistration = row.guardianChildRegistration === null ? null : verifyGuardianChildRegistrationReceipt(row.guardianChildRegistration);
  if (guardianChildRegistration && (!program || !classSession || guardianChildRegistration.programId !== program.id || guardianChildRegistration.classSessionId !== classSession.id)) invalid();
  return { organizationId: ownerLaunchId(row.organizationId), schoolId: ownerLaunchId(row.schoolId), schoolName: text(row.schoolName,160), tier: row.tier as HonTier, program, classSession, registration, guardianChildRegistration };
}

/** Exactly one newly attested pair, not existing-identity/family linking or login. */
export interface RegisterGuardianChildInput {
  programId: string; expectedProgramVersion: number; classSessionId: string; expectedClassSessionVersion: number;
  guardianGivenName: string; guardianFamilyName: string; guardianBirthDate: string;
  childGivenName: string; childFamilyName: string; childBirthDate: string;
  attestation: 'NEW_CHILD_WITH_NEW_GUARDIAN';
}
export interface GuardianChildRegistrationReceipt extends StudentRegistrationReceipt {
  familyId: string; registrationKind: 'NEW_CHILD_WITH_NEW_GUARDIAN';
}
function launchBirthDate(value: unknown): string {
  const date = text(value,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) invalid();
  return date;
}
export function verifyRegisterGuardianChildInput(value: unknown): RegisterGuardianChildInput {
  const row=ownerLaunchRecord(value,['programId','expectedProgramVersion','classSessionId','expectedClassSessionVersion','guardianGivenName','guardianFamilyName','guardianBirthDate','childGivenName','childFamilyName','childBirthDate','attestation']);
  if(row.attestation!=='NEW_CHILD_WITH_NEW_GUARDIAN') invalid();
  const names = ['guardianGivenName','guardianFamilyName','childGivenName','childFamilyName'].map(key=>text(row[key],100));
  if(names.some(name=>!/[\p{L}\p{N}]/u.test(name))) invalid();
  return {programId:ownerLaunchId(row.programId),expectedProgramVersion:version(row.expectedProgramVersion),classSessionId:ownerLaunchId(row.classSessionId),expectedClassSessionVersion:version(row.expectedClassSessionVersion),guardianGivenName:names[0]!,guardianFamilyName:names[1]!,guardianBirthDate:launchBirthDate(row.guardianBirthDate),childGivenName:names[2]!,childFamilyName:names[3]!,childBirthDate:launchBirthDate(row.childBirthDate),attestation:'NEW_CHILD_WITH_NEW_GUARDIAN'};
}
export function verifyGuardianChildRegistrationReceipt(value: unknown, input?: Pick<RegisterGuardianChildInput,'programId'|'classSessionId'>): GuardianChildRegistrationReceipt {
  const row=ownerLaunchRecord(value,['registrationId','studentProfileId','enrollmentId','programId','classSessionId','familyId','registrationKind','status','createdAt']);
  if(row.registrationKind!=='NEW_CHILD_WITH_NEW_GUARDIAN') invalid();
  return {...verifyStudentRegistrationReceipt({registrationId:row.registrationId,studentProfileId:row.studentProfileId,enrollmentId:row.enrollmentId,programId:row.programId,classSessionId:row.classSessionId,status:row.status,createdAt:row.createdAt},input),familyId:ownerLaunchId(row.familyId),registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN'};
}

/** Receipt-only declaration. No price, schedule, payer, participant or activation authority. */
export interface DraftOwnerLaunchMembershipInput {
  registrationId: string; expectedReceiptVersion: 1; planCode: string; termStartedAt: string; termEndsAt: string; currency: string;
}
export interface OwnerLaunchMembershipDraftReceipt {
  registrationId: string; membershipId: string; state: 'DRAFT'; membershipVersion: number; planCode: string;
  termStartedAt: string; termEndsAt: string; currency: string; billingAccountCreated: boolean; recordedAt: string;
}
/** Current audit/receipt-bound confirmation only; historical account metadata is excluded. */
export type OwnerLaunchMembershipDraftConfirmationReceipt = Omit<OwnerLaunchMembershipDraftReceipt, 'billingAccountCreated'>;
export type OwnerLaunchMembershipDraftConfirmation =
  | { state: 'RECORDED_DRAFT'; receipt: OwnerLaunchMembershipDraftConfirmationReceipt }
  | { state: 'NO_RECORDED_DRAFT' | 'DRAFT_UNAVAILABLE'; receipt: null };
export function verifyOwnerLaunchMembershipDraftConfirmation(value: unknown): OwnerLaunchMembershipDraftConfirmation {
  const row = ownerLaunchRecord(value, ['state','receipt']);
  if (row.state === 'NO_RECORDED_DRAFT' || row.state === 'DRAFT_UNAVAILABLE') {
    if (row.receipt !== null) invalid();
    return {state: row.state, receipt: null};
  }
  if (row.state !== 'RECORDED_DRAFT') invalid();
  const safe = ownerLaunchRecord(row.receipt, ['registrationId','membershipId','state','membershipVersion','planCode','termStartedAt','termEndsAt','currency','recordedAt']);
  const {billingAccountCreated: _excluded, ...receipt} = verifyOwnerLaunchMembershipDraftReceipt({...safe, billingAccountCreated: false});
  return {state: 'RECORDED_DRAFT', receipt};
}
/** Fixed ISO 4217 code snapshot; no currency default, normalization, price or catalog inference. */
const OWNER_LAUNCH_CURRENCIES: readonly string[] = ["AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XDR", "XOF", "XPF", "XSU", "YER", "ZAR", "ZMW", "ZWG", "ZWL"];
function launchTerm(value: unknown): string {
  const term = text(value, 29);
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(term) || !Number.isFinite(Date.parse(term))) invalid();
  const utcYear=new Date(term).getUTCFullYear();
  if(utcYear<1 || utcYear>9999 || Number(term.slice(0,4))<1) invalid();
  const date = term.slice(0,10);
  if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0,10) !== date) invalid();
  return term;
}
export function verifyDraftOwnerLaunchMembershipInput(value: unknown): DraftOwnerLaunchMembershipInput {
  const row = ownerLaunchRecord(value, ['registrationId','expectedReceiptVersion','planCode','termStartedAt','termEndsAt','currency']);
  const termStartedAt = launchTerm(row.termStartedAt), termEndsAt = launchTerm(row.termEndsAt);
  if (row.expectedReceiptVersion !== 1 || Date.parse(termEndsAt) <= Date.parse(termStartedAt) || typeof row.currency !== 'string' || !OWNER_LAUNCH_CURRENCIES.includes(row.currency)) invalid();
  return { registrationId: ownerLaunchId(row.registrationId), expectedReceiptVersion: 1, planCode: text(row.planCode,80), termStartedAt, termEndsAt, currency: row.currency };
}
export function verifyOwnerLaunchMembershipDraftReceipt(value: unknown, input?: DraftOwnerLaunchMembershipInput): OwnerLaunchMembershipDraftReceipt {
  const row = ownerLaunchRecord(value, ['registrationId','membershipId','state','membershipVersion','planCode','termStartedAt','termEndsAt','currency','billingAccountCreated','recordedAt']);
  const verified = verifyDraftOwnerLaunchMembershipInput({registrationId:row.registrationId,expectedReceiptVersion:1,planCode:row.planCode,termStartedAt:row.termStartedAt,termEndsAt:row.termEndsAt,currency:row.currency});
  const recordedAt = launchTerm(row.recordedAt);
  if (row.state !== 'DRAFT' || typeof row.billingAccountCreated !== 'boolean') invalid();
  if (input && (verified.registrationId !== input.registrationId || verified.planCode !== input.planCode || verified.currency !== input.currency || Date.parse(verified.termStartedAt) !== Date.parse(input.termStartedAt) || Date.parse(verified.termEndsAt) !== Date.parse(input.termEndsAt))) invalid();
  return {registrationId:verified.registrationId,membershipId:ownerLaunchId(row.membershipId),state:'DRAFT',membershipVersion:version(row.membershipVersion),planCode:verified.planCode,termStartedAt:verified.termStartedAt,termEndsAt:verified.termEndsAt,currency:verified.currency,billingAccountCreated:row.billingAccountCreated,recordedAt};
}

/** Receipt-bound canonical confirmation only, never roster, attendance or commercial authority. */
export interface OwnerLaunchFirstClassBookingContext {
  registrationId: string;
  student: { studentProfileId: string; displayName: string };
  classSession: { id: string; name: string; startsAt: string; endsAt: string; status: LaunchClassReceipt['status']; capacity: number; bookingPolicy: 'WALK_IN' | 'OPTIONAL_BOOKING' | 'REQUIRED_BOOKING' };
  booking: { id: string; bookingKind: 'REGULAR'; status: 'BOOKED' | 'WAITLISTED'; version: number; recordedAt: string };
}
export type OwnerLaunchFirstClassBookingContextProjection =
  | { state: 'RECORDED_BOOKING'; context: OwnerLaunchFirstClassBookingContext }
  | { state: 'NO_RECORDED_BOOKING' | 'BOOKING_UNAVAILABLE'; context: null };
export function verifyOwnerLaunchFirstClassBookingContext(value: unknown): OwnerLaunchFirstClassBookingContextProjection {
  const row = ownerLaunchRecord(value, ['state','context']);
  if (row.state === 'NO_RECORDED_BOOKING' || row.state === 'BOOKING_UNAVAILABLE') {
    if (row.context !== null) invalid();
    return { state: row.state, context: null };
  }
  if (row.state !== 'RECORDED_BOOKING') invalid();
  const context = ownerLaunchRecord(row.context, ['registrationId','student','classSession','booking']);
  const student = ownerLaunchRecord(context.student, ['studentProfileId','displayName']);
  const session = ownerLaunchRecord(context.classSession, ['id','name','startsAt','endsAt','status','capacity','bookingPolicy']);
  const booking = ownerLaunchRecord(context.booking, ['id','bookingKind','status','version','recordedAt']);
  const instant = (value: unknown): string => {
    const time = text(value, 24);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) invalid();
    return time;
  };
  const startsAt = instant(session.startsAt), endsAt = instant(session.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt) || !['DRAFT','SCHEDULED','CANCELLED','COMPLETED'].includes(String(session.status))
    || typeof session.capacity !== 'number' || !Number.isSafeInteger(session.capacity) || session.capacity < 1 || session.capacity > 1000
    || !['WALK_IN','OPTIONAL_BOOKING','REQUIRED_BOOKING'].includes(String(session.bookingPolicy))
    || booking.bookingKind !== 'REGULAR' || !['BOOKED','WAITLISTED'].includes(String(booking.status))) invalid();
  return { state: 'RECORDED_BOOKING', context: {
    registrationId: ownerLaunchId(context.registrationId),
    student: { studentProfileId: ownerLaunchId(student.studentProfileId), displayName: text(student.displayName, 160) },
    classSession: { id: ownerLaunchId(session.id), name: text(session.name, 160), startsAt, endsAt, status: session.status as LaunchClassReceipt['status'], capacity: session.capacity, bookingPolicy: session.bookingPolicy as OwnerLaunchFirstClassBookingContext['classSession']['bookingPolicy'] },
    booking: { id: ownerLaunchId(booking.id), bookingKind: 'REGULAR', status: booking.status as 'BOOKED' | 'WAITLISTED', version: version(booking.version), recordedAt: instant(booking.recordedAt) },
  } };
}
