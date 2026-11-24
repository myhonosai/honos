import type { EianSpeechClip, EianSpeechStatus } from '@hon/contracts/eian-speech';
import type { ParentRead, ParentWrite } from '../api/client';
import type { EianVoice } from './voice';

/** Plays one MP3 clip (base64). `onDone` runs once: true when it played to the end, false when stopped or it could not play. */
export type ClipPlayer = { play(base64Mp3: string, onDone: (finished: boolean) => void): { stop(): void } };
/** The two calls the natural voice makes. The family, school and child never appear: HON reads them from the session. */
export type EianSpeechApi = {
  eianSpeechStatus(): Promise<ParentRead<EianSpeechStatus>>;
  eianSpeak(text: string, idempotencyKey: string): Promise<ParentWrite<EianSpeechClip>>;
};

/** Longer answers are read by the phone's own voice: a long clip takes too long to make to keep a conversation going. */
export const NATURAL_VOICE_MAX_CHARACTERS = 600;
/** How long the app waits for a clip before the phone's own voice reads the answer instead (measured: about 2.5 s for 150 characters, 6 s for 540). */
export function naturalVoiceWaitMs(characters: number): number { return 3000 + 12 * Math.min(characters, NATURAL_VOICE_MAX_CHARACTERS); }
/** After HON says the natural voice is not available, the phone's own voice is used without asking again for this long. */
const PHONE_FOR_MS = 5 * 60_000;
const BUSY_FOR_MS = 60_000;
const NATURAL_FOR_MS = 5 * 60_000;

/**
 * Eian's natural voice: one fixed voice made by HON's speech service, with the phone's own voice behind it. If the
 * school does not have it, a limit was reached, the clip is slow or anything fails, the phone's own voice reads the
 * same words and nothing else changes. Listening is always the phone's own. A clip is only ever asked for once: a slow
 * or lost request is dropped, never retried. Stopping, a new answer, leaving Eian or signing out ends playback and
 * drops the sound.
 */
export function createNaturalEianVoice(options: { api: () => EianSpeechApi | null; phone: EianVoice; player: ClipPlayer; newKey: () => string; now?: () => number }): EianVoice {
  const { phone, player, newKey } = options;
  const now = options.now ?? (() => Date.now());
  let turn = 0;
  let playing: { stop(): void } | null = null;
  let pending: ((finished: boolean) => void) | null = null;
  let phoneUntil = 0, naturalUntil = 0;

  /** Ends whatever this voice is doing and tells the caller of the interrupted answer once. */
  const interrupt = () => {
    turn += 1;
    const clip = playing; playing = null;
    try { clip?.stop(); } catch { /* already stopped */ }
    const told = pending; pending = null;
    told?.(false);
  };

  return {
    speak(text, onDone) {
      interrupt();
      phone.stopSpeaking();
      const mine = turn;
      let handed = false;
      const usePhone = () => { if (handed || mine !== turn) return; handed = true; pending = null; phone.speak(text, onDone); };
      const api = options.api();
      const words = text.trim();
      if (!api || !words || words.length > NATURAL_VOICE_MAX_CHARACTERS || now() < phoneUntil) return usePhone();
      pending = onDone;
      const timer = setTimeout(usePhone, naturalVoiceWaitMs(words.length));
      void (async () => {
        try {
          if (now() >= naturalUntil) {
            const status = await api.eianSpeechStatus();
            if (mine !== turn || handed) return;
            if (!status.ok || status.data.voice !== 'NATURAL') {
              // Signed out or offline is checked again next time; a definite "phone voice" answer is kept for a few minutes.
              if (status.ok) phoneUntil = now() + PHONE_FOR_MS;
              return usePhone();
            }
            naturalUntil = now() + NATURAL_FOR_MS;
          }
          const clip = await api.eianSpeak(words, newKey());
          if (mine !== turn || handed) return;
          if (!clip.ok) {
            naturalUntil = 0;
            if (clip.state === 'refused') phoneUntil = now() + (clip.code === 'EIAN_SPEECH_BUSY' ? BUSY_FOR_MS : PHONE_FOR_MS);
            return usePhone();
          }
          handed = true;
          playing = player.play(clip.data.audio, finished => {
            if (mine !== turn) return;
            playing = null; pending = null;
            onDone(finished);
          });
        } catch { usePhone(); } finally { clearTimeout(timer); }
      })();
    },
    stopSpeaking() { interrupt(); phone.stopSpeaking(); },
    canListen: () => phone.canListen(),
    listen: (on, hints) => phone.listen(on, hints),
    speechService: true,
  };
}
