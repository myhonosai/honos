import { normalizeSchoolCallNumber, schoolCallNumberOk, type SchoolPhoneToken } from '@hon/contracts';
import { CallsAccessError, CallsRefusal, callAttempt, loadPhoneToken, startCall, type CallsScope } from './http';
import { loadHqPhoneToken, startHqCall } from './hq-http';

/** Where the phone gets its token and records a call: a school (0556) or HON HQ (0591). Same token shape for both. */
export interface PhoneBackend {
  loadToken(): Promise<SchoolPhoneToken>;
  /** Records the call and returns its id; contactId is the school person or the HQ contact the call is for. */
  startCall(toE164: string, contactId: string | undefined, key: string): Promise<{ callId: string }>;
}
export function schoolPhoneBackend(scope: CallsScope): PhoneBackend {
  return {
    loadToken: () => loadPhoneToken(scope),
    startCall: async (toE164, personId, key) => (await startCall(scope, { toE164, ...(personId ? { personId } : {}) }, key)).call,
  };
}
export const HQ_PHONE_BACKEND: PhoneBackend = {
  loadToken: () => loadHqPhoneToken(),
  startCall: async (toE164, contactUserId, key) => (await startHqCall({ toE164, ...(contactUserId ? { contactUserId } : {}) }, key)).call,
};

/**
 * The browser phone (0556/0590, docs/architecture/SCHOOL_CALLING.md §4). It holds a one-hour Twilio Voice token in memory
 * only, registers for incoming calls only when the server says Ring me is on, and places a call only after the API has
 * recorded it: the device sends just the recorded call id (HonCallId), and the server dials the number stored on that row.
 * The Twilio SDK sits behind VoiceDevice so the controller is tested with a fake and the SDK loads only when needed.
 */
export interface VoiceCallLike {
  readonly parameters: Record<string, string>;
  accept(): void; reject(): void; disconnect(): void; mute(muted?: boolean): void; isMuted(): boolean; sendDigits(digits: string): void;
  on(event: 'accept' | 'disconnect' | 'cancel' | 'reject' | 'error', listener: (value?: unknown) => void): unknown;
}
export interface VoiceDevice {
  register(): Promise<void>; unregister(): Promise<void>; updateToken(token: string): void; destroy(): void;
  connect(options: { params: Record<string, string> }): Promise<VoiceCallLike>;
  on(event: 'incoming' | 'tokenWillExpire' | 'error', listener: (value?: unknown) => void): unknown;
}
export type VoiceDeviceFactory = (token: string) => Promise<VoiceDevice>;

export type PhoneUnavailable = SchoolPhoneToken['reason'] | 'ERROR';
export type PhoneState =
  | { kind: 'HIDDEN' }
  | { kind: 'LOADING' }
  | { kind: 'UNAVAILABLE'; reason: Exclude<PhoneUnavailable, 'READY'> }
  | { kind: 'READY'; incoming: boolean; problem: PhoneProblem | null }
  | { kind: 'DIALING'; remote: string; callId: string | null }
  | { kind: 'INCOMING'; remote: string }
  | { kind: 'ACTIVE'; remote: string; callId: string | null; direction: 'IN' | 'OUT'; since: number; muted: boolean }
  | { kind: 'ENDED'; remote: string; callId: string | null; direction: 'IN' | 'OUT' };
/** Why the last dial did not go through: a refusal code, a number HON will not call, or an unconfirmed start. */
export type PhoneProblem = { kind: 'NUMBER' } | { kind: 'REFUSED'; code: string } | { kind: 'UNKNOWN' } | { kind: 'MICROPHONE' } | { kind: 'DROPPED' };

const MICROPHONE_CODES = new Set([31208, 31401, 31402, 53405]);
function errorCode(value: unknown): number | null {
  const code = value && typeof value === 'object' ? (value as { code?: unknown }).code : null;
  return typeof code === 'number' ? code : null;
}

export async function twilioVoiceDevice(token: string): Promise<VoiceDevice> {
  const { Device } = await import('@twilio/voice-sdk');
  return new Device(token, { closeProtection: true, codecPreferences: ['opus', 'pcmu'] as never, logLevel: 'error' as never }) as unknown as VoiceDevice;
}

export class PhoneController {
  private state: PhoneState = { kind: 'HIDDEN' };
  private readonly listeners = new Set<(state: PhoneState) => void>();
  private device: VoiceDevice | null = null;
  private call: VoiceCallLike | null = null;
  private token: SchoolPhoneToken | null = null;
  private attempt: { fingerprint: string; key: string } | null = null;
  private generation = 0;
  private cancelled = false;

  private readonly backend: PhoneBackend;
  constructor(target: CallsScope | PhoneBackend, private readonly createDevice: VoiceDeviceFactory = twilioVoiceDevice,
    private readonly clock: () => number = () => Date.now(), private readonly newKey: () => string = () => crypto.randomUUID()) {
    this.backend = 'loadToken' in target ? target : schoolPhoneBackend(target);
  }

  snapshot(): PhoneState { return this.state; }
  subscribe(listener: (state: PhoneState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private set(next: PhoneState): void { this.state = next; for (const listener of this.listeners) listener(next); }
  private live(generation: number): boolean { return generation === this.generation; }

  /** Asks the server once. 403 hides the phone (no calling permission); anything not READY explains why. */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.set({ kind: 'LOADING' });
    let token: SchoolPhoneToken;
    try { token = await this.backend.loadToken(); } catch (problem) {
      if (!this.live(generation)) return;
      this.set(problem instanceof CallsAccessError ? { kind: 'HIDDEN' } : { kind: 'UNAVAILABLE', reason: 'ERROR' });
      return;
    }
    if (!this.live(generation)) return;
    if (!token.ready) { this.set({ kind: 'UNAVAILABLE', reason: token.reason as Exclude<PhoneUnavailable, 'READY'> }); return; }
    this.token = token;
    if (token.incoming) {
      try { await this.ensureDevice(generation); await this.device?.register(); }
      catch { if (this.live(generation)) this.set({ kind: 'UNAVAILABLE', reason: 'ERROR' }); return; }
    }
    if (this.live(generation)) this.set({ kind: 'READY', incoming: token.incoming, problem: null });
  }

  private async ensureDevice(generation: number): Promise<VoiceDevice> {
    if (this.device) return this.device;
    const device = await this.createDevice(this.token!.token!);
    if (!this.live(generation)) { device.destroy(); throw new Error('stale'); }
    this.device = device;
    device.on('incoming', value => this.incoming(value as VoiceCallLike));
    device.on('tokenWillExpire', () => { void this.refreshToken(generation); });
    return device;
  }
  private async refreshToken(generation: number): Promise<void> {
    try {
      const token = await this.backend.loadToken();
      if (!this.live(generation)) return;
      if (!token.ready) { this.stop(); this.set({ kind: 'UNAVAILABLE', reason: token.reason as Exclude<PhoneUnavailable, 'READY'> }); return; }
      this.token = token; this.device?.updateToken(token.token!);
    } catch { /* The SDK keeps the current token until it expires; the next dial asks again. */ }
  }

  private incoming(call: VoiceCallLike): void {
    if (this.call) { call.reject(); return; }
    const remote = call.parameters.From ?? '';
    this.call = call;
    this.set({ kind: 'INCOMING', remote });
    const end = () => this.ended(call, 'IN', null);
    call.on('cancel', end); call.on('reject', end); call.on('disconnect', end);
    call.on('error', value => { if (MICROPHONE_CODES.has(errorCode(value) ?? 0)) this.problem({ kind: 'MICROPHONE' }); end(); });
    call.on('accept', () => { if (this.call === call) this.set({ kind: 'ACTIVE', remote, callId: null, direction: 'IN', since: this.clock(), muted: false }); });
  }
  accept(): void { if (this.state.kind === 'INCOMING') this.call?.accept(); }
  decline(): void { if (this.state.kind === 'INCOMING') { const call = this.call; this.call = null; call?.reject(); this.ready(); } }

  /**
   * Records the call through the API, then connects it with the recorded id only. The same number keeps the same
   * idempotency key until the call is connected, so a retry after an unconfirmed start never records a second call.
   */
  async dial(typed: string, personId?: string): Promise<void> {
    if (this.call || !this.token || (this.state.kind !== 'READY' && this.state.kind !== 'ENDED')) return;
    const to = normalizeSchoolCallNumber(typed);
    if (!to || !schoolCallNumberOk(to)) { this.problem({ kind: 'NUMBER' }); return; }
    const generation = this.generation;
    this.attempt = callAttempt(`${to}:${personId ?? ''}`, this.attempt, this.newKey);
    this.cancelled = false;
    this.set({ kind: 'DIALING', remote: to, callId: null });
    let callId: string;
    try {
      callId = (await this.backend.startCall(to, personId, this.attempt.key)).callId;
    } catch (problem) {
      if (!this.live(generation)) return;
      if (problem instanceof CallsRefusal) { this.attempt = null; this.problem({ kind: 'REFUSED', code: problem.code }); }
      else if (problem instanceof CallsAccessError) { this.attempt = null; this.stop(); this.set({ kind: 'HIDDEN' }); }
      else this.problem({ kind: 'UNKNOWN' });
      return;
    }
    if (!this.live(generation)) return;
    // Hung up before the browser connected: the recorded call is never connected and expires on its own.
    if (this.cancelled) { this.attempt = null; this.cancelled = false; this.ready(); return; }
    this.set({ kind: 'DIALING', remote: to, callId });
    let call: VoiceCallLike;
    try {
      const device = await this.ensureDevice(generation);
      call = await device.connect({ params: { HonCallId: callId } });
    } catch (problem) {
      this.attempt = null;
      if (this.live(generation)) this.problem(MICROPHONE_CODES.has(errorCode(problem) ?? 0) ? { kind: 'MICROPHONE' } : { kind: 'DROPPED' });
      return;
    }
    this.attempt = null;
    if (!this.live(generation)) { call.disconnect(); return; }
    this.call = call;
    call.on('accept', () => { if (this.call === call) this.set({ kind: 'ACTIVE', remote: to, callId, direction: 'OUT', since: this.clock(), muted: false }); });
    call.on('disconnect', () => this.ended(call, 'OUT', callId));
    call.on('cancel', () => this.ended(call, 'OUT', callId));
    call.on('error', value => { if (MICROPHONE_CODES.has(errorCode(value) ?? 0)) this.problem({ kind: 'MICROPHONE' }); else this.ended(call, 'OUT', callId); });
  }
  hangUp(): void { if (this.call) this.call.disconnect(); else if (this.state.kind === 'DIALING') this.cancelled = true; }
  toggleMute(): void {
    if (this.state.kind !== 'ACTIVE' || !this.call) return;
    this.call.mute(!this.call.isMuted());
    this.set({ ...this.state, muted: this.call.isMuted() });
  }
  /** Keypad during a call (menus, extensions). Only the digits a phone keypad has. */
  digits(value: string): void { if (this.state.kind === 'ACTIVE' && /^[0-9*#]{1,10}$/.test(value)) this.call?.sendDigits(value); }

  private ended(call: VoiceCallLike, direction: 'IN' | 'OUT', callId: string | null): void {
    if (this.call !== call) return;
    this.call = null;
    const remote = this.state.kind === 'ACTIVE' || this.state.kind === 'DIALING' || this.state.kind === 'INCOMING' ? this.state.remote : '';
    const answered = this.state.kind === 'ACTIVE';
    if (direction === 'IN' && !answered) { this.ready(); return; }
    this.set({ kind: 'ENDED', remote, callId, direction });
  }
  private problem(problem: PhoneProblem): void {
    this.call = null;
    this.set({ kind: 'READY', incoming: Boolean(this.token?.incoming), problem });
  }
  ready(): void { if (!this.call && this.token) this.set({ kind: 'READY', incoming: this.token.incoming, problem: null }); }

  /** School switch, sign-out or privacy screen: hang up, forget the token and the device. */
  stop(): void {
    ++this.generation;
    const call = this.call, device = this.device;
    this.call = null; this.device = null; this.token = null; this.attempt = null;
    try { call?.disconnect(); } catch { /* already gone */ }
    try { device?.destroy(); } catch { /* already gone */ }
    this.set({ kind: 'HIDDEN' });
  }
}

/** Other pages (a contact, a text thread, the call log) ask the top-bar phone to open with a number filled in. It never dials. */
export const PHONE_REQUEST_EVENT = 'hon-phone-request';
export type PhoneRequest = { toE164: string; personId?: string; name?: string };
export function requestPhoneCall(request: PhoneRequest): void {
  if (typeof window === 'undefined' || !schoolCallNumberOk(request.toE164)) return;
  window.dispatchEvent(new CustomEvent<PhoneRequest>(PHONE_REQUEST_EVENT, { detail: { toE164: request.toE164, ...(request.personId ? { personId: request.personId } : {}),
    ...(request.name ? { name: request.name.slice(0, 120) } : {}) } }));
}
