/**
 * C3 (0483): merge and delete (archive) on the contact card. Delete archives: the contact leaves the contacts list (segment
 * ARCHIVED), keeps every record and can be restored. Merge keeps one person, moves the other's leads, family links, billing
 * accounts, consents (channels the kept person has none for) and conversations onto them, then archives the other as merged.
 * Both are two-step: a read shows what would happen and what blocks it; the command repeats the exact versions (and, for a
 * merge, the plan hash). Nothing is sent or charged.
 */
export const SCHOOL_CONTACT_ARCHIVE_BLOCKERS = ['ALREADY_ARCHIVED', 'HAS_CURRENT_MEMBERSHIP', 'HAS_OPEN_LEAD', 'HAS_OPEN_BALANCE'] as const;
export const SCHOOL_CONTACT_RESTORE_BLOCKERS = ['NOT_ARCHIVED', 'WAS_MERGED'] as const;
export const SCHOOL_CONTACT_MERGE_BLOCKERS = ['SAME_PERSON', 'CONTACT_ARCHIVED', 'MERGED_HAS_STUDENT_RECORD', 'MERGED_HAS_MEMBERSHIPS',
  'MERGED_HAS_REGISTRATION_HISTORY', 'BOTH_IN_SAME_FAMILY', 'BOTH_HAVE_BILLING_ACCOUNTS', 'CONSENT_CONFLICT'] as const;
export type SchoolContactArchiveBlocker = typeof SCHOOL_CONTACT_ARCHIVE_BLOCKERS[number];
export type SchoolContactRestoreBlocker = typeof SCHOOL_CONTACT_RESTORE_BLOCKERS[number];
export type SchoolContactMergeBlocker = typeof SCHOOL_CONTACT_MERGE_BLOCKERS[number];

export interface SchoolContactAdminPerson {
  personId: string; version: number; givenName: string; familyName: string; email: string | null; phoneE164: string | null;
}
export interface SchoolContactArchiveState {
  person: SchoolContactAdminPerson; archived: boolean; mergedIntoPersonId: string | null;
  archiveBlockers: SchoolContactArchiveBlocker[]; restoreBlockers: SchoolContactRestoreBlocker[];
}
export interface SchoolContactMergeCounts { leads: number; familyLinks: number; billingAccounts: number; consents: number; conversations: number }
export interface SchoolContactMergePreview {
  keep: SchoolContactAdminPerson; merge: SchoolContactAdminPerson; blockers: SchoolContactMergeBlocker[];
  moves: SchoolContactMergeCounts; stays: { consents: number; messages: number }; planHash: string;
}
export interface SchoolContactArchiveInput { personId: string; version: number }
export interface SchoolContactMergeInput { keepPersonId: string; keepVersion: number; mergePersonId: string; mergeVersion: number; planHash: string }
export interface SchoolContactArchiveReceipt { personId: string; version: number; archived: boolean }
export interface SchoolContactMergeReceipt { keepPersonId: string; keepVersion: number; mergedPersonId: string; mergedVersion: number; moved: SchoolContactMergeCounts }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;
function fail(): never { throw new Error('Unverified contact change.'); }
function bad(): never { throw new Error('VALIDATION_FAILED'); }
function exact(value: unknown, keys: readonly string[], onFail: () => never = fail): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onFail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) onFail();
  return source;
}
const count = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(); return v; };
const version = (v: unknown, onFail: () => never = fail) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 999_999_999) onFail(); return v; };
const text = (v: unknown, max: number) => { if (typeof v !== 'string' || !v || v.length > max || UNSAFE.test(v)) fail(); return v; };
const maybe = (v: unknown, max: number) => v === null ? null : text(v, max);
const id = (v: unknown, onFail: () => never = fail) => { if (typeof v !== 'string' || !UUID.test(v)) onFail(); return v; };
function codes<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v) || v.length > allowed.length || new Set(v).size !== v.length || v.some(x => !(allowed as readonly unknown[]).includes(x))) fail();
  return v as T[];
}
function person(v: unknown, expected: string): SchoolContactAdminPerson {
  const p = exact(v, ['personId', 'version', 'givenName', 'familyName', 'email', 'phoneE164']);
  if (id(p.personId) !== expected) fail();
  return { personId: expected, version: version(p.version), givenName: text(p.givenName, 200), familyName: text(p.familyName, 200),
    email: maybe(p.email, 320), phoneE164: maybe(p.phoneE164, 20) };
}
function moves(v: unknown): SchoolContactMergeCounts {
  const m = exact(v, ['leads', 'familyLinks', 'billingAccounts', 'consents', 'conversations']);
  return { leads: count(m.leads), familyLinks: count(m.familyLinks), billingAccounts: count(m.billingAccounts), consents: count(m.consents), conversations: count(m.conversations) };
}

export function validateSchoolContactArchiveInput(value: unknown): SchoolContactArchiveInput {
  const v = exact(value, ['personId', 'version'], bad);
  return { personId: id(v.personId, bad), version: version(v.version, bad) };
}
export function validateSchoolContactMergeInput(value: unknown): SchoolContactMergeInput {
  const v = exact(value, ['keepPersonId', 'keepVersion', 'mergePersonId', 'mergeVersion', 'planHash'], bad);
  if (typeof v.planHash !== 'string' || !HASH.test(v.planHash)) bad();
  const keepPersonId = id(v.keepPersonId, bad), mergePersonId = id(v.mergePersonId, bad);
  if (keepPersonId === mergePersonId) bad();
  return { keepPersonId, keepVersion: version(v.keepVersion, bad), mergePersonId, mergeVersion: version(v.mergeVersion, bad), planHash: v.planHash };
}

export function verifySchoolContactArchiveState(value: unknown, personId: string): SchoolContactArchiveState {
  const s = exact(value, ['person', 'archived', 'mergedIntoPersonId', 'archiveBlockers', 'restoreBlockers']);
  if (typeof s.archived !== 'boolean') fail();
  const mergedIntoPersonId = s.mergedIntoPersonId === null ? null : id(s.mergedIntoPersonId);
  if (mergedIntoPersonId !== null && (!s.archived || mergedIntoPersonId === personId)) fail();
  const archiveBlockers = codes(s.archiveBlockers, SCHOOL_CONTACT_ARCHIVE_BLOCKERS);
  const restoreBlockers = codes(s.restoreBlockers, SCHOOL_CONTACT_RESTORE_BLOCKERS);
  if (s.archived !== archiveBlockers.includes('ALREADY_ARCHIVED') || s.archived === restoreBlockers.includes('NOT_ARCHIVED')
    || (mergedIntoPersonId !== null) !== restoreBlockers.includes('WAS_MERGED')) fail();
  return { person: person(s.person, personId), archived: s.archived, mergedIntoPersonId, archiveBlockers, restoreBlockers };
}

export function verifySchoolContactMergePreview(value: unknown, keepPersonId: string, mergePersonId: string): SchoolContactMergePreview {
  const s = exact(value, ['keep', 'merge', 'blockers', 'moves', 'stays', 'planHash']);
  const stays = exact(s.stays, ['consents', 'messages']);
  if (typeof s.planHash !== 'string' || !HASH.test(s.planHash)) fail();
  return { keep: person(s.keep, keepPersonId), merge: person(s.merge, mergePersonId), blockers: codes(s.blockers, SCHOOL_CONTACT_MERGE_BLOCKERS),
    moves: moves(s.moves), stays: { consents: count(stays.consents), messages: count(stays.messages) }, planHash: s.planHash };
}

export function verifySchoolContactArchiveReceipt(value: unknown, input: SchoolContactArchiveInput, archived: boolean): SchoolContactArchiveReceipt {
  const r = exact(value, ['personId', 'version', 'archived']);
  if (r.personId !== input.personId || r.archived !== archived || version(r.version) <= input.version) fail();
  return { personId: input.personId, version: r.version as number, archived };
}

export function verifySchoolContactMergeReceipt(value: unknown, input: SchoolContactMergeInput): SchoolContactMergeReceipt {
  const r = exact(value, ['keepPersonId', 'keepVersion', 'mergedPersonId', 'mergedVersion', 'moved']);
  if (r.keepPersonId !== input.keepPersonId || r.mergedPersonId !== input.mergePersonId
    || version(r.keepVersion) <= input.keepVersion || version(r.mergedVersion) <= input.mergeVersion) fail();
  return { keepPersonId: input.keepPersonId, keepVersion: r.keepVersion as number, mergedPersonId: input.mergePersonId, mergedVersion: r.mergedVersion as number, moved: moves(r.moved) };
}
