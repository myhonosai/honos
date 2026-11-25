import { AGENT_SPEECH_LIMITS, isAgentSpeechAgent, verifyAgentSpeechClip, verifyAgentSpeechStatus, type AgentSpeechAgent, type AgentSpeechStatus } from '@hon/contracts';
import type { HonVoiceLang, HonVoiceProfile, SpeechAdapter } from './hon-voice';

/**
 * 0652 (owner ask 2026-11-22: "Let's use Gemini voices for all agents"): each AI teammate reads its answer in its own Gemini
 * voice when the server says that voice is available to this person at this school. Anything else (no access, paused, not
 * switched on, too long, slow, an error, a browser that cannot play the clip) falls back to the browser's own voice, so a
 * reply is always heard. The server decides access and spend; this file only asks and plays.
 */
export type AgentVoiceScope = Readonly<{ organizationId: string; schoolId: string }>;
export interface AgentNaturalVoiceApi {
  status(scope: AgentVoiceScope, agent: AgentSpeechAgent, signal: AbortSignal): Promise<AgentSpeechStatus>;
  /** One clip as a playable WAV blob. */
  clip(scope: AgentVoiceScope, agent: AgentSpeechAgent, text: string, key: string, signal: AbortSignal): Promise<Blob>;
}
/** Plays one clip; returns a stop function. onEnd runs once, on the end of the clip or on an error. */
export type ClipPlayer = (clip: Blob, onEnd: (ok: boolean) => void) => () => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const base = (scope: AgentVoiceScope, agent: AgentSpeechAgent) => {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId) || !isAgentSpeechAgent(agent)) throw new Error('scope');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/agents/${agent}/speech`;
};
async function read(r: Response): Promise<unknown> {
  if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new Error(`status ${r.status}`);
  const v = JSON.parse(await r.text()) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape');
  return (v as { data: unknown }).data;
}

export const AGENT_NATURAL_VOICE_API: AgentNaturalVoiceApi = {
  async status(scope, agent, signal) {
    const r = await fetch(base(scope, agent), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json' } });
    return verifyAgentSpeechStatus(await read(r));
  },
  async clip(scope, agent, text, key, signal) {
    const r = await fetch(base(scope, agent), { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'agent.speech.speak', 'Idempotency-Key': key },
      body: JSON.stringify({ text }) });
    const clip = verifyAgentSpeechClip(await read(r));
    const binary = atob(clip.audio), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: clip.mime });
  },
};

export const browserClipPlayer: ClipPlayer = (clip, onEnd) => {
  let done = false; const end = (ok: boolean) => { if (done) return; done = true; URL.revokeObjectURL(url); onEnd(ok); };
  const url = URL.createObjectURL(clip);
  const audio = new Audio(url);
  audio.onended = () => end(true); audio.onerror = () => end(false);
  audio.play().catch(() => end(false));
  return () => { if (done) return; done = true; audio.pause(); URL.revokeObjectURL(url); };
};

/** How long a clip may take before the browser voice reads the answer instead: 4 seconds plus 12 ms a character. */
export const clipWaitMs = (characters: number) => 4000 + 12 * characters;
/** A status is asked again after this long, so a pause or a new switch is picked up. */
const STATUS_TTL_MS = 5 * 60_000;

/**
 * A SpeechAdapter that speaks each part in its teammate's natural voice when the server allows it, else through `fallback`.
 * The teammate comes from the voice profile (profile.agent). Exactly one of the two voices reads each part, and onDone runs
 * exactly once per part unless the part is cancelled.
 */
export function naturalSpeech(fallback: SpeechAdapter, scope: AgentVoiceScope, deps: { api?: AgentNaturalVoiceApi; play?: ClipPlayer; now?: () => number; newKey?: () => string } = {}): SpeechAdapter {
  const api = deps.api ?? AGENT_NATURAL_VOICE_API, play = deps.play ?? browserClipPlayer, now = deps.now ?? Date.now;
  const newKey = deps.newKey ?? (() => crypto.randomUUID());
  const statuses = new Map<string, { at: number; natural: Promise<boolean> }>();
  let generation = 0; let stop: (() => void) | null = null; let abort: AbortController | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; abort?.abort(); abort = null; stop?.(); stop = null; };
  const natural = (agent: AgentSpeechAgent): Promise<boolean> => {
    const cached = statuses.get(agent);
    if (cached && now() - cached.at < STATUS_TTL_MS) return cached.natural;
    const asked = api.status(scope, agent, new AbortController().signal).then((s) => s.voice === 'NATURAL', () => false);
    statuses.set(agent, { at: now(), natural: asked });
    return asked;
  };
  return {
    speak(text: string, lang: HonVoiceLang, onDone: () => void, profile?: HonVoiceProfile) {
      clear(); fallback.cancel();
      const mine = ++generation;
      const agent = profile?.agent;
      const said = text.trim();
      if (!isAgentSpeechAgent(agent) || said.length < 1 || said.length > AGENT_SPEECH_LIMITS.maxCharacters || /https?:\/\/|www\./i.test(said)) { fallback.speak(text, lang, onDone, profile); return; }
      let settled = false;
      const browser = () => { if (settled || mine !== generation) return; settled = true; clear(); fallback.speak(text, lang, onDone, profile); };
      void natural(agent).then((yes) => {
        if (settled || mine !== generation) return;
        if (!yes) { browser(); return; }
        const controller = new AbortController(); abort = controller;
        timer = setTimeout(browser, clipWaitMs(said.length));
        api.clip(scope, agent, said, newKey(), controller.signal).then((blob) => {
          if (settled || mine !== generation) return;
          settled = true; if (timer) clearTimeout(timer); timer = null; abort = null;
          stop = play(blob, (ok) => { if (mine !== generation) return; stop = null; if (ok) onDone(); else fallback.speak(text, lang, onDone, profile); });
        }, () => {
          // Busy, a daily limit, a pause or an error: this part and later ones use the browser voice until the status is asked again.
          statuses.set(agent, { at: now(), natural: Promise.resolve(false) });
          browser();
        });
      });
    },
    cancel() { generation++; clear(); fallback.cancel(); },
  };
}
