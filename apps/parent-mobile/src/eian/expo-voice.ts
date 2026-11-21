import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule as Recognition } from 'expo-speech-recognition';
import type { EianVoice, HeardResult } from './voice';

const LANGUAGE = 'en-US';

/**
 * The phone's own voice and speech service for Eian. One short question per tap (not continuous), with the microphone
 * permission asked the first time the parent taps the button.
 */
export function createExpoEianVoice(): EianVoice | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  return {
    speak(text, onDone) {
      let told = false;
      const done = () => { if (!told) { told = true; onDone(); } };
      void Speech.stop().catch(() => undefined).then(() => {
        try { Speech.speak(text.slice(0, Speech.maxSpeechInputLength), { language: LANGUAGE, onDone: done, onStopped: done, onError: done }); } catch { done(); }
      });
    },
    stopSpeaking() { void Speech.stop().catch(() => undefined); },
    canListen() { try { return Recognition.isRecognitionAvailable(); } catch { return false; } },
    listen(on) {
      let over = false, silent = false, started = false, text = '', failure: string | null = null;
      const subscriptions: { remove(): void }[] = [];
      const finish = (result: HeardResult) => {
        if (over) return;
        over = true;
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
        try { started = true; Recognition.start({ lang: LANGUAGE, interimResults: true, continuous: false, maxAlternatives: 1 }); } catch { finish({ kind: 'unavailable' }); }
      })();
      return {
        stop() { if (over) return; if (started) { try { Recognition.stop(); } catch { finish({ kind: 'nothing' }); } } else finish({ kind: 'nothing' }); },
        cancel() { silent = true; if (started && !over) { try { Recognition.abort(); } catch { /* already ended */ } } finish({ kind: 'nothing' }); },
      };
    },
  };
}
