import { createContext } from 'react';
import type { EianAnswer } from './eian-engine';

export type HeardResult = { kind: 'heard'; text: string } | { kind: 'nothing' | 'denied' | 'unavailable' };

/**
 * Voice for Eian, supplied by the phone (see expo-voice.ts) so the screen and its tests never touch native modules.
 * Speaking uses the phone's own built-in voice. Listening uses the phone's own speech service for one question at a
 * time and only after the parent taps the microphone; nothing listens in the background and no audio goes to HON.
 */
export type EianVoice = {
  /** Reads text aloud, replacing anything being read. `onDone` runs once when it finishes or is stopped. */
  speak(text: string, onDone: () => void): void;
  stopSpeaking(): void;
  /** False when this phone has no speech service, so the microphone button is not shown. */
  canListen(): boolean;
  /** Hears one question. `stop` ends it and delivers what was heard; `cancel` ends it and delivers nothing. */
  listen(on: { partial(text: string): void; end(result: HeardResult): void }): { stop(): void; cancel(): void };
};

export const EianVoiceContext = createContext<EianVoice | null>(null);

/** What Eian says for an answer: the lines the parent can read, never the source label or the button. */
export function spokenText(answer: EianAnswer): string {
  return answer.lines.map(line => line.trim()).filter(Boolean).map(line => (/[.!?:…]$/.test(line) ? line : `${line}.`)).join(' ').slice(0, 1500);
}

export const VOICE_NOTE: Record<Exclude<HeardResult['kind'], 'heard'>, string> = {
  nothing: "I didn't catch that. Tap the microphone and try again, or type your question.",
  denied: "The microphone is off for HON Family. You can turn it on in your phone's settings, or type your question.",
  unavailable: "Voice isn't available on this phone right now. You can type your question.",
};
