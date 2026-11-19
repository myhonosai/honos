import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHONE_REQUEST_EVENT, PhoneController, requestPhoneCall, type VoiceCallLike, type VoiceDevice } from '../src/components/calls/phone';
import { phoneCopy } from '../src/components/calls/phone-copy';
import { CallButton } from '../src/components/calls/call-button';
import { SchoolShellFrame } from '../src/components/school-shell/frame';

// Browser phone (0556/0561): the token stays in memory, a call is recorded by the API before the device connects it with the
// recorded id only, retries keep one idempotency key, and incoming calls register only when Ring me is on.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T = '2026-11-20T17:00:00.000Z';
const scope = { organizationId: A, schoolId: B };
const token = (patch = {}) => ({ ready: true, reason: 'READY', identity: `u${'a'.repeat(32)}`, token: 'h.p.s', expiresAt: T, incoming: false, ...patch });
const started = (to = '+15125550101') => ({ callId: C, direction: 'OUT', status: 'INITIATED', remoteE164: to, personId: null, contactName: null, staffName: 'Sam',
  startedAt: T, answeredAt: null, endedAt: null, durationSeconds: null, recorded: false, voicemail: false, recordingAvailable: false, recordingSeconds: null,
  heard: false, outcome: null, note: null, doNotCall: false, version: 1, connectBy: T, replayed: false });

class FakeCall implements VoiceCallLike {
  handlers = new Map<string, ((v?: unknown) => void)[]>(); muted = false; digits: string[] = []; accepted = false; rejected = false; disconnected = false;
  constructor(readonly parameters: Record<string, string> = {}) {}
  on(event: string, fn: (v?: unknown) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this; }
  emit(event: string, value?: unknown) { for (const fn of this.handlers.get(event) ?? []) fn(value); }
  accept() { this.accepted = true; this.emit('accept'); } reject() { this.rejected = true; this.emit('reject'); }
  disconnect() { this.disconnected = true; this.emit('disconnect'); } mute(m = true) { this.muted = m; } isMuted() { return this.muted; } sendDigits(d: string) { this.digits.push(d); }
}
class FakeDevice implements VoiceDevice {
  handlers = new Map<string, ((v?: unknown) => void)[]>(); registered = false; destroyed = false; tokens: string[] = []; connects: Record<string, string>[] = []; next = new FakeCall();
  constructor(readonly token: string) {}
  async register() { this.registered = true; } async unregister() { this.registered = false; } updateToken(t: string) { this.tokens.push(t); } destroy() { this.destroyed = true; }
  async connect(options: { params: Record<string, string> }) { this.connects.push(options.params); return this.next; }
  on(event: string, fn: (v?: unknown) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this; }
  emit(event: string, value?: unknown) { for (const fn of this.handlers.get(event) ?? []) fn(value); }
}
function setup() {
  const devices: FakeDevice[] = [];
  let n = 0;
  const controller = new PhoneController(scope, async t => { const d = new FakeDevice(t); devices.push(d); return d; }, () => 1000, () => `key-0000${++n}`);
  return { controller, devices };
}
afterEach(() => vi.restoreAllMocks());

describe('browser phone controller', () => {
  it('hides for staff without calling permission and explains every other reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(403, { code: 'CALLING_FORBIDDEN' }))
      .mockResolvedValueOnce(json(200, { data: token({ ready: false, reason: 'VOICE_NOT_APPROVED', identity: null, token: null, expiresAt: null }), meta: {} }))
      .mockResolvedValueOnce(json(503, { code: 'CALLING_UNAVAILABLE' }));
    const { controller, devices } = setup();
    await controller.start(); expect(controller.snapshot()).toEqual({ kind: 'HIDDEN' });
    await controller.start(); expect(controller.snapshot()).toEqual({ kind: 'UNAVAILABLE', reason: 'VOICE_NOT_APPROVED' });
    await controller.start(); expect(controller.snapshot()).toEqual({ kind: 'UNAVAILABLE', reason: 'ERROR' });
    expect(devices).toHaveLength(0);
  });
  it('asks for the token as a human command and registers for incoming calls only when Ring me is on', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token(), meta: {} })).mockResolvedValueOnce(json(200, { data: token({ incoming: true }), meta: {} }));
    const off = setup(); await off.controller.start();
    expect(off.controller.snapshot()).toEqual({ kind: 'READY', incoming: false, problem: null }); expect(off.devices).toHaveLength(0);
    const on = setup(); await on.controller.start();
    expect(on.devices[0]!.registered).toBe(true); expect(on.devices[0]!.token).toBe('h.p.s');
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/calls/phone-token`);
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'communication.call.token' });
  });
  it('records the call first, then connects it with the recorded id only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token(), meta: {} })).mockResolvedValueOnce(json(201, { data: started(), meta: { replayed: false } }));
    const { controller, devices } = setup(); await controller.start();
    await controller.dial('(512) 555-0101');
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ toE164: '+15125550101' }) });
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'key-00001' });
    expect(devices[0]!.connects).toEqual([{ HonCallId: C }]);
    expect(controller.snapshot()).toMatchObject({ kind: 'DIALING', callId: C });
    devices[0]!.next.emit('accept');
    expect(controller.snapshot()).toEqual({ kind: 'ACTIVE', remote: '+15125550101', callId: C, direction: 'OUT', since: 1000, muted: false });
    controller.toggleMute(); expect(controller.snapshot()).toMatchObject({ muted: true });
    controller.digits('1'); controller.digits('<script>'); expect(devices[0]!.next.digits).toEqual(['1']);
    controller.hangUp();
    expect(controller.snapshot()).toEqual({ kind: 'ENDED', remote: '+15125550101', callId: C, direction: 'OUT' });
  });
  it('never asks the API for a number HON will not call', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token(), meta: {} }));
    const { controller } = setup(); await controller.start();
    for (const bad of ['876 555 0101', '+44 20 7123 4567', '900-555-0101', 'call me']) {
      await controller.dial(bad);
      expect(controller.snapshot()).toEqual({ kind: 'READY', incoming: false, problem: { kind: 'NUMBER' } });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps one idempotency key across an unconfirmed start, and a new key after a refusal', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token(), meta: {} }))
      .mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json(422, { code: 'CALL_DO_NOT_CALL' })).mockResolvedValueOnce(json(422, { code: 'CALL_DO_NOT_CALL' }));
    const { controller, devices } = setup(); await controller.start();
    await controller.dial('5125550101'); expect(controller.snapshot()).toMatchObject({ problem: { kind: 'UNKNOWN' } });
    await controller.dial('5125550101'); expect(controller.snapshot()).toMatchObject({ problem: { kind: 'REFUSED', code: 'CALL_DO_NOT_CALL' } });
    await controller.dial('5125550101');
    const keys = fetcher.mock.calls.slice(1).map(c => ((c[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual(['key-00001', 'key-00001', 'key-00002']);
    expect(devices).toHaveLength(0);
  });
  it('does not connect a call hung up before it was recorded', async () => {
    let resolve!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token(), meta: {} })).mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }));
    const { controller, devices } = setup(); await controller.start();
    const dialing = controller.dial('5125550101');
    await Promise.resolve(); controller.hangUp();
    resolve(json(201, { data: started(), meta: { replayed: false } })); await dialing;
    expect(devices).toHaveLength(0); expect(controller.snapshot()).toMatchObject({ kind: 'READY', problem: null });
  });
  it('rings, answers and declines incoming calls, and rejects a second call while busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token({ incoming: true }), meta: {} }));
    const { controller, devices } = setup(); await controller.start();
    const first = new FakeCall({ From: '+15125550101' });
    devices[0]!.emit('incoming', first);
    expect(controller.snapshot()).toEqual({ kind: 'INCOMING', remote: '+15125550101' });
    const second = new FakeCall({ From: '+15125550102' }); devices[0]!.emit('incoming', second); expect(second.rejected).toBe(true);
    controller.accept(); expect(controller.snapshot()).toMatchObject({ kind: 'ACTIVE', direction: 'IN' });
    first.emit('disconnect'); expect(controller.snapshot()).toMatchObject({ kind: 'ENDED', direction: 'IN' });
    const third = new FakeCall({ From: '+15125550103' }); devices[0]!.emit('incoming', third);
    controller.decline(); expect(third.rejected).toBe(true); expect(controller.snapshot()).toMatchObject({ kind: 'READY' });
    const fourth = new FakeCall({ From: '+15125550104' }); devices[0]!.emit('incoming', fourth); fourth.emit('cancel');
    expect(controller.snapshot()).toMatchObject({ kind: 'READY' });
  });
  it('refreshes the token before it expires and stops cleanly on a school switch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: token({ incoming: true }), meta: {} }))
      .mockResolvedValueOnce(json(200, { data: token({ incoming: true, token: 'h.p.t' }), meta: {} }));
    const { controller, devices } = setup(); await controller.start();
    devices[0]!.emit('tokenWillExpire'); await new Promise(r => setTimeout(r, 0));
    expect(devices[0]!.tokens).toEqual(['h.p.t']);
    const call = new FakeCall({ From: '+15125550101' }); devices[0]!.emit('incoming', call); controller.accept();
    controller.stop();
    expect(call.disconnected).toBe(true); expect(devices[0]!.destroyed).toBe(true); expect(controller.snapshot()).toEqual({ kind: 'HIDDEN' });
  });
});

describe('phone surfaces', () => {
  it('opens the phone with a number filled in, never for a number HON will not call', () => {
    const seen: unknown[] = [];
    const fake = { dispatchEvent: (e: CustomEvent) => { seen.push({ type: e.type, detail: e.detail }); return true; } };
    vi.stubGlobal('window', fake); vi.stubGlobal('CustomEvent', class { constructor(readonly type: string, init: { detail: unknown }) { (this as unknown as { detail: unknown }).detail = init.detail; } });
    requestPhoneCall({ toE164: '+15125550101', personId: C, name: 'Ada Lee' }); requestPhoneCall({ toE164: '+18765550101' });
    expect(seen).toEqual([{ type: PHONE_REQUEST_EVENT, detail: { toE164: '+15125550101', personId: C, name: 'Ada Lee' } }]);
    vi.unstubAllGlobals();
  });
  it('shows a Call button only for numbers HON calls', () => {
    expect(renderToStaticMarkup(<CallButton phoneE164="+15125550101" language="en" />)).toContain('Call (512) 555-0101');
    expect(renderToStaticMarkup(<CallButton phoneE164="+18765550101" language="en" />)).toBe('');
    expect(renderToStaticMarkup(<CallButton phoneE164={null} language="en" />)).toBe('');
  });
  it('puts the phone in the top bar only for a verified school', () => {
    const base = { path: '/staff/dashboard', language: 'en', selection: scope, schoolName: 'Sunrise', choices: [], mode: 'modern' as const, viewState: 'SAVED' as const, menuOpen: false,
      onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {}, phone: <span data-test-phone="" /> };
    expect(renderToStaticMarkup(<SchoolShellFrame {...base} phase="READY" />)).toContain('data-test-phone');
    expect(renderToStaticMarkup(<SchoolShellFrame {...base} phase="LOADING" />)).not.toContain('data-test-phone');
  });
  it('has every phone string in English, Korean and Spanish', () => {
    const en = phoneCopy('en');
    for (const language of ['ko', 'es']) {
      const copy = phoneCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      expect(Object.keys(copy.unavailable).sort()).toEqual(Object.keys(en.unavailable).sort());
      expect(Object.keys(copy.refusal).sort()).toEqual(Object.keys(en.refusal).sort());
    }
  });
  it('keeps the token in memory only and loads the Twilio SDK only on demand', () => {
    const source = readFileSync(resolve('src/components/calls/phone.ts'), 'utf8') + readFileSync(resolve('src/components/calls/phone-panel.tsx'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|dangerouslySetInnerHTML/);
    expect(source).toContain("await import('@twilio/voice-sdk')");
    expect(source).not.toMatch(/^import .*@twilio\/voice-sdk/m);
    expect(source).toContain('{ params: { HonCallId: callId } }');
  });
});
