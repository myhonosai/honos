import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_NATURAL_VOICE_API, clipWaitMs, naturalSpeech, type AgentNaturalVoiceApi } from '../src/components/hon-command/agent-natural-voice';
import { HON_AGENT_VOICE_OPTIONS, honAgentVoice, type SpeechAdapter } from '../src/components/hon-command/hon-voice';

const scope = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function setup(opts: { natural?: boolean; clip?: 'ok' | 'fail' | 'hang'; playOk?: boolean } = {}) {
  const fallback = { spoken: [] as string[], cancelled: 0 };
  const browser: SpeechAdapter = { speak: (text, _lang, onDone) => { fallback.spoken.push(text); onDone(); }, cancel: () => { fallback.cancelled += 1; } };
  const calls = { status: [] as string[], clip: [] as { agent: string; text: string; key: string }[], played: 0, stopped: 0 };
  let release: ((b: Blob) => void) | null = null;
  const api: AgentNaturalVoiceApi = {
    status: async (_s, agent) => { calls.status.push(agent); return opts.natural === false ? { voice: 'BROWSER', reason: 'NOT_INCLUDED' } : { voice: 'NATURAL', reason: null }; },
    clip: (_s, agent, text, key) => {
      calls.clip.push({ agent, text, key });
      if (opts.clip === 'fail') return Promise.reject(new Error('busy'));
      if (opts.clip === 'hang') return new Promise<Blob>((res) => { release = res; });
      return Promise.resolve(new Blob(['RIFF'], { type: 'audio/wav' }));
    },
  };
  const play = (_b: Blob, onEnd: (ok: boolean) => void) => { calls.played += 1; queueMicrotask(() => onEnd(opts.playOk !== false)); return () => { calls.stopped += 1; }; };
  let n = 0;
  const speech = naturalSpeech(browser, scope, { api, play, newKey: () => `key-${++n}` });
  return { speech, fallback, calls, release: (b: Blob) => release?.(b) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('agent natural voice', () => {
  it('every voice option names its teammate, and choices keep their identity', () => {
    for (const [agent, options] of Object.entries(HON_AGENT_VOICE_OPTIONS)) for (const o of options) expect(o.profile.agent).toBe(agent);
    expect(honAgentVoice('kai', 2)).toBe(HON_AGENT_VOICE_OPTIONS.kai![1].profile);
  });

  it('reads an answer in the teammate’s natural voice when the server allows it, once', async () => {
    const t = setup(); const done = vi.fn();
    t.speech.speak('  Two renewals this month.  ', 'en-US', done, honAgentVoice('maya'));
    await flush(); await flush();
    expect(t.calls.status).toEqual(['maya']);
    expect(t.calls.clip).toEqual([{ agent: 'maya', text: 'Two renewals this month.', key: 'key-1' }]);
    expect(t.calls.played).toBe(1); expect(done).toHaveBeenCalledTimes(1); expect(t.fallback.spoken).toEqual([]);
    t.speech.speak('Next one.', 'en-US', () => undefined, honAgentVoice('maya'));
    await flush(); await flush();
    expect(t.calls.status).toEqual(['maya']); expect(t.calls.clip).toHaveLength(2);
  });

  it('uses the browser voice when the server says no, the text is too long or has a link, or no teammate is named', async () => {
    const no = setup({ natural: false }); const done = vi.fn();
    no.speech.speak('Hi.', 'en-US', done, honAgentVoice('chad'));
    await flush();
    expect(no.fallback.spoken).toEqual(['Hi.']); expect(no.calls.clip).toEqual([]); expect(done).toHaveBeenCalledTimes(1);
    const t = setup();
    t.speech.speak('x'.repeat(1001), 'en-US', () => undefined, honAgentVoice('hon'));
    t.speech.speak('See https://example.test', 'en-US', () => undefined, honAgentVoice('hon'));
    t.speech.speak('No profile.', 'en-US', () => undefined);
    t.speech.speak('Unknown.', 'en-US', () => undefined, { pitch: 1, rate: 1, voiceIndex: 0, agent: 'eian' });
    await flush();
    expect(t.calls.status).toEqual([]); expect(t.fallback.spoken).toHaveLength(4);
  });

  it('falls back when the clip fails, and keeps the browser voice for that teammate afterwards', async () => {
    const t = setup({ clip: 'fail' }); const done = vi.fn();
    t.speech.speak('First.', 'en-US', done, honAgentVoice('jordan'));
    await flush(); await flush();
    expect(t.fallback.spoken).toEqual(['First.']); expect(done).toHaveBeenCalledTimes(1);
    t.speech.speak('Second.', 'en-US', () => undefined, honAgentVoice('jordan'));
    await flush(); await flush();
    expect(t.calls.clip).toHaveLength(1); expect(t.fallback.spoken).toEqual(['First.', 'Second.']);
  });

  it('falls back when the clip cannot be played', async () => {
    const t = setup({ playOk: false }); const done = vi.fn();
    t.speech.speak('Hello.', 'en-US', done, honAgentVoice('alex'));
    await flush(); await flush();
    expect(t.calls.played).toBe(1); expect(t.fallback.spoken).toEqual(['Hello.']); expect(done).toHaveBeenCalledTimes(1);
  });

  it('reads with the browser voice when the clip is slow, and never plays the late clip', async () => {
    vi.useFakeTimers();
    const t = setup({ clip: 'hang' }); const done = vi.fn();
    t.speech.speak('Slow answer.', 'en-US', done, honAgentVoice('claire'));
    await flush();
    expect(t.calls.clip).toHaveLength(1);
    vi.advanceTimersByTime(clipWaitMs('Slow answer.'.length) + 1);
    expect(t.fallback.spoken).toEqual(['Slow answer.']); expect(done).toHaveBeenCalledTimes(1);
    t.release(new Blob(['RIFF'])); await flush();
    expect(t.calls.played).toBe(0); expect(done).toHaveBeenCalledTimes(1);
  });

  it('a cancel stops everything: no clip plays and nothing is read', async () => {
    const t = setup({ clip: 'hang' }); const done = vi.fn();
    t.speech.speak('Cancelled.', 'en-US', done, honAgentVoice('marcus'));
    await flush();
    t.speech.cancel();
    t.release(new Blob(['RIFF'])); await flush();
    expect(t.calls.played).toBe(0); expect(t.fallback.spoken).toEqual([]); expect(done).not.toHaveBeenCalled();
  });

  it('asks the server on its own same-origin route with its own command and a key', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({ data: init.method === 'GET' ? { voice: 'NATURAL', reason: null } : { audio: 'UklGRiQAAABXQVZF', mime: 'audio/wav' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await AGENT_NATURAL_VOICE_API.status(scope, 'lena', signal)).toEqual({ voice: 'NATURAL', reason: null });
    const blob = await AGENT_NATURAL_VOICE_API.clip(scope, 'lena', 'Hi.', '33333333-3333-4333-8333-333333333333', signal);
    expect(blob.type).toBe('audio/wav'); expect(blob.size).toBe(12);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/agents/lena/speech`);
    expect(init.method).toBe('POST'); expect(init.credentials).toBe('same-origin'); expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('agent.speech.speak');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('33333333-3333-4333-8333-333333333333');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hi.' });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'AGENT_SPEECH_BUSY' }), { status: 429, headers: { 'content-type': 'application/json' } }));
    await expect(AGENT_NATURAL_VOICE_API.clip(scope, 'lena', 'Hi.', 'k', signal)).rejects.toThrow();
  });
});
