import {
  SCHOOL_CALL_DO_NOT_CALL_COMMAND, SCHOOL_CALL_RING_COMMAND, SCHOOL_CALL_SETTINGS_COMMAND, SCHOOL_CALL_START_COMMAND, SCHOOL_CALL_TOKEN_COMMAND,
  SCHOOL_CALL_UPDATE_COMMAND,
  validateSchoolCallListQuery, validateSchoolCallRingingInput, validateSchoolDoNotCallInput, validateSetSchoolCallingSettingsInput,
  validateStartSchoolCallInput, validateUpdateSchoolCallInput,
  verifySchoolCall, verifySchoolCallList, verifySchoolCallRinging, verifySchoolCallingOverview, verifySchoolCallingSettings, verifySchoolDoNotCall,
  verifySchoolPhoneToken, verifyStartedSchoolCall,
  type SchoolCall, type SchoolCallList, type SchoolCallListQuery, type SchoolCallRinging, type SchoolCallingOverview, type SchoolCallingSettings,
  type SchoolDoNotCallInput, type SchoolPhoneToken, type SetSchoolCallingSettingsInput, type StartSchoolCallInput, type StartedSchoolCall,
  type UpdateSchoolCallInput,
} from '@hon/contracts';

/**
 * School calling (0556; docs/architecture/SCHOOL_CALLING.md): same-origin browser commands only. The shell's school scope is
 * sent and checked again by the server with communication.call.use (settings: communication.call.manage); nothing here
 * decides permission or reaches Twilio. Starting a call only records it: the number dialled always comes from that stored
 * row, and only the separately approved voice switch lets a call leave HON.
 */
export class CallsAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN', readonly status: number) { super(reason); } }
/** A definite refusal (nothing stored): the code picks the plain message; a retry is a new command. */
export class CallsRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown. */
export class CallsUnknown extends Error {}
export type CallsScope = Readonly<{ organizationId: string; schoolId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codes the calling API returns for a definite refusal. Anything else is treated as unknown. */
export const CALL_REFUSALS = [
  'VALIDATION_FAILED', 'CALLING_OFF', 'CALL_NUMBER_NOT_READY', 'CALL_NUMBER_NOT_ALLOWED', 'CALL_DO_NOT_CALL', 'CALL_PERSON_PHONE_MISMATCH',
  'RECORDING_CONSENT_REQUIRED', 'CALL_RATE_LIMITED', 'CALL_PERSON_NOT_FOUND', 'CALL_NOT_FOUND', 'CALL_RECORDING_NOT_FOUND', 'CALLING_VERSION_CONFLICT', 'CALL_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED', 'CALL_CONFLICT',
] as const;
const REFUSAL = new Set<string>(CALL_REFUSALS);
export function invalid(): never { throw new CallsUnknown('unverified'); }
export function checked<T>(run: () => T): T { try { return run(); } catch { return invalid(); } }

/** One same-origin calling request (school or HQ): JSON only, no redirects, no cache; refusals by known code only. */
export async function callsRequest(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
  } catch { throw new CallsUnknown('network'); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new CallsAccessError('SESSION', 401);
    if (response.status === 403) throw new CallsAccessError('FORBIDDEN', 403);
    if (REFUSAL.has(String(root.code))) throw new CallsRefusal(String(root.code));
    throw new CallsUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function base(scope: CallsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/calls`;
}

export async function loadCalling(scope: CallsScope): Promise<SchoolCallingOverview> {
  const out = await callsRequest(`${base(scope)}/overview`, 'GET');
  return checked(() => verifySchoolCallingOverview(out.data));
}
/** Filters go out as plain query strings; the keyset cursor is the previous page's nextCursor, unchanged. */
export async function loadCalls(scope: CallsScope, filters: SchoolCallListQuery = {}): Promise<SchoolCallList> {
  const query = validateSchoolCallListQuery(filters);
  const params = new URLSearchParams();
  if (query.filter && query.filter !== 'ALL') params.set('filter', query.filter);
  if (query.personId) params.set('personId', query.personId.toLowerCase());
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  const text = params.toString();
  const out = await callsRequest(base(scope) + (text ? `?${text}` : ''), 'GET');
  const list = checked(() => verifySchoolCallList(out.data));
  // The page shows only what was asked for; a list that does not match the filter is not shown at all.
  if (query.personId && list.calls.some(c => c.personId !== query.personId!.toLowerCase())) invalid();
  if (query.filter === 'OUTGOING' && list.calls.some(c => c.direction !== 'OUT')) invalid();
  if (query.filter === 'VOICEMAIL' && list.calls.some(c => !c.voicemail)) invalid();
  return list;
}
export async function saveCallingSettings(scope: CallsScope, input: SetSchoolCallingSettingsInput): Promise<SchoolCallingSettings> {
  const body = validateSetSchoolCallingSettingsInput(input);
  const out = await callsRequest(`${base(scope)}/settings`, 'POST', SCHOOL_CALL_SETTINGS_COMMAND, body);
  const saved = checked(() => verifySchoolCallingSettings(out.data));
  if (saved.callingOn !== body.callingOn || saved.recordingOn !== body.recordingOn || saved.voicemailGreeting !== body.voicemailGreeting) invalid();
  return saved;
}
export async function setRingMe(scope: CallsScope, ringMe: boolean): Promise<SchoolCallRinging> {
  const body = validateSchoolCallRingingInput({ ringMe });
  const out = await callsRequest(`${base(scope)}/ring-me`, 'POST', SCHOOL_CALL_RING_COMMAND, body);
  const saved = checked(() => verifySchoolCallRinging(out.data));
  if (saved.ringMe !== ringMe) invalid();
  return saved;
}
/** Records an outgoing call; the same key replays the same call. The browser phone must connect it before connectBy. */
export async function startCall(scope: CallsScope, input: StartSchoolCallInput, key: string): Promise<StartedSchoolCall> {
  const body = validateStartSchoolCallInput(input);
  const out = await callsRequest(base(scope), 'POST', SCHOOL_CALL_START_COMMAND, body, key);
  return checked(() => verifyStartedSchoolCall(out.data, body));
}
/** The after-call card: outcome chip, note, or a voicemail marked heard. Version-checked; nothing else changes. */
export async function updateCall(scope: CallsScope, input: UpdateSchoolCallInput): Promise<SchoolCall> {
  const { callId, ...body } = validateUpdateSchoolCallInput(input);
  const out = await callsRequest(`${base(scope)}/${callId.toLowerCase()}`, 'POST', SCHOOL_CALL_UPDATE_COMMAND, body);
  const saved = checked(() => verifySchoolCall(out.data));
  if (saved.callId !== callId.toLowerCase() || saved.version !== body.expectedVersion + 1) invalid();
  return saved;
}
export async function setDoNotCall(scope: CallsScope, input: SchoolDoNotCallInput): Promise<SchoolDoNotCallInput> {
  const body = validateSchoolDoNotCallInput(input);
  const out = await callsRequest(`${base(scope)}/do-not-call`, 'POST', SCHOOL_CALL_DO_NOT_CALL_COMMAND, body);
  return checked(() => verifySchoolDoNotCall(out.data, body));
}
/** A one-hour browser phone token, or the reason there is none. Never stored: kept only in memory by the phone. */
export async function loadPhoneToken(scope: CallsScope): Promise<SchoolPhoneToken> {
  const out = await callsRequest(`${base(scope)}/phone-token`, 'POST', SCHOOL_CALL_TOKEN_COMMAND, {});
  return checked(() => verifySchoolPhoneToken(out.data));
}

/** The recording or voicemail stream for one call: a same-origin GET the server authorizes and audits on every play. */
export function recordingUrl(scope: CallsScope, callId: string): string {
  if (!UUID.test(callId)) invalid();
  return `${base(scope)}/${callId.toLowerCase()}/recording`;
}
/** Keep the idempotency key only while the same call is retried; any change starts a new call. */
export function callAttempt(fingerprint: string, previous: { fingerprint: string; key: string } | null, newKey: () => string): { fingerprint: string; key: string } {
  return previous && previous.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() };
}
/** How a stored +1 number reads on screen: (512) 555-0101. Anything else is shown as stored. */
export function formatCallNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
export function formatCallDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
