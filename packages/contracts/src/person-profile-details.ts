/**
 * 0656: more profile details for one person at one exact school, edited from the contact card's Edit profile pop-up.
 * Gender, parent/guardian name, notes, a label for the primary phone and email, and up to five other phones and emails.
 * Nothing is ever sent to the other addresses; consent stays with the primary address (0217). Never billing, family or access.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const PERSON_GENDERS = ['MALE', 'FEMALE'] as const;
export type PersonGender = typeof PERSON_GENDERS[number];
export const PERSON_PHONE_LABELS = ['MOBILE', 'HOME', 'WORK', 'OTHER'] as const;
export type PersonPhoneLabel = typeof PERSON_PHONE_LABELS[number];
export const PERSON_EMAIL_LABELS = ['PERSONAL', 'WORK', 'SCHOOL', 'OTHER'] as const;
export type PersonEmailLabel = typeof PERSON_EMAIL_LABELS[number];
export const PERSON_DETAILS_MAX_OTHER = 5;
export const PERSON_DETAILS_FIELDS = ['gender', 'guardianName', 'notes', 'primaryPhoneLabel', 'primaryEmailLabel', 'otherPhones', 'otherEmails'] as const;
export type PersonDetailsField = typeof PERSON_DETAILS_FIELDS[number];

export type PersonOtherPhone = Readonly<{ phoneE164: string; label: PersonPhoneLabel }>;
export type PersonOtherEmail = Readonly<{ email: string; label: PersonEmailLabel }>;
export interface PersonDetailsUpdateInput {
  schoolId: string; personId: string; expectedVersion: number;
  gender: PersonGender | null; guardianName: string | null; notes: string | null;
  primaryPhoneLabel: PersonPhoneLabel | null; primaryEmailLabel: PersonEmailLabel | null;
  otherPhones: readonly PersonOtherPhone[]; otherEmails: readonly PersonOtherEmail[];
}
export interface PersonDetails {
  personId: string; version: number; gender: PersonGender | null; guardianName: string | null; notes: string | null;
  primaryPhoneLabel: PersonPhoneLabel | null; primaryEmailLabel: PersonEmailLabel | null;
  otherPhones: readonly PersonOtherPhone[]; otherEmails: readonly PersonOtherEmail[]; canEdit: boolean;
}
export interface PersonDetailsUpdateResult { details: PersonDetails; changedFields: readonly PersonDetailsField[] }

const E164 = /^\+[1-9]\d{1,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function fail(response: boolean): never { throw new Error(response ? 'PERSON_RESPONSE_INVALID' : 'PERSON_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function oneOf<T extends string>(v: unknown, set: readonly T[], response: boolean): T | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) fail(response);
  return v as T;
}
/** Free text: trimmed; empty becomes null. Notes may hold line breaks, a guardian name may not. */
function text(v: unknown, max: number, lines: boolean, response: boolean): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') fail(response);
  const t = v.trim();
  if (!t) { if (response) fail(response); return null; }
  if (t.length > max || (lines ? NOTE_CONTROL : CONTROL).test(t)) fail(response);
  return t;
}
function phones(v: unknown, primary: string | null, response: boolean): PersonOtherPhone[] {
  if (!Array.isArray(v) || v.length > PERSON_DETAILS_MAX_OTHER) fail(response);
  const seen = new Set<string>();
  return v.map(x => {
    const o = closed(x, ['phoneE164', 'label'], response);
    if (typeof o.phoneE164 !== 'string') fail(response);
    const p = o.phoneE164.trim();
    if (!E164.test(p) || seen.has(p) || p === primary) fail(response);
    seen.add(p);
    return Object.freeze({ phoneE164: p, label: oneOf(o.label, PERSON_PHONE_LABELS, response) ?? fail(response) });
  });
}
function emails(v: unknown, primary: string | null, response: boolean): PersonOtherEmail[] {
  if (!Array.isArray(v) || v.length > PERSON_DETAILS_MAX_OTHER) fail(response);
  const seen = new Set<string>();
  return v.map(x => {
    const o = closed(x, ['email', 'label'], response);
    if (typeof o.email !== 'string') fail(response);
    const e = o.email.trim().toLowerCase();
    if (e.length < 3 || e.length > 320 || !EMAIL.test(e) || CONTROL.test(e) || seen.has(e) || e === primary) fail(response);
    seen.add(e);
    return Object.freeze({ email: e, label: oneOf(o.label, PERSON_EMAIL_LABELS, response) ?? fail(response) });
  });
}

/** Closed body. The primary phone and email are passed only so the browser refuses an other address equal to them; the server checks again. */
export function validatePersonDetailsUpdateInput(v: unknown, primary: Readonly<{ email: string | null; phoneE164: string | null }> = { email: null, phoneE164: null }): PersonDetailsUpdateInput {
  const o = closed(v, ['schoolId', 'personId', 'expectedVersion', ...PERSON_DETAILS_FIELDS], false);
  if (!Number.isInteger(o.expectedVersion) || (o.expectedVersion as number) < 0 || (o.expectedVersion as number) > 999_999_999) fail(false);
  let schoolId: string, personId: string;
  try { schoolId = accountUuid(o.schoolId); personId = accountUuid(o.personId); } catch { fail(false); }
  return Object.freeze({ schoolId, personId, expectedVersion: o.expectedVersion as number,
    gender: oneOf(o.gender, PERSON_GENDERS, false), guardianName: text(o.guardianName, 200, false, false), notes: text(o.notes, 2000, true, false),
    primaryPhoneLabel: oneOf(o.primaryPhoneLabel, PERSON_PHONE_LABELS, false), primaryEmailLabel: oneOf(o.primaryEmailLabel, PERSON_EMAIL_LABELS, false),
    otherPhones: Object.freeze(phones(o.otherPhones, primary.phoneE164, false)), otherEmails: Object.freeze(emails(o.otherEmails, primary.email?.toLowerCase() ?? null, false)) });
}

export function validatePersonDetails(v: unknown, personId?: string): PersonDetails {
  const o = closed(v, ['personId', 'version', ...PERSON_DETAILS_FIELDS, 'canEdit'], true);
  let id: string;
  try { id = accountUuid(o.personId); } catch { fail(true); }
  if (personId !== undefined && id !== personId.toLowerCase()) fail(true);
  if (!Number.isInteger(o.version) || (o.version as number) < 0 || typeof o.canEdit !== 'boolean') fail(true);
  return Object.freeze({ personId: id, version: o.version as number, gender: oneOf(o.gender, PERSON_GENDERS, true),
    guardianName: text(o.guardianName, 200, false, true), notes: text(o.notes, 2000, true, true),
    primaryPhoneLabel: oneOf(o.primaryPhoneLabel, PERSON_PHONE_LABELS, true), primaryEmailLabel: oneOf(o.primaryEmailLabel, PERSON_EMAIL_LABELS, true),
    otherPhones: Object.freeze(phones(o.otherPhones, null, true)), otherEmails: Object.freeze(emails(o.otherEmails, null, true)), canEdit: o.canEdit as boolean });
}

export function validatePersonDetailsUpdateResult(v: unknown, personId?: string): PersonDetailsUpdateResult {
  const o = closed(v, ['details', 'changedFields'], true);
  if (!Array.isArray(o.changedFields) || o.changedFields.length < 1 || o.changedFields.length > PERSON_DETAILS_FIELDS.length
    || o.changedFields.some(f => !(PERSON_DETAILS_FIELDS as readonly unknown[]).includes(f)) || new Set(o.changedFields).size !== o.changedFields.length) fail(true);
  return Object.freeze({ details: validatePersonDetails(o.details, personId), changedFields: Object.freeze([...o.changedFields] as PersonDetailsField[]) });
}
