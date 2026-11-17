/**
 * 0443: face check-in with parent consent. Opt-in per school, a draft consent form per jurisdiction profile and language
 * (TEST_ONLY_DRAFT, lawyer review before real use), staff confirm every match, and a SYNTHETIC matcher only (a picture
 * "matches" when it is byte-identical, after metadata stripping, to the enrolled profile photo). The camera picture is
 * never stored: the API sends only its SHA-256 to the database.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';
import { PERSON_PHOTO_MAX_BYTES, PERSON_PHOTO_MEDIA_TYPES, type PersonPhotoMediaType } from './person-photos.js';

export const FACE_CHECKIN_HUMAN_COMMAND = 'face-checkin' as const;
export const FACE_CHECKIN_SCAN_COMMAND = 'face-checkin-scan' as const;
export const FAMILY_FACE_CHECKIN_COMMAND = 'family-face-checkin' as const;
export const FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND = 'family-face-checkin-withdraw' as const;
export const FACE_CHECKIN_PROGRAM_STATUSES = ['CLOSED', 'TEST_MODE'] as const;
export const FACE_CHECKIN_ACKNOWLEDGEMENTS = ['ALTERNATIVE_CHECK_IN_OFFERED', 'ENTRANCE_SIGN_POSTED', 'IMPACT_ASSESSMENT_DONE', 'RETENTION_POLICY_PUBLISHED'] as const;
export type FaceCheckInAcknowledgement = typeof FACE_CHECKIN_ACKNOWLEDGEMENTS[number];
export const FACE_CHECKIN_CONSENT_STATES = ['GIVEN', 'RENEW', 'WITHDRAWN'] as const;
export type FaceCheckInConsentState = typeof FACE_CHECKIN_CONSENT_STATES[number];
export const FACE_CHECKIN_SIGNER_KINDS = ['GUARDIAN', 'ADULT_STUDENT'] as const;
export type FaceCheckInSignerKind = typeof FACE_CHECKIN_SIGNER_KINDS[number];
export const FACE_CHECKIN_MATCH_OUTCOMES = ['PROPOSED', 'NO_MATCH'] as const;
export const FACE_CHECKIN_DECISIONS = ['CONFIRMED', 'REJECTED', 'EXPIRED'] as const;
export const FACE_CHECKIN_LANGUAGES = ['en', 'ko', 'es'] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const NAME_UNSAFE = /[<>\u0000-\u001f\u007f]/;
function fail(response: boolean): never { throw new Error(response ? 'FACE_CHECKIN_RESPONSE_INVALID' : 'FACE_CHECKIN_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function int(v: unknown, min: number, response: boolean, max = 999_999_999): number { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(response); return v as number; }
function bool(v: unknown, response: boolean): boolean { if (typeof v !== 'boolean') fail(response); return v; }
function oneOf<T extends string>(v: unknown, values: readonly T[], response: boolean): T { if (!(values as readonly unknown[]).includes(v)) fail(response); return v as T; }
function text(v: unknown, max: number, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) fail(response);
  return v;
}
function code(v: unknown, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !CODE.test(v)) fail(response);
  return v;
}
function time(v: unknown, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v)) fail(response);
  return v;
}
function list<T>(v: unknown, max: number, item: (x: unknown) => T, response: boolean): readonly T[] {
  if (!Array.isArray(v) || v.length > max) fail(response);
  return Object.freeze(v.map(item));
}
/** A typed full name: 2-200 characters, no surrounding spaces, no < > or control characters. */
export function faceCheckInSignerNameOk(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 2 && v.length <= 200 && v.trim() === v && !NAME_UNSAFE.test(v);
}

// ---------- read shapes ----------
export interface FaceCheckInForm { formId: number; profile: string; language: typeof FACE_CHECKIN_LANGUAGES[number]; version: number; title: string; body: string; digest: string; reviewStatus: 'TEST_ONLY_DRAFT' }
function form(v: unknown): FaceCheckInForm {
  const o = closed(v, ['formId', 'profile', 'language', 'version', 'title', 'body', 'digest', 'reviewStatus'], true);
  if (o.reviewStatus !== 'TEST_ONLY_DRAFT' || typeof o.digest !== 'string' || !/^[a-f0-9]{64}$/.test(o.digest)) fail(true);
  return Object.freeze({ formId: int(o.formId, 1, true, 9999), profile: code(o.profile, true) as string, language: oneOf(o.language, FACE_CHECKIN_LANGUAGES, true),
    version: int(o.version, 1, true), title: text(o.title, 500, true) as string, body: text(o.body, 20000, true) as string, digest: o.digest, reviewStatus: 'TEST_ONLY_DRAFT' });
}
const forms = (v: unknown) => list(v, 3, form, true);

export interface FaceCheckInConsent {
  consentId: string; state: FaceCheckInConsentState; formId: number; signerKind: FaceCheckInSignerKind; method: 'PARENT_PORTAL' | 'IN_PERSON';
  version: number; signedAt: string; withdrawnAt: string | null;
}
function consent(v: unknown): FaceCheckInConsent | null {
  if (v === null) return null;
  const o = closed(v, ['consentId', 'state', 'formId', 'signerKind', 'method', 'version', 'signedAt', 'withdrawnAt'], true);
  const state = oneOf(o.state, FACE_CHECKIN_CONSENT_STATES, true), withdrawnAt = time(o.withdrawnAt, true, true);
  if ((state === 'WITHDRAWN') !== (withdrawnAt !== null)) fail(true);
  return Object.freeze({ consentId: id(o.consentId, true), state, formId: int(o.formId, 1, true, 9999), signerKind: oneOf(o.signerKind, FACE_CHECKIN_SIGNER_KINDS, true),
    method: oneOf(o.method, ['PARENT_PORTAL', 'IN_PERSON'] as const, true), version: int(o.version, 1, true), signedAt: time(o.signedAt, true) as string, withdrawnAt });
}

export interface FaceCheckInSettings {
  status: 'ON' | 'OFF'; profile: string | null; cityLimits: string | null; acknowledgements: readonly FaceCheckInAcknowledgement[];
  offReason: 'OWNER' | 'LOCATION_CHANGED' | null; /** 0 when never saved. */ version: number; updatedAt: string | null;
}
function settings(v: unknown, extra: readonly string[] = []): FaceCheckInSettings & { templatesDeleted?: number } {
  const o = closed(v, ['status', 'profile', 'cityLimits', 'acknowledgements', 'offReason', 'version', 'updatedAt', ...extra], true);
  const status = oneOf(o.status, ['ON', 'OFF'] as const, true), profile = code(o.profile, true, true);
  const offReason = o.offReason === null ? null : oneOf(o.offReason, ['OWNER', 'LOCATION_CHANGED'] as const, true);
  if ((status === 'ON') !== (profile !== null) || (status === 'ON' && offReason !== null)) fail(true);
  const out = { status, profile, cityLimits: code(o.cityLimits, true, true), acknowledgements: list(o.acknowledgements, 4, a => oneOf(a, FACE_CHECKIN_ACKNOWLEDGEMENTS, true), true),
    offReason, version: int(o.version, 0, true), updatedAt: time(o.updatedAt, true, true) };
  return Object.freeze(extra.includes('templatesDeleted') ? { ...out, templatesDeleted: int(o.templatesDeleted, 0, true) } : out);
}

/** One answer to "is the school inside these city limits?". cityLimits null when the state has no such city. */
export interface FaceCheckInChoice { cityLimits: string | null; profile: string; status: string; acknowledgements: readonly FaceCheckInAcknowledgement[] }
function choice(v: unknown): FaceCheckInChoice {
  const o = closed(v, ['cityLimits', 'profile', 'status', 'acknowledgements'], true);
  return Object.freeze({ cityLimits: code(o.cityLimits, true, true), profile: code(o.profile, true) as string,
    status: oneOf(o.status, ['AVAILABLE_WITH_CONSENT', 'BLOCKED', 'NOT_REVIEWED', 'NOT_LAUNCHED'] as const, true),
    acknowledgements: list(o.acknowledgements, 4, a => oneOf(a, FACE_CHECKIN_ACKNOWLEDGEMENTS, true), true) });
}

export interface FaceCheckInNoticeView { profile: string | null; status: string; laws: readonly string[]; addOns: readonly string[]; reviewStatus: 'TEST_ONLY_DRAFT'; rulesVersion: number }
function notice(v: unknown): FaceCheckInNoticeView {
  const o = closed(v, ['profile', 'status', 'laws', 'addOns', 'reviewStatus', 'rulesVersion'], true);
  if (o.reviewStatus !== 'TEST_ONLY_DRAFT') fail(true);
  return Object.freeze({ profile: code(o.profile, true, true), status: oneOf(o.status, ['AVAILABLE_WITH_CONSENT', 'BLOCKED', 'NOT_REVIEWED', 'LOCATION_REQUIRED'] as const, true),
    laws: list(o.laws, 6, l => text(l, 200, true) as string, true), addOns: list(o.addOns, 12, a => code(a, true) as string, true), reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: int(o.rulesVersion, 1, true) });
}

export interface FaceCheckInStudent {
  studentProfileId: string; givenName: string; familyName: string; studentStatus: string; adult: boolean; hasPhoto: boolean;
  consent: FaceCheckInConsent | null; enrolled: boolean; enrolledAt: string | null;
}
export interface FaceCheckInRead {
  program: 'CLOSED' | 'TEST_MODE'; matcher: 'SYNTHETIC'; addressNotice: FaceCheckInNoticeView; choices: readonly FaceCheckInChoice[];
  settings: FaceCheckInSettings; forms: readonly FaceCheckInForm[]; deletionsLast30Days: number; students: readonly FaceCheckInStudent[];
}
export function validateFaceCheckInRead(v: unknown): FaceCheckInRead {
  const o = closed(v, ['program', 'matcher', 'addressNotice', 'choices', 'settings', 'forms', 'deletionsLast30Days', 'students'], true);
  if (o.matcher !== 'SYNTHETIC') fail(true);
  const st = settings(o.settings), fs = forms(o.forms);
  if ((st.status === 'ON') !== (fs.length === 3) || fs.some(f => f.profile !== st.profile)) fail(true);
  const students = list(o.students, 500, s => {
    const x = closed(s, ['studentProfileId', 'givenName', 'familyName', 'studentStatus', 'adult', 'hasPhoto', 'consent', 'enrolled', 'enrolledAt'], true);
    const enrolled = bool(x.enrolled, true), enrolledAt = time(x.enrolledAt, true, true);
    if (enrolled !== (enrolledAt !== null)) fail(true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), givenName: text(x.givenName, 200, true) as string, familyName: text(x.familyName, 200, true) as string,
      studentStatus: text(x.studentStatus, 40, true) as string, adult: bool(x.adult, true), hasPhoto: bool(x.hasPhoto, true), consent: consent(x.consent), enrolled, enrolledAt });
  }, true);
  if (new Set(students.map(s => s.studentProfileId)).size !== students.length) fail(true);
  return Object.freeze({ program: oneOf(o.program, FACE_CHECKIN_PROGRAM_STATUSES, true), matcher: 'SYNTHETIC', addressNotice: notice(o.addressNotice),
    choices: list(o.choices, 4, choice, true), settings: st, forms: fs, deletionsLast30Days: int(o.deletionsLast30Days, 0, true), students });
}

// ---------- staff commands ----------
export interface FaceCheckInSettingsInput { schoolId: string; expectedVersion: number; enabled: boolean; cityLimits: string | null; acknowledgements: readonly FaceCheckInAcknowledgement[] }
export function validateFaceCheckInSettingsInput(v: unknown): FaceCheckInSettingsInput {
  const o = closed(v, ['schoolId', 'expectedVersion', 'enabled', 'cityLimits', 'acknowledgements'], false);
  const enabled = bool(o.enabled, false), cityLimits = code(o.cityLimits, false, true);
  const acknowledgements = list(o.acknowledgements, 4, a => oneOf(a, FACE_CHECKIN_ACKNOWLEDGEMENTS, false), false);
  if (new Set(acknowledgements).size !== acknowledgements.length || (!enabled && (cityLimits !== null || acknowledgements.length > 0))) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), expectedVersion: int(o.expectedVersion, 0, false), enabled, cityLimits, acknowledgements });
}
export interface FaceCheckInSettingsResult { settings: FaceCheckInSettings; templatesDeleted: number; replayed: boolean }
export function validateFaceCheckInSettingsResult(v: unknown): FaceCheckInSettingsResult {
  const o = closed(v, ['record', 'replayed'], true);
  const { templatesDeleted, ...rest } = settings(o.record, ['templatesDeleted']);
  return Object.freeze({ settings: Object.freeze(rest), templatesDeleted: templatesDeleted ?? 0, replayed: bool(o.replayed, true) });
}

export interface FaceCheckInConsentInput {
  schoolId: string; studentProfileId: string; formId: number; formDigest: string; signerKind: FaceCheckInSignerKind; signerName: string; witnessAttested: true;
}
export function validateFaceCheckInConsentInput(v: unknown): FaceCheckInConsentInput {
  const o = closed(v, ['schoolId', 'studentProfileId', 'formId', 'formDigest', 'signerKind', 'signerName', 'witnessAttested'], false);
  if (o.witnessAttested !== true || !faceCheckInSignerNameOk(o.signerName) || typeof o.formDigest !== 'string' || !/^[a-f0-9]{64}$/.test(o.formDigest)) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), studentProfileId: id(o.studentProfileId, false), formId: int(o.formId, 1, false, 9999), formDigest: o.formDigest,
    signerKind: oneOf(o.signerKind, FACE_CHECKIN_SIGNER_KINDS, false), signerName: o.signerName, witnessAttested: true });
}
export interface FaceCheckInWithdrawInput { schoolId: string; consentId: string; expectedVersion: number }
export function validateFaceCheckInWithdrawInput(v: unknown): FaceCheckInWithdrawInput {
  const o = closed(v, ['schoolId', 'consentId', 'expectedVersion'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), consentId: id(o.consentId, false), expectedVersion: int(o.expectedVersion, 1, false) });
}
export interface FaceCheckInConsentResult { studentProfileId: string; consent: FaceCheckInConsent; replayed: boolean }
export function validateFaceCheckInConsentResult(v: unknown): FaceCheckInConsentResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['studentProfileId', 'consent'], true);
  const c = consent(r.consent); if (!c) fail(true);
  return Object.freeze({ studentProfileId: id(r.studentProfileId, true), consent: c, replayed: bool(o.replayed, true) });
}

export interface FaceCheckInEnrollInput { schoolId: string; studentProfileId: string }
export function validateFaceCheckInEnrollInput(v: unknown): FaceCheckInEnrollInput {
  const o = closed(v, ['schoolId', 'studentProfileId'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), studentProfileId: id(o.studentProfileId, false) });
}
export interface FaceCheckInEnrollResult { studentProfileId: string; outcome: 'ENROLLED' | 'ALREADY_ENROLLED'; enrolledAt: string; matcher: 'SYNTHETIC'; replayed: boolean }
export function validateFaceCheckInEnrollResult(v: unknown): FaceCheckInEnrollResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['studentProfileId', 'outcome', 'enrolledAt', 'matcher'], true);
  if (r.matcher !== 'SYNTHETIC') fail(true);
  return Object.freeze({ studentProfileId: id(r.studentProfileId, true), outcome: oneOf(r.outcome, ['ENROLLED', 'ALREADY_ENROLLED'] as const, true),
    enrolledAt: time(r.enrolledAt, true) as string, matcher: 'SYNTHETIC', replayed: bool(o.replayed, true) });
}

/** One camera picture, base64, for a class session. It is stripped of metadata, hashed and discarded by the API. */
export interface FaceCheckInMatchInput { schoolId: string; sessionId: string; mediaType: PersonPhotoMediaType; data: string }
export function validateFaceCheckInMatchInput(v: unknown): FaceCheckInMatchInput {
  const o = closed(v, ['schoolId', 'sessionId', 'mediaType', 'data'], false);
  if (typeof o.data !== 'string' || o.data.length < 4 || o.data.length > Math.ceil(PERSON_PHOTO_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.data)) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), sessionId: id(o.sessionId, false), mediaType: oneOf(o.mediaType, PERSON_PHOTO_MEDIA_TYPES, false), data: o.data });
}
export interface FaceCheckInMatchResult {
  matchId: string; sessionId: string; outcome: typeof FACE_CHECKIN_MATCH_OUTCOMES[number];
  student: { studentProfileId: string; givenName: string; familyName: string } | null; proposedAt: string; replayed: boolean;
}
export function validateFaceCheckInMatchResult(v: unknown): FaceCheckInMatchResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['matchId', 'sessionId', 'outcome', 'student', 'proposedAt'], true);
  const outcome = oneOf(r.outcome, FACE_CHECKIN_MATCH_OUTCOMES, true);
  let student = null;
  if (r.student !== null) {
    const s = closed(r.student, ['studentProfileId', 'givenName', 'familyName'], true);
    student = Object.freeze({ studentProfileId: id(s.studentProfileId, true), givenName: text(s.givenName, 200, true) as string, familyName: text(s.familyName, 200, true) as string });
  }
  if ((outcome === 'PROPOSED') !== (student !== null)) fail(true);
  return Object.freeze({ matchId: id(r.matchId, true), sessionId: id(r.sessionId, true), outcome, student, proposedAt: time(r.proposedAt, true) as string, replayed: bool(o.replayed, true) });
}

export interface FaceCheckInConfirmInput { schoolId: string; matchId: string; accept: boolean; status: 'PRESENT' | 'LATE' }
export function validateFaceCheckInConfirmInput(v: unknown): FaceCheckInConfirmInput {
  const o = closed(v, ['schoolId', 'matchId', 'accept', 'status'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), matchId: id(o.matchId, false), accept: bool(o.accept, false), status: oneOf(o.status, ['PRESENT', 'LATE'] as const, false) });
}
export interface FaceCheckInConfirmResult {
  matchId: string; sessionId: string; studentProfileId: string; outcome: typeof FACE_CHECKIN_DECISIONS[number];
  checkIn: { outcome: 'RECORDED' | 'ALREADY_RECORDED'; attendance: { id: string; status: string; version: number; recordedAt: string } } | null; replayed: boolean;
}
export function validateFaceCheckInConfirmResult(v: unknown): FaceCheckInConfirmResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['matchId', 'sessionId', 'studentProfileId', 'outcome', 'checkIn'], true);
  const outcome = oneOf(r.outcome, FACE_CHECKIN_DECISIONS, true);
  let checkIn = null;
  if (r.checkIn !== null) {
    const c = closed(r.checkIn, ['outcome', 'attendance'], true), a = closed(c.attendance, ['id', 'status', 'version', 'recordedAt'], true);
    checkIn = Object.freeze({ outcome: oneOf(c.outcome, ['RECORDED', 'ALREADY_RECORDED'] as const, true),
      attendance: Object.freeze({ id: id(a.id, true), status: text(a.status, 40, true) as string, version: int(a.version, 1, true), recordedAt: time(a.recordedAt, true) as string }) });
  }
  if ((outcome === 'CONFIRMED') !== (checkIn !== null)) fail(true);
  return Object.freeze({ matchId: id(r.matchId, true), sessionId: id(r.sessionId, true), studentProfileId: id(r.studentProfileId, true), outcome, checkIn, replayed: bool(o.replayed, true) });
}

// ---------- family (parent portal) ----------
export interface FamilyFaceCheckInChild { studentProfileId: string; givenName: string; familyName: string; consent: FaceCheckInConsent | null; enrolled: boolean }
export interface FamilyFaceCheckInRead {
  program: 'CLOSED' | 'TEST_MODE'; schoolStatus: 'ON' | 'OFF'; canSign: boolean; canWithdraw: boolean; forms: readonly FaceCheckInForm[]; children: readonly FamilyFaceCheckInChild[];
}
export function validateFamilyFaceCheckInRead(v: unknown): FamilyFaceCheckInRead {
  const o = closed(v, ['program', 'schoolStatus', 'canSign', 'canWithdraw', 'forms', 'children'], true);
  const schoolStatus = oneOf(o.schoolStatus, ['ON', 'OFF'] as const, true), fs = forms(o.forms), canSign = bool(o.canSign, true);
  if ((schoolStatus === 'ON') !== (fs.length === 3) || (canSign && schoolStatus !== 'ON')) fail(true);
  const children = list(o.children, 20, c => {
    const x = closed(c, ['studentProfileId', 'givenName', 'familyName', 'consent', 'enrolled'], true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), givenName: text(x.givenName, 200, true) as string, familyName: text(x.familyName, 200, true) as string,
      consent: consent(x.consent), enrolled: bool(x.enrolled, true) });
  }, true);
  return Object.freeze({ program: oneOf(o.program, FACE_CHECKIN_PROGRAM_STATUSES, true), schoolStatus, canSign, canWithdraw: bool(o.canWithdraw, true), forms: fs, children });
}
export interface FamilyFaceCheckInSignInput { studentProfileId: string; formId: number; formDigest: string; signerName: string }
export function validateFamilyFaceCheckInSignInput(v: unknown): FamilyFaceCheckInSignInput {
  const o = closed(v, ['studentProfileId', 'formId', 'formDigest', 'signerName'], false);
  if (!faceCheckInSignerNameOk(o.signerName) || typeof o.formDigest !== 'string' || !/^[a-f0-9]{64}$/.test(o.formDigest)) fail(false);
  return Object.freeze({ studentProfileId: id(o.studentProfileId, false), formId: int(o.formId, 1, false, 9999), formDigest: o.formDigest, signerName: o.signerName });
}
export interface FamilyFaceCheckInWithdrawInput { consentId: string; expectedVersion: number }
export function validateFamilyFaceCheckInWithdrawInput(v: unknown): FamilyFaceCheckInWithdrawInput {
  const o = closed(v, ['consentId', 'expectedVersion'], false);
  return Object.freeze({ consentId: id(o.consentId, false), expectedVersion: int(o.expectedVersion, 1, false) });
}
