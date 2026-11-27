/**
 * Calling on the school texting number (0556 CL1, 0693 CL2; docs/architecture/SCHOOL_CALLING.md). Staff with
 * communication.call.use make and take browser calls on the school's own number, see the call log and voicemail, and
 * set their own Ring me. communication.call.manage (the school owner) switches calling on, sets the voicemail greeting
 * and, after accepting the consent statement, call recording. Nothing here reaches Twilio: the API proves every call
 * through the database and only the separately approved voice switch lets a call leave HON.
 */

export const SCHOOL_CALL_DIRECTIONS = ['IN', 'OUT'] as const;
export type SchoolCallDirection = (typeof SCHOOL_CALL_DIRECTIONS)[number];
export const SCHOOL_CALL_STATUSES = [
  'INITIATED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED', 'MISSED', 'VOICEMAIL', 'EXPIRED',
] as const;
export type SchoolCallStatus = (typeof SCHOOL_CALL_STATUSES)[number];
export const SCHOOL_CALL_OUTCOMES = ['TRIAL_BOOKED', 'CALL_BACK', 'INTERESTED', 'NOT_INTERESTED', 'LEFT_VOICEMAIL', 'WRONG_NUMBER', 'OTHER'] as const;
export type SchoolCallOutcome = (typeof SCHOOL_CALL_OUTCOMES)[number];
export const SCHOOL_CALL_FILTERS = ['ALL', 'MISSED', 'VOICEMAIL', 'OUTGOING'] as const;
export type SchoolCallFilter = (typeof SCHOOL_CALL_FILTERS)[number];
export const SCHOOL_CALL_LIMITS = { page: 50, noteMax: 1000, greetingMax: 300, staffMax: 500, connectSeconds: 120, perHour: 60 } as const;

/** The statement the owner accepts before recording is switched on (shown on the settings card, stored as accepted). */
export const SCHOOL_CALL_RECORDING_CONSENT =
  'I understand that some states require everyone on a call to agree to recording. HON will play "This call may be recorded" '
  + 'at the start of every recorded call, and recordings are deleted after 90 days. I am responsible for following the laws that apply to my school.';

/** Same-origin browser command names (the X-HON-Human-Command header), one per call. */
export const SCHOOL_CALL_READ_COMMAND = 'communication.call.read';
export const SCHOOL_CALL_SETTINGS_COMMAND = 'communication.call.settings';
export const SCHOOL_CALL_RING_COMMAND = 'communication.call.ring';
export const SCHOOL_CALL_START_COMMAND = 'communication.call.start';
export const SCHOOL_CALL_UPDATE_COMMAND = 'communication.call.update';
export const SCHOOL_CALL_DO_NOT_CALL_COMMAND = 'communication.call.do_not_call';
export const SCHOOL_CALL_TOKEN_COMMAND = 'communication.call.token';

export interface SchoolCall {
  callId: string; direction: SchoolCallDirection; status: SchoolCallStatus; /** null: the caller withheld their number (incoming only). */ remoteE164: string | null; personId: string | null; contactName: string | null;
  staffName: string | null; startedAt: string; answeredAt: string | null; endedAt: string | null; durationSeconds: number | null;
  recorded: boolean; voicemail: boolean; recordingAvailable: boolean; recordingSeconds: number | null; heard: boolean;
  outcome: SchoolCallOutcome | null; note: string | null; doNotCall: boolean; version: number;
}
export interface SchoolCallStaffMember { principalId: string; name: string; ringMe: boolean }
export interface SchoolCallingOverview {
  callingOn: boolean; voicemailGreeting: string | null; recordingOn: boolean; recordingConsentAt: string | null; version: number;
  schoolNumber: string | null; numberReady: boolean; forwardingPhoneSet: boolean; missedCallTextBack: boolean; ringMe: boolean;
  canManage: boolean; unheardVoicemails: number; missedToday: number; staff: SchoolCallStaffMember[] | null;
}
export interface SchoolCallingSettings { callingOn: boolean; voicemailGreeting: string | null; recordingOn: boolean; recordingConsentAt: string | null; version: number }
export interface SetSchoolCallingSettingsInput {
  callingOn: boolean; voicemailGreeting: string | null; recordingOn: boolean; recordingConsentAccepted: boolean; expectedVersion: number;
}
export interface SchoolCallRinging { ringMe: boolean; version: number }
export interface StartSchoolCallInput { toE164: string; personId?: string }
export interface StartedSchoolCall { call: SchoolCall; connectBy: string; replayed: boolean }
export interface SchoolCallListQuery { filter?: SchoolCallFilter; personId?: string; before?: { at: string; id: string } }
export interface SchoolCallList { calls: SchoolCall[]; nextCursor: { at: string; id: string } | null }
export interface UpdateSchoolCallInput { callId: string; expectedVersion: number; outcome?: SchoolCallOutcome | null; note?: string | null; heard?: true }
export interface SchoolDoNotCallInput { phoneE164: string; doNotCall: boolean }
/** What the browser phone needs: a short-lived Twilio Voice token for this staff member at this school, or why not. */
export interface SchoolPhoneToken {
  ready: boolean; reason: 'READY' | 'CALLING_OFF' | 'NUMBER_NOT_READY' | 'PHONE_NOT_SET_UP' | 'VOICE_NOT_APPROVED';
  identity: string | null; token: string | null; expiresAt: string | null; incoming: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const IDENTITY = /^u[0-9a-f]{32}$/;
const NOTE_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PREMIUM_AND_OFFSHORE = new Set([
  '900', '456', '500', '521', '522', '523', '524', '525', '526', '527', '528', '529', '530', '531', '532', '533', '544', '566', '577', '588',
  '600', '622', '700', '710',
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664', '670', '671', '684', '721', '758', '767', '784',
  '787', '809', '829', '849', '868', '869', '876', '939',
]);

function invalid(): never { throw new Error('Invalid school call data.'); }
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
function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function text(value: unknown, max = 300): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function nullableText(value: unknown, max = 300): string | null { return value === null ? null : text(value, max); }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function e164(value: unknown): string { if (typeof value !== 'string' || !E164.test(value)) invalid(); return value; }

/**
 * True for a number HON will dial: +1 US states and Canada only, a real area code and exchange, never premium (900,
 * 976), personal, carrier, government, reserved (N9X) or an N11 code, and never a NANP Caribbean or territory code
 * (billed as international). The database applies the same rule; this lets the dialer explain it before asking.
 */
export function schoolCallNumberOk(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value)) return false;
  const area = value.slice(2, 5), exchange = value.slice(5, 8);
  return !PREMIUM_AND_OFFSHORE.has(area) && area[1] !== '9' && exchange !== '976' && area.slice(1) !== '11' && exchange.slice(1) !== '11';
}
/** A US/Canada number typed in any common way ("(512) 555-0101", "512.555.0101", "+1 512 555 0101") as +1XXXXXXXXXX, or null. */
export function normalizeSchoolCallNumber(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^[\d\s().+-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10 || (value.trim().startsWith('+') && !(digits.length === 11 && digits.startsWith('1')))) return null;
  return `+1${ten}`;
}
export function schoolCallGreetingOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_CALL_LIMITS.greetingMax && value.trim() === value
    && !/[\u0000-\u001f\u007f<>]/.test(value);
}
export function schoolCallNoteOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_CALL_LIMITS.noteMax && value.trim() !== ''
    && !NOTE_CONTROL.test(value) && !value.includes('\u0000');
}

export function validateSetSchoolCallingSettingsInput(value: unknown): SetSchoolCallingSettingsInput {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'recordingOn', 'recordingConsentAccepted', 'expectedVersion']);
  if (row.voicemailGreeting !== null && !schoolCallGreetingOk(row.voicemailGreeting)) invalid();
  return {
    callingOn: bool(row.callingOn), voicemailGreeting: row.voicemailGreeting as string | null, recordingOn: bool(row.recordingOn),
    recordingConsentAccepted: bool(row.recordingConsentAccepted), expectedVersion: count(row.expectedVersion, 0),
  };
}
export function validateSchoolCallRingingInput(value: unknown): { ringMe: boolean } {
  const row = record(value, ['ringMe']);
  return { ringMe: bool(row.ringMe) };
}
export function validateStartSchoolCallInput(value: unknown): StartSchoolCallInput {
  const row = record(value, ['toE164'], ['personId']);
  if (!schoolCallNumberOk(row.toE164)) invalid();
  return { toE164: row.toE164, ...('personId' in row ? { personId: uuid(row.personId) } : {}) };
}
export function validateSchoolCallListQuery(value: unknown): SchoolCallListQuery {
  const row = record(value, [], ['filter', 'personId', 'before']);
  const out: SchoolCallListQuery = {};
  if ('filter' in row) out.filter = oneOf(row.filter, SCHOOL_CALL_FILTERS);
  if ('personId' in row) out.personId = uuid(row.personId);
  if ('before' in row) { const b = record(row.before, ['at', 'id']); out.before = { at: instant(b.at), id: uuid(b.id) }; }
  return out;
}
export function validateUpdateSchoolCallInput(value: unknown): UpdateSchoolCallInput {
  const row = record(value, ['callId', 'expectedVersion'], ['outcome', 'note', 'heard']);
  if (!('outcome' in row) && !('note' in row) && !('heard' in row)) invalid();
  const out: UpdateSchoolCallInput = { callId: uuid(row.callId), expectedVersion: count(row.expectedVersion, 1) };
  if ('outcome' in row) out.outcome = row.outcome === null ? null : oneOf(row.outcome, SCHOOL_CALL_OUTCOMES);
  if ('note' in row) { if (row.note !== null && !schoolCallNoteOk(row.note)) invalid(); out.note = row.note as string | null; }
  if ('heard' in row) { if (row.heard !== true) invalid(); out.heard = true; }
  return out;
}
export function validateSchoolDoNotCallInput(value: unknown): SchoolDoNotCallInput {
  const row = record(value, ['phoneE164', 'doNotCall']);
  return { phoneE164: e164(row.phoneE164), doNotCall: bool(row.doNotCall) };
}

const CALL_KEYS = ['callId', 'direction', 'status', 'remoteE164', 'personId', 'contactName', 'staffName', 'startedAt', 'answeredAt', 'endedAt',
  'durationSeconds', 'recorded', 'voicemail', 'recordingAvailable', 'recordingSeconds', 'heard', 'outcome', 'note', 'doNotCall', 'version'] as const;
export function verifySchoolCall(value: unknown): SchoolCall {
  const row = record(value, CALL_KEYS);
  const call: SchoolCall = {
    callId: uuid(row.callId), direction: oneOf(row.direction, SCHOOL_CALL_DIRECTIONS), status: oneOf(row.status, SCHOOL_CALL_STATUSES),
    remoteE164: row.remoteE164 === null ? null : e164(row.remoteE164), personId: nullableUuid(row.personId), contactName: nullableText(row.contactName, 202),
    staffName: nullableText(row.staffName, 200), startedAt: instant(row.startedAt), answeredAt: nullableInstant(row.answeredAt),
    endedAt: nullableInstant(row.endedAt), durationSeconds: nullableCount(row.durationSeconds), recorded: bool(row.recorded),
    voicemail: bool(row.voicemail), recordingAvailable: bool(row.recordingAvailable), recordingSeconds: nullableCount(row.recordingSeconds),
    heard: bool(row.heard), outcome: row.outcome === null ? null : oneOf(row.outcome, SCHOOL_CALL_OUTCOMES),
    note: row.note === null ? null : (schoolCallNoteOk(row.note) ? row.note : invalid()), doNotCall: bool(row.doNotCall), version: count(row.version, 1),
  };
  if (call.direction === 'OUT' && (call.voicemail || call.remoteE164 === null)) invalid();
  if (!call.recordingAvailable && call.recordingSeconds !== null) invalid();
  if (call.heard && !call.voicemail) invalid();
  return call;
}
export function verifySchoolCallingOverview(value: unknown): SchoolCallingOverview {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'recordingOn', 'recordingConsentAt', 'version', 'schoolNumber', 'numberReady',
    'forwardingPhoneSet', 'missedCallTextBack', 'ringMe', 'canManage', 'unheardVoicemails', 'missedToday', 'staff']);
  const canManage = bool(row.canManage);
  let staff: SchoolCallStaffMember[] | null = null;
  if (canManage) {
    if (!Array.isArray(row.staff) || row.staff.length > SCHOOL_CALL_LIMITS.staffMax) invalid();
    staff = row.staff.map(item => { const s = record(item, ['principalId', 'name', 'ringMe']); return { principalId: uuid(s.principalId), name: text(s.name, 200), ringMe: bool(s.ringMe) }; });
    if (new Set(staff.map(s => s.principalId)).size !== staff.length) invalid();
  } else if (row.staff !== null) invalid();
  const settings = verifySchoolCallingSettings({ callingOn: row.callingOn, voicemailGreeting: row.voicemailGreeting, recordingOn: row.recordingOn,
    recordingConsentAt: row.recordingConsentAt, version: row.version }, true);
  const numberReady = bool(row.numberReady), schoolNumber = row.schoolNumber === null ? null : e164(row.schoolNumber);
  if (numberReady !== (schoolNumber !== null)) invalid();
  return { ...settings, schoolNumber, numberReady, forwardingPhoneSet: bool(row.forwardingPhoneSet), missedCallTextBack: bool(row.missedCallTextBack),
    ringMe: bool(row.ringMe), canManage, unheardVoicemails: count(row.unheardVoicemails), missedToday: count(row.missedToday), staff };
}
export function verifySchoolCallingSettings(value: unknown, allowUnsaved = false): SchoolCallingSettings {
  const row = record(value, ['callingOn', 'voicemailGreeting', 'recordingOn', 'recordingConsentAt', 'version']);
  const out: SchoolCallingSettings = {
    callingOn: bool(row.callingOn), voicemailGreeting: row.voicemailGreeting === null ? null : (schoolCallGreetingOk(row.voicemailGreeting) ? row.voicemailGreeting : invalid()),
    recordingOn: bool(row.recordingOn), recordingConsentAt: nullableInstant(row.recordingConsentAt), version: count(row.version, allowUnsaved ? 0 : 1),
  };
  if (out.recordingOn !== (out.recordingConsentAt !== null)) invalid();
  return out;
}
export function verifySchoolCallRinging(value: unknown): SchoolCallRinging {
  const row = record(value, ['ringMe', 'version']);
  return { ringMe: bool(row.ringMe), version: count(row.version, 1) };
}
export function verifyStartedSchoolCall(value: unknown, input: StartSchoolCallInput): StartedSchoolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const { connectBy, replayed, ...call } = value as Record<string, unknown>;
  const verified = verifySchoolCall(call);
  if (verified.direction !== 'OUT' || verified.remoteE164 !== input.toE164 || (input.personId !== undefined && verified.personId !== input.personId)) invalid();
  return { call: verified, connectBy: instant(connectBy), replayed: bool(replayed) };
}
export function verifySchoolCallList(value: unknown): SchoolCallList {
  const row = record(value, ['calls', 'nextCursor']);
  if (!Array.isArray(row.calls) || row.calls.length > SCHOOL_CALL_LIMITS.page) invalid();
  const calls = row.calls.map(verifySchoolCall);
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
export function verifySchoolDoNotCall(value: unknown, input: SchoolDoNotCallInput): SchoolDoNotCallInput {
  const row = record(value, ['phoneE164', 'doNotCall']);
  if (row.phoneE164 !== input.phoneE164 || row.doNotCall !== input.doNotCall) invalid();
  return input;
}
export function verifySchoolPhoneToken(value: unknown): SchoolPhoneToken {
  const row = record(value, ['ready', 'reason', 'identity', 'token', 'expiresAt', 'incoming']);
  const out: SchoolPhoneToken = {
    ready: bool(row.ready), reason: oneOf(row.reason, ['READY', 'CALLING_OFF', 'NUMBER_NOT_READY', 'PHONE_NOT_SET_UP', 'VOICE_NOT_APPROVED'] as const),
    identity: row.identity === null ? null : (typeof row.identity === 'string' && IDENTITY.test(row.identity) ? row.identity : invalid()),
    token: row.token === null ? null : (typeof row.token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.token) && row.token.length <= 4096 ? row.token : invalid()),
    expiresAt: nullableInstant(row.expiresAt), incoming: bool(row.incoming),
  };
  if (out.ready !== (out.reason === 'READY') || out.ready !== (out.token !== null) || out.ready !== (out.identity !== null) || out.ready !== (out.expiresAt !== null)) invalid();
  if (!out.ready && out.incoming) invalid();
  return out;
}
