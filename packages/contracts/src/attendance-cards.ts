/**
 * 0394: attendance cards and scan check-in.
 *
 * A card code is 26 digits: 24 random digits and 2 ISO 7064 mod 97-10 check digits. Barcode (Code 128) and QR cards carry
 * the same digits, so a scanner reads either kind without being told which. The code is shown once for printing; the
 * server keeps only its SHA-256 digest and last four digits. It is not a student id and carries no school or person data.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const ATTENDANCE_CARDS_HUMAN_COMMAND = 'attendance-cards' as const;
export const ATTENDANCE_SCAN_HUMAN_COMMAND = 'attendance-scan' as const;
export const ATTENDANCE_CARD_CODE_TYPES = ['BARCODE', 'QR'] as const;
export type AttendanceCardCodeType = typeof ATTENDANCE_CARD_CODE_TYPES[number];
export const ATTENDANCE_CARD_DESIGNS = ['CLASSIC', 'BOLD', 'MINIMAL'] as const;
export type AttendanceCardDesign = typeof ATTENDANCE_CARD_DESIGNS[number];
export const ATTENDANCE_CARD_STATUSES = ['ACTIVE', 'REPLACED', 'REVOKED'] as const;
export type AttendanceCardStatus = typeof ATTENDANCE_CARD_STATUSES[number];
export const ATTENDANCE_CARD_MAX_PER_PRINT = 40;
export const ATTENDANCE_CARD_CODE_LENGTH = 26;
export const ATTENDANCE_CHECK_IN_STATUSES = ['PRESENT', 'LATE'] as const;
export type AttendanceCheckInStatus = typeof ATTENDANCE_CHECK_IN_STATUSES[number];
/** A student's photo consent for printed cards. NOT_REQUIRED where the school's place does not need it. */
export const ATTENDANCE_PHOTO_CONSENT_STATES = ['NOT_REQUIRED', 'GIVEN', 'MISSING'] as const;
export type AttendancePhotoConsentState = typeof ATTENDANCE_PHOTO_CONSENT_STATES[number];
export const ATTENDANCE_CHECK_IN_OUTCOMES = ['RECORDED', 'ALREADY_RECORDED', 'NOT_RECOGNIZED', 'CARD_NOT_ACTIVE'] as const;
export type AttendanceCheckInOutcome = typeof ATTENDANCE_CHECK_IN_OUTCOMES[number];

/** Remainder of a digit string divided by 97, without big numbers. */
function mod97(digits: string): number { let r = 0; for (const d of digits) r = (r * 10 + d.charCodeAt(0) - 48) % 97; return r; }
/** The two ISO 7064 mod 97-10 check digits for 24 body digits. */
export function attendanceCardCheckDigits(body: string): string {
  if (!/^\d{24}$/.test(body)) throw new Error('ATTENDANCE_CARD_CODE_INVALID');
  return String(98 - mod97(body + '00')).padStart(2, '0');
}
/** True for exactly 26 digits whose check digits match (one wrong digit and most swaps fail). */
export function isAttendanceCardCode(code: string): boolean { return /^\d{26}$/.test(code) && mod97(code) === 1; }
/**
 * What a scanner or a person typed, as a card code, or null. Spaces and dashes are ignored (cards print the code in
 * groups); anything else, a wrong length or wrong check digits gives null. Nothing is sent for a null code.
 */
export function normalizeAttendanceCardCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 80) return null;
  const digits = raw.replace(/[\s-]/g, '');
  return isAttendanceCardCode(digits) ? digits : null;
}
/** The code in groups of four for printing under the barcode, e.g. "1234 5678 ...". */
export const groupAttendanceCardCode = (code: string) => code.replace(/(\d{4})(?=\d)/g, '$1 ');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
function fail(response: boolean): never { throw new Error(response ? 'ATTENDANCE_CARDS_RESPONSE_INVALID' : 'ATTENDANCE_CARDS_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function int(v: unknown, min: number, response: boolean): number { if (!Number.isInteger(v) || (v as number) < min || (v as number) > 999_999_999) fail(response); return v as number; }
function bool(v: unknown, response: boolean): boolean { if (typeof v !== 'boolean') fail(response); return v; }
function oneOf<T extends string>(v: unknown, values: readonly T[], response: boolean): T { if (!(values as readonly unknown[]).includes(v)) fail(response); return v as T; }
function text(v: unknown, max: number, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) fail(response);
  return v;
}
function time(v: unknown, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v)) fail(response);
  return v;
}

export interface AttendanceCardSettings {
  codeType: AttendanceCardCodeType; showPhoto: boolean; showLogo: boolean; design: AttendanceCardDesign;
  /** 0 when the school never chose (defaults shown). */ version: number; updatedAt: string | null;
  schoolName: string; logoUrl: string | null; accentColor: string | null;
  /** Whether this school's place needs consent before a photo is printed (draft rules, lawyer review before real use). */
  photoConsent: AttendancePhotoConsentRule;
}
export interface AttendancePhotoConsentRule { required: boolean; profile: string | null; reason: 'NO_LOCATION' | 'PROFILE' }
function consentRule(v: unknown): AttendancePhotoConsentRule {
  const o = closed(v, ['required', 'profile', 'reason'], true);
  const reason = oneOf(o.reason, ['NO_LOCATION', 'PROFILE'] as const, true), profile = text(o.profile, 40, true, true);
  if (profile !== null && !/^[A-Z][A-Z0-9_]*$/.test(profile)) fail(true);
  const required = bool(o.required, true);
  if ((reason === 'NO_LOCATION') !== (profile === null) || (reason === 'NO_LOCATION' && required)) fail(true);
  return Object.freeze({ required, profile, reason });
}
function settings(v: unknown): AttendanceCardSettings {
  const o = closed(v, ['codeType', 'showPhoto', 'showLogo', 'design', 'version', 'updatedAt', 'schoolName', 'logoUrl', 'accentColor', 'photoConsent'], true);
  const logoUrl = text(o.logoUrl, 2048, true, true), accentColor = text(o.accentColor, 7, true, true);
  if (logoUrl !== null && !/^https:\/\/[^\s"'<>\\]+$/i.test(logoUrl)) fail(true);
  if (accentColor !== null && !/^#[0-9a-f]{6}$/i.test(accentColor)) fail(true);
  return Object.freeze({ codeType: oneOf(o.codeType, ATTENDANCE_CARD_CODE_TYPES, true), showPhoto: bool(o.showPhoto, true), showLogo: bool(o.showLogo, true),
    design: oneOf(o.design, ATTENDANCE_CARD_DESIGNS, true), version: int(o.version, 0, true), updatedAt: time(o.updatedAt, true, true),
    schoolName: text(o.schoolName, 200, true) as string, logoUrl, accentColor, photoConsent: consentRule(o.photoConsent) });
}
export const validateAttendanceCardSettings = settings;

export interface AttendanceCard { cardId: string; studentProfileId: string; last4: string; status: AttendanceCardStatus; version: number; issuedAt: string; endedAt: string | null }
function card(v: unknown): AttendanceCard {
  const o = closed(v, ['cardId', 'studentProfileId', 'last4', 'status', 'version', 'issuedAt', 'endedAt'], true);
  if (typeof o.last4 !== 'string' || !/^\d{4}$/.test(o.last4)) fail(true);
  const status = oneOf(o.status, ATTENDANCE_CARD_STATUSES, true), endedAt = time(o.endedAt, true, true);
  if ((status === 'ACTIVE') !== (endedAt === null)) fail(true);
  return Object.freeze({ cardId: id(o.cardId, true), studentProfileId: id(o.studentProfileId, true), last4: o.last4, status,
    version: int(o.version, 1, true), issuedAt: time(o.issuedAt, true) as string, endedAt });
}
export const validateAttendanceCard = card;

export interface AttendanceCardStudent {
  studentProfileId: string; personId: string; givenName: string; familyName: string; studentStatus: string; hasPhoto: boolean; card: AttendanceCard | null;
  photoConsent: AttendancePhotoConsentState; /** 0 when never recorded. */ photoConsentVersion: number;
}
export interface AttendanceCardsRead { settings: AttendanceCardSettings; maxPerPrint: number; students: readonly AttendanceCardStudent[] }
export function validateAttendanceCardsRead(v: unknown): AttendanceCardsRead {
  const o = closed(v, ['settings', 'maxPerPrint', 'students'], true);
  if (!Array.isArray(o.students) || o.students.length > 500 || o.maxPerPrint !== ATTENDANCE_CARD_MAX_PER_PRINT) fail(true);
  const students = o.students.map(s => {
    const x = closed(s, ['studentProfileId', 'personId', 'givenName', 'familyName', 'studentStatus', 'hasPhoto', 'card', 'photoConsent', 'photoConsentVersion'], true);
    const c = x.card === null ? null : card(x.card), studentProfileId = id(x.studentProfileId, true);
    if (c && (c.studentProfileId !== studentProfileId || c.status !== 'ACTIVE')) fail(true);
    return Object.freeze({ studentProfileId, personId: id(x.personId, true), givenName: text(x.givenName, 200, true) as string,
      familyName: text(x.familyName, 200, true) as string, studentStatus: text(x.studentStatus, 40, true) as string, hasPhoto: bool(x.hasPhoto, true), card: c,
      photoConsent: oneOf(x.photoConsent, ATTENDANCE_PHOTO_CONSENT_STATES, true), photoConsentVersion: int(x.photoConsentVersion, 0, true) });
  });
  if (new Set(students.map(s => s.studentProfileId)).size !== students.length) fail(true);
  const st = settings(o.settings);
  if (students.some(s => (s.photoConsent === 'NOT_REQUIRED') === st.photoConsent.required)) fail(true);
  return Object.freeze({ settings: st, maxPerPrint: ATTENDANCE_CARD_MAX_PER_PRINT, students: Object.freeze(students) });
}

export interface AttendanceCardSettingsInput { schoolId: string; expectedVersion: number; codeType: AttendanceCardCodeType; showPhoto: boolean; showLogo: boolean; design: AttendanceCardDesign }
export function validateAttendanceCardSettingsInput(v: unknown): AttendanceCardSettingsInput {
  const o = closed(v, ['schoolId', 'expectedVersion', 'codeType', 'showPhoto', 'showLogo', 'design'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), expectedVersion: int(o.expectedVersion, 0, false), codeType: oneOf(o.codeType, ATTENDANCE_CARD_CODE_TYPES, false),
    showPhoto: bool(o.showPhoto, false), showLogo: bool(o.showLogo, false), design: oneOf(o.design, ATTENDANCE_CARD_DESIGNS, false) });
}
export interface AttendanceCardSettingsResult { settings: AttendanceCardSettings; replayed: boolean }
export function validateAttendanceCardSettingsResult(v: unknown): AttendanceCardSettingsResult {
  const o = closed(v, ['settings', 'replayed'], true);
  return Object.freeze({ settings: settings(o.settings), replayed: bool(o.replayed, true) });
}

/** Print new cards for 1..40 students. Each student's current card stops working. */
export interface AttendanceCardIssueInput { schoolId: string; studentProfileIds: readonly string[] }
export function validateAttendanceCardIssueInput(v: unknown): AttendanceCardIssueInput {
  const o = closed(v, ['schoolId', 'studentProfileIds'], false);
  if (!Array.isArray(o.studentProfileIds) || o.studentProfileIds.length < 1 || o.studentProfileIds.length > ATTENDANCE_CARD_MAX_PER_PRINT) fail(false);
  const ids = o.studentProfileIds.map(x => id(x, false));
  if (new Set(ids).size !== ids.length) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), studentProfileIds: Object.freeze(ids) });
}
/**
 * A printed card. code is the full code on a fresh print, and null on a replay (codes are shown only once). printPhoto is
 * the server's decision: the saved look shows photos, the student has one, and consent is given where it is needed.
 */
export interface AttendanceIssuedCard extends AttendanceCard { code: string | null; printPhoto: boolean }
export interface AttendanceCardIssueResult { printId: string; cards: readonly AttendanceIssuedCard[]; replaced: number; replayed: boolean }
export function validateAttendanceCardIssueResult(v: unknown): AttendanceCardIssueResult {
  const o = closed(v, ['printId', 'cards', 'replaced', 'replayed'], true);
  if (!Array.isArray(o.cards) || o.cards.length < 1 || o.cards.length > ATTENDANCE_CARD_MAX_PER_PRINT) fail(true);
  const replayed = bool(o.replayed, true);
  const cards = o.cards.map(raw => {
    const x = closed(raw, ['cardId', 'studentProfileId', 'last4', 'status', 'version', 'issuedAt', 'endedAt', 'code', 'printPhoto'], true);
    const { code, printPhoto, ...rest } = x; const c = card(rest);
    if (replayed ? code !== null : (typeof code !== 'string' || !isAttendanceCardCode(code) || code.slice(-4) !== c.last4)) fail(true);
    return Object.freeze({ ...c, code: code as string | null, printPhoto: bool(printPhoto, true) });
  });
  return Object.freeze({ printId: id(o.printId, true), cards: Object.freeze(cards), replaced: int(o.replaced, 0, true), replayed });
}

export interface AttendanceCardRevokeInput { schoolId: string; cardId: string; expectedVersion: number }
export function validateAttendanceCardRevokeInput(v: unknown): AttendanceCardRevokeInput {
  const o = closed(v, ['schoolId', 'cardId', 'expectedVersion'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), cardId: id(o.cardId, false), expectedVersion: int(o.expectedVersion, 1, false) });
}
export interface AttendanceCardRevokeResult { card: AttendanceCard; replayed: boolean }
export function validateAttendanceCardRevokeResult(v: unknown): AttendanceCardRevokeResult {
  const o = closed(v, ['card', 'replayed'], true);
  const c = card(o.card); if (c.status !== 'REVOKED') fail(true);
  return Object.freeze({ card: c, replayed: bool(o.replayed, true) });
}

/** Staff record that the parent (or adult student) agreed to the photo on the card, or withdrew. */
export interface AttendancePhotoConsentInput { schoolId: string; studentProfileId: string; given: boolean; expectedVersion: number }
export function validateAttendancePhotoConsentInput(v: unknown): AttendancePhotoConsentInput {
  const o = closed(v, ['schoolId', 'studentProfileId', 'given', 'expectedVersion'], false);
  const given = bool(o.given, false), expectedVersion = int(o.expectedVersion, 0, false);
  if (!given && expectedVersion === 0) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), studentProfileId: id(o.studentProfileId, false), given, expectedVersion });
}
export interface AttendancePhotoConsentResult {
  studentProfileId: string; photoConsent: AttendancePhotoConsentState; photoConsentVersion: number; recordedAt: string; replayed: boolean;
}
export function validateAttendancePhotoConsentResult(v: unknown): AttendancePhotoConsentResult {
  const o = closed(v, ['studentProfileId', 'photoConsent', 'photoConsentVersion', 'recordedAt', 'replayed'], true);
  return Object.freeze({ studentProfileId: id(o.studentProfileId, true), photoConsent: oneOf(o.photoConsent, ATTENDANCE_PHOTO_CONSENT_STATES, true),
    photoConsentVersion: int(o.photoConsentVersion, 1, true), recordedAt: time(o.recordedAt, true) as string, replayed: bool(o.replayed, true) });
}

/** One scan. code is what the scanner sent (normalized server-side again). */
export interface AttendanceCheckInInput { schoolId: string; sessionId: string; code: string; status: AttendanceCheckInStatus }
export function validateAttendanceCheckInInput(v: unknown): AttendanceCheckInInput {
  const o = closed(v, ['schoolId', 'sessionId', 'code', 'status'], false);
  const code = normalizeAttendanceCardCode(o.code); if (!code) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), sessionId: id(o.sessionId, false), code, status: oneOf(o.status, ATTENDANCE_CHECK_IN_STATUSES, false) });
}
export interface AttendanceCheckInStudent { studentProfileId: string; personId: string; givenName: string; familyName: string; studentStatus: string }
export interface AttendanceCheckInRecord { id: string; status: string; version: number; recordedAt: string }
export interface AttendanceCheckInResult {
  outcome: AttendanceCheckInOutcome; student: AttendanceCheckInStudent | null; card: AttendanceCard | null; attendance: AttendanceCheckInRecord | null;
}
export function validateAttendanceCheckInResult(v: unknown): AttendanceCheckInResult {
  const o = closed(v, ['outcome', 'student', 'card', 'attendance'], true);
  const outcome = oneOf(o.outcome, ATTENDANCE_CHECK_IN_OUTCOMES, true);
  const student = o.student === null ? null : (() => {
    const s = closed(o.student, ['studentProfileId', 'personId', 'givenName', 'familyName', 'studentStatus'], true);
    return Object.freeze({ studentProfileId: id(s.studentProfileId, true), personId: id(s.personId, true), givenName: text(s.givenName, 200, true) as string,
      familyName: text(s.familyName, 200, true) as string, studentStatus: text(s.studentStatus, 40, true) as string });
  })();
  const c = o.card === null ? null : card(o.card);
  const attendance = o.attendance === null ? null : (() => {
    const a = closed(o.attendance, ['id', 'status', 'version', 'recordedAt'], true);
    return Object.freeze({ id: id(a.id, true), status: text(a.status, 40, true) as string, version: int(a.version, 1, true), recordedAt: time(a.recordedAt, true) as string });
  })();
  const named = outcome !== 'NOT_RECOGNIZED';
  if ((student !== null) !== named || (c !== null) !== named || (attendance !== null) !== (outcome === 'RECORDED' || outcome === 'ALREADY_RECORDED')
    || (c && student && c.studentProfileId !== student.studentProfileId) || (outcome === 'CARD_NOT_ACTIVE' && c?.status === 'ACTIVE')
    || ((outcome === 'RECORDED' || outcome === 'ALREADY_RECORDED') && c?.status !== 'ACTIVE')) fail(true);
  return Object.freeze({ outcome, student, card: c, attendance });
}
