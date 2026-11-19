/**
 * HQ calling on the HQ texting number (0580 CL5; docs/architecture/SCHOOL_CALLING.md §10). HQ people with an HQ messaging
 * purpose make and take browser calls on the HQ number, see the HQ call log and voicemail and set their own Ring me; only
 * the HQ owner switches HQ calling on and sets the greeting. HQ calls are not recorded; only voicemail is kept (90 days).
 * Nothing here reaches Twilio: the API proves every call through the database behind the voice switch.
 */
import {
  SCHOOL_CALL_DIRECTIONS, SCHOOL_CALL_FILTERS, SCHOOL_CALL_LIMITS, SCHOOL_CALL_STATUSES, schoolCallGreetingOk, schoolCallNoteOk, schoolCallNumberOk,
  type SchoolCallDirection, type SchoolCallFilter, type SchoolCallStatus,
} from './school-calls.js';

export const HQ_CALL_OUTCOMES = ['RESOLVED', 'CALL_BACK', 'FOLLOW_UP', 'LEFT_VOICEMAIL', 'WRONG_NUMBER', 'OTHER'] as const;
export type HqCallOutcome = (typeof HQ_CALL_OUTCOMES)[number];
/** Same values as the HQ calling entries of SAAS_COMMANDS (the X-HON-Human-Command header). */
export const HQ_CALL_COMMANDS = {
  settings: 'hq-call-settings', ring: 'hq-call-ring', start: 'hq-call-start', update: 'hq-call-update', doNotCall: 'hq-call-do-not-call', token: 'hq-call-token',
} as const;

export interface HqCall {
  callId: string; direction: SchoolCallDirection; status: SchoolCallStatus; remoteE164: string | null; contactUserId: string | null;
  contactName: string | null; contactSchools: string[]; staffName: string | null; startedAt: string; answeredAt: string | null; endedAt: string | null;
  durationSeconds: number | null; voicemail: boolean; recordingAvailable: boolean; recordingSeconds: number | null; heard: boolean;
  outcome: HqCallOutcome | null; note: string | null; doNotCall: boolean; version: number;
}
export interface HqCallStaffMember { principalId: string; name: string; ringMe: boolean }
export interface HqCallingSettings { callingOn: boolean; voicemailGreeting: string | null; version: number }
export interface HqCallingOverview extends HqCallingSettings {
  hqNumber: string | null; numberReady: boolean; ringMe: boolean; canManage: boolean; unheardVoicemails: number; missedToday: number;
  staff: HqCallStaffMember[] | null;
}
export interface SetHqCallingSettingsInput { callingOn: boolean; voicemailGreeting: string | null; expectedVersion: number }
export interface StartHqCallInput { toE164: string; contactUserId?: string }
export interface StartedHqCall { call: HqCall; connectBy: string; replayed: boolean }
export interface HqCallListQuery { filter?: SchoolCallFilter; contactUserId?: string; before?: { at: string; id: string } }
export interface HqCallList { calls: HqCall[]; nextCursor: { at: string; id: string } | null }
export interface UpdateHqCallInput { callId: string; expectedVersion: number; outcome?: HqCallOutcome | null; note?: string | null; heard?: true }
export interface HqPhoneToken {
  ready: boolean; reason: 'READY' | 'CALLING_OFF' | 'PHONE_NOT_SET_UP' | 'VOICE_NOT_APPROVED';
  identity: string | null; token: string | null; expiresAt: string | null; incoming: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const E164 = /^\+[1-9]\d{7,14}$/;
export const HQ_CALL_IDENTITY = /^h[0-9a-f]{32}$/;

function invalid(): never { throw new Error('Invalid HQ call data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function count(value: unknown, minimum = 0, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
const nullableCount = (value: unknown) => value === null ? null : count(value);
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
const nullableUuid = (value: unknown) => value === null ? null : uuid(value);
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
const nullableInstant = (value: unknown) => value === null ? null : instant(value);
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
const nullableText = (value: unknown, max = 200) => value === null ? null : text(value, max);
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function e164(value: unknown): string { if (typeof value !== 'string' || !E164.test(value)) invalid(); return value; }

export function validateSetHqCallingSettingsInput(value: unknown): SetHqCallingSettingsInput {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'expectedVersion']);
  if (row.voicemailGreeting !== null && !schoolCallGreetingOk(row.voicemailGreeting)) invalid();
  return { callingOn: bool(row.callingOn), voicemailGreeting: row.voicemailGreeting as string | null, expectedVersion: count(row.expectedVersion, 0) };
}
export function validateStartHqCallInput(value: unknown): StartHqCallInput {
  const row = record(value, ['toE164'], ['contactUserId']);
  if (!schoolCallNumberOk(row.toE164)) invalid();
  return { toE164: row.toE164, ...('contactUserId' in row ? { contactUserId: uuid(row.contactUserId) } : {}) };
}
export function validateHqCallListQuery(value: unknown): HqCallListQuery {
  const row = record(value, [], ['filter', 'contactUserId', 'before']);
  const out: HqCallListQuery = {};
  if ('filter' in row) out.filter = oneOf(row.filter, SCHOOL_CALL_FILTERS);
  if ('contactUserId' in row) out.contactUserId = uuid(row.contactUserId);
  if ('before' in row) { const b = record(row.before, ['at', 'id']); out.before = { at: instant(b.at), id: uuid(b.id) }; }
  return out;
}
export function validateUpdateHqCallInput(value: unknown): UpdateHqCallInput {
  const row = record(value, ['callId', 'expectedVersion'], ['outcome', 'note', 'heard']);
  if (!('outcome' in row) && !('note' in row) && !('heard' in row)) invalid();
  const out: UpdateHqCallInput = { callId: uuid(row.callId), expectedVersion: count(row.expectedVersion, 1) };
  if ('outcome' in row) out.outcome = row.outcome === null ? null : oneOf(row.outcome, HQ_CALL_OUTCOMES);
  if ('note' in row) { if (row.note !== null && !schoolCallNoteOk(row.note)) invalid(); out.note = row.note as string | null; }
  if ('heard' in row) { if (row.heard !== true) invalid(); out.heard = true; }
  return out;
}

const CALL_KEYS = ['callId', 'direction', 'status', 'remoteE164', 'contactUserId', 'contactName', 'contactSchools', 'staffName', 'startedAt', 'answeredAt',
  'endedAt', 'durationSeconds', 'voicemail', 'recordingAvailable', 'recordingSeconds', 'heard', 'outcome', 'note', 'doNotCall', 'version'] as const;
export function verifyHqCall(value: unknown): HqCall {
  const row = record(value, CALL_KEYS);
  if (!Array.isArray(row.contactSchools) || row.contactSchools.length > 50) invalid();
  const call: HqCall = {
    callId: uuid(row.callId), direction: oneOf(row.direction, SCHOOL_CALL_DIRECTIONS), status: oneOf(row.status, SCHOOL_CALL_STATUSES),
    remoteE164: row.remoteE164 === null ? null : e164(row.remoteE164), contactUserId: nullableUuid(row.contactUserId),
    contactName: nullableText(row.contactName, 120), contactSchools: row.contactSchools.map(s => text(s, 200)), staffName: nullableText(row.staffName),
    startedAt: instant(row.startedAt), answeredAt: nullableInstant(row.answeredAt), endedAt: nullableInstant(row.endedAt),
    durationSeconds: nullableCount(row.durationSeconds), voicemail: bool(row.voicemail), recordingAvailable: bool(row.recordingAvailable),
    recordingSeconds: nullableCount(row.recordingSeconds), heard: bool(row.heard), outcome: row.outcome === null ? null : oneOf(row.outcome, HQ_CALL_OUTCOMES),
    note: row.note === null ? null : (schoolCallNoteOk(row.note) ? row.note : invalid()), doNotCall: bool(row.doNotCall), version: count(row.version, 1),
  };
  if (call.direction === 'OUT' && (call.voicemail || call.remoteE164 === null)) invalid();
  if (!call.recordingAvailable && call.recordingSeconds !== null) invalid();
  if ((call.heard || call.recordingAvailable) && !call.voicemail) invalid();
  if (call.contactUserId === null && (call.contactName !== null || call.contactSchools.length)) invalid();
  return call;
}
export function verifyHqCallingSettings(value: unknown, allowUnsaved = false): HqCallingSettings {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'version']);
  return {
    callingOn: bool(row.callingOn), voicemailGreeting: row.voicemailGreeting === null ? null : (schoolCallGreetingOk(row.voicemailGreeting) ? row.voicemailGreeting : invalid()),
    version: count(row.version, allowUnsaved ? 0 : 1),
  };
}
export function verifyHqCallingOverview(value: unknown): HqCallingOverview {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'version', 'hqNumber', 'numberReady', 'ringMe', 'canManage', 'unheardVoicemails', 'missedToday', 'staff']);
  const canManage = bool(row.canManage);
  let staff: HqCallStaffMember[] | null = null;
  if (canManage) {
    if (!Array.isArray(row.staff) || row.staff.length > SCHOOL_CALL_LIMITS.staffMax) invalid();
    staff = row.staff.map(item => { const s = record(item, ['principalId', 'name', 'ringMe']); return { principalId: uuid(s.principalId), name: text(s.name), ringMe: bool(s.ringMe) }; });
    if (new Set(staff.map(s => s.principalId)).size !== staff.length) invalid();
  } else if (row.staff !== null) invalid();
  const settings = verifyHqCallingSettings({ callingOn: row.callingOn, voicemailGreeting: row.voicemailGreeting, version: row.version }, true);
  const numberReady = bool(row.numberReady), hqNumber = row.hqNumber === null ? null : e164(row.hqNumber);
  if (numberReady !== (hqNumber !== null)) invalid();
  return { ...settings, hqNumber, numberReady, ringMe: bool(row.ringMe), canManage, unheardVoicemails: count(row.unheardVoicemails), missedToday: count(row.missedToday), staff };
}
export function verifyStartedHqCall(value: unknown, input: StartHqCallInput): StartedHqCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const { connectBy, replayed, ...call } = value as Record<string, unknown>;
  const verified = verifyHqCall(call);
  if (verified.direction !== 'OUT' || verified.remoteE164 !== input.toE164 || (input.contactUserId !== undefined && verified.contactUserId !== input.contactUserId)) invalid();
  return { call: verified, connectBy: instant(connectBy), replayed: bool(replayed) };
}
export function verifyHqCallList(value: unknown): HqCallList {
  const row = record(value, ['calls', 'nextCursor']);
  if (!Array.isArray(row.calls) || row.calls.length > SCHOOL_CALL_LIMITS.page) invalid();
  const calls = row.calls.map(verifyHqCall);
  let nextCursor: { at: string; id: string } | null = null;
  if (row.nextCursor !== null) {
    const c = record(row.nextCursor, ['at', 'id']);
    const last = calls[calls.length - 1];
    nextCursor = { at: instant(c.at), id: uuid(c.id) };
    if (calls.length !== SCHOOL_CALL_LIMITS.page || !last || last.callId !== nextCursor.id || last.startedAt !== nextCursor.at) invalid();
  }
  for (let i = 1; i < calls.length; i += 1) {
    const a = calls[i - 1]!, b = calls[i]!;
    if (a.startedAt < b.startedAt || (a.startedAt === b.startedAt && a.callId <= b.callId)) invalid();
  }
  return { calls, nextCursor };
}
export function verifyHqPhoneToken(value: unknown): HqPhoneToken {
  const row = record(value, ['ready', 'reason', 'identity', 'token', 'expiresAt', 'incoming']);
  const out: HqPhoneToken = {
    ready: bool(row.ready), reason: oneOf(row.reason, ['READY', 'CALLING_OFF', 'PHONE_NOT_SET_UP', 'VOICE_NOT_APPROVED'] as const),
    identity: row.identity === null ? null : (typeof row.identity === 'string' && HQ_CALL_IDENTITY.test(row.identity) ? row.identity : invalid()),
    token: row.token === null ? null : (typeof row.token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.token) && row.token.length <= 4096 ? row.token : invalid()),
    expiresAt: nullableInstant(row.expiresAt), incoming: bool(row.incoming),
  };
  if (out.ready !== (out.reason === 'READY') || out.ready !== (out.token !== null) || out.ready !== (out.identity !== null) || out.ready !== (out.expiresAt !== null)) invalid();
  if (!out.ready && out.incoming) invalid();
  return out;
}
