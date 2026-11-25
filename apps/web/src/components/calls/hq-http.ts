import {
  HQ_CALL_COMMANDS, validateHqCallListQuery, validateSchoolCallRingingInput, validateSchoolDoNotCallInput, validateSetHqCallingSettingsInput,
  validateStartHqCallInput, validateUpdateHqCallInput, verifyHqCall, verifyHqCallList, verifyHqCallingOverview, verifyHqCallingSettings, verifyHqPhoneToken,
  verifySchoolCallRinging, verifySchoolDoNotCall, verifyStartedHqCall,
  type HqCall, type HqCallList, type HqCallListQuery, type HqCallingOverview, type HqCallingSettings, type HqPhoneToken, type SchoolCallRinging,
  type SchoolDoNotCallInput, type SetHqCallingSettingsInput, type StartHqCallInput, type StartedHqCall, type UpdateHqCallInput,
} from '@hon/contracts';
import { callsRequest, checked, invalid } from './http';

/**
 * HQ calling on the HQ texting number (0694). Same-origin HQ commands only; the server re-proves the HQ person on every
 * read and command (settings: HQ owner). Starting a call only records it; only the separately approved voice switch lets
 * a call leave HON. Errors are the same CallsAccessError / CallsRefusal / CallsUnknown as school calling.
 */
const BASE = '/api/v1/hq/calls';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadHqCalling(): Promise<HqCallingOverview> {
  const out = await callsRequest(`${BASE}/overview`, 'GET');
  return checked(() => verifyHqCallingOverview(out.data));
}
export async function loadHqCalls(filters: HqCallListQuery = {}): Promise<HqCallList> {
  const query = validateHqCallListQuery(filters);
  const params = new URLSearchParams();
  if (query.filter && query.filter !== 'ALL') params.set('filter', query.filter);
  if (query.contactUserId) params.set('contactUserId', query.contactUserId.toLowerCase());
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  const text = params.toString();
  const out = await callsRequest(BASE + (text ? `?${text}` : ''), 'GET');
  const list = checked(() => verifyHqCallList(out.data));
  if (query.contactUserId && list.calls.some(c => c.contactUserId !== query.contactUserId!.toLowerCase())) invalid();
  if (query.filter === 'OUTGOING' && list.calls.some(c => c.direction !== 'OUT')) invalid();
  if (query.filter === 'VOICEMAIL' && list.calls.some(c => !c.voicemail)) invalid();
  return list;
}
export async function saveHqCallingSettings(input: SetHqCallingSettingsInput): Promise<HqCallingSettings> {
  const body = validateSetHqCallingSettingsInput(input);
  const out = await callsRequest(`${BASE}/settings`, 'POST', HQ_CALL_COMMANDS.settings, body);
  const saved = checked(() => verifyHqCallingSettings(out.data));
  if (saved.callingOn !== body.callingOn || saved.voicemailGreeting !== body.voicemailGreeting || saved.version !== body.expectedVersion + 1) invalid();
  return saved;
}
export async function setHqRingMe(ringMe: boolean): Promise<SchoolCallRinging> {
  const body = validateSchoolCallRingingInput({ ringMe });
  const out = await callsRequest(`${BASE}/ring-me`, 'POST', HQ_CALL_COMMANDS.ring, body);
  const saved = checked(() => verifySchoolCallRinging(out.data));
  if (saved.ringMe !== ringMe) invalid();
  return saved;
}
/** Records an outgoing HQ call; the same key (a uuid) replays the same call. */
export async function startHqCall(input: StartHqCallInput, key: string): Promise<StartedHqCall> {
  const body = validateStartHqCallInput(input);
  if (!UUID.test(key)) invalid();
  const out = await callsRequest(BASE, 'POST', HQ_CALL_COMMANDS.start, body, key.toLowerCase());
  return checked(() => verifyStartedHqCall(out.data, body));
}
export async function updateHqCall(input: UpdateHqCallInput): Promise<HqCall> {
  const { callId, ...body } = validateUpdateHqCallInput(input);
  const out = await callsRequest(`${BASE}/${callId.toLowerCase()}`, 'POST', HQ_CALL_COMMANDS.update, body);
  const saved = checked(() => verifyHqCall(out.data));
  if (saved.callId !== callId.toLowerCase() || saved.version !== body.expectedVersion + 1) invalid();
  return saved;
}
export async function setHqDoNotCall(input: SchoolDoNotCallInput): Promise<SchoolDoNotCallInput> {
  const body = validateSchoolDoNotCallInput(input);
  const out = await callsRequest(`${BASE}/do-not-call`, 'POST', HQ_CALL_COMMANDS.doNotCall, body);
  return checked(() => verifySchoolDoNotCall(out.data, body));
}
export async function loadHqPhoneToken(): Promise<HqPhoneToken> {
  const out = await callsRequest(`${BASE}/phone-token`, 'POST', HQ_CALL_COMMANDS.token, {});
  return checked(() => verifyHqPhoneToken(out.data));
}
/** A voicemail stream for one HQ call: a same-origin GET the server authorizes and audits on every play. */
export function hqRecordingUrl(callId: string): string {
  if (!UUID.test(callId)) invalid();
  return `${BASE}/${callId.toLowerCase()}/recording`;
}
