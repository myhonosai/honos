import { createHash } from 'node:crypto';
import { voiceCallsApproved } from './twilio-voice.js';

/**
 * CL3c (0556 K3, 0693 V1; docs/architecture/SCHOOL_CALLING.md §4): the Twilio Voice pieces HON creates and removes on a
 * school's own subaccount. Every Twilio request is authenticated as HON's parent account and is made only when the owner's
 * voice switch HON_VOICE_CALLS_APPROVED is exactly 'true'; otherwise nothing leaves HON. The workers are off unless their
 * interval is set. Recording audio is fetched only to stream it to a staff member the database just authorized.
 */
export const SCHOOL_VOICE_TWILIO_CLIENT = Symbol('SCHOOL_VOICE_TWILIO_CLIENT');

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const APP_SID = /^AP[0-9a-f]{32}$/;
const KEY_SID = /^SK[0-9a-f]{32}$/;
const RECORDING_SID = /^RE[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Two minutes of voicemail or a four-hour call are well under this; anything larger is refused. */
export const RECORDING_MAX_BYTES = 64 * 1024 * 1024;

export class TwilioVoiceError extends Error {
  constructor(readonly outcome: 'RETRYABLE' | 'FAILED' | 'UNKNOWN' | 'GONE', readonly code = 'TWILIO_VOICE_FAILED') { super(`${outcome}:${code}`); }
}
export interface SchoolVoiceTwilioClient {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  findTwimlApp(accountSid: string, friendlyName: string): Promise<string | null>;
  createTwimlApp(accountSid: string, friendlyName: string, voiceUrl: string): Promise<string>;
  createApiKey(accountSid: string, friendlyName: string): Promise<{ sid: string; secret: string }>;
  fetchRecording(accountSid: string | null, recordingSid: string): Promise<{ audio: Buffer; contentType: 'audio/mpeg' }>;
  deleteRecording(accountSid: string | null, recordingSid: string): Promise<'DELETED' | 'GONE'>;
}

/** The Twilio names HON gives a school's voice pieces: HON's school id only, never a person's or school's name. */
export function voiceAppFriendlyName(schoolId: string): string {
  if (!UUID.test(schoolId)) throw new Error('INVALID_SCHOOL_ID');
  return `hon-voice-${schoolId}`;
}

type Env = Record<string, string | undefined>;
export class TwilioRestVoiceClient implements SchoolVoiceTwilioClient {
  constructor(private readonly environment: () => Env = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') && env.TWILIO_AUTH_TOKEN?.trim() && voiceCallsApproved(env as NodeJS.ProcessEnv)
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }
  private auth(): string {
    if (this.readiness() !== 'READY') throw new TwilioVoiceError('RETRYABLE', 'VOICE_NOT_APPROVED');
    const env = this.environment();
    return `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN!.trim()}`).toString('base64')}`;
  }
  private account(accountSid: string | null): string {
    const sid = accountSid ?? this.environment().TWILIO_ACCOUNT_SID ?? '';
    if (!ACCOUNT_SID.test(sid)) throw new TwilioVoiceError('FAILED', 'INVALID_ACCOUNT');
    return `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  }
  private async send(url: string, init: RequestInit, unknownOnNetwork: boolean): Promise<Response> {
    try { return await this.transport(url, { ...init, signal: AbortSignal.timeout(20_000) }); }
    catch { throw new TwilioVoiceError(unknownOnNetwork ? 'UNKNOWN' : 'RETRYABLE', 'PROVIDER_UNREACHABLE'); }
  }
  private static failed(status: number, unknown: boolean): never {
    if (status === 429 || status === 401 || status === 403 || status >= 500) throw new TwilioVoiceError(unknown && status >= 500 ? 'UNKNOWN' : 'RETRYABLE', 'PROVIDER_FAILED');
    throw new TwilioVoiceError('FAILED', 'PROVIDER_REJECTED');
  }

  async findTwimlApp(accountSid: string, friendlyName: string): Promise<string | null> {
    const authorization = this.auth();
    const response = await this.send(`${this.account(accountSid)}/Applications.json?${new URLSearchParams({ FriendlyName: friendlyName })}`,
      { method: 'GET', headers: { authorization }, redirect: 'error' }, false);
    if (response.status !== 200) TwilioRestVoiceClient.failed(response.status, false);
    const body = await response.json().catch(() => { throw new TwilioVoiceError('RETRYABLE', 'PROVIDER_FAILED'); }) as { applications?: unknown };
    const found = (Array.isArray(body.applications) ? body.applications : [])
      .map(app => (app as { sid?: unknown; friendly_name?: unknown }))
      .filter(app => typeof app.sid === 'string' && APP_SID.test(app.sid) && app.friendly_name === friendlyName).map(app => app.sid as string);
    // Two apps with one school's name would mean one was made twice: stop for an operator instead of guessing.
    if (found.length > 1) throw new TwilioVoiceError('FAILED', 'DUPLICATE_TWIML_APP');
    return found[0] ?? null;
  }

  async createTwimlApp(accountSid: string, friendlyName: string, voiceUrl: string): Promise<string> {
    const authorization = this.auth();
    const response = await this.send(`${this.account(accountSid)}/Applications.json`, { method: 'POST', redirect: 'error',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ FriendlyName: friendlyName, VoiceUrl: voiceUrl, VoiceMethod: 'POST' }).toString() }, true);
    if (response.status !== 201 && response.status !== 200) TwilioRestVoiceClient.failed(response.status, true);
    const body = await response.json().catch(() => { throw new TwilioVoiceError('UNKNOWN'); }) as { sid?: unknown };
    if (typeof body.sid !== 'string' || !APP_SID.test(body.sid)) throw new TwilioVoiceError('UNKNOWN');
    return body.sid;
  }

  async createApiKey(accountSid: string, friendlyName: string): Promise<{ sid: string; secret: string }> {
    const authorization = this.auth();
    const response = await this.send(`${this.account(accountSid)}/Keys.json`, { method: 'POST', redirect: 'error',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ FriendlyName: friendlyName }).toString() }, true);
    if (response.status !== 201 && response.status !== 200) TwilioRestVoiceClient.failed(response.status, true);
    const body = await response.json().catch(() => { throw new TwilioVoiceError('UNKNOWN'); }) as { sid?: unknown; secret?: unknown };
    if (typeof body.sid !== 'string' || !KEY_SID.test(body.sid) || typeof body.secret !== 'string' || !SECRET.test(body.secret)) throw new TwilioVoiceError('UNKNOWN');
    return { sid: body.sid, secret: body.secret };
  }

  async fetchRecording(accountSid: string | null, recordingSid: string): Promise<{ audio: Buffer; contentType: 'audio/mpeg' }> {
    if (!RECORDING_SID.test(recordingSid)) throw new TwilioVoiceError('FAILED', 'INVALID_RECORDING');
    const authorization = this.auth();
    // Twilio may redirect to its media host; fetch drops the Authorization header on a cross-origin redirect.
    const response = await this.send(`${this.account(accountSid)}/Recordings/${recordingSid}.mp3`, { method: 'GET', headers: { authorization }, redirect: 'follow' }, false);
    if (response.status === 404) throw new TwilioVoiceError('GONE', 'RECORDING_GONE');
    if (response.status !== 200) TwilioRestVoiceClient.failed(response.status, false);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > RECORDING_MAX_BYTES) throw new TwilioVoiceError('FAILED', 'RECORDING_TOO_LARGE');
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > RECORDING_MAX_BYTES) throw new TwilioVoiceError('FAILED', 'RECORDING_TOO_LARGE');
    return { audio, contentType: 'audio/mpeg' };
  }

  async deleteRecording(accountSid: string | null, recordingSid: string): Promise<'DELETED' | 'GONE'> {
    if (!RECORDING_SID.test(recordingSid)) throw new TwilioVoiceError('FAILED', 'INVALID_RECORDING');
    const authorization = this.auth();
    const response = await this.send(`${this.account(accountSid)}/Recordings/${recordingSid}.json`, { method: 'DELETE', headers: { authorization }, redirect: 'error' }, false);
    if (response.status === 204 || response.status === 200) return 'DELETED';
    if (response.status === 404) return 'GONE';
    return TwilioRestVoiceClient.failed(response.status, false);
  }
}

/** Deterministic fake for tests and local runs; refused in production and staging. SIDs derive from their inputs. */
export class FakeSchoolVoiceTwilioClient implements SchoolVoiceTwilioClient {
  readonly apps = new Map<string, { accountSid: string; voiceUrl: string }>();
  readonly keys: string[] = [];
  readonly deleted: string[] = [];
  readonly recordings = new Map<string, Buffer>();
  loseNextKey = false;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
    if (deployment === 'production' || deployment === 'staging' || (deployment === undefined && env.NODE_ENV === 'production')) throw new Error('FAKE_TWILIO_VOICE_REFUSED');
  }
  private static hex(seed: string) { return createHash('sha256').update(seed).digest('hex').slice(0, 32); }
  readiness() { return 'READY' as const; }
  async findTwimlApp(accountSid: string, friendlyName: string) {
    const sid = `AP${FakeSchoolVoiceTwilioClient.hex(`${accountSid}:${friendlyName}`)}`;
    return this.apps.has(sid) ? sid : null;
  }
  async createTwimlApp(accountSid: string, friendlyName: string, voiceUrl: string) {
    const sid = `AP${FakeSchoolVoiceTwilioClient.hex(`${accountSid}:${friendlyName}`)}`;
    this.apps.set(sid, { accountSid, voiceUrl });
    return sid;
  }
  async createApiKey(accountSid: string, friendlyName: string) {
    const sid = `SK${FakeSchoolVoiceTwilioClient.hex(`${accountSid}:${friendlyName}:${this.keys.length}`)}`;
    this.keys.push(sid);
    if (this.loseNextKey) { this.loseNextKey = false; throw new TwilioVoiceError('UNKNOWN'); }
    return { sid, secret: FakeSchoolVoiceTwilioClient.hex(`secret:${sid}`) };
  }
  async fetchRecording(_accountSid: string | null, recordingSid: string) {
    const audio = this.recordings.get(recordingSid);
    if (!audio || this.deleted.includes(recordingSid)) throw new TwilioVoiceError('GONE', 'RECORDING_GONE');
    return { audio, contentType: 'audio/mpeg' as const };
  }
  async deleteRecording(_accountSid: string | null, recordingSid: string) {
    if (this.deleted.includes(recordingSid)) return 'GONE' as const;
    this.deleted.push(recordingSid);
    return 'DELETED' as const;
  }
}
