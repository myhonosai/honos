/**
 * M-E (0410): the digital membership agreement. The school writes one agreement (English required, Korean and Spanish
 * optional) and chooses whether a signature is required before a membership starts. Staff send a signing link for one
 * membership that has not started; the family signs on their own device; while required, the membership cannot start
 * unsigned. Nothing is charged or scheduled.
 */
export const MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_AGREEMENT_TEXT' as const;
export const MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION = 'I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT' as const;
export const MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION = 'I_AGREE_AND_SIGN_THIS_MEMBERSHIP_AGREEMENT' as const;
export const MEMBERSHIP_AGREEMENT_TEMPLATE_READ_COMMAND = 'billing.membership_agreement.read' as const;
export const MEMBERSHIP_AGREEMENT_TEMPLATE_SAVE_COMMAND = 'billing.membership_agreement.save' as const;
export const MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND = 'billing.membership_agreement.card_read' as const;
export const MEMBERSHIP_AGREEMENT_SEND_COMMAND = 'billing.membership_agreement.send' as const;
export const MEMBERSHIP_AGREEMENT_LANGUAGES = ['en', 'ko', 'es'] as const;
export const MEMBERSHIP_AGREEMENT_BLOCKERS = ['MEMBERSHIP_STARTED', 'NO_AGREEMENT', 'ALREADY_SIGNED', 'SIGNER_NOT_ALLOWED'] as const;
export const MEMBERSHIP_AGREEMENT_RELATIONSHIPS = ['SELF', 'PARENT', 'LEGAL_GUARDIAN'] as const;
export type MembershipAgreementLanguage = typeof MEMBERSHIP_AGREEMENT_LANGUAGES[number];
export type MembershipAgreementBlocker = typeof MEMBERSHIP_AGREEMENT_BLOCKERS[number];
export type MembershipAgreementRelationship = typeof MEMBERSHIP_AGREEMENT_RELATIONSHIPS[number];
export type MembershipAgreementTexts = Partial<Record<MembershipAgreementLanguage, { title: string; body: string }>> & { en: { title: string; body: string } };

export interface MembershipAgreementTemplate { textVersion: number | null; signatureRequired: boolean; texts: MembershipAgreementTexts | null; updatedAt: string | null }
export interface SaveMembershipAgreementInput { expectedVersion: number | null; texts: MembershipAgreementTexts; signatureRequired: boolean; confirmation: typeof MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION }
export interface MembershipAgreementSigner { personId: string; givenName: string; familyName: string; relation: 'SELF' | 'GUARDIAN' }
export interface MembershipAgreementRequest {
  requestId: string; state: 'OPEN' | 'SIGNED' | 'REPLACED' | 'EXPIRED'; signerPersonId: string; signerRelation: 'SELF' | 'GUARDIAN'; textVersion: number;
  createdAt: string; expiresAt: string;
  signature: { signedName: string; relationship: MembershipAgreementRelationship; language: MembershipAgreementLanguage; signedAt: string } | null;
}
export interface MembershipAgreementCard {
  membershipId: string; membershipState: string; agreementVersion: number | null; signatureRequired: boolean; signed: boolean;
  signers: MembershipAgreementSigner[]; requests: MembershipAgreementRequest[];
}
export interface SendMembershipAgreementInput { membershipId: string; signerPersonId: string; token: string; confirmation: typeof MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION }
export type SentMembershipAgreement = MembershipAgreementRequest & { membershipId: string };
export interface MembershipAgreementTerms {
  studentName: string | null; payerName: string | null; planName: string; planCode: string; priceMinor: number | null; currency: string | null;
  billingFrequency: string | null; termKind: string | null; termMonths: number | null; startDate: string | null; endDate: string | null;
}
export type MembershipAgreementLink =
  | { state: 'SIGNED' | 'REPLACED' | 'EXPIRED'; schoolName: string }
  | { state: 'OPEN'; schoolName: string; signerRelation: 'SELF' | 'GUARDIAN'; signerGivenName: string; expiresAt: string;
    languages: Partial<Record<MembershipAgreementLanguage, { title: string; body: string; documentHash: string }>>; terms: MembershipAgreementTerms };
export interface SignMembershipAgreementInput {
  language: MembershipAgreementLanguage; documentHash: string; signerName: string; relationship: MembershipAgreementRelationship;
  strokes: number[][]; confirmation: typeof MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;
export const MEMBERSHIP_AGREEMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LINE_UNSAFE = /[\x00-\x1f\x7f]/;
const BODY_UNSAFE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function fail(): never { throw new Error('Unverified membership agreement.'); }
function bad(): never { throw new Error('VALIDATION_FAILED'); }
function exact(value: unknown, keys: readonly string[], onFail: () => never = fail): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onFail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) onFail();
  return v;
}
const id = (v: unknown, onFail: () => never = fail): string => { if (typeof v !== 'string' || !UUID.test(v)) onFail(); return v as string; };
const instant = (v: unknown): string => { if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) fail(); return v; };
const maybeInstant = (v: unknown): string | null => v === null ? null : instant(v);
const line = (v: unknown, max: number, onFail: () => never = fail): string => { if (typeof v !== 'string' || !v || v.length > max || v.trim() !== v || LINE_UNSAFE.test(v)) onFail(); return v as string; };
const maybeLine = (v: unknown, max: number): string | null => v === null ? null : line(v, max);
const version = (v: unknown, onFail: () => never = fail): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 100_000) onFail(); return v as number; };
const bool = (v: unknown, onFail: () => never = fail): boolean => { if (typeof v !== 'boolean') onFail(); return v as boolean; };
const maybeDate = (v: unknown): string | null => { if (v === null) return null; if (typeof v !== 'string' || !DATE.test(v)) fail(); return v; };
const maybeInt = (v: unknown): number | null => { if (v === null) return null; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(); return v; };

/** The school agreement texts: English required; titles 1..200, bodies 1..20000 characters. */
export function validateMembershipAgreementTexts(value: unknown, onFail: () => never = bad): MembershipAgreementTexts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onFail();
  const v = value as Record<string, unknown>;
  if (!Object.hasOwn(v, 'en') || Object.keys(v).some(k => !(MEMBERSHIP_AGREEMENT_LANGUAGES as readonly string[]).includes(k))) onFail();
  const out: Record<string, { title: string; body: string }> = {};
  for (const language of MEMBERSHIP_AGREEMENT_LANGUAGES) {
    if (!Object.hasOwn(v, language)) continue;
    const t = exact(v[language], ['title', 'body'], onFail);
    const title = line(t.title, 200, onFail);
    if (typeof t.body !== 'string' || !t.body.trim() || t.body.trim().length > 20_000 || BODY_UNSAFE.test(t.body)) onFail();
    out[language] = { title, body: t.body as string };
  }
  return out as MembershipAgreementTexts;
}
export function validateSaveMembershipAgreementInput(value: unknown): SaveMembershipAgreementInput {
  const v = exact(value, ['expectedVersion', 'texts', 'signatureRequired', 'confirmation'], bad);
  if (v.confirmation !== MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION) bad();
  return { expectedVersion: v.expectedVersion === null ? null : version(v.expectedVersion, bad), texts: validateMembershipAgreementTexts(v.texts),
    signatureRequired: bool(v.signatureRequired, bad), confirmation: MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION };
}
export function verifyMembershipAgreementTemplate(value: unknown): MembershipAgreementTemplate {
  const v = exact(value, ['textVersion', 'signatureRequired', 'texts', 'updatedAt']);
  const textVersion = v.textVersion === null ? null : version(v.textVersion);
  const texts = v.texts === null ? null : validateMembershipAgreementTexts(v.texts, fail);
  const updatedAt = maybeInstant(v.updatedAt);
  if ((textVersion === null) !== (texts === null) || (textVersion === null) !== (updatedAt === null) || (textVersion === null && v.signatureRequired !== false)) fail();
  return { textVersion, signatureRequired: bool(v.signatureRequired), texts, updatedAt };
}
export function validateSendMembershipAgreementInput(value: unknown): SendMembershipAgreementInput {
  const v = exact(value, ['membershipId', 'signerPersonId', 'token', 'confirmation'], bad);
  if (typeof v.token !== 'string' || !MEMBERSHIP_AGREEMENT_TOKEN.test(v.token) || v.confirmation !== MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION) bad();
  return { membershipId: id(v.membershipId, bad), signerPersonId: id(v.signerPersonId, bad), token: v.token, confirmation: MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION };
}
function request(value: unknown): MembershipAgreementRequest {
  const r = exact(value, ['requestId', 'state', 'signerPersonId', 'signerRelation', 'textVersion', 'createdAt', 'expiresAt', 'signature']);
  if (!['OPEN', 'SIGNED', 'REPLACED', 'EXPIRED'].includes(r.state as string) || (r.signerRelation !== 'SELF' && r.signerRelation !== 'GUARDIAN')) fail();
  let signature: MembershipAgreementRequest['signature'] = null;
  if (r.signature !== null) {
    const s = exact(r.signature, ['signedName', 'relationship', 'language', 'signedAt']);
    if (!(MEMBERSHIP_AGREEMENT_RELATIONSHIPS as readonly unknown[]).includes(s.relationship) || !(MEMBERSHIP_AGREEMENT_LANGUAGES as readonly unknown[]).includes(s.language)) fail();
    signature = { signedName: line(s.signedName, 120), relationship: s.relationship as MembershipAgreementRelationship, language: s.language as MembershipAgreementLanguage, signedAt: instant(s.signedAt) };
  }
  if ((r.state === 'SIGNED') !== (signature !== null)) fail();
  return { requestId: id(r.requestId), state: r.state as MembershipAgreementRequest['state'], signerPersonId: id(r.signerPersonId), signerRelation: r.signerRelation,
    textVersion: version(r.textVersion), createdAt: instant(r.createdAt), expiresAt: instant(r.expiresAt), signature };
}
export function verifyMembershipAgreementCard(value: unknown, membershipId: string): MembershipAgreementCard {
  const v = exact(value, ['membershipId', 'membershipState', 'agreementVersion', 'signatureRequired', 'signed', 'signers', 'requests']);
  if (id(v.membershipId) !== membershipId || typeof v.membershipState !== 'string' || !/^[A-Z_]{1,40}$/.test(v.membershipState)
    || !Array.isArray(v.signers) || v.signers.length > 50 || !Array.isArray(v.requests) || v.requests.length > 20) fail();
  const signers = v.signers.map(x => { const s = exact(x, ['personId', 'givenName', 'familyName', 'relation']);
    if (s.relation !== 'SELF' && s.relation !== 'GUARDIAN') fail();
    return { personId: id(s.personId), givenName: line(s.givenName, 200), familyName: line(s.familyName, 200), relation: s.relation as 'SELF' | 'GUARDIAN' }; });
  const requests = v.requests.map(request);
  const signed = bool(v.signed);
  if (signed !== requests.some(r => r.state === 'SIGNED') && requests.length < 20) fail();
  if (requests.filter(r => r.state === 'OPEN').length > 1) fail();
  return { membershipId, membershipState: v.membershipState, agreementVersion: v.agreementVersion === null ? null : version(v.agreementVersion),
    signatureRequired: bool(v.signatureRequired), signed, signers, requests };
}
export function verifySentMembershipAgreement(value: unknown, input: SendMembershipAgreementInput): SentMembershipAgreement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const { membershipId, ...rest } = value as Record<string, unknown>;
  const r = request(rest);
  if (membershipId !== input.membershipId || r.signerPersonId !== input.signerPersonId || r.state !== 'OPEN') fail();
  return { ...r, membershipId: input.membershipId };
}
export function verifyMembershipAgreementLink(value: unknown): MembershipAgreementLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const state = (value as { state?: unknown }).state;
  if (state === 'SIGNED' || state === 'REPLACED' || state === 'EXPIRED') {
    const v = exact(value, ['state', 'schoolName']); return { state, schoolName: line(v.schoolName, 200) };
  }
  const v = exact(value, ['state', 'schoolName', 'signerRelation', 'signerGivenName', 'expiresAt', 'languages', 'terms']);
  if (v.state !== 'OPEN' || (v.signerRelation !== 'SELF' && v.signerRelation !== 'GUARDIAN') || !v.languages || typeof v.languages !== 'object' || Array.isArray(v.languages)) fail();
  const raw = v.languages as Record<string, unknown>;
  if (!Object.hasOwn(raw, 'en') || Object.keys(raw).some(k => !(MEMBERSHIP_AGREEMENT_LANGUAGES as readonly string[]).includes(k))) fail();
  const languages: Record<string, { title: string; body: string; documentHash: string }> = {};
  for (const [k, x] of Object.entries(raw)) {
    const l = exact(x, ['title', 'body', 'documentHash']);
    if (typeof l.body !== 'string' || !l.body.trim() || l.body.length > 20_100 || typeof l.documentHash !== 'string' || !HASH.test(l.documentHash)) fail();
    languages[k] = { title: line(l.title, 200), body: l.body, documentHash: l.documentHash };
  }
  const t = exact(v.terms, ['studentName', 'payerName', 'planName', 'planCode', 'priceMinor', 'currency', 'billingFrequency', 'termKind', 'termMonths', 'startDate', 'endDate']);
  const terms: MembershipAgreementTerms = { studentName: maybeLine(t.studentName, 240), payerName: maybeLine(t.payerName, 240), planName: line(t.planName, 200),
    planCode: line(t.planCode, 200), priceMinor: maybeInt(t.priceMinor), currency: t.currency === null ? null : line(t.currency, 3),
    billingFrequency: t.billingFrequency === null ? null : line(t.billingFrequency, 20), termKind: t.termKind === null ? null : line(t.termKind, 20),
    termMonths: maybeInt(t.termMonths), startDate: maybeDate(t.startDate), endDate: maybeDate(t.endDate) };
  return { state: 'OPEN', schoolName: line(v.schoolName, 200), signerRelation: v.signerRelation, signerGivenName: line(v.signerGivenName, 200),
    expiresAt: instant(v.expiresAt), languages, terms };
}
export function validateSignMembershipAgreementInput(value: unknown): SignMembershipAgreementInput {
  const v = exact(value, ['language', 'documentHash', 'signerName', 'relationship', 'strokes', 'confirmation'], bad);
  if (!(MEMBERSHIP_AGREEMENT_LANGUAGES as readonly unknown[]).includes(v.language) || typeof v.documentHash !== 'string' || !HASH.test(v.documentHash)
    || !(MEMBERSHIP_AGREEMENT_RELATIONSHIPS as readonly unknown[]).includes(v.relationship) || v.confirmation !== MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION) bad();
  const strokes = v.strokes;
  if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > 200 || JSON.stringify(strokes).length > 16_384
    || strokes.some(s => !Array.isArray(s) || s.length < 2 || s.length > 2000 || s.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10_000))) bad();
  return { language: v.language as MembershipAgreementLanguage, documentHash: v.documentHash, signerName: line(v.signerName, 120, bad),
    relationship: v.relationship as MembershipAgreementRelationship, strokes: strokes as number[][], confirmation: MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION };
}
