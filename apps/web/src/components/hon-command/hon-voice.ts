/**
 * Talk to HON by voice (V1). Browser speech only: the browser's own speech recognition turns speech into the composer's
 * text, and its own speech output reads HON's answer. There is no voice API, no provider and no new permission: a spoken
 * question is handed to the same `send` as a typed one, so the server re-checks the human, school, permission and AI spend
 * limits exactly as it does for typing. Voice can only ask questions; every other control stays tap-only.
 *
 * "Hey HON" hands-free listening is offered only when the browser recognises speech on the device, so no room audio is
 * streamed anywhere while HON waits for its name. Hands-free stops after a run of spoken questions until someone taps.
 */

export type HonVoiceLang = 'en-US' | 'ko-KR' | 'es-US';
export const HON_VOICE_LIMITS = Object.freeze({
  /** Spoken questions in a row (hands-free or follow-ups) before voice pauses for a tap. */
  questionsInARow: 10,
  /** How long HON listens for a follow-up after it finishes speaking. */
  followUpMs: 8000,
  /** Times the wake listener is restarted after the browser ends it, before hands-free turns itself off. */
  maxQuietRestarts: 30,
  /** Longest stretch of an answer read aloud; the rest stays on screen. */
  spokenCharacters: 600,
});

export function honVoiceLang(appLanguage: string | null | undefined): HonVoiceLang {
  const base = (appLanguage ?? '').trim().toLowerCase().slice(0, 2);
  return base === 'ko' ? 'ko-KR' : base === 'es' ? 'es-US' : 'en-US';
}

/* ------------------------------ phrases ------------------------------ */

/** Lower case, letters/digits/Hangul only, single spaces. */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
}

// What recognisers write for "Hey HON". English is always accepted: people say it in English whatever the app language.
const WAKE_EN = String.raw`(?:hey|hi|okay|ok)\s+(?:hon|hun|han|hahn|hone|honn|haan|hawn)`;
const WAKE: Record<HonVoiceLang, RegExp> = {
  'en-US': new RegExp(String.raw`(?:^|\s)${WAKE_EN}(?=\s|$)`, 'u'),
  'ko-KR': new RegExp(String.raw`(?:^|\s)(?:${WAKE_EN}|헤이\s*(?:혼|훈|홍|hon))(?=\s|$)`, 'u'),
  'es-US': new RegExp(String.raw`(?:^|\s)(?:${WAKE_EN}|(?:oye|ey)\s+(?:hon|jon|han))(?=\s|$)`, 'u'),
};

/** Finds the wake phrase anywhere in what was heard and returns what was said after it (punctuation kept, trimmed). */
export function parseWake(transcript: string, lang: HonVoiceLang): { woke: boolean; question: string } {
  const flat = normalize(transcript);
  const match = WAKE[lang].exec(flat);
  if (!match) return { woke: false, question: '' };
  // Count the words up to the end of the wake phrase, then take the same number of words off the original text.
  // Count the words through the wake phrase, then cut the original text right after that many words. Words are found the
  // same way normalize() separates them, so punctuation between words ("Hey,HON") never shifts the count.
  const wordsThrough = flat.slice(0, match.index + match[0].length).trim().split(' ').length;
  const words = [...transcript.matchAll(/[\p{L}\p{N}']+/gu)].filter((m) => m[0].replace(/'/g, '').length > 0);
  if (words.length <= wordsThrough) return { woke: true, question: '' };
  const after = words[wordsThrough - 1]!; const rest = transcript.slice(after.index! + after[0].length);
  const question = rest.replace(/^[\s,.;:!?¡¿-]+/u, '').replace(/[\s,.;:!?¡¿]+$/u, '').trim();
  return { woke: true, question };
}

const STOP: Record<HonVoiceLang, ReadonlySet<string>> = {
  'en-US': new Set(['stop', 'stop listening', 'cancel', 'goodbye', 'good bye', 'bye', 'thats all', 'that is all', 'never mind', 'nevermind', 'no thanks', 'thanks', 'thank you', 'ok thanks', 'okay thanks', 'ok thank you', 'okay thank you', 'thank you thats all', 'thanks thats all', 'nothing', 'nothing else', 'im done', 'done']),
  'ko-KR': new Set(['그만', '그만해', '멈춰', '됐어', '됐어요', '끝', '끝내', '안녕', '고마워', '고마워요', '감사합니다', '취소']),
  'es-US': new Set(['para', 'alto', 'adiós', 'adios', 'eso es todo', 'nada', 'nada más', 'nada mas', 'gracias', 'olvídalo', 'olvidalo', 'cancelar', 'listo']),
};
const FILLER = /(?:^|\s)(?:hon|hun|please|por favor|ok|okay)(?=\s|$)/gu;

/** True when the whole utterance means "we're done" (wake word, please and okay ignored), so it is never sent. */
export function isStopPhrase(transcript: string, lang: HonVoiceLang): boolean {
  const flat = normalize(transcript);
  if (!flat) return false;
  const all = new Set([...STOP[lang], ...STOP['en-US']]);
  if (all.has(flat)) return true;
  const bare = flat.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  return bare.length > 0 && all.has(bare);
}

/** A question worth sending: at least four letters, so a cough or an "uh" never spends a question. */
export function meaningfulQuestion(text: string): boolean {
  return (text.match(/\p{L}/gu) ?? []).length >= 4;
}

/* ------------------------------ speech text ------------------------------ */

const LINE: Record<HonVoiceLang, { rest: string; link: string; failed: string; onScreen: string }> = {
  'en-US': { rest: 'The rest is on screen.', link: 'a link', failed: 'I couldn’t answer that one. The details are on screen.', onScreen: 'Done. The details are on screen.' },
  'ko-KR': { rest: '나머지는 화면에 있어요.', link: '링크', failed: '그 질문에는 답하지 못했어요. 자세한 내용은 화면에 있어요.', onScreen: '완료했어요. 자세한 내용은 화면에 있어요.' },
  'es-US': { rest: 'El resto está en pantalla.', link: 'un enlace', failed: 'No pude responder eso. Los detalles están en pantalla.', onScreen: 'Listo. Los detalles están en pantalla.' },
};
export const honVoiceLine = (lang: HonVoiceLang, key: keyof (typeof LINE)['en-US']): string => LINE[lang][key];

/** Plain sentences for speech: no markdown, no URLs, list items as sentences, trimmed at a sentence boundary. */
export function speakableText(text: string, lang: HonVoiceLang): string {
  const lines = text.replace(/https?:\/\/\S+/g, LINE[lang].link).split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s*/, '').replace(/^\s*>\s?/, '').replace(/[*_`~]/g, '').trim())
    .filter(Boolean);
  let joined = '';
  for (const line of lines) joined += joined === '' ? line : /[.!?。:;]$/.test(joined) ? ` ${line}` : `. ${line}`;
  joined = joined.replace(/\s+/g, ' ').trim();
  if (lines.length > 1 && joined && !/[.!?。]$/.test(joined)) joined += '.';
  const max = HON_VOICE_LIMITS.spokenCharacters;
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('。'));
  const head = (end > max / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')).trim();
  return `${head} ${LINE[lang].rest}`;
}

/* ------------------------------ browser support ------------------------------ */

type VoiceWindow = Partial<Record<'SpeechRecognition' | 'webkitSpeechRecognition' | 'speechSynthesis' | 'SpeechSynthesisUtterance', unknown>>;
type RecognitionStatic = { available?: (options: { langs: string[]; processLocally: boolean }) => Promise<unknown>; install?: (options: { langs: string[]; processLocally: boolean }) => Promise<unknown> };
const recognitionCtor = (win: VoiceWindow): unknown => win.SpeechRecognition ?? win.webkitSpeechRecognition;

export function detectHonVoiceSupport(win: VoiceWindow): { recognition: boolean; synthesis: boolean } {
  return { recognition: typeof recognitionCtor(win) === 'function', synthesis: !!win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function' };
}

export type OnDeviceSpeech = 'available' | 'downloadable' | 'unavailable';
/** Chrome's on-device speech recognition check. Anything unexpected counts as unavailable (hands-free stays off). */
export async function onDeviceSpeech(win: VoiceWindow, lang: HonVoiceLang): Promise<OnDeviceSpeech> {
  const ctor = recognitionCtor(win) as RecognitionStatic | undefined;
  if (!ctor || typeof ctor.available !== 'function') return 'unavailable';
  try {
    const result = await ctor.available({ langs: [lang], processLocally: true });
    return result === 'available' ? 'available' : result === 'downloadable' || result === 'downloading' ? 'downloadable' : 'unavailable';
  } catch { return 'unavailable'; }
}
/** Asks the browser to download its on-device speech model for this language (free, local). */
export async function installOnDeviceSpeech(win: VoiceWindow, lang: HonVoiceLang): Promise<boolean> {
  const ctor = recognitionCtor(win) as RecognitionStatic | undefined;
  if (!ctor || typeof ctor.install !== 'function') return false;
  try { return (await ctor.install({ langs: [lang], processLocally: true })) === true; } catch { return false; }
}

/* ------------------------------ adapters ------------------------------ */

export type RecognitionOptions = { lang: HonVoiceLang; continuous: boolean; onDevice: boolean };
export type RecognitionHandlers = { onInterim(text: string): void; onFinal(text: string): void; onError(code: string): void; onEnd(): void };
export interface RecognitionSession { stop(): void; abort(): void }
export interface RecognitionAdapter { start(options: RecognitionOptions, handlers: RecognitionHandlers): RecognitionSession }
export interface SpeechAdapter { speak(text: string, lang: HonVoiceLang, onDone: () => void): void; cancel(): void }
export interface VoiceTimer { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

type BrowserRecognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};

export function browserRecognition(win: VoiceWindow): RecognitionAdapter {
  return {
    start(options, handlers) {
      const Ctor = recognitionCtor(win) as new () => BrowserRecognition;
      const rec = new Ctor();
      rec.lang = options.lang; rec.continuous = options.continuous; rec.interimResults = true; rec.maxAlternatives = 1;
      if (options.onDevice) rec.processLocally = true;
      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!; const text = result[0]?.transcript ?? '';
          if (result.isFinal) handlers.onFinal(text.trim()); else interim += text;
        }
        if (interim.trim()) handlers.onInterim(interim.trim());
      };
      rec.onerror = (event) => handlers.onError(typeof event.error === 'string' ? event.error : 'unknown');
      rec.onend = () => handlers.onEnd();
      try { rec.start(); } catch { queueMicrotask(() => { handlers.onError('start-failed'); handlers.onEnd(); }); }
      return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } }, abort: () => { rec.onresult = null; rec.onerror = null; rec.onend = null; try { rec.abort(); } catch { /* already stopped */ } } };
    },
  };
}

type Synth = { speak(u: unknown): void; cancel(): void; getVoices(): { lang: string; localService: boolean }[] };
type Utterance = { lang: string; voice: unknown; rate: number; onend: (() => void) | null; onerror: (() => void) | null };

/** A run of text with no sentence end is cut at commas or spaces into pieces of at most 200 characters. */
export function splitLong(chunk: string): string[] {
  const out: string[] = []; let rest = chunk;
  while (rest.length > 200) {
    const window = rest.slice(0, 200);
    const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('، '), window.lastIndexOf(' '));
    const cut = at > 40 ? at + 1 : 200;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** Splits into short chunks (browsers cut long single utterances) and prefers on-device voices for the language. */
export function browserSpeech(win: VoiceWindow): SpeechAdapter {
  const synth = win.speechSynthesis as Synth; const Utter = win.SpeechSynthesisUtterance as new (text: string) => Utterance;
  let generation = 0;
  // Utterances are kept referenced until spoken: some browsers drop the end event of an utterance nothing holds on to.
  let held: Utterance[] = []; let watchdog: ReturnType<typeof setTimeout> | null = null;
  return {
    speak(text, lang, onDone) {
      const mine = ++generation; held = [];
      if (watchdog) clearTimeout(watchdog);
      let finished = false;
      const finish = () => { if (finished || mine !== generation) return; finished = true; if (watchdog) clearTimeout(watchdog); watchdog = null; held = []; onDone(); };
      // If the browser never reports the end, carry on after a generous estimate of the speaking time.
      watchdog = setTimeout(finish, 5000 + text.length * 90);
      const voices = synth.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      const voice = voices.find((v) => v.localService && v.lang.replace('_', '-') === lang) ?? voices.find((v) => v.localService) ?? voices[0] ?? null;
      const chunks = text.match(/[^.!?。]+[.!?。]*\s*/g)?.reduce<string[]>((all, piece) => {
        const last = all[all.length - 1];
        if (last !== undefined && (last + piece).length <= 200) all[all.length - 1] = last + piece; else all.push(piece);
        return all;
      }, []).flatMap(splitLong).map((c) => c.trim()).filter(Boolean) ?? [];
      if (chunks.length === 0) { queueMicrotask(finish); return; }
      chunks.forEach((chunk, index) => {
        const u = new Utter(chunk); u.lang = lang; u.rate = 1; if (voice) u.voice = voice;
        if (index === chunks.length - 1) { u.onend = finish; u.onerror = finish; }
        held.push(u); synth.speak(u);
      });
    },
    cancel() { generation++; held = []; if (watchdog) clearTimeout(watchdog); watchdog = null; try { synth.cancel(); } catch { /* nothing speaking */ } },
  };
}

export const browserTimer: VoiceTimer = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/* ------------------------------ controller ------------------------------ */

export type HonVoiceState = 'IDLE' | 'WAITING_WAKE' | 'LISTENING' | 'SENDING' | 'SPEAKING' | 'FOLLOW_UP' | 'BLOCKED';
export type HonVoiceSnapshot = Readonly<{ state: HonVoiceState; handsFree: boolean; onDevice: boolean; heard: string; message: string | null }>;

const MESSAGE = {
  notCaught: 'I didn’t catch that. Tap Talk and try again.',
  noSpeech: 'I didn’t hear anything.',
  blocked: 'Microphone access is blocked for this site. Allow it in your browser settings to talk to HON.',
  busy: 'HON can’t take a question right now. Check the screen.',
  network: 'Voice needs an internet connection in this browser right now. Type your question instead.',
  quiet: 'Hands-free listening stopped. Turn it on again when you need it.',
  paused: `Paused after ${HON_VOICE_LIMITS.questionsInARow} spoken questions. Tap Talk or turn hands-free on to keep going.`,
  failed: 'Voice stopped because the microphone could not be used.',
  done: 'Okay. Tap Talk when you need me.',
} as const;
export const HON_VOICE_MESSAGES = MESSAGE;

/** What HON says back for one turn receipt: the answer, or a short line pointing at the screen. */
export function honVoiceReplyText(receipt: Readonly<{ status: string; reply: string | null }>, lang: HonVoiceLang): string {
  if (receipt.reply && receipt.reply.trim()) return receipt.reply;
  return receipt.status === 'COMPLETED' || receipt.status === 'AWAITING_APPROVAL' || receipt.status === 'DELEGATING' ? LINE[lang].onScreen : LINE[lang].failed;
}

export class HonVoiceController {
  private current: HonVoiceSnapshot;
  private readonly listeners = new Set<() => void>();
  private session: RecognitionSession | null = null;
  /** Names the one live recognition session; events from any other session are ignored. */
  private sessionId = 0;
  private heardFinal = false;
  private followTimer: unknown = null;
  private quietRestarts = 0;
  private inARow = 0;
  private awaiting = false;

  constructor(private readonly deps: { recognition: RecognitionAdapter; speech: SpeechAdapter; timer: VoiceTimer; lang: HonVoiceLang; ask: (text: string) => boolean }) {
    this.current = Object.freeze({ state: 'IDLE', handsFree: false, onDevice: false, heard: '', message: null });
  }

  snapshot(): HonVoiceSnapshot { return this.current; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private set(patch: Partial<HonVoiceSnapshot>): void { this.current = Object.freeze({ ...this.current, ...patch }); for (const l of [...this.listeners]) l(); }

  setOnDevice(onDevice: boolean): void {
    if (!onDevice && this.current.handsFree) this.setHandsFree(false);
    this.set({ onDevice });
  }

  /** A human tap: listen for one question. Resets the spoken-questions-in-a-row count. */
  talk(): void {
    if (this.current.state === 'SENDING') return;
    if (this.current.state === 'SPEAKING') this.deps.speech.cancel();
    this.awaiting = false; this.clearFollow(); this.inARow = 0;
    this.listen('LISTENING', false);
  }

  setHandsFree(on: boolean): void {
    if (on && (!this.current.onDevice || this.current.state === 'BLOCKED')) return;
    if (!on) {
      if (this.current.state === 'WAITING_WAKE') this.endSession();
      this.set({ handsFree: false, ...(this.current.state === 'WAITING_WAKE' ? { state: 'IDLE' as const } : {}) });
      return;
    }
    this.inARow = 0; this.quietRestarts = 0;
    this.set({ handsFree: true, message: null });
    if (this.current.state === 'IDLE') this.waitForWake();
  }

  /** The container's answer to the question this controller sent (the answer text, or a short status line). */
  reply(text: string): void {
    if (!this.awaiting || this.current.state !== 'SENDING') return;
    this.awaiting = false;
    const spoken = speakableText(text, this.deps.lang);
    this.set({ state: 'SPEAKING', heard: '' });
    const mine = this.sessionId;
    this.deps.speech.speak(spoken, this.deps.lang, () => { if (mine === this.sessionId && this.current.state === 'SPEAKING') this.afterSpeaking(); });
  }

  /** A tap on "Stop listening" while HON waits for one question. */
  cancelListening(): void {
    if (this.current.state !== 'LISTENING' && this.current.state !== 'FOLLOW_UP') return;
    this.sessionId++; this.endSession(); this.rest(null);
  }

  stopSpeaking(): void {
    if (this.current.state !== 'SPEAKING') return;
    this.sessionId++; this.deps.speech.cancel(); this.rest(null);
  }

  /** Conceal, close or unmount: stop everything at once. Hands-free must be turned on again by a person. */
  shutdown(): void {
    this.sessionId++; this.awaiting = false; this.clearFollow(); this.endSession(); this.deps.speech.cancel();
    this.set({ state: 'IDLE', handsFree: false, heard: '', message: null });
  }

  private afterSpeaking(): void {
    if (this.inARow >= HON_VOICE_LIMITS.questionsInARow) { this.set({ handsFree: false }); this.rest(MESSAGE.paused); return; }
    this.listen('FOLLOW_UP', false);
    const mine = this.sessionId;
    this.followTimer = this.deps.timer.set(() => { if (mine === this.sessionId && this.current.state === 'FOLLOW_UP') { this.endSession(); this.rest(null); } }, HON_VOICE_LIMITS.followUpMs);
  }

  private rest(message: string | null): void {
    this.clearFollow();
    if (this.current.handsFree) this.waitForWake(message); else this.set({ state: 'IDLE', heard: '', message });
  }

  private waitForWake(message: string | null = null): void {
    this.set({ message });
    this.listen('WAITING_WAKE', true);
  }

  private listen(state: 'LISTENING' | 'FOLLOW_UP' | 'WAITING_WAKE', continuous: boolean): void {
    this.endSession();
    const id = ++this.sessionId; this.heardFinal = false;
    this.set({ state, heard: '', ...(state === 'WAITING_WAKE' ? {} : { message: null }) });
    const mine = () => id === this.sessionId;
    // Hands-free and its follow-ups stay on the device; a tap-to-talk question may use the browser's own speech service.
    const onDevice = this.current.onDevice && (state === 'WAITING_WAKE' || this.current.handsFree);
    this.session = this.deps.recognition.start({ lang: this.deps.lang, continuous, onDevice }, {
      onInterim: (text) => { if (mine() && this.current.state !== 'WAITING_WAKE') this.set({ heard: text }); },
      onFinal: (text) => { if (mine()) this.final(text); },
      onError: (code) => { if (mine()) this.error(code); },
      onEnd: () => { if (mine()) this.ended(); },
    });
  }

  private final(text: string): void {
    const state = this.current.state;
    if (state === 'WAITING_WAKE') {
      const wake = parseWake(text, this.deps.lang);
      if (!wake.woke) return;
      this.quietRestarts = 0;
      if (isStopPhrase(wake.question, this.deps.lang)) return;
      // "Hey HON, uh…": the wake counted, the mumble did not; listen for the real question instead of sending it.
      if (meaningfulQuestion(wake.question)) { this.endSession(); this.send(wake.question); } else this.listen('LISTENING', false);
      return;
    }
    if (state !== 'LISTENING' && state !== 'FOLLOW_UP') return;
    this.heardFinal = true; this.clearFollow(); this.endSession();
    if (isStopPhrase(text, this.deps.lang)) { this.rest(state === 'FOLLOW_UP' ? null : MESSAGE.done); return; }
    if (!meaningfulQuestion(text)) { this.rest(MESSAGE.notCaught); return; }
    this.send(text);
  }

  private send(text: string): void {
    this.set({ state: 'SENDING', heard: text });
    this.awaiting = true;
    if (!this.deps.ask(text)) { this.awaiting = false; this.set({ handsFree: false }); this.rest(MESSAGE.busy); return; }
    this.inARow++;
  }

  private error(code: string): void {
    if (code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      this.sessionId++; this.endSession(); this.clearFollow();
      this.set({ state: 'BLOCKED', handsFree: false, heard: '', message: code === 'audio-capture' ? MESSAGE.failed : MESSAGE.blocked });
      return;
    }
    if (code === 'no-speech' && this.current.state === 'LISTENING') { this.sessionId++; this.endSession(); this.rest(MESSAGE.noSpeech); return; }
    if (code === 'network' && (this.current.state === 'LISTENING' || this.current.state === 'FOLLOW_UP')) { this.sessionId++; this.endSession(); this.clearFollow(); this.set({ handsFree: false }); this.rest(MESSAGE.network); return; }
    if (code === 'language-not-supported' && this.current.state === 'WAITING_WAKE') { this.sessionId++; this.endSession(); this.set({ handsFree: false, onDevice: false }); this.rest(MESSAGE.quiet); }
  }

  private ended(): void {
    this.session = null;
    const state = this.current.state;
    if (state === 'WAITING_WAKE') {
      if (this.quietRestarts >= HON_VOICE_LIMITS.maxQuietRestarts) { this.set({ handsFree: false }); this.rest(MESSAGE.quiet); return; }
      // Restart after a short, growing pause so a recogniser that fails at once never spins in a tight loop.
      this.quietRestarts++;
      const mine = this.sessionId;
      this.followTimer = this.deps.timer.set(() => { this.followTimer = null; if (mine === this.sessionId && this.current.state === 'WAITING_WAKE') this.listen('WAITING_WAKE', true); },
        Math.min(250 * this.quietRestarts, 3000));
      return;
    }
    if ((state === 'LISTENING' || state === 'FOLLOW_UP') && !this.heardFinal) { this.rest(state === 'LISTENING' ? MESSAGE.noSpeech : null); }
  }

  private endSession(): void { const s = this.session; this.session = null; s?.abort(); }
  private clearFollow(): void { if (this.followTimer !== null) { this.deps.timer.clear(this.followTimer); this.followTimer = null; } }
}
