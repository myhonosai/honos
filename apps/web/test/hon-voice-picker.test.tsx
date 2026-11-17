import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HON_VOICE_AGENT_KEYS } from '@hon/contracts';
import { AGENT_VOICE_API, AGENT_VOICE_DEFAULTS, AgentVoicePreferenceError, agentVoicePath, verifyAgentVoiceChoices } from '../src/components/hon-command/agent-voice-preference';
import { HON_AGENT_VOICES, HON_AGENT_VOICE_OPTIONS, honAgentVoice } from '../src/components/hon-command/hon-voice';
import { HonVoicePickerView, type AgentVoicesState } from '../src/components/hon-command/hon-voice-picker';
import { teamSpokenParts } from '../src/components/hon-command/hon-team-chat-model';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const body = (choices: unknown) => ({ data: { choices }, meta: { requestId: id(3), correlationId: id(3) } });

describe('voice choices: three free voices per teammate', () => {
  it('gives every teammate three different voices, the first being their usual one', () => {
    for (const k of HON_VOICE_AGENT_KEYS) {
      const options = HON_AGENT_VOICE_OPTIONS[k]!;
      expect(options).toHaveLength(3);
      expect(options[0].profile).toBe(HON_AGENT_VOICES[k]);
      expect(options[0].style).toBe('standard');
      expect(new Set(options.map((o) => `${o.profile.pitch}/${o.profile.rate}/${o.profile.voiceIndex}`)).size).toBe(3);
    }
    const all = HON_VOICE_AGENT_KEYS.flatMap((k) => HON_AGENT_VOICE_OPTIONS[k]!.map((o) => `${o.profile.pitch}/${o.profile.rate}/${o.profile.voiceIndex}`));
    expect(new Set(all).size).toBe(27);
  });
  it('maps a choice to its voice, and anything else to the usual voice', () => {
    expect(honAgentVoice('jordan', 2)).toBe(HON_AGENT_VOICE_OPTIONS.jordan![1].profile);
    expect(honAgentVoice('jordan', 3)).toBe(HON_AGENT_VOICE_OPTIONS.jordan![2].profile);
    for (const bad of [0, 4, NaN]) expect(honAgentVoice('jordan', bad)).toBe(HON_AGENT_VOICES.jordan);
    expect(honAgentVoice('jordan')).toBe(HON_AGENT_VOICES.jordan);
    expect(honAgentVoice('nobody', 2)).toBe(HON_AGENT_VOICE_OPTIONS.hon![1].profile);
  });
  it('reads each answer aloud in the voice chosen for that teammate', () => {
    const parts = teamSpokenParts([{ key: 'hon', reply: 'Focus.' }, { key: 'lena', reply: 'Buddy week.' }], (n) => `${n} says:`, { ...AGENT_VOICE_DEFAULTS, lena: 3 });
    expect(parts.map((p) => p.profile)).toEqual([HON_AGENT_VOICES.hon, HON_AGENT_VOICE_OPTIONS.lena![2].profile]);
  });
});

describe('voice choices: server answers are verified exactly', () => {
  it('accepts exactly the nine teammates with 1, 2 or 3', () => {
    expect(verifyAgentVoiceChoices(body({ ...AGENT_VOICE_DEFAULTS, kai: 2 }))).toEqual({ ...AGENT_VOICE_DEFAULTS, kai: 2 });
  });
  it('refuses missing, extra or out-of-range values (nothing is assumed)', () => {
    const { kai: _kai, ...missing } = AGENT_VOICE_DEFAULTS;
    for (const bad of [null, [], {}, { data: null }, body(null), body(missing), body({ ...AGENT_VOICE_DEFAULTS, zed: 1 }), body({ ...AGENT_VOICE_DEFAULTS, hon: 4 }),
      body({ ...AGENT_VOICE_DEFAULTS, hon: '2' }), body({ ...AGENT_VOICE_DEFAULTS, hon: 0 })]) {
      expect(() => verifyAgentVoiceChoices(bad)).toThrow(AgentVoicePreferenceError);
    }
  });
});

describe('voice choices: http', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads and saves only on the verified school path, with a retry key and a closed body', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify(body({ ...AGENT_VOICE_DEFAULTS, alex: 2 })), { status: 200 }); }));
    expect((await AGENT_VOICE_API.load(SCHOOL)).alex).toBe(2);
    expect((await AGENT_VOICE_API.save(SCHOOL, 'alex', 2, id(4))).alex).toBe(2);
    expect(calls.map(([u, i]) => [u, i.method])).toEqual([[`/api/v1/organizations/${id(1)}/schools/${id(2)}/agent-voices`, 'GET'], [`/api/v1/organizations/${id(1)}/schools/${id(2)}/agent-voices`, 'PUT']]);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ agentKey: 'alex', voiceChoice: 2 });
    expect((calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBe(id(4));
    expect(calls.every(([, i]) => i.credentials === 'same-origin' && i.cache === 'no-store')).toBe(true);
  });
  it('refuses a bad scope, teammate, choice or key before any request, and reports refusals', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    expect(() => agentVoicePath({ organizationId: 'x', schoolId: id(2) })).toThrow();
    expect(() => AGENT_VOICE_API.save(SCHOOL, 'bob' as never, 2, id(4))).toThrow();
    expect(() => AGENT_VOICE_API.save(SCHOOL, 'hon', 4 as never, id(4))).toThrow();
    expect(() => AGENT_VOICE_API.save(SCHOOL, 'hon', 2, 'retry')).toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(AGENT_VOICE_API.load(SCHOOL)).rejects.toMatchObject({ status: 403 });
  });
});

describe('voice picker view', () => {
  const state = (over: Partial<AgentVoicesState> = {}): AgentVoicesState => ({ choices: { ...AGENT_VOICE_DEFAULTS, jordan: 3 }, status: 'READY', saving: null, failed: null, ...over });
  const render = (over: Partial<AgentVoicesState> = {}, language = 'en', canPreview = true) =>
    renderToStaticMarkup(<HonVoicePickerView language={language} mode="modern" state={state(over)} canPreview={canPreview} onChoose={() => {}} onPreview={() => {}} />);
  it('lists all nine teammates with three voices each and the chosen one pressed', () => {
    const html = render();
    expect(html.match(/data-voice-agent=/g)).toHaveLength(9);
    expect(html.match(/data-voice-choice=/g)).toHaveLength(27);
    expect(html.match(/data-voice-hear=/g)).toHaveLength(27);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(9);
    expect(html).toMatch(/data-voice-agent="jordan"[\s\S]*?aria-pressed="true"[^>]*data-voice-choice="3"/);
    expect(html).toContain('Choose voices');
    expect(html).toContain('Nothing is charged');
  });
  it('locks the choices while loading or unavailable, and says why', () => {
    expect(render({ status: 'LOADING' })).toContain('Loading your voices');
    const off = render({ status: 'UNAVAILABLE' });
    expect(off).toContain('could not be loaded');
    expect(off.match(/data-voice-choice="\d"[^>]*>/g)!.length).toBe(27);
    expect(off).toMatch(/disabled=""[^>]*data-voice-choice/);
  });
  it('shows saving and a failed save for the one teammate', () => {
    expect(render({ saving: 'lena' })).toMatch(/data-voice-agent="lena"[\s\S]*Saving…/);
    expect(render({ failed: 'kai' })).toContain('Not saved. The previous voice is back');
  });
  it('hides "hear it" where the browser cannot speak, and speaks Korean and Spanish', () => {
    const quiet = render({}, 'en', false);
    expect(quiet).not.toContain('data-voice-hear');
    expect(quiet).toContain('This browser cannot speak');
    expect(render({}, 'ko')).toContain('목소리 선택');
    expect(render({}, 'es')).toContain('Elegir voces');
  });
});
