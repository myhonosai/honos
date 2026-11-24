// HQ-COMM E1 HON prospects and their consent (migration 0283). HON's own prospects, never a school's leads. HQ owner, or an
// HQ operator holding hq.marketing.manage, adds, corrects, archives and reads them, and sees their contact details. Consent
// is per channel and purpose and tied to the exact address. HQ records only opt-outs and email service opt-ins; marketing
// and texting opt-ins come only from the person themselves. Nothing here sends a message.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { isHqEmail as isEmail, isHqPhone as isPhone } from './hq-communications.js';

export const HQ_PROSPECT_SOURCES = ['PUBLIC_SIGN_UP', 'TRIAL', 'HQ_ENTERED', 'IMPORT', 'INBOUND_TEXT'] as const;
export const HQ_PROSPECT_HQ_SOURCES = ['HQ_ENTERED', 'IMPORT'] as const;
export const HQ_PROSPECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const HQ_PROSPECT_CHANNELS = ['EMAIL', 'SMS'] as const;
export const HQ_PROSPECT_PURPOSES = ['SERVICE', 'MARKETING'] as const;
export const HQ_PROSPECT_CONSENT_STATUSES = ['OPTED_IN', 'OPTED_OUT'] as const;
export const HQ_PROSPECT_CONSENT_SOURCES = ['SIGN_UP_FORM', 'HQ_RECORDED', 'RECIPIENT'] as const;
export type HqProspectSource = typeof HQ_PROSPECT_SOURCES[number];
export type HqProspectStatus = typeof HQ_PROSPECT_STATUSES[number];
export type HqProspectChannel = typeof HQ_PROSPECT_CHANNELS[number];
export type HqProspectPurpose = typeof HQ_PROSPECT_PURPOSES[number];
export type HqProspectConsentStatus = typeof HQ_PROSPECT_CONSENT_STATUSES[number];
export type HqProspectConsentSource = typeof HQ_PROSPECT_CONSENT_SOURCES[number];
export const HQ_PROSPECT_COMMANDS = { create: 'hq-prospect-create', update: 'hq-prospect-update', consent: 'hq-prospect-consent' } as const;
export const HQ_PROSPECT_LIMITS = { fullName: 120, schoolName: 160, note: 300 } as const;

/** Whether HQ may record this answer for someone: any opt-out, and only an email service opt-in. */
export function hqMayRecordProspectConsent(channel: HqProspectChannel, purpose: HqProspectPurpose, status: HqProspectConsentStatus): boolean {
  return status === 'OPTED_OUT' || (channel === 'EMAIL' && purpose === 'SERVICE');
}

export interface HqProspectPerson { principalId: string; displayName: string }
export interface HqProspectConsentNow { status: HqProspectConsentStatus; source: HqProspectConsentSource; capturedAt: string }
export type HqProspectConsentGrid = Record<HqProspectChannel, Record<HqProspectPurpose, HqProspectConsentNow | null>>;
export interface HqProspect {
  prospectId: string; fullName: string; schoolName: string | null; email: string | null; phone: string | null; source: HqProspectSource;
  campaign: { campaignId: string; code: string; name: string } | null; status: HqProspectStatus; consent: HqProspectConsentGrid;
  createdBy: HqProspectPerson | null; createdAt: string; updatedAt: string; version: number;
}
export interface HqProspectCursor { createdAt: string; prospectId: string }
export interface HqProspectList { prospects: HqProspect[]; limit: number; nextCursor: HqProspectCursor | null; viewer: HqProspectPerson; asOf: string }
export interface HqProspectConsentEntry {
  channel: HqProspectChannel; purpose: HqProspectPurpose; status: HqProspectConsentStatus; source: HqProspectConsentSource; address: string;
  current: boolean; disclosureVersion: string | null; note: string | null; recordedBy: HqProspectPerson | null; capturedAt: string;
}
export interface HqProspectDetail { prospect: HqProspect; consentHistory: HqProspectConsentEntry[]; viewer: HqProspectPerson; asOf: string }
export interface HqProspectReceipt { operation: 'CREATE' | 'UPDATE' | 'CONSENT'; prospect: HqProspect; replayed: boolean }
export interface HqProspectFields { fullName: string; schoolName: string | null; email: string | null; phone: string | null; campaignId: string | null }
export interface HqProspectCreateInput extends HqProspectFields { source: typeof HQ_PROSPECT_HQ_SOURCES[number] }
export interface HqProspectUpdateInput extends HqProspectFields { status: HqProspectStatus; expectedVersion: number }
export interface HqProspectConsentInput { channel: HqProspectChannel; purpose: HqProspectPurpose; status: HqProspectConsentStatus; note: string; expectedVersion: number }
export interface HqProspectListQuery { status: HqProspectStatus | null; campaignId: string | null; cursor: HqProspectCursor | null; limit: number }

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
// The database's text rule exactly: btrim strips only spaces, and [[:cntrl:]] covers C0 and C1 controls.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F<>]/;
/** A name, school name or note as the database accepts it: no leading or trailing spaces, no control characters, no angle brackets. */
export function isHqProspectText(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && !v.startsWith(' ') && !v.endsWith(' ') && v.length >= min && v.length <= max && !UNSAFE.test(v);
}
const text = isHqProspectText;
const nullable = <T>(v: unknown, ok: (x: unknown) => x is T): boolean => v === null || ok(v);
const isName = (v: unknown): v is string => text(v, 1, HQ_PROSPECT_LIMITS.fullName);
const isSchool = (v: unknown): v is string => text(v, 1, HQ_PROSPECT_LIMITS.schoolName);

function fields(r: Record<string, unknown>, fail: () => never): HqProspectFields {
  if (!isName(r.fullName) || !nullable(r.schoolName, isSchool) || !nullable(r.email, isEmail) || !nullable(r.phone, isPhone)
    || (r.email === null && r.phone === null) || !nullable(r.campaignId, isUuid)) fail();
  return { fullName: r.fullName as string, schoolName: r.schoolName as string | null, email: r.email as string | null, phone: r.phone as string | null,
    campaignId: r.campaignId === null ? null : (r.campaignId as string).toLowerCase() };
}
export function validateHqProspectCreateInput(value: unknown): HqProspectCreateInput {
  const r = record(value, invalid); exactKeys(r, ['fullName', 'schoolName', 'email', 'phone', 'campaignId', 'source'], invalid);
  if (!has(HQ_PROSPECT_HQ_SOURCES, r.source)) invalid();
  return { ...fields(r, invalid), source: r.source as HqProspectCreateInput['source'] };
}
export function validateHqProspectUpdateInput(value: unknown): HqProspectUpdateInput {
  const r = record(value, invalid); exactKeys(r, ['fullName', 'schoolName', 'email', 'phone', 'campaignId', 'status', 'expectedVersion'], invalid);
  if (!has(HQ_PROSPECT_STATUSES, r.status) || !isInt(r.expectedVersion, 1, 999_999_999)) invalid();
  return { ...fields(r, invalid), status: r.status as HqProspectStatus, expectedVersion: r.expectedVersion as number };
}
export function validateHqProspectConsentInput(value: unknown): HqProspectConsentInput {
  const r = record(value, invalid); exactKeys(r, ['channel', 'purpose', 'status', 'note', 'expectedVersion'], invalid);
  if (!has(HQ_PROSPECT_CHANNELS, r.channel) || !has(HQ_PROSPECT_PURPOSES, r.purpose) || !has(HQ_PROSPECT_CONSENT_STATUSES, r.status)
    || !text(r.note, 3, HQ_PROSPECT_LIMITS.note)
    || !isInt(r.expectedVersion, 1, 999_999_999)) invalid();
  return r as unknown as HqProspectConsentInput;
}
export function encodeHqProspectCursor(c: HqProspectCursor): string { return `${c.createdAt}~${c.prospectId}`; }
export function validateHqProspectListQuery(value: unknown): HqProspectListQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status', 'campaignId', 'cursor', 'limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), campaignId = one(q.campaignId), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(HQ_PROSPECT_STATUSES, status)) || (campaignId !== null && !isUuid(campaignId))
    || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: HqProspectCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [createdAt, prospectId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(createdAt) || !isUuid(prospectId)) invalid();
    decoded = { createdAt: createdAt as string, prospectId: (prospectId as string).toLowerCase() };
  }
  return { status: status as HqProspectStatus | null, campaignId: campaignId?.toLowerCase() ?? null, cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

function person(value: unknown): HqProspectPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || typeof p.displayName !== 'string' || p.displayName.length < 1 || p.displayName.length > 120) drift();
  return p as unknown as HqProspectPerson;
}
function consentNow(value: unknown): HqProspectConsentNow | null {
  if (value === null) return null;
  const c = record(value, drift); exactKeys(c, ['status', 'source', 'capturedAt'], drift);
  if (!has(HQ_PROSPECT_CONSENT_STATUSES, c.status) || !has(HQ_PROSPECT_CONSENT_SOURCES, c.source) || !isTimestamp(c.capturedAt)) drift();
  return c as unknown as HqProspectConsentNow;
}
function prospect(value: unknown): HqProspect {
  const p = record(value, drift);
  exactKeys(p, ['prospectId', 'fullName', 'schoolName', 'email', 'phone', 'source', 'campaign', 'status', 'consent', 'createdBy', 'createdAt', 'updatedAt', 'version'], drift);
  if (!isUuid(p.prospectId) || !isName(p.fullName) || !nullable(p.schoolName, isSchool) || !nullable(p.email, isEmail) || !nullable(p.phone, isPhone)
    || (p.email === null && p.phone === null) || !has(HQ_PROSPECT_SOURCES, p.source) || !has(HQ_PROSPECT_STATUSES, p.status)
    || !isTimestamp(p.createdAt) || !isTimestamp(p.updatedAt) || !isInt(p.version, 1, 999_999_999)) drift();
  if (p.campaign !== null) {
    const c = record(p.campaign, drift); exactKeys(c, ['campaignId', 'code', 'name'], drift);
    if (!isUuid(c.campaignId) || typeof c.code !== 'string' || !/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(c.code) || typeof c.name !== 'string' || c.name.length > 120) drift();
  }
  if ((p.source === 'HQ_ENTERED' || p.source === 'IMPORT') !== (p.createdBy !== null)) drift();
  if (p.createdBy !== null) person(p.createdBy);
  const grid = record(p.consent, drift); exactKeys(grid, ['EMAIL', 'SMS'], drift);
  for (const ch of HQ_PROSPECT_CHANNELS) {
    const row = record(grid[ch], drift); exactKeys(row, ['SERVICE', 'MARKETING'], drift);
    const address = ch === 'EMAIL' ? p.email : p.phone;
    for (const pu of HQ_PROSPECT_PURPOSES) if (consentNow(row[pu]) !== null && address === null) drift();
  }
  return p as unknown as HqProspect;
}
export function validateHqProspectList(value: unknown): HqProspectList {
  const r = record(value, drift); exactKeys(r, ['prospects', 'limit', 'nextCursor', 'viewer', 'asOf'], drift);
  if (!Array.isArray(r.prospects) || !isInt(r.limit, 1, 100) || r.prospects.length > r.limit || !isTimestamp(r.asOf)) drift();
  (r.prospects as unknown[]).forEach(prospect);
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['createdAt', 'prospectId'], drift);
    if (!isTimestamp(c.createdAt) || !isUuid(c.prospectId) || (r.prospects as unknown[]).length !== r.limit) drift();
  }
  person(r.viewer);
  return r as unknown as HqProspectList;
}
export function validateHqProspectDetail(value: unknown): HqProspectDetail {
  const r = record(value, drift); exactKeys(r, ['prospect', 'consentHistory', 'viewer', 'asOf'], drift);
  prospect(r.prospect);
  if (!Array.isArray(r.consentHistory) || r.consentHistory.length > 100 || !isTimestamp(r.asOf)) drift();
  for (const e of r.consentHistory as unknown[]) {
    const c = record(e, drift);
    exactKeys(c, ['channel', 'purpose', 'status', 'source', 'address', 'current', 'disclosureVersion', 'note', 'recordedBy', 'capturedAt'], drift);
    if (!has(HQ_PROSPECT_CHANNELS, c.channel) || !has(HQ_PROSPECT_PURPOSES, c.purpose) || !has(HQ_PROSPECT_CONSENT_STATUSES, c.status)
      || !has(HQ_PROSPECT_CONSENT_SOURCES, c.source) || !(c.channel === 'EMAIL' ? isEmail(c.address) : isPhone(c.address)) || typeof c.current !== 'boolean'
      || !nullable(c.disclosureVersion, (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9.-]{0,39}$/.test(v))
      || !nullable(c.note, (v: unknown): v is string => typeof v === 'string' && v.length <= HQ_PROSPECT_LIMITS.note)
      || (c.source === 'HQ_RECORDED') !== (c.recordedBy !== null) || !isTimestamp(c.capturedAt)) drift();
    if (c.recordedBy !== null) person(c.recordedBy);
  }
  person(r.viewer);
  return r as unknown as HqProspectDetail;
}
export function validateHqProspectReceipt(value: unknown): HqProspectReceipt {
  const r = record(value, drift); exactKeys(r, ['operation', 'prospect', 'replayed'], drift);
  if (!has(['CREATE', 'UPDATE', 'CONSENT'], r.operation) || typeof r.replayed !== 'boolean') drift();
  prospect(r.prospect);
  return r as unknown as HqProspectReceipt;
}
