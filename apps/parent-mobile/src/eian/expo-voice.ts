import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule as Recognition } from 'expo-speech-recognition';
import type { EianVoice, HeardResult } from './voice';

/** Eian's answers are English; an English phone keeps its own accent setting (en-GB, en-AU), any other phone uses en-US. */
function language(): string {
  try { const locale = Intl.DateTimeFormat().resolvedOptions().locale; return /^en-[A-Za-z]{2}$/.test(locale) ? locale : 'en-US'; } catch { return 'en-US'; }
}
/** Eian is drawn as a young boy, so the phone's best English voice is raised a little. Presentation only. */
const EIAN_PITCH = 1.3;
const EIAN_RATE = 1.0;
let bestVoice: Promise<string | undefined> | undefined;
function pickVoice(lang: string): Promise<string | undefined> {
  bestVoice ??= Speech.getAvailableVoicesAsync().then(voices => {
    const english = voices.filter(v => v.language?.toLowerCase().startsWith('en'));
    const score = (v: (typeof voices)[number]) => (v.language?.toLowerCase() === lang.toLowerCase() ? 2 : 0) + (v.quality === Speech.VoiceQuality.Enhanced ? 1 : 0);
    return english.sort((a, b) => score(b) - score(a))[0]?.identifier;
  }).catch(() => undefined);
  return bestVoice;
}
/** If the phone never reports the end of listening, stop anyway so the microphone is not left open. */
const LISTEN_LIMIT_MS = 20_000;

/**
 * The phone's own voice and speech service for Eian. One short question per tap (not continuous), with the microphone
 * permission asked the first time the parent taps the button.
 */
export function createExpoEianVoice(): EianVoice | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  return {
    speak(text, onDone) {
      let told = false;
      const done = (finished: boolean) => { if (!told) { told = true; onDone(finished); } };
      const lang = language();
      void Speech.stop().catch(() => undefined).then(() => pickVoice(lang)).then(voice => {
        try {
          Speech.speak(text.slice(0, Speech.maxSpeechInputLength), { language: lang, voice, pitch: EIAN_PITCH, rate: EIAN_RATE,
            onDone: () => done(true), onStopped: () => done(false), onError: () => done(false) });
        } catch { done(false); }
      });
    },
    stopSpeaking() { void Speech.stop().catch(() => undefined); },
    canListen() { try { return Recognition.isRecognitionAvailable(); } catch { return false; } },
    listen(on, hints = []) {
      let over = false, silent = false, started = false, text = '', failure: string | null = null;
      const subscriptions: { remove(): void }[] = [];
      let limit: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: HeardResult) => {
        if (over) return;
        over = true;
        if (limit) clearTimeout(limit);
        subscriptions.forEach(s => s.remove());
        if (!silent) on.end(result);
      };
      void (async () => {
        const permission = await Recognition.requestPermissionsAsync().catch(() => null);
        if (over) return;
        if (!permission?.granted) return finish({ kind: 'denied' });
        subscriptions.push(Recognition.addListener('result', event => {
          text = event.results[0]?.transcript ?? text;
          if (!event.isFinal && !over) on.partial(text);
        }));
        subscriptions.push(Recognition.addListener('error', event => { failure = event.error; }));
        subscriptions.push(Recognition.addListener('end', () => {
          const heard = text.trim();
          if (heard) return finish({ kind: 'heard', text: heard });
          finish({ kind: failure === 'not-allowed' ? 'denied' : failure === 'service-not-allowed' || failure === 'language-not-supported' ? 'unavailable' : 'nothing' });
        }));
        try { started = true; Recognition.start({ lang: language(), interimResults: true, continuous: false, maxAlternatives: 1, contextualStrings: [...hints] }); } catch { finish({ kind: 'unavailable' }); }
        limit = setTimeout(() => {
          try { Recognition.abort(); } catch { /* already ended */ }
          const heard = text.trim();
          finish(heard ? { kind: 'heard', text: heard } : { kind: 'nothing' });
        }, LISTEN_LIMIT_MS);
      })();
      return {
        stop() { if (over) return; if (started) { try { Recognition.stop(); } catch { finish({ kind: 'nothing' }); } } else finish({ kind: 'nothing' }); },
        cancel() { silent = true; if (started && !over) { try { Recognition.abort(); } catch { /* already ended */ } } finish({ kind: 'nothing' }); },
      };
    },
  };
}
