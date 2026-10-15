import { validateVoiceInput, validateVoiceSession, VOICE_UUID, type VoiceOperation, type VoiceReceipt, type VoiceSession } from '@hon/contracts';
export class VoiceAccessError extends Error {}
export class VoiceConflictError extends Error {}
function invalid(): never { throw new Error('Unverified voice evidence. No connection or execution is assumed.'); }
async function request(school: string, path: string, body?: unknown, key?: string): Promise<unknown> {
  if (!VOICE_UUID.test(school)) invalid();
  const result = await fetch(`/api/v1/staff/voice/${school}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? { 'X-HON-Human-Command': 'voice-session' } : { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'voice-session', 'Idempotency-Key': key! },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!result.ok) {
    if ([401,403].includes(result.status)) throw new VoiceAccessError('Current Complete human school access is unavailable. Private context has been cleared.');
    if ([400,409].includes(result.status)) throw new VoiceConflictError('Input, version, expiry or retry conflict. Reload exact evidence; no connection or command is assumed.');
    throw new Error('Voice session service unavailable. Outcome unknown; retry only the retained exact request. No voice connection or execution is assumed.');
  }
  const envelope: unknown = await result.json();
  if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope,'data')) invalid();
  return (envelope as { data: unknown }).data;
}
export async function readVoiceSession(school: string, id: string): Promise<VoiceSession> {
  if (!VOICE_UUID.test(id)) invalid();
  const result = await request(school,`/${id}`); validateVoiceSession(result);
  if (result.schoolId !== school || result.id !== id) invalid(); return result;
}
export async function changeVoiceSession(school: string, operation: VoiceOperation, id: string | null, input: unknown, key: string): Promise<VoiceReceipt> {
  validateVoiceInput(operation,input);
  if (!VOICE_UUID.test(key) || (operation === 'create') !== (id === null) || (id !== null && !VOICE_UUID.test(id))) invalid();
  const value = await request(school,id === null ? '' : `/${id}/${operation}`,input,key);
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'receiptVersion,replayed,session') invalid();
  const result = value as VoiceReceipt; validateVoiceSession(result.session);
  if (result.session.schoolId !== school || (id !== null && result.session.id !== id) || typeof result.replayed !== 'boolean' || !Number.isInteger(result.receiptVersion) || result.receiptVersion < 1 || result.receiptVersion > result.session.version) invalid();
  return result;
}
