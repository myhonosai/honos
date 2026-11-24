import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { createNaturalEianVoice, NATURAL_VOICE_MAX_CHARACTERS, naturalVoiceWaitMs, type ClipPlayer, type EianSpeechApi } from '../src/eian/natural-voice';
import { PHONE_VOICE_NOTE, SPEECH_SERVICE_NOTE, type EianVoice } from '../src/eian/voice';
import { createExpoClipPlayer } from '../src/eian/expo-clip-player';
import { jsonResponse, NOW } from './fixtures';

type MockFile = { uri: string; exists: boolean; written: string | null; options: unknown; deleted: number };
jest.mock('expo-file-system', () => {
  const files: unknown[] = [];
  class File {
    uri: string; exists = false; written: string | null = null; options: unknown = null; deleted = 0;
    constructor(_dir: unknown, name: string) { this.uri = `file:///cache/${name}`; files.push(this); }
    create() { this.exists = true; }
    write(content: string, options: unknown) { this.written = content; this.options = options; }
    delete() { this.deleted += 1; this.exists = false; }
  }
  return { File, Paths: { cache: 'cache' }, files };
});
jest.mock('expo-audio', () => {
  const module: Record<string, unknown> = { players: [], fail: false };
  module.setAudioModeAsync = jest.fn(async () => undefined);
  module.createAudioPlayer = jest.fn((source: unknown) => {
    if (module.fail) throw new Error('no audio');
    const player = { source, played: 0, paused: 0, removed: 0, unsubscribed: 0, listener: null as unknown,
      play() { player.played += 1; }, pause() { player.paused += 1; }, remove() { player.removed += 1; },
      addListener(_name: string, listener: unknown) { player.listener = listener; return { remove() { player.unsubscribed += 1; } }; } };
    (module.players as unknown[]).push(player);
    return player;
  });
  return module;
});
type MockPlayer = { source: { uri: string }; played: number; paused: number; removed: number; unsubscribed: number; listener: (status: { didJustFinish: boolean }) => void };
const mockAudio = jest.requireMock('expo-audio') as { players: MockPlayer[]; fail: boolean; setAudioModeAsync: jest.Mock; createAudioPlayer: jest.Mock };
const mockFiles = (jest.requireMock('expo-file-system') as { files: MockFile[] }).files;

const AUDIO = 'SUQzAAAAAAAAAAAAAAAAAAAA';
const KEY = 'key-0000000000000001';
const natural = { ok: true as const, data: { voice: 'NATURAL' as const, reason: null } };
const clip = { ok: true as const, data: { audio: AUDIO, mime: 'audio/mpeg' as const }, replayed: false };
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function setup(overrides: Partial<EianSpeechApi> = {}, withApi = true) {
  const phone = { spoken: [] as string[], stops: 0, done: null as null | ((finished: boolean) => void) };
  const phoneVoice: EianVoice = {
    speak(text, onDone) { phone.spoken.push(text); phone.done = onDone; },
    stopSpeaking() { phone.stops += 1; },
    canListen: () => true,
    listen: jest.fn(() => ({ stop() {}, cancel() {} })),
  };
  const played: { audio: string; done: (finished: boolean) => void; stopped: number }[] = [];
  const player: ClipPlayer = { play(audio, done) { const entry = { audio, done, stopped: 0 }; played.push(entry); return { stop() { entry.stopped += 1; } }; } };
  const api = { eianSpeechStatus: jest.fn(async () => natural), eianSpeak: jest.fn(async () => clip), ...overrides } as { eianSpeechStatus: jest.Mock; eianSpeak: jest.Mock };
  let clock = 1_000_000;
  const voice = createNaturalEianVoice({ api: () => (withApi ? api : null), phone: phoneVoice, player, newKey: () => KEY, now: () => clock });
  return { voice, phone, phoneVoice, played, api, advance: (ms: number) => { clock += ms; } };
}

describe("Eian's natural voice", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('asks HON for one clip of the exact words and plays it', async () => {
    const { voice, phone, played, api } = setup();
    const done = jest.fn();
    voice.speak('  Maya has class at four thirty.  ', done);
    await flush();
    expect(api.eianSpeechStatus).toHaveBeenCalledTimes(1);
    expect(api.eianSpeak).toHaveBeenCalledWith('Maya has class at four thirty.', KEY);
    expect(played).toHaveLength(1);
    expect(played[0]!.audio).toBe(AUDIO);
    expect(phone.spoken).toEqual([]);
    played[0]!.done(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(true);
    // The wait for a slow clip no longer applies once the clip is playing.
    jest.advanceTimersByTime(60_000);
    expect(phone.spoken).toEqual([]);
    expect(voice.speechService).toBe(true);
  });

  it('checks the status once for a few minutes, not for every answer', async () => {
    const { voice, played, api, advance } = setup();
    voice.speak('One.', jest.fn()); await flush(); played[0]!.done(true);
    voice.speak('Two.', jest.fn()); await flush(); played[1]!.done(true);
    expect(api.eianSpeechStatus).toHaveBeenCalledTimes(1);
    expect(api.eianSpeak).toHaveBeenCalledTimes(2);
    advance(5 * 60_000 + 1);
    voice.speak('Three.', jest.fn()); await flush();
    expect(api.eianSpeechStatus).toHaveBeenCalledTimes(2);
  });

  it("uses the phone's own voice when the school does not have the natural voice, and does not ask again for a while", async () => {
    const { voice, phone, played, api, advance } = setup({ eianSpeechStatus: jest.fn(async () => ({ ok: true as const, data: { voice: 'PHONE' as const, reason: 'NOT_INCLUDED' as const } })) });
    const done = jest.fn();
    voice.speak('Class is at four.', done); await flush();
    expect(phone.spoken).toEqual(['Class is at four.']);
    expect(api.eianSpeak).not.toHaveBeenCalled();
    phone.done!(true);
    expect(done).toHaveBeenCalledWith(true);
    voice.speak('Again.', jest.fn()); await flush();
    expect(api.eianSpeechStatus).toHaveBeenCalledTimes(1);
    expect(phone.spoken).toEqual(['Class is at four.', 'Again.']);
    advance(5 * 60_000 + 1);
    voice.speak('Later.', jest.fn()); await flush();
    expect(api.eianSpeechStatus).toHaveBeenCalledTimes(2);
    expect(played).toHaveLength(0);
  });

  it("falls back to the phone's own voice when a clip is refused, lost or cannot be made, and never asks twice", async () => {
    for (const failure of [{ ok: false as const, state: 'refused' as const, code: 'EIAN_SPEECH_DAILY_LIMIT' }, { ok: false as const, state: 'refused' as const, code: 'EIAN_SPEECH_UNAVAILABLE' },
      { ok: false as const, state: 'unknown' as const }, { ok: false as const, state: 'signed-out' as const }]) {
      const { voice, phone, played, api } = setup({ eianSpeak: jest.fn(async () => failure) });
      voice.speak('Class is at four.', jest.fn()); await flush();
      expect(phone.spoken).toEqual(['Class is at four.']);
      expect(api.eianSpeak).toHaveBeenCalledTimes(1);
      expect(played).toHaveLength(0);
    }
    const thrown = setup({ eianSpeak: jest.fn(async () => { throw new Error('bad key'); }) });
    thrown.voice.speak('Class is at four.', jest.fn()); await flush();
    expect(thrown.phone.spoken).toEqual(['Class is at four.']);
    const offline = setup({ eianSpeechStatus: jest.fn(async () => ({ ok: false as const, state: 'offline' as const })) });
    offline.voice.speak('Class is at four.', jest.fn()); await flush();
    expect(offline.phone.spoken).toEqual(['Class is at four.']);
    // Offline is not remembered: the next answer checks again.
    offline.voice.speak('Next.', jest.fn()); await flush();
    expect(offline.api.eianSpeechStatus).toHaveBeenCalledTimes(2);
  });

  it('a limit is remembered: a definite refusal sends the next answers straight to the phone voice', async () => {
    const { voice, phone, api, advance } = setup({ eianSpeak: jest.fn(async () => ({ ok: false as const, state: 'refused' as const, code: 'EIAN_SPEECH_BUSY' })) });
    voice.speak('One.', jest.fn()); await flush();
    voice.speak('Two.', jest.fn()); await flush();
    expect(api.eianSpeak).toHaveBeenCalledTimes(1);
    expect(phone.spoken).toEqual(['One.', 'Two.']);
    advance(60_001);
    voice.speak('Three.', jest.fn()); await flush();
    expect(api.eianSpeak).toHaveBeenCalledTimes(2);
  });

  it("reads with the phone's own voice when the clip is slow, and drops the late clip", async () => {
    let deliver!: (value: typeof clip) => void;
    const { voice, phone, played } = setup({ eianSpeak: jest.fn(() => new Promise<typeof clip>(resolve => { deliver = resolve; })) });
    const done = jest.fn();
    const text = 'Maya has class at four thirty.';
    voice.speak(text, done); await flush();
    jest.advanceTimersByTime(naturalVoiceWaitMs(text.length) - 1);
    expect(phone.spoken).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(phone.spoken).toEqual([text]);
    deliver(clip); await flush();
    expect(played).toHaveLength(0);
    phone.done!(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(naturalVoiceWaitMs(150)).toBe(4800);
    expect(naturalVoiceWaitMs(5000)).toBe(3000 + 12 * NATURAL_VOICE_MAX_CHARACTERS);
  });

  it("long answers, an empty answer and a missing API go straight to the phone's own voice", async () => {
    const long = setup();
    long.voice.speak('x'.repeat(NATURAL_VOICE_MAX_CHARACTERS + 1), jest.fn()); await flush();
    expect(long.phone.spoken).toHaveLength(1);
    expect(long.api.eianSpeechStatus).not.toHaveBeenCalled();
    const none = setup({}, false);
    none.voice.speak('Class is at four.', jest.fn()); await flush();
    expect(none.phone.spoken).toEqual(['Class is at four.']);
  });

  it('stop ends a playing clip, tells the screen once and drops a clip that is still on its way', async () => {
    const { voice, phone, played } = setup();
    const done = jest.fn();
    voice.speak('Class is at four.', done); await flush();
    voice.stopSpeaking();
    expect(played[0]!.stopped).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(false);
    played[0]!.done(false);
    expect(done).toHaveBeenCalledTimes(1);
    expect(phone.stops).toBeGreaterThan(0);

    let deliver!: (value: typeof clip) => void;
    const waiting = setup({ eianSpeak: jest.fn(() => new Promise<typeof clip>(resolve => { deliver = resolve; })) });
    const waitingDone = jest.fn();
    waiting.voice.speak('Class is at four.', waitingDone); await flush();
    waiting.voice.stopSpeaking();
    expect(waitingDone).toHaveBeenCalledWith(false);
    deliver(clip); await flush();
    jest.advanceTimersByTime(60_000);
    expect(waiting.played).toHaveLength(0);
    expect(waiting.phone.spoken).toEqual([]);
    expect(waitingDone).toHaveBeenCalledTimes(1);
  });

  it('a new answer replaces the one being read', async () => {
    const { voice, played } = setup();
    const first = jest.fn(), second = jest.fn();
    voice.speak('One.', first); await flush();
    voice.speak('Two.', second); await flush();
    expect(played).toHaveLength(2);
    expect(played[0]!.stopped).toBe(1);
    expect(first).toHaveBeenCalledWith(false);
    played[1]!.done(true);
    expect(second).toHaveBeenCalledWith(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("listening is always the phone's own", () => {
    const { voice, phoneVoice } = setup();
    const on = { partial: jest.fn(), end: jest.fn() };
    expect(voice.canListen()).toBe(true);
    voice.listen(on, ['Mia']);
    expect(phoneVoice.listen).toHaveBeenCalledWith(on, ['Mia']);
  });
});

describe('the clip player on the phone', () => {
  beforeEach(() => { mockAudio.players.length = 0; mockFiles.length = 0; mockAudio.fail = false; jest.clearAllMocks(); });

  it('plays the clip from the private cache and deletes it when it ends', () => {
    const done = jest.fn();
    createExpoClipPlayer()!.play(AUDIO, done);
    const file = mockFiles[0]!, player = mockAudio.players[0]!;
    expect(file.uri).toMatch(/^file:\/\/\/cache\/eian-voice-\d+-\d+\.mp3$/);
    expect(file.written).toBe(AUDIO);
    expect(file.options).toEqual({ encoding: 'base64' });
    expect(player.source).toEqual({ uri: file.uri });
    expect(player.played).toBe(1);
    expect(mockAudio.setAudioModeAsync).toHaveBeenCalledWith({ playsInSilentMode: true });
    player.listener({ didJustFinish: false });
    expect(done).not.toHaveBeenCalled();
    player.listener({ didJustFinish: true });
    expect(done).toHaveBeenCalledWith(true);
    expect(file.deleted).toBe(1);
    expect(player.removed).toBe(1);
    expect(player.unsubscribed).toBe(1);
    player.listener({ didJustFinish: true });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('stop ends playback, deletes the clip and reports once', () => {
    const done = jest.fn();
    const handle = createExpoClipPlayer()!.play(AUDIO, done);
    handle.stop(); handle.stop();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(false);
    expect(mockFiles[0]!.deleted).toBe(1);
    expect(mockAudio.players[0]!.paused).toBe(1);
  });

  it('a clip that cannot play is deleted and reported as not finished', () => {
    mockAudio.fail = true;
    const done = jest.fn();
    createExpoClipPlayer()!.play(AUDIO, done);
    expect(done).toHaveBeenCalledWith(false);
    expect(mockFiles[0]!.deleted).toBe(1);
  });
});

describe("Eian's natural voice: client and screen", () => {
  const client = (fetchImpl: jest.Mock) => createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl, timeoutMs: 1000 });

  it('reads the voice status with no selector and verifies it', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { voice: 'PHONE', reason: 'BUDGET_REACHED' } }));
    expect(await client(fetchImpl).eianSpeechStatus()).toEqual({ ok: true, data: { voice: 'PHONE', reason: 'BUDGET_REACHED' } });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.test/v1/parent/eian/speech/status');
    const bad = jest.fn().mockResolvedValue(jsonResponse(200, { data: { voice: 'NATURAL', reason: null, model: 'x' } }));
    expect(await client(bad).eianSpeechStatus()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('asks for a clip naming only the words, as its own command with a key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { audio: AUDIO, mime: 'audio/mpeg' } }));
    const result = await client(fetchImpl).eianSpeak('Class is at four.', KEY);
    expect(result).toEqual({ ok: true, data: { audio: AUDIO, mime: 'audio/mpeg' }, replayed: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/eian/speech');
    expect(init.headers['x-hon-human-command']).toBe('parent.eian.speak');
    expect(init.headers['Idempotency-Key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({ text: 'Class is at four.' });
    const off = jest.fn().mockResolvedValue(jsonResponse(503, { code: 'EIAN_SPEECH_UNAVAILABLE' }));
    expect(await client(off).eianSpeak('Hi.', KEY)).toEqual({ ok: false, state: 'refused', code: 'EIAN_SPEECH_UNAVAILABLE' });
    const limit = jest.fn().mockResolvedValue(jsonResponse(429, { code: 'EIAN_SPEECH_DAILY_LIMIT' }));
    expect(await client(limit).eianSpeak('Hi.', KEY)).toEqual({ ok: false, state: 'refused', code: 'EIAN_SPEECH_DAILY_LIMIT' });
    const wrong = jest.fn().mockResolvedValue(jsonResponse(201, { data: { audio: AUDIO, mime: 'audio/wav' } }));
    expect(await client(wrong).eianSpeak('Hi.', KEY)).toEqual({ ok: false, state: 'unknown' });
    await expect(async () => client(jest.fn()).eianSpeak('See https://example.test', KEY)).rejects.toThrow();
  });

  it("the sample family never reaches the speech service", async () => {
    const sample = createSampleApi(() => new Date(NOW));
    expect(await sample.eianSpeechStatus()).toEqual({ ok: true, data: { voice: 'PHONE', reason: 'NOT_INCLUDED' } });
    expect(await sample.eianSpeak('Hi.', KEY)).toEqual({ ok: false, state: 'refused', code: 'EIAN_SPEECH_UNAVAILABLE' });
  });

  it('the screen says when answers may be read by a speech service, and reads the sample family with the phone voice', async () => {
    const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
    const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
    const phone = { spoken: [] as string[] };
    const phoneVoice: EianVoice = { speak(text) { phone.spoken.push(text); }, stopSpeaking() {}, canListen: () => false, listen: () => ({ stop() {}, cancel() {} }) };
    const played: string[] = [];
    const player: ClipPlayer = { play(audio) { played.push(audio); return { stop() {} }; } };
    await render(<ParentApp api={liveApi} session={signedOut} now={() => new Date(NOW)} newKey={() => KEY} sampleApi={() => createSampleApi(() => new Date(NOW))} voice={phoneVoice} clipPlayer={player} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
    await screen.findByRole('button', { name: 'Open Mia Sample journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
    await screen.findByText(/next class is/);
    expect(screen.getByText(SPEECH_SERVICE_NOTE)).toBeTruthy();
    expect(screen.queryByText(PHONE_VOICE_NOTE)).toBeNull();
    expect(SPEECH_SERVICE_NOTE).toMatch(/speech service/);
    expect(SPEECH_SERVICE_NOTE).toMatch(/children's names/);
    expect(SPEECH_SERVICE_NOTE).toMatch(/No recording of you is sent/);
    await fireEvent.press(screen.getAllByRole('button', { name: "Read Eian's answer aloud" })[0]!);
    await act(async () => { await flush(); });
    expect(phone.spoken).toHaveLength(1);
    expect(played).toEqual([]);
  });
});
