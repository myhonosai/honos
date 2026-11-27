import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HQ_CALL_OUTCOMES, SCHOOL_CALL_FILTERS, SCHOOL_CALL_STATUSES } from '@hon/contracts';
import { CallsAccessError, CallsRefusal, CallsUnknown } from '../src/components/calls/http';
import {
  hqRecordingUrl, loadHqCalling, loadHqCalls, loadHqPhoneToken, saveHqCallingSettings, setHqDoNotCall, setHqRingMe, startHqCall, updateHqCall,
} from '../src/components/calls/hq-http';
import { hqCallsCopy } from '../src/components/calls/hq-copy';
import { HQ_PHONE_BACKEND, PhoneController, type VoiceCallLike, type VoiceDevice } from '../src/components/calls/phone';
import { HqCalls } from '../src/components/calls/hq-calls';
import { hqNavLinks, hqNavMatch, hqPageLabel } from '../src/components/hq-modern/catalog';
import { hqPhoneCopy, phoneCopy } from '../src/components/calls/phone-copy';

// CL5 (0694) HQ calling: same-origin HQ commands, verified answers, and the HQ top-bar phone records before it connects.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', C = '33333333-3333-4333-8333-333333333333', K = '55555555-5555-4555-8555-555555555555';
const T = '2026-11-20T17:00:00.000Z';
const call = (patch = {}) => ({ callId: C, direction: 'IN', status: 'VOICEMAIL', remoteE164: '+15125550101', contactUserId: A, contactName: 'Ada Lee',
  contactSchools: ['Tiger Dojo'], staffName: null, startedAt: T, answeredAt: null, endedAt: T, durationSeconds: 0, voicemail: true, recordingAvailable: true,
  recordingSeconds: 12, heard: false, outcome: null, note: null, doNotCall: false, version: 2, ...patch });
const overview = (patch = {}) => ({ callingOn: true, voicemailGreeting: null, version: 1, hqNumber: '+15125550100', numberReady: true, ringMe: false,
  canManage: true, unheardVoicemails: 1, missedToday: 2, staff: [{ principalId: A, name: 'Sam', ringMe: true }], ...patch });
const token = (patch = {}) => ({ ready: true, reason: 'READY', identity: `h${'a'.repeat(32)}`, token: 'h.p.s', expiresAt: T, incoming: false, ...patch });
afterEach(() => vi.restoreAllMocks());

describe('HQ calls http', () => {
  it('reads the overview and the filtered log from the HQ calling API only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: overview() }))
      .mockResolvedValueOnce(json(200, { data: { calls: [call()], nextCursor: null } }));
    expect((await loadHqCalling()).hqNumber).toBe('+15125550100');
    await loadHqCalls({ filter: 'VOICEMAIL', contactUserId: A });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/hq/calls/overview');
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/v1/hq/calls?filter=VOICEMAIL&contactUserId=${A}`);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(hqRecordingUrl(C)).toBe(`/api/v1/hq/calls/${C}/recording`);
  });
  it('refuses answers that do not match what was asked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { calls: [call({ voicemail: false, recordingAvailable: false, recordingSeconds: null, heard: false, status: 'MISSED' })], nextCursor: null } }))
      .mockResolvedValueOnce(json(200, { data: { callingOn: false, voicemailGreeting: null, version: 2 } }))
      .mockResolvedValueOnce(json(200, { data: { ...call({ direction: 'OUT', status: 'INITIATED', voicemail: false, recordingAvailable: false, recordingSeconds: null, remoteE164: '+15125550199' }), connectBy: T, replayed: false } }));
    await expect(loadHqCalls({ filter: 'VOICEMAIL' })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(saveHqCallingSettings({ callingOn: true, voicemailGreeting: null, expectedVersion: 1 })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(startHqCall({ toE164: '+15125550101' }, K)).rejects.toBeInstanceOf(CallsUnknown);
  });
  it('sends each change as its own HQ human command; start carries a uuid key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { data: { ringMe: true, version: 1 } }))
      .mockResolvedValueOnce(json(200, { data: call({ outcome: 'RESOLVED', version: 3 }) }))
      .mockResolvedValueOnce(json(200, { data: { phoneE164: '+15125550101', doNotCall: true } }))
      .mockResolvedValueOnce(json(200, { data: { ...call({ direction: 'OUT', status: 'INITIATED', voicemail: false, recordingAvailable: false, recordingSeconds: null }), connectBy: T, replayed: false } }));
    await setHqRingMe(true);
    await updateHqCall({ callId: C, expectedVersion: 2, outcome: 'RESOLVED' });
    await setHqDoNotCall({ phoneE164: '+15125550101', doNotCall: true });
    await startHqCall({ toE164: '+15125550101', contactUserId: A }, K);
    const sent = fetcher.mock.calls.map(([url, init]) => [url, (init as RequestInit & { headers: Record<string, string> }).headers['X-HON-Human-Command'],
      (init as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'] ?? null]);
    expect(sent).toEqual([
      ['/api/v1/hq/calls/ring-me', 'hq-call-ring', null], [`/api/v1/hq/calls/${C}`, 'hq-call-update', null],
      ['/api/v1/hq/calls/do-not-call', 'hq-call-do-not-call', null], ['/api/v1/hq/calls', 'hq-call-start', K],
    ]);
    await expect(startHqCall({ toE164: '+15125550101' }, 'not-a-uuid')).rejects.toBeInstanceOf(CallsUnknown);
    await expect(startHqCall({ toE164: '+19005551234' }, K)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('tells refusals from access errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(403, { code: 'CALLING_FORBIDDEN' })).mockResolvedValueOnce(json(422, { code: 'CALLING_OFF' }))
      .mockResolvedValueOnce(json(200, { data: token({ identity: `u${'a'.repeat(32)}` }) }));
    await expect(loadHqCalling()).rejects.toBeInstanceOf(CallsAccessError);
    await expect(setHqRingMe(true)).rejects.toBeInstanceOf(CallsRefusal);
    await expect(loadHqPhoneToken()).rejects.toBeInstanceOf(CallsUnknown);
  });
});

class FakeCall implements VoiceCallLike {
  handlers = new Map<string, ((v?: unknown) => void)[]>();
  constructor(readonly parameters: Record<string, string> = {}) {}
  on(event: string, fn: (v?: unknown) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this; }
  accept() {} reject() {} disconnect() {} mute() {} isMuted() { return false; } sendDigits() {}
}
class FakeDevice implements VoiceDevice {
  connects: Record<string, string>[] = []; registered = false;
  async register() { this.registered = true; } async unregister() {} updateToken() {} destroy() {}
  async connect(options: { params: Record<string, string> }) { this.connects.push(options.params); return new FakeCall(); }
  on() { return this; }
}

describe('HQ top-bar phone', () => {
  it('uses the HQ token and records the HQ call before connecting it with the recorded id only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token({ incoming: true }) }))
      .mockResolvedValueOnce(json(200, { data: { ...call({ direction: 'OUT', status: 'INITIATED', voicemail: false, recordingAvailable: false, recordingSeconds: null, contactUserId: A }), connectBy: T, replayed: false } }));
    const devices: FakeDevice[] = [];
    const controller = new PhoneController(HQ_PHONE_BACKEND, async () => { const d = new FakeDevice(); devices.push(d); return d; }, () => 1000, () => K);
    await controller.start();
    expect(devices[0]!.registered).toBe(true);
    await controller.dial('(512) 555-0101', A);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/v1/hq/calls/phone-token', '/api/v1/hq/calls']);
    expect((fetcher.mock.calls[1]![1] as RequestInit).body).toBe(JSON.stringify({ toE164: '+15125550101', contactUserId: A }));
    expect(devices[0]!.connects).toEqual([{ HonCallId: C }]);
  });
  it('hides for anyone the HQ calling API refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(403, { code: 'CALLING_FORBIDDEN' }));
    const controller = new PhoneController(HQ_PHONE_BACKEND, async () => new FakeDevice());
    await controller.start();
    expect(controller.snapshot()).toEqual({ kind: 'HIDDEN' });
  });
});

describe('HQ calls page', () => {
  it('has every string, status and outcome in English, Korean and Spanish', () => {
    for (const language of ['en', 'ko', 'es']) {
      const copy = hqCallsCopy(language);
      for (const f of SCHOOL_CALL_FILTERS) expect(copy.filters[f]).toBeTruthy();
      for (const st of SCHOOL_CALL_STATUSES) expect(copy.status[st]).toBeTruthy();
      for (const o of HQ_CALL_OUTCOMES) expect(copy.outcomes[o]).toBeTruthy();
    }
    expect(hqCallsCopy('ko').title).not.toBe(hqCallsCopy('en').title);
    for (const language of ['en', 'ko', 'es']) {
      expect(hqPhoneCopy(language).title).not.toBe(phoneCopy(language).title);
      expect(hqPhoneCopy(language).unavailable.VOICE_NOT_APPROVED).not.toBe(phoneCopy(language).unavailable.VOICE_NOT_APPROVED);
      expect(hqPhoneCopy(language).answer).toBe(phoneCopy(language).answer);
    }
    expect(hqCallsCopy('es').intro).not.toBe(hqCallsCopy('en').intro);
  });
  it('renders the shell while loading and is in the HQ navigation next to texts', () => {
    expect(renderToStaticMarkup(<HqCalls />)).toContain('data-hq-calls');
    const paths = hqNavLinks().map(item => item.path);
    expect(paths.indexOf('/hq/communications/calls')).toBe(paths.indexOf('/hq/communications') + 1);
    expect(hqPageLabel('/hq/communications/calls')).toBe('Calls');
    expect(hqNavMatch('/hq/communications/calls')).toBe('/hq/communications/calls');
    expect(hqNavMatch(`/hq/communications/${C}`)).toBe('/hq/communications');
    expect(hqNavMatch('/hq/schools')).not.toBe('/hq');
  });
  it('never stores, injects HTML, dials or reaches a provider from the page', () => {
    for (const file of ['hq-calls.tsx', 'hq-http.ts', 'hq-copy.ts']) {
      const source = readFileSync(resolve(__dirname, '../src/components/calls', file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|twilio\.com|@twilio/);
    }
  });
});
