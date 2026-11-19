import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaffCalls, greetingValue } from '../src/components/calls/staff-calls';
import { callsCopy } from '../src/components/calls/copy';
import {
  CALL_REFUSALS, CallsAccessError, CallsRefusal, CallsUnknown, callAttempt, formatCallDuration, formatCallNumber, loadCalling, loadCalls, loadPhoneToken,
  recordingUrl, saveCallingSettings, setDoNotCall, setRingMe, startCall, updateCall,
} from '../src/components/calls/http';
import { NO_SCHOOL_SHELL, SchoolShellProvider } from '../src/components/school-shell/context';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';

// 0556 Calls page: fixed same-origin calls with the shell scope, verified answers, definite refusals vs unknown outcomes.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const T = '2026-11-20T17:00:00.000Z';
const scope = { organizationId: A, schoolId: B };
const BASE = `/api/v1/organizations/${A}/schools/${B}/calls`;
const call = (patch = {}) => ({ callId: C, direction: 'IN', status: 'VOICEMAIL', remoteE164: '+15125550101', personId: D, contactName: 'Ada Lee', staffName: null,
  startedAt: T, answeredAt: null, endedAt: T, durationSeconds: 0, recorded: false, voicemail: true, recordingAvailable: true, recordingSeconds: 12, heard: false,
  outcome: null, note: null, doNotCall: false, version: 2, ...patch });
const overview = (patch = {}) => ({ callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAt: null, version: 1, schoolNumber: '+15125550100',
  numberReady: true, forwardingPhoneSet: true, missedCallTextBack: true, ringMe: false, canManage: true, unheardVoicemails: 1, missedToday: 2,
  staff: [{ principalId: D, name: 'Sam', ringMe: true }], ...patch });
afterEach(() => vi.restoreAllMocks());

describe('school calls http', () => {
  it('reads the overview and filtered log as same-origin GETs with plain query strings', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: overview(), meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { calls: [call()], nextCursor: null }, meta: {} }));
    expect((await loadCalling(scope)).staff).toHaveLength(1);
    await loadCalls(scope, { filter: 'VOICEMAIL', personId: D, before: { at: T, id: C } });
    expect(fetcher.mock.calls[0]![0]).toBe(`${BASE}/overview`);
    expect(fetcher.mock.calls[1]![0]).toBe(`${BASE}?filter=VOICEMAIL&personId=${D}&beforeAt=${encodeURIComponent(T)}&beforeId=${C}`);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect((init as RequestInit).headers).not.toHaveProperty('X-HON-Human-Command');
    }
    await expect(loadCalls({ organizationId: '../x', schoolId: B })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(loadCalls(scope, { filter: 'GONE' } as never)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses a log that does not match the filter that was asked for', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { calls: [call({ voicemail: false, heard: false, status: 'MISSED' })], nextCursor: null }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { calls: [call({ personId: null })], nextCursor: null }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { calls: [call()], nextCursor: null }, meta: {} }));
    await expect(loadCalls(scope, { filter: 'VOICEMAIL' })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(loadCalls(scope, { personId: D })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(loadCalls(scope, { filter: 'OUTGOING' })).rejects.toBeInstanceOf(CallsUnknown);
  });
  it('sends each change as its own human command, version-checked, with no idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { data: call({ outcome: 'CALL_BACK', version: 3 }), meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { ringMe: true, version: 1 }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { phoneE164: '+15125550101', doNotCall: true }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { callingOn: true, voicemailGreeting: 'Hi', recordingOn: false, recordingConsentAt: null, version: 2 }, meta: {} }));
    expect((await updateCall(scope, { callId: C, expectedVersion: 2, outcome: 'CALL_BACK' })).outcome).toBe('CALL_BACK');
    await setRingMe(scope, true);
    await setDoNotCall(scope, { phoneE164: '+15125550101', doNotCall: true });
    await saveCallingSettings(scope, { callingOn: true, voicemailGreeting: 'Hi', recordingOn: false, recordingConsentAccepted: false, expectedVersion: 1 });
    const expected = [[`${BASE}/${C}`, 'communication.call.update', { expectedVersion: 2, outcome: 'CALL_BACK' }], [`${BASE}/ring-me`, 'communication.call.ring', { ringMe: true }],
      [`${BASE}/do-not-call`, 'communication.call.do_not_call', { phoneE164: '+15125550101', doNotCall: true }],
      [`${BASE}/settings`, 'communication.call.settings', { callingOn: true, voicemailGreeting: 'Hi', recordingOn: false, recordingConsentAccepted: false, expectedVersion: 1 }]] as const;
    expected.forEach(([url, command, body], i) => {
      const [u, init] = fetcher.mock.calls[i]!;
      expect(u).toBe(url);
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
      expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': command });
      expect((init as RequestInit).headers).not.toHaveProperty('Idempotency-Key');
    });
    await expect(updateCall(scope, { callId: C, expectedVersion: 2 } as never)).rejects.toThrow();
    await expect(updateCall(scope, { callId: C, expectedVersion: 2, note: ' ' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('refuses answers that do not match the command that was sent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: call({ version: 2 }), meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { ringMe: false, version: 1 }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { phoneE164: '+15125550199', doNotCall: true }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { callingOn: false, voicemailGreeting: null, recordingOn: false, recordingConsentAt: null, version: 2 }, meta: {} }));
    await expect(updateCall(scope, { callId: C, expectedVersion: 2, heard: true })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(setRingMe(scope, true)).rejects.toBeInstanceOf(CallsUnknown);
    await expect(setDoNotCall(scope, { phoneE164: '+15125550101', doNotCall: true })).rejects.toBeInstanceOf(CallsUnknown);
    await expect(saveCallingSettings(scope, { callingOn: true, voicemailGreeting: null, recordingOn: false, recordingConsentAccepted: false, expectedVersion: 1 }))
      .rejects.toBeInstanceOf(CallsUnknown);
  });
  it('starts a call only for an allowed number, with an idempotency key, bound to the number sent', async () => {
    const out = { ...call({ direction: 'OUT', status: 'INITIATED', voicemail: false, recordingAvailable: false, recordingSeconds: null, endedAt: null, durationSeconds: null, version: 1 }),
      connectBy: T, replayed: false };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(201, { data: out, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(201, { data: { ...out, remoteE164: '+15125550199' }, meta: { replayed: false } }));
    expect((await startCall(scope, { toE164: '+15125550101', personId: D }, 'key-12345')).call.direction).toBe('OUT');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ toE164: '+15125550101', personId: D }) });
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'communication.call.start', 'Idempotency-Key': 'key-12345' });
    await expect(startCall(scope, { toE164: '+15125550101' }, 'key-12345')).rejects.toBeInstanceOf(CallsUnknown);
    for (const bad of ['+18765550101', '+19005550101', '+15129765555', '+442071234567']) await expect(startCall(scope, { toE164: bad }, 'key-12345')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reads a phone token only as a verified answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { ready: false, reason: 'VOICE_NOT_APPROVED', identity: null, token: null, expiresAt: null, incoming: false }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { ready: true, reason: 'READY', identity: null, token: 'a.b.c', expiresAt: T, incoming: false }, meta: {} }));
    expect((await loadPhoneToken(scope)).reason).toBe('VOICE_NOT_APPROVED');
    await expect(loadPhoneToken(scope)).rejects.toBeInstanceOf(CallsUnknown);
  });
  it('tells definite refusals from access errors and unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(422, { code: 'CALL_DO_NOT_CALL' })).mockResolvedValueOnce(json(503, { code: 'CALLING_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'CALLING_FORBIDDEN' })).mockResolvedValueOnce(json(401, {})).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const refusal = await setRingMe(scope, true).catch(e => e);
    expect(refusal).toBeInstanceOf(CallsRefusal); expect(refusal.code).toBe('CALL_DO_NOT_CALL');
    await expect(setRingMe(scope, true)).rejects.toBeInstanceOf(CallsUnknown);
    expect((await loadCalling(scope).catch(e => e)).reason).toBe('FORBIDDEN');
    expect((await loadCalling(scope).catch(e => e)).reason).toBe('SESSION');
    expect(await loadCalling(scope).catch(e => e)).toBeInstanceOf(CallsUnknown);
  });
  it('keeps the key only for the same call and formats numbers and durations', () => {
    let n = 0; const key = () => `k${++n}`;
    const first = callAttempt('+15125550101', null, key);
    expect(callAttempt('+15125550101', first, key)).toBe(first);
    expect(callAttempt('+15125550102', first, key).key).toBe('k2');
    expect(formatCallNumber('+15125550101')).toBe('(512) 555-0101'); expect(formatCallNumber('+442071234567')).toBe('+442071234567');
    expect(recordingUrl(scope, C.toUpperCase())).toBe(`${BASE}/${C}/recording`); expect(() => recordingUrl(scope, '../x')).toThrow();
    expect(formatCallDuration(65)).toBe('1:05'); expect(formatCallDuration(3725)).toBe('1:02:05'); expect(formatCallDuration(null)).toBe('');
  });
});

describe('school calls screen', () => {
  it('asks for a school, then renders the page shell without data or IDs', () => {
    expect(renderToStaticMarkup(<StaffCalls />)).toContain('Choose a school to see its calls.');
    const html = renderToStaticMarkup(<SchoolShellProvider value={{ ...NO_SCHOOL_SHELL, phase: 'READY', selection: scope, schoolName: 'Sunrise' }}><StaffCalls /></SchoolShellProvider>);
    expect(html).toContain('<h1>Calls</h1>'); expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain(A); expect(html).not.toContain(B);
  });
  it('has every string, status, outcome and refusal in English, Korean and Spanish', () => {
    const en = callsCopy('en');
    for (const language of ['en', 'ko', 'es'] as const) {
      const copy = callsCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const code of CALL_REFUSALS) expect(copy.refusal[code], `${language} ${code}`).toBeTruthy();
      for (const part of ['status', 'outcomes', 'filters'] as const) expect(Object.keys(copy[part]).sort()).toEqual(Object.keys(en[part]).sort());
    }
    expect(callsCopy('ko').title).toBe('전화'); expect(callsCopy('es').title).toBe('Llamadas');
  });
  it('accepts a blank or plain voicemail greeting only', () => {
    expect(greetingValue('  ')).toBeNull(); expect(greetingValue(' Thanks for calling ')).toBe('Thanks for calling');
    expect(greetingValue('<b>hi</b>')).toBeUndefined(); expect(greetingValue('x'.repeat(301))).toBeUndefined();
  });
  it('is in the Communication menu next to texts', () => {
    const item = SCHOOL_SHELL_NAV.find(i => i.key === 'calls');
    expect(item?.section).toBe('communication');
    expect(item?.routes.map(r => r.href)).toEqual(['/staff/calls']);
  });
  it('never stores, injects HTML, dials or reaches a provider from the page', () => {
    for (const file of ['calls/staff-calls.tsx', 'calls/http.ts']) {
      const source = readFileSync(resolve('src/components', file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|twilio\.com|@twilio|apiKey/i);
    }
    expect(readFileSync(resolve('src/components/calls/staff-calls.tsx'), 'utf8')).not.toMatch(/startCall|loadPhoneToken/);
  });
});
