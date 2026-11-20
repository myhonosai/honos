/**
 * Family referrals (0604, docs/architecture/FAMILY_REFERRALS.md). The school's own family referral program: a family
 * shares a personal link, a friend who signs up through it becomes a CRM lead recorded as that family's referral, and the
 * school records its reward decision. The reward is the school's own words: recording it moves no money or credit.
 * A family never sees a friend's name or contact.
 */
export type FamilyReferralStatus = 'INTERESTED' | 'JOINED' | 'NOT_JOINED';
export type FamilyReferralReward = 'PENDING' | 'GIVEN' | 'NOT_ELIGIBLE';
export const FAMILY_REFERRAL_STATUSES: readonly FamilyReferralStatus[] = ['INTERESTED', 'JOINED', 'NOT_JOINED'];
export const FAMILY_REFERRAL_REWARDS: readonly FamilyReferralReward[] = ['PENDING', 'GIVEN', 'NOT_ELIGIBLE'];
export const PARENT_REFERRALS_LIMIT = 100;
export const SCHOOL_REFERRALS_LIMIT = 200;
export const FAMILY_REFERRAL_CODE = /^[0-9a-f]{16}$/;

export interface ParentReferralItem { referredAt: string; status: FamilyReferralStatus; reward: FamilyReferralReward }
export interface ParentReferralCounts { referred: number; joined: number; rewarded: number }
/** The family's view. `shareUrl` is built by the API from the code; the code itself never reaches the app. */
export interface ParentReferrals {
  schoolName: string;
  on: boolean;
  referrerReward: string | null;
  friendOffer: string | null;
  rules: string | null;
  shareMessage: string | null;
  canShare: boolean;
  shareUrl: string | null;
  counts: ParentReferralCounts;
  referrals: ParentReferralItem[];
}
export interface ParentReferralLink { shareUrl: string }

export interface PublicReferral {
  schoolName: string;
  friendOffer: string;
  form: { title: string; description: string; optionalFields: ('ageBand' | 'experience' | 'preferredTime')[] };
}

export type SchoolReferralProgramStatus = 'ON' | 'OFF';
export interface SchoolReferralProgram {
  version: number;
  status: SchoolReferralProgramStatus;
  formId: string | null;
  referrerReward: string;
  friendOffer: string;
  rules: string;
  shareMessage: string;
  updatedAt: string | null;
}
export interface SchoolReferralForm { formId: string; title: string; status: 'DRAFT' | 'PUBLISHED' | 'DISABLED' }
export interface SchoolReferral {
  referralId: string;
  version: number;
  familyName: string;
  friendName: string;
  leadId: string;
  leadStatus: 'OPEN' | 'WON' | 'LOST' | 'ARCHIVED';
  selfReferral: boolean;
  existingContact: boolean;
  rewardStatus: FamilyReferralReward;
  rewardNote: string;
  rewardDecidedAt: string | null;
  createdAt: string;
}
export interface SchoolReferrals {
  program: SchoolReferralProgram;
  forms: SchoolReferralForm[];
  counts: { referred: number; joined: number; rewarded: number; awaitingDecision: number };
  referrals: SchoolReferral[];
  canManage: boolean;
}
export interface SchoolReferralProgramInput {
  expectedVersion: number;
  status: SchoolReferralProgramStatus;
  formId: string | null;
  referrerReward: string;
  friendOffer: string;
  rules: string;
  shareMessage: string;
}
export interface FamilyReferralRewardInput { expectedVersion: number; decision: FamilyReferralReward; note: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

function invalid(): never { throw new Error('Invalid referral data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function str(value: unknown, max: number, { required = false, multiline = false } = {}): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!multiline && /[\n\r]/.test(value))) invalid();
  if (required && !value.trim()) invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value))) invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid();
  return value as T;
}
function nullableStr(value: unknown, max: number, multiline = false): string | null {
  return value === null ? null : str(value, max, { multiline });
}

/** The database answer for the family read (with `code`), before the API turns the code into a share link. */
export interface ParentReferralsRecord extends Omit<ParentReferrals, 'shareUrl'> { code: string | null }
export function verifyParentReferralsRecord(value: unknown): ParentReferralsRecord {
  const row = record(value, ['schoolName', 'on', 'referrerReward', 'friendOffer', 'rules', 'shareMessage', 'code', 'canShare', 'counts', 'referrals']);
  if (typeof row.on !== 'boolean' || typeof row.canShare !== 'boolean' || (row.canShare && !row.on)) invalid();
  if (row.code !== null && (typeof row.code !== 'string' || !FAMILY_REFERRAL_CODE.test(row.code) || !row.canShare)) invalid();
  const texts = { referrerReward: nullableStr(row.referrerReward, 200), friendOffer: nullableStr(row.friendOffer, 200),
    rules: nullableStr(row.rules, 500, true), shareMessage: nullableStr(row.shareMessage, 280, true) };
  if (row.on ? Object.values(texts).some(t => t === null) || !texts.referrerReward!.trim() : Object.values(texts).some(t => t !== null)) invalid();
  const c = record(row.counts, ['referred', 'joined', 'rewarded']);
  const counts = { referred: count(c.referred), joined: count(c.joined), rewarded: count(c.rewarded) };
  if (counts.joined > counts.referred || counts.rewarded > counts.referred) invalid();
  if (!Array.isArray(row.referrals) || row.referrals.length > PARENT_REFERRALS_LIMIT || row.referrals.length > counts.referred) invalid();
  const referrals = row.referrals.map(item => {
    const r = record(item, ['referredAt', 'status', 'reward']);
    return { referredAt: instant(r.referredAt), status: oneOf(r.status, FAMILY_REFERRAL_STATUSES), reward: oneOf(r.reward, FAMILY_REFERRAL_REWARDS) };
  });
  return { schoolName: str(row.schoolName, 200, { required: true }), on: row.on, ...texts, code: row.code as string | null, canShare: row.canShare, counts, referrals };
}

/** The share link: the HON site origin plus /refer/<code>, nothing else. */
export function familyReferralShareUrl(origin: string, code: string): string {
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) invalid();
  if (!FAMILY_REFERRAL_CODE.test(code)) invalid();
  return `${origin}/refer/${code}`;
}
const SHARE_URL = /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/refer\/[0-9a-f]{16}$/i;
export function verifyParentReferrals(value: unknown): ParentReferrals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const { shareUrl, ...rest } = value as Record<string, unknown>;
  const base = verifyParentReferralsRecord({ ...rest, code: null });
  if (shareUrl !== null && (typeof shareUrl !== 'string' || !SHARE_URL.test(shareUrl) || !base.canShare)) invalid();
  const { code: _code, ...shown } = base;
  return { ...shown, shareUrl: shareUrl as string | null };
}
export function verifyParentReferralLink(value: unknown): ParentReferralLink {
  const row = record(value, ['shareUrl']);
  if (typeof row.shareUrl !== 'string' || !SHARE_URL.test(row.shareUrl)) invalid();
  return { shareUrl: row.shareUrl };
}

const OPTIONAL_FIELDS = ['ageBand', 'experience', 'preferredTime'] as const;
export function verifyPublicReferral(value: unknown): PublicReferral {
  const row = record(value, ['schoolName', 'friendOffer', 'form']);
  const form = record(row.form, ['title', 'description', 'optionalFields']);
  if (!Array.isArray(form.optionalFields) || form.optionalFields.length > 3) invalid();
  const optionalFields = form.optionalFields.map(f => oneOf(f, OPTIONAL_FIELDS));
  if (new Set(optionalFields).size !== optionalFields.length) invalid();
  return { schoolName: str(row.schoolName, 200, { required: true }), friendOffer: str(row.friendOffer, 200),
    form: { title: str(form.title, 120, { required: true }), description: str(form.description, 500, { multiline: true }), optionalFields } };
}

function program(value: unknown): SchoolReferralProgram {
  const row = record(value, ['version', 'status', 'formId', 'referrerReward', 'friendOffer', 'rules', 'shareMessage', 'updatedAt']);
  const version = count(row.version);
  const status = oneOf(row.status, ['ON', 'OFF'] as const);
  if (row.formId !== null && (typeof row.formId !== 'string' || !UUID.test(row.formId))) invalid();
  if (status === 'ON' && (row.formId === null || version === 0)) invalid();
  if ((version === 0) !== (row.updatedAt === null)) invalid();
  return { version, status, formId: row.formId as string | null, referrerReward: str(row.referrerReward, 200, { required: status === 'ON' }),
    friendOffer: str(row.friendOffer, 200), rules: str(row.rules, 500, { multiline: true }), shareMessage: str(row.shareMessage, 280, { multiline: true }),
    updatedAt: row.updatedAt === null ? null : instant(row.updatedAt) };
}
function schoolReferral(value: unknown): SchoolReferral {
  const row = record(value, ['referralId', 'version', 'familyName', 'friendName', 'leadId', 'leadStatus', 'selfReferral', 'existingContact', 'rewardStatus', 'rewardNote', 'rewardDecidedAt', 'createdAt']);
  if (typeof row.referralId !== 'string' || !UUID.test(row.referralId) || typeof row.leadId !== 'string' || !UUID.test(row.leadId)) invalid();
  if (typeof row.selfReferral !== 'boolean' || typeof row.existingContact !== 'boolean') invalid();
  const version = count(row.version); if (version < 1) invalid();
  const rewardStatus = oneOf(row.rewardStatus, FAMILY_REFERRAL_REWARDS);
  if ((rewardStatus === 'PENDING') !== (row.rewardDecidedAt === null)) invalid();
  return { referralId: row.referralId, version, familyName: str(row.familyName, 200), friendName: str(row.friendName, 300), leadId: row.leadId,
    leadStatus: oneOf(row.leadStatus, ['OPEN', 'WON', 'LOST', 'ARCHIVED'] as const), selfReferral: row.selfReferral, existingContact: row.existingContact,
    rewardStatus, rewardNote: str(row.rewardNote, 300), rewardDecidedAt: row.rewardDecidedAt === null ? null : instant(row.rewardDecidedAt), createdAt: instant(row.createdAt) };
}
export function verifySchoolReferrals(value: unknown): SchoolReferrals {
  const row = record(value, ['program', 'forms', 'counts', 'referrals', 'canManage']);
  if (typeof row.canManage !== 'boolean' || !Array.isArray(row.forms) || row.forms.length > 100) invalid();
  if (!Array.isArray(row.referrals) || row.referrals.length > SCHOOL_REFERRALS_LIMIT) invalid();
  const forms = row.forms.map(item => {
    const f = record(item, ['formId', 'title', 'status']);
    if (typeof f.formId !== 'string' || !UUID.test(f.formId)) invalid();
    return { formId: f.formId, title: str(f.title, 120, { required: true }), status: oneOf(f.status, ['DRAFT', 'PUBLISHED', 'DISABLED'] as const) };
  });
  const c = record(row.counts, ['referred', 'joined', 'rewarded', 'awaitingDecision']);
  const counts = { referred: count(c.referred), joined: count(c.joined), rewarded: count(c.rewarded), awaitingDecision: count(c.awaitingDecision) };
  if (counts.joined > counts.referred || counts.rewarded > counts.referred || counts.awaitingDecision > counts.joined) invalid();
  return { program: program(row.program), forms, counts,
    referrals: row.referrals.map(schoolReferral), canManage: row.canManage };
}
export function verifySchoolReferralProgramReceipt(value: unknown): { program: SchoolReferralProgram; replayed: boolean } {
  const row = record(value, ['program', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  return { program: program(row.program), replayed: row.replayed };
}
export function verifyFamilyReferralRewardReceipt(value: unknown): { referral: SchoolReferral; replayed: boolean } {
  const row = record(value, ['referral', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  return { referral: schoolReferral(row.referral), replayed: row.replayed };
}

/** Closed staff inputs; the database checks them again. */
export function validateSchoolReferralProgramInput(value: unknown): SchoolReferralProgramInput {
  const row = record(value, ['expectedVersion', 'status', 'formId', 'referrerReward', 'friendOffer', 'rules', 'shareMessage']);
  if (typeof row.expectedVersion !== 'number' || !Number.isInteger(row.expectedVersion) || row.expectedVersion < 0 || row.expectedVersion > 999999998) invalid();
  const status = oneOf(row.status, ['ON', 'OFF'] as const);
  if (row.formId !== null && (typeof row.formId !== 'string' || !UUID.test(row.formId))) invalid();
  if (status === 'ON' && row.formId === null) invalid();
  const trimmed = (v: unknown, max: number, required: boolean, multiline: boolean) => { const t = str(v, max, { required, multiline }); if (t.trim() !== t) invalid(); return t; };
  return { expectedVersion: row.expectedVersion, status, formId: row.formId as string | null,
    referrerReward: trimmed(row.referrerReward, 200, status === 'ON', false), friendOffer: trimmed(row.friendOffer, 200, false, false),
    rules: trimmed(row.rules, 500, false, true), shareMessage: trimmed(row.shareMessage, 280, false, true) };
}
export function validateFamilyReferralRewardInput(value: unknown): FamilyReferralRewardInput {
  const row = record(value, ['expectedVersion', 'decision', 'note']);
  if (typeof row.expectedVersion !== 'number' || !Number.isInteger(row.expectedVersion) || row.expectedVersion < 1 || row.expectedVersion > 999999998) invalid();
  const note = str(row.note, 300); if (note.trim() !== note) invalid();
  const decision = oneOf(row.decision, FAMILY_REFERRAL_REWARDS);
  if (decision === 'PENDING' && note !== '') invalid();
  return { expectedVersion: row.expectedVersion, decision, note };
}
