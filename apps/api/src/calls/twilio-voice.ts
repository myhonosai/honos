import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * CL3b (0556/0590, docs/architecture/SCHOOL_CALLING.md §4): browser calling through Twilio Voice on the school's own
 * subaccount. This module holds the pure pieces: the fixed webhook paths, the sealed voice API key, the browser phone
 * token, and the TwiML HON answers with. Nothing here talks to Twilio; the voice switch HON_VOICE_CALLS_APPROVED (owner
 * approval, unset by default) decides whether any call may leave HON at all.
 */
const WEBHOOKS = '/v1/communications/webhooks/twilio';
export const TWILIO_CLIENT_VOICE_PATH = `${WEBHOOKS}/client-voice`;
export const TWILIO_CLIENT_DIAL_RESULT_PATH = `${WEBHOOKS}/client-dial-result`;
export const TWILIO_INCOMING_DIAL_RESULT_PATH = `${WEBHOOKS}/incoming-dial-result`;
export const TWILIO_CALL_ANSWERED_PATH = `${WEBHOOKS}/call-answered`;
export const TWILIO_RECORDING_STATUS_PATH = `${WEBHOOKS}/recording-status`;
export const TWILIO_VOICEMAIL_STATUS_PATH = `${WEBHOOKS}/voicemail-status`;
export const TWILIO_VOICEMAIL_DONE_PATH = `${WEBHOOKS}/voicemail-done`;
export const CALL_LANGUAGES = ['en', 'es', 'ko'] as const;
export type CallLanguage = (typeof CALL_LANGUAGES)[number];
export const TWILIO_RECORDING_NOTICE_PATHS: Readonly<Record<CallLanguage, string>> = {
  en: `${WEBHOOKS}/recording-notice-en`, es: `${WEBHOOKS}/recording-notice-es`, ko: `${WEBHOOKS}/recording-notice-ko`,
};
export const SCHOOL_CALL_WEBHOOK_PATHS: readonly string[] = [TWILIO_CLIENT_VOICE_PATH, TWILIO_CLIENT_DIAL_RESULT_PATH, TWILIO_INCOMING_DIAL_RESULT_PATH,
  TWILIO_CALL_ANSWERED_PATH, TWILIO_RECORDING_STATUS_PATH, TWILIO_VOICEMAIL_STATUS_PATH, TWILIO_VOICEMAIL_DONE_PATH, ...Object.values(TWILIO_RECORDING_NOTICE_PATHS)];
/**
 * CL5 (0591): HQ calling on the HQ number, on HON's parent account only. `voice` is the HQ number's Voice URL; the HQ
 * TwiML App's Voice URL is `clientVoice`. HQ calls are never recorded, so there is no recording or notice path.
 */
export const HQ_CALL_PATHS = {
  clientVoice: `${WEBHOOKS}/hq/client-voice`, clientDialResult: `${WEBHOOKS}/hq/client-dial-result`, callAnswered: `${WEBHOOKS}/hq/call-answered`,
  voice: `${WEBHOOKS}/hq/voice`, incomingDialResult: `${WEBHOOKS}/hq/incoming-dial-result`, voicemailStatus: `${WEBHOOKS}/hq/voicemail-status`,
  voicemailDone: `${WEBHOOKS}/hq/voicemail-done`,
} as const;
export const HQ_CALL_WEBHOOK_PATHS: readonly string[] = Object.values(HQ_CALL_PATHS);
/** The sealed HQ voice key's binding id (the HQ calling integration principal; never a school id). */
export const HQ_VOICE_BINDING_ID = '00000000-0000-4000-8000-00000000c562';

export const PHONE_TOKEN_SECONDS = 3600;
export const INCOMING_RING_SECONDS = 20;
export const VOICEMAIL_MAX_SECONDS = 120;
/** Longest outgoing or incoming call HON connects (4 hours), so a stuck call cannot run up minutes for ever. */
export const CALL_TIME_LIMIT_SECONDS = 14_400;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const APP_SID = /^AP[0-9a-f]{32}$/;
const KEY_SID = /^SK[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;
/** A school staff ('u') or HQ ('h') browser phone identity. */
const IDENTITY = /^[uh][0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const KEY_ID = /^[a-z0-9-]{1,40}$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

/** Owner approval for paid calling. Anything but exactly "true" keeps every call inside HON. */
export function voiceCallsApproved(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HON_VOICE_CALLS_APPROVED === 'true';
}

export interface VoiceKeyBinding { schoolId: string; accountSid: string; apiKeySid: string }
function refuse(): never { throw new Error('TWILIO_VOICE_VAULT_REFUSED'); }
function bindingOk(b: VoiceKeyBinding): boolean {
  return UUID.test(b.schoolId.toLowerCase()) && ACCOUNT_SID.test(b.accountSid) && KEY_SID.test(b.apiKeySid);
}
function aad(b: VoiceKeyBinding, keyId: string): Buffer {
  return Buffer.from(`hon-twilio-voice-key:v1:${keyId}:${b.schoolId.toLowerCase()}:${b.accountSid}:${b.apiKeySid}`, 'utf8');
}

/**
 * The school voice API key secret, sealed with AES-256-GCM. Key id, school, subaccount and API key SID are
 * authenticated, so a secret copied to another school's row, account or key never opens.
 */
export class TwilioVoiceKeyVault {
  constructor(private readonly key: Buffer, readonly keyId: string) {
    if (key.length !== 32 || !KEY_ID.test(keyId)) refuse();
  }
  seal(binding: VoiceKeyBinding, secret: string): string {
    if (!bindingOk(binding) || typeof secret !== 'string' || !SECRET.test(secret)) refuse();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(binding, this.keyId));
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }
  open(binding: VoiceKeyBinding, keyId: string, sealed: string): string {
    const parts = typeof sealed === 'string' && sealed.length <= 1024 ? SEALED.exec(sealed) : null;
    if (keyId !== this.keyId || !parts || !bindingOk(binding)) refuse();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1]!, 'base64url'));
      decipher.setAAD(aad(binding, keyId));
      decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
      const secret = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
      if (!SECRET.test(secret)) refuse();
      return secret;
    } catch { return refuse(); }
  }
}

/** Same key as the school payment and subaccount vaults (HON_SCHOOL_PAY_VAULT_KEY), under its own authenticated label. */
export function twilioVoiceKeyVaultFromEnvironment(env: NodeJS.ProcessEnv = process.env): TwilioVoiceKeyVault | null {
  const encoded = env.HON_SCHOOL_PAY_VAULT_KEY ?? '';
  const keyId = env.HON_SCHOOL_PAY_VAULT_KEY_ID ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || !KEY_ID.test(keyId)) return null;
  return new TwilioVoiceKeyVault(Buffer.from(encoded, 'base64'), keyId);
}

export interface PhoneTokenInput {
  accountSid: string; apiKeySid: string; apiKeySecret: string; twimlAppSid: string; identity: string; incoming: boolean; nowSeconds: number;
}

/**
 * A Twilio Voice access token (HS256 JWT signed with the school's own API key secret) for one staff identity: it may
 * place calls only through the school's TwiML App (whose Voice URL is HON's signed client-voice webhook) and may
 * receive calls only when the staff member has Ring me on. It never carries a number, school or HON permission.
 */
export function mintPhoneToken(input: PhoneTokenInput): { token: string; expiresAt: string } {
  if (!ACCOUNT_SID.test(input.accountSid) || !KEY_SID.test(input.apiKeySid) || !SECRET.test(input.apiKeySecret) || !APP_SID.test(input.twimlAppSid)
    || !IDENTITY.test(input.identity) || typeof input.incoming !== 'boolean' || !Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 1) {
    throw new Error('HON phone token input is invalid.');
  }
  const exp = input.nowSeconds + PHONE_TOKEN_SECONDS;
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${input.apiKeySid}-${input.nowSeconds}`, iss: input.apiKeySid, sub: input.accountSid, iat: input.nowSeconds, nbf: input.nowSeconds, exp,
    grants: { identity: input.identity, voice: { ...(input.incoming ? { incoming: { allow: true } } : {}), outgoing: { application_sid: input.twimlAppSid } } },
  };
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part(header)}.${part(payload)}`;
  const signature = createHmac('sha256', input.apiKeySecret).update(unsigned).digest('base64url');
  return { token: `${unsigned}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function url(base: string, path: string): string {
  const parsed = new URL(base);
  return xml(`${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${path}`);
}
function language(value: string | null | undefined): CallLanguage {
  return (CALL_LANGUAGES as readonly string[]).includes(value ?? '') ? value as CallLanguage : 'en';
}
const SAY_VOICE: Readonly<Record<CallLanguage, string>> = { en: 'en-US', es: 'es-US', ko: 'ko-KR' };
const NOTICE: Readonly<Record<CallLanguage, string>> = {
  en: 'This call may be recorded.', es: 'Esta llamada puede ser grabada.', ko: '이 통화는 녹음될 수 있습니다.',
};
const DEFAULT_GREETING: Readonly<Record<CallLanguage, (school: string) => string>> = {
  en: (school) => `Thanks for calling ${school}. We can't take your call right now. Please leave a message after the tone.`,
  es: (school) => `Gracias por llamar a ${school}. No podemos atender su llamada ahora. Deje un mensaje después del tono.`,
  ko: (school) => `${school}에 전화해 주셔서 감사합니다. 지금은 전화를 받을 수 없습니다. 신호음 후에 메시지를 남겨 주세요.`,
};
const UNAVAILABLE: Readonly<Record<CallLanguage, string>> = {
  en: 'This call cannot be connected.', es: 'No se puede conectar esta llamada.', ko: '이 통화는 연결할 수 없습니다.',
};
function say(text: string, lang: CallLanguage): string {
  return `<Say language="${SAY_VOICE[lang]}">${xml(text)}</Say>`;
}
function schoolLabel(name: string | null | undefined): string {
  return (name ?? '').replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'our school';
}

export const HANGUP_TWIML = `${XML_HEAD}<Response><Hangup/></Response>`;
export const REJECT_CALL_TWIML = `${XML_HEAD}<Response><Reject/></Response>`;

/** A refused browser call: a short spoken reason, then hang up (a browser leg cannot be rejected). */
export function refusedCallTwiml(lang: string | null): string {
  const l = language(lang);
  return `${XML_HEAD}<Response>${say(UNAVAILABLE[l], l)}<Hangup/></Response>`;
}

/** What the called person hears before a recorded call connects (Twilio plays it to them on answer). */
export function recordingNoticeTwiml(lang: CallLanguage): string {
  return `${XML_HEAD}<Response>${say(NOTICE[lang], lang)}</Response>`;
}

export interface CallLegPaths { dialResult: string; answered: string }
export interface OutgoingDial { toE164: string; callerIdE164: string; recorded: boolean; language: string | null; publicBase: string; paths?: CallLegPaths }
/**
 * The browser's outgoing call: dial the number stored on the call row from the school's own number. The result and
 * the answer time come back to HON's fixed signed paths; a recorded call tells the callee first.
 */
export function outgoingDialTwiml(dial: OutgoingDial): string {
  if (!E164.test(dial.toE164) || !E164.test(dial.callerIdE164)) throw new Error('HON outgoing dial is invalid.');
  const lang = language(dial.language), base = dial.publicBase;
  const record = dial.recorded
    ? ` record="record-from-answer-dual" recordingStatusCallback="${url(base, TWILIO_RECORDING_STATUS_PATH)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`
    : '';
  const notice = dial.recorded ? ` url="${url(base, TWILIO_RECORDING_NOTICE_PATHS[lang])}" method="POST"` : '';
  return `${XML_HEAD}<Response><Dial callerId="${dial.callerIdE164}" answerOnBridge="true" timeLimit="${CALL_TIME_LIMIT_SECONDS}" `
    + `action="${url(base, dial.paths?.dialResult ?? TWILIO_CLIENT_DIAL_RESULT_PATH)}" method="POST"${record}>`
    + `<Number statusCallbackEvent="answered" statusCallback="${url(base, dial.paths?.answered ?? TWILIO_CALL_ANSWERED_PATH)}" statusCallbackMethod="POST"${notice}>${dial.toE164}</Number>`
    + '</Dial></Response>';
}

export interface IncomingRing {
  identities: readonly string[]; forwardPhoneE164: string | null; recorded: boolean; voicemailGreeting: string | null; language: string | null;
  schoolName: string | null; publicBase: string; paths?: CallLegPaths; voicemailPaths?: VoicemailPaths;
}
export interface VoicemailPaths { done: string; status: string }
/**
 * An incoming call with calling on: ring every Ring me browser (at most 10) and the school's forwarding phone at once;
 * the first to answer takes it. With nobody to ring, go straight to voicemail. A recorded call says so first.
 */
export function incomingRingTwiml(ring: IncomingRing): string {
  const lang = language(ring.language), base = ring.publicBase;
  const identities = ring.identities.slice(0, 10);
  if (identities.some(identity => !IDENTITY.test(identity)) || (ring.forwardPhoneE164 !== null && !E164.test(ring.forwardPhoneE164))) {
    throw new Error('HON incoming ring is invalid.');
  }
  const notice = ring.recorded ? say(NOTICE[lang], lang) : '';
  if (!identities.length && !ring.forwardPhoneE164) return voicemailTwiml({ voicemailGreeting: ring.voicemailGreeting, language: ring.language, schoolName: ring.schoolName, publicBase: base,
    noticeSaid: ring.recorded, ...(ring.voicemailPaths ? { paths: ring.voicemailPaths } : {}) });
  const record = ring.recorded
    ? ` record="record-from-answer-dual" recordingStatusCallback="${url(base, TWILIO_RECORDING_STATUS_PATH)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`
    : '';
  const answered = `statusCallbackEvent="answered" statusCallback="${url(base, ring.paths?.answered ?? TWILIO_CALL_ANSWERED_PATH)}" statusCallbackMethod="POST"`;
  const clients = identities.map(identity => `<Client ${answered}><Identity>${identity}</Identity></Client>`).join('');
  const forward = ring.forwardPhoneE164 ? `<Number ${answered}>${ring.forwardPhoneE164}</Number>` : '';
  return `${XML_HEAD}<Response>${notice}<Dial timeout="${INCOMING_RING_SECONDS}" answerOnBridge="true" timeLimit="${CALL_TIME_LIMIT_SECONDS}" `
    + `action="${url(base, ring.paths?.dialResult ?? TWILIO_INCOMING_DIAL_RESULT_PATH)}" method="POST"${record}>${clients}${forward}</Dial></Response>`;
}

/** Nobody answered: the school's greeting (or a plain default), then record a voicemail of up to two minutes. */
export function voicemailTwiml(vm: { voicemailGreeting: string | null; language: string | null; schoolName: string | null; publicBase: string; noticeSaid?: boolean; paths?: VoicemailPaths }): string {
  const lang = language(vm.language);
  const greeting = vm.voicemailGreeting && !/[<>\u0000-\u001f\u007f]/.test(vm.voicemailGreeting) ? vm.voicemailGreeting : DEFAULT_GREETING[lang](schoolLabel(vm.schoolName));
  const notice = vm.noticeSaid ? say(NOTICE[lang], lang) : '';
  return `${XML_HEAD}<Response>${notice}${say(greeting, lang)}<Record maxLength="${VOICEMAIL_MAX_SECONDS}" timeout="5" playBeep="true" trim="trim-silence" `
    + `action="${url(vm.publicBase, vm.paths?.done ?? TWILIO_VOICEMAIL_DONE_PATH)}" method="POST" recordingStatusCallback="${url(vm.publicBase, vm.paths?.status ?? TWILIO_VOICEMAIL_STATUS_PATH)}" `
    + 'recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/></Response>';
}

const DIAL_STATUS: Readonly<Record<string, 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELED'>> = {
  completed: 'COMPLETED', answered: 'COMPLETED', 'no-answer': 'NO_ANSWER', busy: 'BUSY', failed: 'FAILED', canceled: 'CANCELED',
};
/** Twilio's DialCallStatus as HON's call status, or null for anything else. */
export function dialCallStatus(value: string | null): 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELED' | null {
  return value !== null && Object.prototype.hasOwnProperty.call(DIAL_STATUS, value) ? DIAL_STATUS[value]! : null;
}
/** A whole number of seconds from a Twilio duration field, or null. */
export function twilioSeconds(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n <= 86_400 ? n : null;
}
