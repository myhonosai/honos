/** B-CRM-1a/1b: read one person at one exact school; correct name, email, phone and a student's birth date. Never consent, family, billing or access. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const PERSON_RECORD_HUMAN_COMMAND = 'school-person-record' as const;
export const PERSON_CONSENT_STATES = ['OPTED_IN', 'OPTED_OUT', 'NOT_RECORDED'] as const;
export type PersonConsentState = typeof PERSON_CONSENT_STATES[number];
export const PERSON_EDITABLE_FIELDS = ['givenName', 'familyName', 'email', 'phoneE164'] as const;
export type PersonEditableField = typeof PERSON_EDITABLE_FIELDS[number];

const E164 = /^\+[1-9]\d{1,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
function personError(response: boolean): never { throw new Error(response ? 'PERSON_RESPONSE_INVALID' : 'PERSON_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response = false): Record<string, unknown> {
  try { return accountClosed(v, keys); } catch { personError(response); }
}
function id(v: unknown, response = false): string { try { return accountUuid(v); } catch { personError(response); } }
// Responses carry the stored spelling (other intake paths may predate these input rules), so they are only bounded.
function stored(v: unknown, max: number): string { if (typeof v !== 'string' || v.length < 1 || v.length > max) personError(true); return v; }
function name(v: unknown, response = false): string {
  if (response) return stored(v, 500);
  if (typeof v !== 'string') personError(response);
  const t = v.trim();
  if (t.length < 1 || t.length > 120 || CONTROL.test(t)) personError(response);
  return t;
}
function email(v: unknown, response = false): string | null {
  if (v === null) return null;
  if (response) return stored(v, 320);
  if (typeof v !== 'string') personError(response);
  const t = v.trim().toLowerCase();
  if (t.length < 3 || t.length > 320 || !EMAIL.test(t) || CONTROL.test(t)) personError(response);
  return t;
}
function phone(v: unknown, response = false): string | null {
  if (v === null) return null;
  if (response) return stored(v, 32);
  if (typeof v !== 'string') personError(response);
  const t = v.trim();
  if (!E164.test(t)) personError(response);
  return t;
}

export interface PersonRecordUpdateInput {
  schoolId: string; personId: string; expectedVersion: number;
  givenName: string; familyName: string; email: string | null; phoneE164: string | null;
}
/** Closed body: exactly these keys; null clears email or phone. Names are trimmed, email lower-cased. */
export function validatePersonRecordUpdateInput(v: unknown): PersonRecordUpdateInput {
  const o = closed(v, ['schoolId', 'personId', 'expectedVersion', 'givenName', 'familyName', 'email', 'phoneE164']);
  if (!Number.isInteger(o.expectedVersion) || (o.expectedVersion as number) < 1 || (o.expectedVersion as number) > 999_999_999) personError(false);
  return Object.freeze({ schoolId: id(o.schoolId), personId: id(o.personId), expectedVersion: o.expectedVersion as number,
    givenName: name(o.givenName), familyName: name(o.familyName), email: email(o.email), phoneE164: phone(o.phoneE164) });
}

export interface PersonRecord {
  personId: string; schoolId: string; givenName: string; familyName: string; email: string | null; phoneE164: string | null;
  version: number; updatedAt: string;
  student: { birthDate: string | null; status: string; version: number } | null;
  consents: { EMAIL: PersonConsentState; SMS: PersonConsentState };
  canEdit: boolean;
}
function consent(v: unknown): PersonConsentState {
  if (typeof v !== 'string' || !(PERSON_CONSENT_STATES as readonly string[]).includes(v)) personError(true);
  return v as PersonConsentState;
}
export function validatePersonRecord(v: unknown): PersonRecord {
  const o = closed(v, ['personId', 'schoolId', 'givenName', 'familyName', 'email', 'phoneE164', 'version', 'updatedAt', 'student', 'consents', 'canEdit'], true);
  if (!Number.isInteger(o.version) || (o.version as number) < 1 || typeof o.updatedAt !== 'string' || !Number.isFinite(Date.parse(o.updatedAt))
    || typeof o.canEdit !== 'boolean') personError(true);
  let student: PersonRecord['student'] = null;
  if (o.student !== null) {
    const s = closed(o.student, ['birthDate', 'status', 'version'], true);
    if ((s.birthDate !== null && (typeof s.birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.birthDate)))
      || typeof s.status !== 'string' || !/^[A-Z_]{1,40}$/.test(s.status) || !Number.isInteger(s.version) || (s.version as number) < 1) personError(true);
    student = { birthDate: s.birthDate as string | null, status: s.status, version: s.version as number };
  }
  const c = closed(o.consents, ['EMAIL', 'SMS'], true);
  return { personId: id(o.personId, true), schoolId: id(o.schoolId, true), givenName: name(o.givenName, true), familyName: name(o.familyName, true),
    email: email(o.email, true), phoneE164: phone(o.phoneE164, true), version: o.version as number, updatedAt: o.updatedAt,
    student, consents: { EMAIL: consent(c.EMAIL), SMS: consent(c.SMS) }, canEdit: o.canEdit };
}

export interface PersonRecordUpdateResult { person: PersonRecord; changedFields: PersonEditableField[] }
export function validatePersonRecordUpdateResult(v: unknown): PersonRecordUpdateResult {
  const o = closed(v, ['person', 'changedFields'], true);
  if (!Array.isArray(o.changedFields) || o.changedFields.length < 1 || o.changedFields.length > 4
    || new Set(o.changedFields).size !== o.changedFields.length
    || o.changedFields.some(f => !(PERSON_EDITABLE_FIELDS as readonly unknown[]).includes(f))) personError(true);
  return { person: validatePersonRecord(o.person), changedFields: [...o.changedFields] as PersonEditableField[] };
}

/** B-CRM-1b: a student's birth date, with a reason. expectedVersion is the student profile's version (record.student.version). */
export interface StudentBirthDateUpdateInput { schoolId: string; personId: string; expectedVersion: number; birthDate: string; reason: string }
function calendarDate(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) personError(false);
  const d = new Date(v + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v || v < '1900-01-01') personError(false);
  return v;
}
export function validateStudentBirthDateUpdateInput(v: unknown): StudentBirthDateUpdateInput {
  const o = closed(v, ['schoolId', 'personId', 'expectedVersion', 'birthDate', 'reason']);
  if (!Number.isInteger(o.expectedVersion) || (o.expectedVersion as number) < 1 || (o.expectedVersion as number) > 999_999_999) personError(false);
  if (typeof o.reason !== 'string') personError(false);
  const reason = o.reason.trim();
  if (reason.length < 1 || reason.length > 300 || CONTROL.test(reason)) personError(false);
  return Object.freeze({ schoolId: id(o.schoolId), personId: id(o.personId), expectedVersion: o.expectedVersion as number, birthDate: calendarDate(o.birthDate), reason });
}
export interface StudentBirthDateUpdateResult { person: PersonRecord; changedFields: ['birthDate']; enrollmentCorrected: boolean }
export function validateStudentBirthDateUpdateResult(v: unknown): StudentBirthDateUpdateResult {
  const o = closed(v, ['person', 'changedFields', 'enrollmentCorrected'], true);
  if (!Array.isArray(o.changedFields) || o.changedFields.length !== 1 || o.changedFields[0] !== 'birthDate' || typeof o.enrollmentCorrected !== 'boolean') personError(true);
  const person = validatePersonRecord(o.person);
  if (person.student === null) personError(true);
  return { person, changedFields: ['birthDate'], enrollmentCorrected: o.enrollmentCorrected };
}
