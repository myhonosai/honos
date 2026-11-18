import { describe, expect, it } from 'vitest';
import {
  HON_VOICE_LIMITS, HonVoiceController, honVoiceLang, isStopPhrase, meaningfulQuestion, parseWake, speakableText, detectHonVoiceSupport, onDeviceSpeech,
  HON_AGENT_VOICES, honAgentVoice, type HonVoiceProfile,
  type RecognitionAdapter, type RecognitionHandlers, type RecognitionOptions, type SpeechAdapter, type VoiceTimer,
} from '../src/components/hon-command/hon-voice';

describe('voice language', () => {
  it('follows the app language and defaults to US English', () => {
    expect(honVoiceLang('ko')).toBe('ko-KR');
    expect(honVoiceLang('es')).toBe('es-US');
    expect(honVoiceLang('en')).toBe('en-US');
    expect(honVoiceLang('fr')).toBe('en-US');
    expect(honVoiceLang(undefined)).toBe('en-US');
  });
});

describe('wake phrase', () => {
  it('wakes on "Hey HON" with the question that follows', () => {
    expect(parseWake('Hey HON, how many trials do we have this week?', 'en-US')).toEqual({ woke: true, question: 'how many trials do we have this week' });
    expect(parseWake('hey hun', 'en-US')).toEqual({ woke: true, question: '' });
    expect(parseWake('OK Hon what is on today', 'en-US')).toEqual({ woke: true, question: 'what is on today' });
    expect(parseWake('so, hey Hahn. Who missed class?', 'en-US')).toEqual({ woke: true, question: 'Who missed class' });
    expect(parseWake('Hey,HON how many trials today', 'en-US')).toEqual({ woke: true, question: 'how many trials today' });
    expect(parseWake('um-hmm hey hon who is new', 'en-US')).toEqual({ woke: true, question: 'who is new' });
  });
  it('ignores speech without the wake phrase', () => {
    expect(parseWake('honestly the class was great', 'en-US').woke).toBe(false);
    expect(parseWake('hey everyone line up', 'en-US').woke).toBe(false);
    expect(parseWake('', 'en-US').woke).toBe(false);
  });
  it('knows the Korean and Spanish wake phrases and always accepts the English one', () => {
    expect(parseWake('헤이 혼 오늘 체험 수업 몇 개야', 'ko-KR')).toEqual({ woke: true, question: '오늘 체험 수업 몇 개야' });
    expect(parseWake('헤이혼', 'ko-KR').woke).toBe(true);
    expect(parseWake('Oye HON, ¿cuántos alumnos nuevos?', 'es-US')).toEqual({ woke: true, question: 'cuántos alumnos nuevos' });
    expect(parseWake('hey hon que tal', 'es-US').woke).toBe(true);
    expect(parseWake('hey jon', 'en-US').woke).toBe(false);
  });
});

describe('stop phrases and questions', () => {
  it('ends the conversation on stop, thanks and goodbye, in each language', () => {
    for (const text of ['Stop', "that's all", 'Thank you HON', 'goodbye.', 'never mind', 'OK thanks']) expect(isStopPhrase(text, 'en-US')).toBe(true);
    for (const text of ['그만', '고마워', '감사합니다']) expect(isStopPhrase(text, 'ko-KR')).toBe(true);
    for (const text of ['Gracias', 'eso es todo', 'adiós']) expect(isStopPhrase(text, 'es-US')).toBe(true);
    expect(isStopPhrase('stop the trial for Ana', 'en-US')).toBe(false);
    expect(isStopPhrase('thanks, now show my leads', 'en-US')).toBe(false);
  });
  it('treats mumbles as not a question', () => {
    expect(meaningfulQuestion('uh')).toBe(false);
    expect(meaningfulQuestion('   ')).toBe(false);
    expect(meaningfulQuestion('attendance?')).toBe(true);
    expect(meaningfulQuestion('출석 현황')).toBe(true);
  });
});

describe('speakable text', () => {
  it('removes formatting and links', () => {
    expect(speakableText('**Three** leads:\n- Ana\n- Ben\nSee https://example.com/x for more.', 'en-US')).toBe('Three leads: Ana. Ben. See a link for more.');
  });
  it('trims long answers at a sentence and says the rest is on screen', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const spoken = speakableText(long, 'en-US');
    expect(spoken.length).toBeLessThanOrEqual(HON_VOICE_LIMITS.spokenCharacters + 40);
    expect(spoken.endsWith('The rest is on screen.')).toBe(true);
    expect(spoken).toContain('Sentence number 0 is here.');
    expect(speakableText(long, 'ko-KR').endsWith('나머지는 화면에 있어요.')).toBe(true);
  });
});

describe('browser support', () => {
  it('detects recognition and speech output', () => {
    expect(detectHonVoiceSupport({} as never)).toEqual({ recognition: false, synthesis: false });
    expect(detectHonVoiceSupport({ webkitSpeechRecognition: function () {}, speechSynthesis: {}, SpeechSynthesisUtterance: function () {} } as never)).toEqual({ recognition: true, synthesis: true });
  });
  it('reports on-device recognition only when the browser says it is available', async () => {
    expect(await onDeviceSpeech({} as never, 'en-US')).toBe('unavailable');
    const seen: unknown[] = [];
    const Ctor = Object.assign(function () {}, { available: async (options: unknown) => { seen.push(options); return 'available'; } });
    expect(await onDeviceSpeech({ SpeechRecognition: Ctor } as never, 'en-US')).toBe('available');
    expect(seen).toEqual([{ langs: ['en-US'], processLocally: true }]);
    const Down = Object.assign(function () {}, { available: async () => 'downloadable' });
    expect(await onDeviceSpeech({ SpeechRecognition: Down } as never, 'en-US')).toBe('downloadable');
    const Broken = Object.assign(function () {}, { available: async () => { throw new Error('x'); } });
    expect(await onDeviceSpeech({ SpeechRecognition: Broken } as never, 'en-US')).toBe('unavailable');
    const Odd = Object.assign(function () {}, { available: async () => 'maybe' });
    expect(await onDeviceSpeech({ SpeechRecognition: Odd } as never, 'en-US')).toBe('unavailable');
  });
});

/* ------------------------------ controller ------------------------------ */

type Session = { options: RecognitionOptions; handlers: RecognitionHandlers; stopped: boolean; aborted: boolean };
function fakes() {
  const sessions: Session[] = [];
  const spoken: string[] = [];
  const profiles: (HonVoiceProfile | undefined)[] = [];
  let speakDone: (() => void) | null = null;
  let cancelled = 0;
  const timers = new Map<number, () => void>(); let nextTimer = 1;
  const recognition: RecognitionAdapter = {
    start(options, handlers) {
      const session: Session = { options, handlers, stopped: false, aborted: false }; sessions.push(session);
      return { stop: () => { session.stopped = true; }, abort: () => { session.aborted = true; } };
    },
  };
  const speech: SpeechAdapter = {
    speak(text, _lang, onDone, profile) { spoken.push(text); profiles.push(profile); speakDone = onDone; },
    cancel() { cancelled++; speakDone = null; },
  };
  const timer: VoiceTimer = { set(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clear(id) { timers.delete(id as number); } };
  const asked: string[] = [];
  let accept = true;
  const controller = new HonVoiceController({ recognition, speech, timer, lang: 'en-US', ask: (text) => { if (!accept) return false; asked.push(text); return true; } });
  return {
    controller, sessions, spoken, profiles, asked, timers,
    last: () => sessions[sessions.length - 1]!,
    finishSpeaking: () => { const done = speakDone; speakDone = null; done?.(); },
    fireTimers: () => { const all = [...timers.values()]; timers.clear(); for (const fn of all) fn(); },
    reject: () => { accept = false; },
    get cancelled() { return cancelled; },
  };
}

describe('HonVoiceController: tap to talk', () => {
  it('listens once, sends the question, speaks the answer, then listens for a follow-up', () => {
    const f = fakes();
    expect(f.controller.snapshot().state).toBe('IDLE');
    f.controller.talk();
    expect(f.controller.snapshot().state).toBe('LISTENING');
    expect(f.last().options).toEqual({ lang: 'en-US', continuous: false, onDevice: false });
    f.last().handlers.onInterim('how many');
    expect(f.controller.snapshot().heard).toBe('how many');
    f.last().handlers.onFinal('How many trials today');
    expect(f.asked).toEqual(['How many trials today']);
    expect(f.controller.snapshot().state).toBe('SENDING');
    f.controller.reply('You have **3** trials today.');
    expect(f.controller.snapshot().state).toBe('SPEAKING');
    expect(f.spoken).toEqual(['You have 3 trials today.']);
    f.finishSpeaking();
    expect(f.controller.snapshot().state).toBe('FOLLOW_UP');
    expect(f.sessions).toHaveLength(2);
    f.last().handlers.onFinal('Who are they');
    expect(f.asked).toEqual(['How many trials today', 'Who are they']);
  });

  it('goes back to rest when the follow-up window passes in silence', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('Any new leads'); f.controller.reply('Two.'); f.finishSpeaking();
    expect(f.controller.snapshot().state).toBe('FOLLOW_UP');
    const followUp = f.last();
    f.fireTimers();
    expect(followUp.aborted).toBe(true);
    expect(f.controller.snapshot().state).toBe('IDLE');
    followUp.handlers.onFinal('late words from a stale session');
    expect(f.asked).toEqual(['Any new leads']);
  });

  it('ends on a stop phrase without sending it', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('Any new leads'); f.controller.reply('Two.'); f.finishSpeaking();
    f.last().handlers.onFinal('thank you');
    expect(f.asked).toEqual(['Any new leads']);
    expect(f.controller.snapshot().state).toBe('IDLE');
  });

  it('does not send a mumble and says it did not catch that', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('uh');
    expect(f.asked).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', message: 'I didn’t catch that. Tap Talk and try again.' });
  });

  it('rests with a message when nothing was heard', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onError('no-speech'); f.last().handlers.onEnd();
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', message: 'I didn’t hear anything.' });
  });

  it('explains when the microphone is refused and stops listening', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onError('not-allowed');
    expect(f.controller.snapshot()).toMatchObject({ state: 'BLOCKED', message: 'Microphone access is blocked for this site. Allow it in your browser settings to talk to HON.' });
    expect(f.sessions[0]!.aborted).toBe(true);
  });

  it('keeps the question out of the composer when the panel cannot take it right now', () => {
    const f = fakes(); f.reject();
    f.controller.talk(); f.last().handlers.onFinal('How many trials today');
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', message: 'HON can’t take a question right now. Check the screen.' });
  });

  it('can be stopped while speaking', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('Any new leads'); f.controller.reply('Two.');
    f.controller.stopSpeaking();
    expect(f.cancelled).toBe(1);
    expect(f.controller.snapshot().state).toBe('IDLE');
    expect(f.sessions).toHaveLength(1);
  });

  it('ignores a reply it is not waiting for', () => {
    const f = fakes();
    f.controller.reply('stray');
    expect(f.spoken).toEqual([]);
    expect(f.controller.snapshot().state).toBe('IDLE');
  });
});

describe('HonVoiceController: Hey HON hands-free', () => {
  function handsFree() { const f = fakes(); f.controller.setOnDevice(true); f.controller.setHandsFree(true); return f; }

  it('needs on-device recognition', () => {
    const f = fakes();
    f.controller.setHandsFree(true);
    expect(f.controller.snapshot().handsFree).toBe(false);
    expect(f.sessions).toHaveLength(0);
  });

  it('waits on the device for the wake phrase without showing what the room says', () => {
    const f = handsFree();
    expect(f.controller.snapshot()).toMatchObject({ state: 'WAITING_WAKE', handsFree: true });
    expect(f.last().options).toEqual({ lang: 'en-US', continuous: true, onDevice: true });
    f.last().handlers.onInterim('the kids are lining up');
    f.last().handlers.onFinal('the kids are lining up');
    expect(f.controller.snapshot().heard).toBe('');
    expect(f.asked).toEqual([]);
  });

  it('answers "Hey HON <question>" in one breath and returns to waiting', () => {
    const f = handsFree();
    const wake = f.last();
    wake.handlers.onFinal('hey hon how many trials today');
    expect(wake.aborted).toBe(true);
    expect(f.asked).toEqual(['how many trials today']);
    f.controller.reply('Three.'); f.finishSpeaking();
    expect(f.controller.snapshot().state).toBe('FOLLOW_UP');
    expect(f.last().options.onDevice).toBe(true);
    f.fireTimers();
    expect(f.controller.snapshot().state).toBe('WAITING_WAKE');
  });

  it('listens for the question after a bare "Hey HON"', () => {
    const f = handsFree();
    f.last().handlers.onFinal('hey hon');
    expect(f.controller.snapshot().state).toBe('LISTENING');
    expect(f.last().options.continuous).toBe(false);
    f.last().handlers.onFinal('who missed class');
    expect(f.asked).toEqual(['who missed class']);
  });

  it('restarts the wake listener when the browser ends it, up to a limit', () => {
    const f = handsFree();
    for (let i = 0; i < HON_VOICE_LIMITS.maxQuietRestarts; i++) {
      const before = f.sessions.length;
      f.last().handlers.onEnd();
      expect(f.sessions).toHaveLength(before); // waits before restarting: never a tight loop
      f.fireTimers();
      expect(f.sessions).toHaveLength(before + 1);
    }
    expect(f.controller.snapshot().state).toBe('WAITING_WAKE');
    f.last().handlers.onEnd();
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', handsFree: false, message: 'Hands-free listening stopped. Turn it on again when you need it.' });
  });

  it('pauses after ten spoken questions in a row until someone taps', () => {
    const f = handsFree();
    for (let i = 0; i < HON_VOICE_LIMITS.questionsInARow; i++) {
      f.last().handlers.onFinal(`hey hon question number ${i}`);
      f.controller.reply('Answer.'); f.finishSpeaking();
      if (f.controller.snapshot().state === 'FOLLOW_UP') f.fireTimers();
    }
    expect(f.asked).toHaveLength(HON_VOICE_LIMITS.questionsInARow);
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', handsFree: false, message: 'Paused after 10 spoken questions. Tap Talk or turn hands-free on to keep going.' });
    f.controller.talk(); f.last().handlers.onFinal('one more question');
    expect(f.asked).toHaveLength(HON_VOICE_LIMITS.questionsInARow + 1);
  });

  it('turning hands-free off stops listening', () => {
    const f = handsFree();
    const wake = f.last();
    f.controller.setHandsFree(false);
    expect(wake.aborted).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', handsFree: false });
  });
});

describe('HonVoiceController: shutdown', () => {
  it('stops listening and speaking, turns hands-free off and ignores late events', () => {
    const f = fakes(); f.controller.setOnDevice(true); f.controller.setHandsFree(true);
    f.last().handlers.onFinal('hey hon any leads'); f.controller.reply('Two.');
    f.controller.shutdown();
    expect(f.cancelled).toBeGreaterThan(0);
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', handsFree: false, heard: '' });
    f.finishSpeaking();
    f.controller.reply('late');
    expect(f.controller.snapshot().state).toBe('IDLE');
    expect(f.sessions.every((s) => s.aborted || s.stopped)).toBe(true);
  });

  it('notifies subscribers on every change', () => {
    const f = fakes(); let calls = 0;
    const off = f.controller.subscribe(() => { calls++; });
    f.controller.talk();
    expect(calls).toBeGreaterThan(0);
    off(); const before = calls; f.controller.shutdown();
    expect(calls).toBe(before);
  });
});

describe('HonVoiceController: cancel listening and reply text', () => {
  it('a tap on Stop listening rests without sending', () => {
    const f = fakes();
    f.controller.talk(); const session = f.last();
    f.controller.cancelListening();
    expect(session.aborted).toBe(true);
    session.handlers.onFinal('how many trials');
    expect(f.asked).toEqual([]);
    expect(f.controller.snapshot().state).toBe('IDLE');
  });
  it('speaks the answer, or a line pointing at the screen', async () => {
    const { honVoiceReplyText } = await import('../src/components/hon-command/hon-voice');
    expect(honVoiceReplyText({ status: 'COMPLETED', reply: 'Three trials.' }, 'en-US')).toBe('Three trials.');
    expect(honVoiceReplyText({ status: 'AWAITING_APPROVAL', reply: null }, 'en-US')).toBe('Done. The details are on screen.');
    expect(honVoiceReplyText({ status: 'FAILED', reply: null }, 'es-US')).toBe('No pude responder eso. Los detalles están en pantalla.');
    expect(honVoiceReplyText({ status: 'COMPLETED', reply: '  ' }, 'en-US')).toBe('Done. The details are on screen.');
  });
});

describe('review fixes', () => {
  it('a mumble after "Hey HON" is not sent; HON listens for the real question', () => {
    const f = fakes(); f.controller.setOnDevice(true); f.controller.setHandsFree(true);
    f.last().handlers.onFinal('hey hon uh');
    expect(f.asked).toEqual([]);
    expect(f.controller.snapshot().state).toBe('LISTENING');
  });
  it('"Hey HON, thanks" in the room is ignored', () => {
    const f = fakes(); f.controller.setOnDevice(true); f.controller.setHandsFree(true);
    f.last().handlers.onFinal('hey hon thanks');
    expect(f.asked).toEqual([]);
    expect(f.controller.snapshot().state).toBe('WAITING_WAKE');
  });
  it('a blocked microphone recovers after a tap (or turning voice off and on)', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onError('audio-capture');
    expect(f.controller.snapshot().state).toBe('BLOCKED');
    f.controller.talk();
    expect(f.controller.snapshot().state).toBe('LISTENING');
    f.last().handlers.onError('not-allowed');
    f.controller.shutdown();
    expect(f.controller.snapshot().state).toBe('IDLE');
  });
  it('a network failure says so instead of "I didn’t hear anything"', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onError('network'); f.last().handlers.onEnd();
    expect(f.controller.snapshot()).toMatchObject({ state: 'IDLE', message: 'Voice needs an internet connection in this browser right now. Type your question instead.' });
  });
  it('splits a long run without sentence ends into short pieces', async () => {
    const { splitLong } = await import('../src/components/hon-command/hon-voice');
    const run = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const pieces = splitLong(run);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 200)).toBe(true);
    expect(pieces.join('')).toBe(run);
    expect(splitLong('x'.repeat(450)).map((p) => p.length)).toEqual([200, 200, 50]);
  });
});

describe('HonVoiceController: team chat voices', () => {
  it('reads each teammate in turn, in their own voice, then listens for a follow-up', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('What should we do this week');
    f.controller.replyParts([{ text: 'HON says: focus on trials.', profile: honAgentVoice('hon') }, { text: 'Jordan says: two classes have no instructor.', profile: honAgentVoice('jordan') }]);
    expect(f.controller.snapshot().state).toBe('SPEAKING');
    expect(f.spoken).toEqual(['HON says: focus on trials.']);
    f.finishSpeaking();
    expect(f.spoken).toEqual(['HON says: focus on trials.', 'Jordan says: two classes have no instructor.']);
    expect(f.profiles).toEqual([HON_AGENT_VOICES.hon, HON_AGENT_VOICES.jordan]);
    f.finishSpeaking();
    expect(f.controller.snapshot().state).toBe('FOLLOW_UP');
  });
  it('shares the spoken length between the parts and keeps the rest on screen', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('Team, what now');
    const long = 'This is one long sentence about the school. '.repeat(30);
    f.controller.replyParts(['hon', 'claire', 'alex', 'jordan', 'lena'].map((k) => ({ text: long, profile: honAgentVoice(k) })));
    for (let i = 0; i < 5; i++) f.finishSpeaking();
    expect(f.spoken).toHaveLength(5);
    expect(f.spoken.every((s) => s.length <= 160 + 40 && s.endsWith('The rest is on screen.'))).toBe(true);
    expect(f.spoken.join(' ').length).toBeLessThan(HON_VOICE_LIMITS.spokenCharacters * 2);
  });
  it('stops every part at once', () => {
    const f = fakes();
    f.controller.talk(); f.last().handlers.onFinal('Team, what now');
    f.controller.replyParts([{ text: 'One.' }, { text: 'Two.' }]);
    f.controller.stopSpeaking();
    f.finishSpeaking();
    expect(f.spoken).toEqual(['One.']);
    expect(f.controller.snapshot().state).toBe('IDLE');
  });
  it('gives every teammate a voice and falls back to HON for anyone else', () => {
    for (const k of ['hon', 'claire', 'alex', 'jordan', 'lena', 'marcus', 'chad', 'maya', 'kai']) expect(HON_AGENT_VOICES[k]).toBeDefined();
    expect(new Set(Object.values(HON_AGENT_VOICES).map((v) => `${v.pitch}/${v.rate}`)).size).toBe(9);
    expect(honAgentVoice('nobody')).toBe(HON_AGENT_VOICES.hon);
  });
});
