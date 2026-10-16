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
