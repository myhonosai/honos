/**
 * 0463: the school membership agreement, signed once in the parent portal for every child it covers, with face check-in as
 * a separate optional box on the same page (each ticked child gets its own 0443 face consent in the same transaction).
 * HON ships no agreement text: the school writes it and is responsible for its wording. Parents may also add or replace a
 * child's photo; the API strips image metadata first.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';
import { PERSON_PHOTO_MAX_BASE64, PERSON_PHOTO_MEDIA_TYPES, type PersonPhotoMediaType } from './person-photos.js';
import { faceCheckInSignerNameOk, FACE_CHECKIN_CONSENT_STATES, FACE_CHECKIN_SIGNER_KINDS, type FaceCheckInConsent, type FaceCheckInForm } from './face-checkin.js';

export const MEMBERSHIP_AGREEMENT_HUMAN_COMMAND = 'membership-agreement' as const;
export const FAMILY_MEMBERSHIP_AGREEMENT_SIGN_COMMAND = 'family-membership-agreement-sign' as const;
export const FAMILY_PERSON_PHOTO_COMMAND = 'family-person-photo' as const;
export const MEMBERSHIP_AGREEMENT_LANGUAGES = ['en', 'ko', 'es'] as const;
export type MembershipAgreementLanguage = typeof MEMBERSHIP_AGREEMENT_LANGUAGES[number];
export const MEMBERSHIP_AGREEMENT_STATUSES = ['SIGNED', 'NEEDS_NEW_VERSION', 'NOT_SIGNED'] as const;
export type MembershipAgreementStatus = typeof MEMBERSHIP_AGREEMENT_STATUSES[number];
export const MEMBERSHIP_AGREEMENT_TITLE_MAX = 200;
export const MEMBERSHIP_AGREEMENT_BODY_MAX = 50_000;
/** At most this many children in one signing (and in the family read). */
export const MEMBERSHIP_AGREEMENT_MAX_CHILDREN = 20;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TITLE_UNSAFE = /[<>\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BODY_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function fail(response: boolean): never { throw new Error(response ? 'MEMBERSHIP_AGREEMENT_RESPONSE_INVALID' : 'MEMBERSHIP_AGREEMENT_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function int(v: unknown, min: number, response: boolean, max = 999_999_999): number { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(response); return v as number; }
function bool(v: unknown, response: boolean): boolean { if (typeof v !== 'boolean') fail(response); return v; }
function oneOf<T extends string>(v: unknown, values: readonly T[], response: boolean): T { if (!(values as readonly unknown[]).includes(v)) fail(response); return v as T; }
function text(v: unknown, max: number, response: boolean): string { if (typeof v !== 'string' || v.length < 1 || v.length > max) fail(response); return v; }
function time(v: unknown, response: boolean, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v)) fail(response);
  return v;
}
function digest(v: unknown, response: boolean): string { if (typeof v !== 'string' || !DIGEST.test(v)) fail(response); return v; }
function list<T>(v: unknown, max: number, item: (x: unknown) => T, response: boolean, min = 0): readonly T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(response);
  return Object.freeze(v.map(item));
}
const language = (v: unknown, response: boolean) => oneOf(v, MEMBERSHIP_AGREEMENT_LANGUAGES, response);

/** A draft or agreement title: 1-200 characters, no surrounding spaces, no < > or control characters. */
export function membershipAgreementTitleOk(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MEMBERSHIP_AGREEMENT_TITLE_MAX && v.trim() === v && !TITLE_UNSAFE.test(v);
}
/** Body text: 1-50,000 characters; line breaks and tabs are fine, other control characters are not. */
export function membershipAgreementBodyOk(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MEMBERSHIP_AGREEMENT_BODY_MAX && !BODY_UNSAFE.test(v);
}

// ---------- shared shapes ----------
export interface MembershipAgreementText { language: MembershipAgreementLanguage; title: string; body: string; digest: string }
export interface MembershipAgreementVersion { versionId: string; number: number; publishedAt: string; texts: readonly MembershipAgreementText[] }
function version(v: unknown): MembershipAgreementVersion | null {
  if (v === null) return null;
  const o = closed(v, ['versionId', 'number', 'publishedAt', 'texts'], true);
  const texts = list(o.texts, 3, t => {
    const x = closed(t, ['language', 'title', 'body', 'digest'], true);
    return Object.freeze({ language: language(x.language, true), title: text(x.title, MEMBERSHIP_AGREEMENT_TITLE_MAX, true), body: text(x.body, MEMBERSHIP_AGREEMENT_BODY_MAX, true), digest: digest(x.digest, true) });
  }, true, 1);
  if (texts[0]!.language !== 'en' || new Set(texts.map(t => t.language)).size !== texts.length) fail(true);
  return Object.freeze({ versionId: id(o.versionId, true), number: int(o.number, 1, true, 999_999), publishedAt: time(o.publishedAt, true) as string, texts });
}
export interface MembershipAgreementStatusView { status: MembershipAgreementStatus; versionNumber: number | null; signedAt: string | null }
function status(v: unknown): MembershipAgreementStatusView {
  const o = closed(v, ['status', 'versionNumber', 'signedAt'], true);
  const s = oneOf(o.status, MEMBERSHIP_AGREEMENT_STATUSES, true);
  const versionNumber = o.versionNumber === null ? null : int(o.versionNumber, 1, true, 999_999), signedAt = time(o.signedAt, true, true);
  if ((s === 'NOT_SIGNED') !== (versionNumber === null) || (versionNumber === null) !== (signedAt === null)) fail(true);
  return Object.freeze({ status: s, versionNumber, signedAt });
}
// The face shapes are re-checked here so a change to either contract is caught.
function faceForm(v: unknown): FaceCheckInForm {
  const o = closed(v, ['formId', 'profile', 'language', 'version', 'title', 'body', 'digest', 'reviewStatus'], true);
  if (o.reviewStatus !== 'TEST_ONLY_DRAFT' || typeof o.profile !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(o.profile)) fail(true);
  return Object.freeze({ formId: int(o.formId, 1, true, 9999), profile: o.profile, language: language(o.language, true), version: int(o.version, 1, true),
    title: text(o.title, 500, true), body: text(o.body, 20000, true), digest: digest(o.digest, true), reviewStatus: 'TEST_ONLY_DRAFT' });
}
function faceConsent(v: unknown): FaceCheckInConsent | null {
  if (v === null) return null;
  const o = closed(v, ['consentId', 'state', 'formId', 'signerKind', 'method', 'version', 'signedAt', 'withdrawnAt'], true);
  const state = oneOf(o.state, FACE_CHECKIN_CONSENT_STATES, true), withdrawnAt = time(o.withdrawnAt, true, true);
  if ((state === 'WITHDRAWN') !== (withdrawnAt !== null)) fail(true);
  return Object.freeze({ consentId: id(o.consentId, true), state, formId: int(o.formId, 1, true, 9999), signerKind: oneOf(o.signerKind, FACE_CHECKIN_SIGNER_KINDS, true),
    method: oneOf(o.method, ['PARENT_PORTAL', 'IN_PERSON'] as const, true), version: int(o.version, 1, true), signedAt: time(o.signedAt, true) as string, withdrawnAt });
}

// ---------- staff ----------
export interface MembershipAgreementDraft { language: MembershipAgreementLanguage; title: string; body: string; version: number; updatedAt: string }
function draft(v: unknown): MembershipAgreementDraft {
  const o = closed(v, ['language', 'title', 'body', 'version', 'updatedAt'], true);
  return Object.freeze({ language: language(o.language, true), title: text(o.title, MEMBERSHIP_AGREEMENT_TITLE_MAX, true), body: text(o.body, MEMBERSHIP_AGREEMENT_BODY_MAX, true),
    version: int(o.version, 1, true), updatedAt: time(o.updatedAt, true) as string });
}
export interface MembershipAgreementVersionSummary { versionId: string; number: number; publishedAt: string; languages: readonly MembershipAgreementLanguage[]; signatures: number }
export interface MembershipAgreementRead {
  drafts: readonly MembershipAgreementDraft[]; current: MembershipAgreementVersion | null; versions: readonly MembershipAgreementVersionSummary[];
  /** Students with a DRAFT or ACTIVE membership, by their agreement status. */
  summary: { covered: number; signed: number; needsNewVersion: number; notSigned: number };
}
export function validateMembershipAgreementRead(v: unknown): MembershipAgreementRead {
  const o = closed(v, ['drafts', 'current', 'versions', 'summary'], true);
  const drafts = list(o.drafts, 3, draft, true);
  if (new Set(drafts.map(d => d.language)).size !== drafts.length) fail(true);
  const versions = list(o.versions, 50, x => {
    const s = closed(x, ['versionId', 'number', 'publishedAt', 'languages', 'signatures'], true);
    return Object.freeze({ versionId: id(s.versionId, true), number: int(s.number, 1, true, 999_999), publishedAt: time(s.publishedAt, true) as string,
      languages: list(s.languages, 3, l => language(l, true), true, 1), signatures: int(s.signatures, 0, true) });
  }, true);
  const current = version(o.current);
  if ((current === null) !== (versions.length === 0) || (current && (versions[0]!.versionId !== current.versionId || versions[0]!.number !== current.number))) fail(true);
  const m = closed(o.summary, ['covered', 'signed', 'needsNewVersion', 'notSigned'], true);
  const summary = Object.freeze({ covered: int(m.covered, 0, true), signed: int(m.signed, 0, true), needsNewVersion: int(m.needsNewVersion, 0, true), notSigned: int(m.notSigned, 0, true) });
  if (summary.signed + summary.needsNewVersion + summary.notSigned !== summary.covered) fail(true);
  return Object.freeze({ drafts, current, versions, summary });
}

export interface MembershipAgreementDraftInput { schoolId: string; language: MembershipAgreementLanguage; title: string; body: string; expectedVersion: number }
export function validateMembershipAgreementDraftInput(v: unknown): MembershipAgreementDraftInput {
  const o = closed(v, ['schoolId', 'language', 'title', 'body', 'expectedVersion'], false);
  if (!membershipAgreementTitleOk(o.title) || !membershipAgreementBodyOk(o.body)) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), language: language(o.language, false), title: o.title, body: o.body, expectedVersion: int(o.expectedVersion, 0, false) });
}
export interface MembershipAgreementDraftResult { draft: MembershipAgreementDraft; replayed: boolean }
export function validateMembershipAgreementDraftResult(v: unknown): MembershipAgreementDraftResult {
  const o = closed(v, ['record', 'replayed'], true);
  return Object.freeze({ draft: draft(o.record), replayed: bool(o.replayed, true) });
}

/** Publish exactly the drafts the owner previewed (by version); English is required. */
export interface MembershipAgreementPublishInput {
  schoolId: string; expectedNumber: number; drafts: readonly { language: MembershipAgreementLanguage; version: number }[]; schoolResponsible: true;
}
export function validateMembershipAgreementPublishInput(v: unknown): MembershipAgreementPublishInput {
  const o = closed(v, ['schoolId', 'expectedNumber', 'drafts', 'schoolResponsible'], false);
  if (o.schoolResponsible !== true) fail(false);
  const drafts = list(o.drafts, 3, d => {
    const x = closed(d, ['language', 'version'], false);
    return Object.freeze({ language: language(x.language, false), version: int(x.version, 1, false) });
  }, false, 1);
  if (new Set(drafts.map(d => d.language)).size !== drafts.length || !drafts.some(d => d.language === 'en')) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), expectedNumber: int(o.expectedNumber, 0, false, 999_999), drafts, schoolResponsible: true });
}
export interface MembershipAgreementPublishResult {
  versionId: string; number: number; publishedAt: string; texts: readonly { language: MembershipAgreementLanguage; digest: string }[]; replayed: boolean;
}
export function validateMembershipAgreementPublishResult(v: unknown): MembershipAgreementPublishResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['versionId', 'number', 'publishedAt', 'texts'], true);
  const texts = list(r.texts, 3, t => { const x = closed(t, ['language', 'digest'], true); return Object.freeze({ language: language(x.language, true), digest: digest(x.digest, true) }); }, true, 1);
  if (texts[0]!.language !== 'en' || new Set(texts.map(t => t.language)).size !== texts.length) fail(true);
  return Object.freeze({ versionId: id(r.versionId, true), number: int(r.number, 1, true, 999_999), publishedAt: time(r.publishedAt, true) as string, texts, replayed: bool(o.replayed, true) });
}

// ---------- parent portal ----------
export interface FamilyPersonPhotoSummary { mediaType: PersonPhotoMediaType; bytes: number; version: number; updatedAt: string }
function photo(v: unknown): FamilyPersonPhotoSummary | null {
  if (v === null) return null;
  const o = closed(v, ['mediaType', 'bytes', 'version', 'updatedAt'], true);
  return Object.freeze({ mediaType: oneOf(o.mediaType, PERSON_PHOTO_MEDIA_TYPES, true), bytes: int(o.bytes, 1, true, 400_000), version: int(o.version, 1, true), updatedAt: time(o.updatedAt, true) as string });
}
export interface FamilyMembershipAgreementChild {
  studentProfileId: string; givenName: string; familyName: string;
  /** A DRAFT or ACTIVE membership at the school. */
  covered: boolean;
  /** GUARDIAN: under 18 or no birth date. SELF: 18 or older, signs for themselves (not in the portal yet). */
  signer: 'GUARDIAN' | 'SELF';
  agreement: MembershipAgreementStatusView; photo: FamilyPersonPhotoSummary | null; faceConsent: FaceCheckInConsent | null; faceEnrolled: boolean;
}
export interface FamilyMembershipAgreementSigning {
  signingId: string; language: MembershipAgreementLanguage; digest: string; signerName: string; signedAt: string;
  children: readonly { studentProfileId: string; faceOptIn: boolean }[];
}
export interface FamilyMembershipAgreementRead {
  canSign: boolean; canChangePhotos: boolean; agreement: MembershipAgreementVersion | null;
  /** Face check-in box: forms only while the program is open and the school has it on. */
  face: { available: boolean; forms: readonly FaceCheckInForm[] };
  children: readonly FamilyMembershipAgreementChild[];
  /** This family's signings of the current version, newest first (the printable copy). */
  signings: readonly FamilyMembershipAgreementSigning[];
}
export function validateFamilyMembershipAgreementRead(v: unknown): FamilyMembershipAgreementRead {
  const o = closed(v, ['canSign', 'canChangePhotos', 'agreement', 'face', 'children', 'signings'], true);
  const agreement = version(o.agreement), canSign = bool(o.canSign, true);
  if (canSign && !agreement) fail(true);
  const f = closed(o.face, ['available', 'forms'], true), available = bool(f.available, true), forms = list(f.forms, 3, faceForm, true);
  if (available !== (forms.length === 3)) fail(true);
  const children = list(o.children, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, c => {
    const x = closed(c, ['studentProfileId', 'givenName', 'familyName', 'covered', 'signer', 'agreement', 'photo', 'faceConsent', 'faceEnrolled'], true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), givenName: text(x.givenName, 200, true), familyName: text(x.familyName, 200, true),
      covered: bool(x.covered, true), signer: oneOf(x.signer, ['GUARDIAN', 'SELF'] as const, true), agreement: status(x.agreement), photo: photo(x.photo),
      faceConsent: faceConsent(x.faceConsent), faceEnrolled: bool(x.faceEnrolled, true) });
  }, true);
  if (new Set(children.map(c => c.studentProfileId)).size !== children.length) fail(true);
  const signings = list(o.signings, 20, s => {
    const x = closed(s, ['signingId', 'language', 'digest', 'signerName', 'signedAt', 'children'], true);
    if (!faceCheckInSignerNameOk(x.signerName)) fail(true);
    return Object.freeze({ signingId: id(x.signingId, true), language: language(x.language, true), digest: digest(x.digest, true), signerName: x.signerName,
      signedAt: time(x.signedAt, true) as string,
      children: list(x.children, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, c => { const y = closed(c, ['studentProfileId', 'faceOptIn'], true); return Object.freeze({ studentProfileId: id(y.studentProfileId, true), faceOptIn: bool(y.faceOptIn, true) }); }, true, 1) });
  }, true);
  if (signings.length && !agreement) fail(true);
  return Object.freeze({ canSign, canChangePhotos: bool(o.canChangePhotos, true), agreement, face: Object.freeze({ available, forms }), children, signings });
}

export interface FamilyFaceOptIn { studentProfileId: string; formId: number; formDigest: string }
export interface FamilyMembershipAgreementSignInput {
  versionId: string; language: MembershipAgreementLanguage; digest: string; signerName: string; eSignConsent: true;
  studentProfileIds: readonly string[]; faceOptIns: readonly FamilyFaceOptIn[];
}
export function validateFamilyMembershipAgreementSignInput(v: unknown): FamilyMembershipAgreementSignInput {
  const o = closed(v, ['versionId', 'language', 'digest', 'signerName', 'eSignConsent', 'studentProfileIds', 'faceOptIns'], false);
  if (o.eSignConsent !== true || !faceCheckInSignerNameOk(o.signerName)) fail(false);
  const studentProfileIds = list(o.studentProfileIds, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, x => id(x, false), false, 1);
  const faceOptIns = list(o.faceOptIns, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, x => {
    const y = closed(x, ['studentProfileId', 'formId', 'formDigest'], false);
    return Object.freeze({ studentProfileId: id(y.studentProfileId, false), formId: int(y.formId, 1, false, 9999), formDigest: digest(y.formDigest, false) });
  }, false);
  if (new Set(studentProfileIds).size !== studentProfileIds.length || new Set(faceOptIns.map(f => f.studentProfileId)).size !== faceOptIns.length
    || faceOptIns.some(f => !studentProfileIds.includes(f.studentProfileId))) fail(false);
  return Object.freeze({ versionId: id(o.versionId, false), language: language(o.language, false), digest: digest(o.digest, false), signerName: o.signerName,
    eSignConsent: true, studentProfileIds, faceOptIns });
}
export interface FamilyMembershipAgreementSignResult {
  signingId: string; versionId: string; number: number; language: MembershipAgreementLanguage; digest: string; signedAt: string;
  children: readonly { studentProfileId: string; signatureId: string; faceConsent: FaceCheckInConsent | null }[]; replayed: boolean;
}
export function validateFamilyMembershipAgreementSignResult(v: unknown): FamilyMembershipAgreementSignResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['signingId', 'versionId', 'number', 'language', 'digest', 'signedAt', 'children'], true);
  const children = list(r.children, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, c => {
    const x = closed(c, ['studentProfileId', 'signatureId', 'faceConsent'], true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), signatureId: id(x.signatureId, true), faceConsent: faceConsent(x.faceConsent) });
  }, true, 1);
  return Object.freeze({ signingId: id(r.signingId, true), versionId: id(r.versionId, true), number: int(r.number, 1, true, 999_999), language: language(r.language, true),
    digest: digest(r.digest, true), signedAt: time(r.signedAt, true) as string, children, replayed: bool(o.replayed, true) });
}

export interface FamilyPersonPhotoSetInput { studentProfileId: string; expectedVersion: number | null; mediaType: PersonPhotoMediaType; data: string }
export function validateFamilyPersonPhotoSetInput(v: unknown): FamilyPersonPhotoSetInput {
  const o = closed(v, ['studentProfileId', 'expectedVersion', 'mediaType', 'data'], false);
  if (typeof o.data !== 'string' || o.data.length < 4 || o.data.length > PERSON_PHOTO_MAX_BASE64 || o.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.data)) fail(false);
  return Object.freeze({ studentProfileId: id(o.studentProfileId, false), expectedVersion: o.expectedVersion === null ? null : int(o.expectedVersion, 1, false),
    mediaType: oneOf(o.mediaType, PERSON_PHOTO_MEDIA_TYPES, false), data: o.data });
}
export interface FamilyPersonPhotoRemoveInput { studentProfileId: string; expectedVersion: number }
export function validateFamilyPersonPhotoRemoveInput(v: unknown): FamilyPersonPhotoRemoveInput {
  const o = closed(v, ['studentProfileId', 'expectedVersion'], false);
  return Object.freeze({ studentProfileId: id(o.studentProfileId, false), expectedVersion: int(o.expectedVersion, 1, false) });
}
export interface FamilyPersonPhotoResult { studentProfileId: string; photo: FamilyPersonPhotoSummary | null; replaced: boolean; templatesDeleted: number; replayed: boolean }
export function validateFamilyPersonPhotoResult(v: unknown): FamilyPersonPhotoResult {
  const o = closed(v, ['record', 'replayed'], true), r = closed(o.record, ['studentProfileId', 'photo', 'replaced', 'templatesDeleted'], true);
  return Object.freeze({ studentProfileId: id(r.studentProfileId, true), photo: photo(r.photo), replaced: bool(r.replaced, true), templatesDeleted: int(r.templatesDeleted, 0, true, 1),
    replayed: bool(o.replayed, true) });
}

// ---------- 0499 signing link by email and text ----------
/** The command header for staff sending a signing link. */
export const MEMBERSHIP_AGREEMENT_LINK_COMMAND = 'membership-agreement-link' as const;
export const MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION = 'I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT_LINK' as const;
/** The random part of a signing link: 32 bytes as base64url, made in the staff member's browser. Only its SHA-256 is stored. */
export const MEMBERSHIP_AGREEMENT_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MEMBERSHIP_AGREEMENT_LINK_CHANNELS = ['EMAIL', 'SMS'] as const;
export type MembershipAgreementLinkChannel = typeof MEMBERSHIP_AGREEMENT_LINK_CHANNELS[number];
export const MEMBERSHIP_AGREEMENT_LINK_STATES = ['OPEN', 'SIGNED', 'REPLACED', 'EXPIRED'] as const;
export type MembershipAgreementLinkState = typeof MEMBERSHIP_AGREEMENT_LINK_STATES[number];
export const MEMBERSHIP_AGREEMENT_LINK_OUTCOMES = ['QUEUED', 'NO_CONSENT', 'NO_ADDRESS'] as const;
export type MembershipAgreementLinkOutcome = typeof MEMBERSHIP_AGREEMENT_LINK_OUTCOMES[number];
export const MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS = ['SIGNED', 'ALREADY_SIGNED', 'CHANGED', 'INVALID', 'GONE'] as const;
export type MembershipAgreementLinkSignResult = typeof MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS[number];

const name = (v: unknown, response: boolean) => text(v, 200, response);
export interface MembershipAgreementLinkSummary {
  linkId: string; state: MembershipAgreementLinkState; recipientPersonId: string; studentProfileIds: readonly string[];
  createdAt: string; expiresAt: string; closedAt: string | null;
}
function linkSummary(v: unknown): MembershipAgreementLinkSummary {
  const o = closed(v, ['linkId', 'state', 'recipientPersonId', 'studentProfileIds', 'createdAt', 'expiresAt', 'closedAt'], true);
  const state = oneOf(o.state, MEMBERSHIP_AGREEMENT_LINK_STATES, true), closedAt = time(o.closedAt, true, true);
  if ((closedAt === null) !== (state === 'OPEN' || state === 'EXPIRED')) fail(true);
  return Object.freeze({ linkId: id(o.linkId, true), state, recipientPersonId: id(o.recipientPersonId, true),
    studentProfileIds: list(o.studentProfileIds, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, x => id(x, true), true, 1),
    createdAt: time(o.createdAt, true) as string, expiresAt: time(o.expiresAt, true) as string, closedAt });
}
export interface MembershipAgreementLinkGuardian {
  personId: string; givenName: string; familyName: string;
  email: { address: boolean; consent: boolean }; text: { address: boolean; consent: boolean };
}
export interface MembershipAgreementSendRead {
  current: { versionId: string; number: number } | null; familyId: string | null;
  guardians: readonly MembershipAgreementLinkGuardian[]; children: readonly { studentProfileId: string; givenName: string; familyName: string }[];
  latestLink: MembershipAgreementLinkSummary | null;
}
function reach(v: unknown) { const o = closed(v, ['address', 'consent'], true); return Object.freeze({ address: bool(o.address, true), consent: bool(o.consent, true) }); }
export function validateMembershipAgreementSendRead(v: unknown): MembershipAgreementSendRead {
  const o = closed(v, ['current', 'familyId', 'guardians', 'children', 'latestLink'], true);
  let current = null;
  if (o.current !== null) { const c = closed(o.current, ['versionId', 'number'], true); current = Object.freeze({ versionId: id(c.versionId, true), number: int(c.number, 1, true, 999_999) }); }
  const familyId = o.familyId === null ? null : id(o.familyId, true);
  const guardians = list(o.guardians, 50, g => {
    const x = closed(g, ['personId', 'givenName', 'familyName', 'email', 'text'], true);
    return Object.freeze({ personId: id(x.personId, true), givenName: name(x.givenName, true), familyName: name(x.familyName, true), email: reach(x.email), text: reach(x.text) });
  }, true);
  const children = list(o.children, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, c => {
    const x = closed(c, ['studentProfileId', 'givenName', 'familyName'], true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), givenName: name(x.givenName, true), familyName: name(x.familyName, true) });
  }, true);
  const latestLink = o.latestLink === null ? null : linkSummary(o.latestLink);
  if (familyId === null && (guardians.length || children.length || latestLink)) fail(true);
  if (current === null && children.length) fail(true);
  return Object.freeze({ current, familyId, guardians, children, latestLink });
}
export interface MembershipAgreementLinkSendInput {
  schoolId: string; personId: string; recipientPersonId: string; channels: readonly MembershipAgreementLinkChannel[]; token: string;
  confirmation: typeof MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION;
}
export function validateMembershipAgreementLinkSendInput(v: unknown): MembershipAgreementLinkSendInput {
  const o = closed(v, ['schoolId', 'personId', 'recipientPersonId', 'channels', 'token', 'confirmation'], false);
  if (o.confirmation !== MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION || typeof o.token !== 'string' || !MEMBERSHIP_AGREEMENT_LINK_TOKEN.test(o.token)) fail(false);
  const channels = list(o.channels, 2, x => oneOf(x, MEMBERSHIP_AGREEMENT_LINK_CHANNELS, false), false);
  if (new Set(channels).size !== channels.length) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), personId: id(o.personId, false), recipientPersonId: id(o.recipientPersonId, false),
    channels, token: o.token, confirmation: MEMBERSHIP_AGREEMENT_LINK_CONFIRMATION });
}
export interface MembershipAgreementLinkDelivery { channel: MembershipAgreementLinkChannel; outcome: MembershipAgreementLinkOutcome; messageId: string | null }
export interface MembershipAgreementLinkSendResult { link: MembershipAgreementLinkSummary; deliveries: readonly MembershipAgreementLinkDelivery[]; replayed: boolean }
export function validateMembershipAgreementLinkSendResult(v: unknown): MembershipAgreementLinkSendResult {
  const o = closed(v, ['record', 'replayed'], true);
  if (typeof o.record !== 'object' || o.record === null || Array.isArray(o.record)) fail(true);
  const { deliveries: raw, ...rest } = o.record as Record<string, unknown>;
  const deliveries = list(raw, 2, d => {
    const x = closed(d, ['channel', 'outcome', 'messageId'], true);
    const outcome = oneOf(x.outcome, MEMBERSHIP_AGREEMENT_LINK_OUTCOMES, true), messageId = x.messageId === null ? null : id(x.messageId, true);
    if ((outcome === 'QUEUED') !== (messageId !== null)) fail(true);
    return Object.freeze({ channel: oneOf(x.channel, MEMBERSHIP_AGREEMENT_LINK_CHANNELS, true), outcome, messageId });
  }, true);
  const link = linkSummary(rest);
  // The receipt records the link as it was made.
  if (link.state !== 'OPEN') fail(true);
  return Object.freeze({ link, deliveries, replayed: bool(o.replayed, true) });
}

/** What a public signing link shows. A link that is not open shows only its state and the school name. */
export type MembershipAgreementLinkView =
  | Readonly<{ state: 'SIGNED' | 'REPLACED' | 'EXPIRED'; schoolName: string }>
  | Readonly<{ state: 'OPEN'; schoolName: string; recipientGivenName: string; expiresAt: string; agreement: MembershipAgreementVersion | null;
      children: readonly { studentProfileId: string; givenName: string }[] }>;
export function validateMembershipAgreementLinkView(v: unknown): MembershipAgreementLinkView {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(true);
  if ((v as { state?: unknown }).state !== 'OPEN') {
    const o = closed(v, ['state', 'schoolName'], true);
    return Object.freeze({ state: oneOf(o.state, ['SIGNED', 'REPLACED', 'EXPIRED'] as const, true), schoolName: text(o.schoolName, 300, true) });
  }
  const o = closed(v, ['state', 'schoolName', 'recipientGivenName', 'expiresAt', 'agreement', 'children'], true);
  const children = list(o.children, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, c => {
    const x = closed(c, ['studentProfileId', 'givenName'], true);
    return Object.freeze({ studentProfileId: id(x.studentProfileId, true), givenName: name(x.givenName, true) });
  }, true);
  return Object.freeze({ state: 'OPEN', schoolName: text(o.schoolName, 300, true), recipientGivenName: name(o.recipientGivenName, true),
    expiresAt: time(o.expiresAt, true) as string, agreement: version(o.agreement), children });
}
export interface MembershipAgreementLinkSignInput {
  versionId: string; language: MembershipAgreementLanguage; digest: string; signerName: string; eSignConsent: true; studentProfileIds: readonly string[];
}
export function validateMembershipAgreementLinkSignInput(v: unknown): MembershipAgreementLinkSignInput {
  const o = closed(v, ['versionId', 'language', 'digest', 'signerName', 'eSignConsent', 'studentProfileIds'], false);
  if (o.eSignConsent !== true || !faceCheckInSignerNameOk(o.signerName)) fail(false);
  const studentProfileIds = list(o.studentProfileIds, MEMBERSHIP_AGREEMENT_MAX_CHILDREN, x => id(x, false), false, 1);
  if (new Set(studentProfileIds).size !== studentProfileIds.length) fail(false);
  return Object.freeze({ versionId: id(o.versionId, false), language: language(o.language, false), digest: digest(o.digest, false), signerName: o.signerName,
    eSignConsent: true, studentProfileIds });
}
