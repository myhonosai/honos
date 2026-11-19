'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HON_VOICE_LIMITS, HonVoiceController, browserRecognition, browserSpeech, browserTimer, detectHonVoiceSupport, installOnDeviceSpeech, onDeviceSpeech,
  type HonSpokenPart, type HonVoiceLang, type HonVoiceSnapshot, type OnDeviceSpeech, type SpeechAdapter,
} from './hon-voice';
import { HonOrb } from './hon-orb';
import { createHonOrbSignal, heardPulse, honOrbStateFor, type HonOrbSignal } from './hon-orb-signal';
import styles from './hon-conversation.module.css';

export type HonVoiceSupport = Readonly<{ checked: boolean; recognition: boolean; synthesis: boolean }>;
export type HonVoiceControlsProps = {
  support: HonVoiceSupport; enabled: boolean; canAsk: boolean; onDeviceStatus: OnDeviceSpeech; snapshot: HonVoiceSnapshot;
  /** Drives the live HON orb (heard words while listening, spoken words while answering). Optional for static renders. */
  orbSignal?: HonOrbSignal;
  onEnable(): void; onDisable(): void; onTalk(): void; onCancelListening(): void; onHandsFree(on: boolean): void; onStopSpeaking(): void; onInstall(): void;
  /** Team chat: who the talk button and status lines name (default HON). */
  who?: 'hon' | 'team';
};

const TEAM_LABEL: Partial<Record<HonVoiceSnapshot['state'], string>> = {
  WAITING_WAKE: 'Say “Hey HON” and your question for the team.', SENDING: 'The team is thinking…', SPEAKING: 'The team is answering…',
};

const STATE_LABEL: Record<HonVoiceSnapshot['state'], string> = {
  IDLE: 'Voice ready', WAITING_WAKE: 'Say “Hey HON” and your question.', LISTENING: 'Listening…', SENDING: 'HON is thinking…',
  SPEAKING: 'HON is answering…', FOLLOW_UP: 'Listening for a follow-up… say “thank you” to finish.', BLOCKED: 'Microphone blocked',
};

/** The voice controls inside the Ask HON composer. Pure: all behaviour is in HonVoiceController. */
export function HonVoiceControls(props: HonVoiceControlsProps): React.ReactElement | null {
  const { support, snapshot } = props;
  if (!support.checked) return null;
  if (!support.recognition) return <p className={styles.meta} data-voice="unsupported">Voice isn’t supported in this browser. Try Chrome, Edge or Safari, or type your question.</p>;
  if (!props.enabled) {
    return <div className={styles.voice} data-voice="off">
      <button type="button" className={styles.secondary} onClick={props.onEnable}>Turn on voice</button>
      <p className={styles.meta}>{props.who === 'team' ? 'Talk to the team instead of typing, and hear each teammate answer in their own voice.' : 'Talk to HON instead of typing, and hear its answers.'}{' '}Your browser turns your speech into text; some browsers (like Chrome and Edge) do that on the browser maker’s servers. HON gets only the text of your question, just like typing. No audio is recorded or saved by HON.</p>
    </div>;
  }
  const listening = snapshot.state === 'LISTENING' || snapshot.state === 'FOLLOW_UP';
  // A tap while the microphone is blocked tries it again (permission may have been granted since).
  const busy = snapshot.state === 'SENDING';
  return <div className={styles.voice} data-voice={snapshot.state}>
    <HonOrb state={honOrbStateFor(snapshot.state)} signal={props.orbSignal} className={styles.voiceOrb} />
    <div className={styles.actions}>
      {listening
        ? <button type="button" data-voice="stop-listening" onClick={props.onCancelListening}>Stop listening</button>
        : <button type="button" data-voice="talk" disabled={!props.canAsk || busy} onClick={props.onTalk}>{props.who === 'team' ? 'Talk to the team' : 'Talk to HON'}</button>}
      {snapshot.state === 'SPEAKING' ? <button type="button" className={styles.secondary} data-voice="stop-speaking" onClick={props.onStopSpeaking}>Stop talking</button> : null}
      <button type="button" className={styles.secondary} data-voice="disable" onClick={props.onDisable}>Turn off voice</button>
    </div>
    {props.onDeviceStatus === 'available'
      ? <label className={styles.voiceSwitch}><input type="checkbox" checked={snapshot.handsFree} disabled={!snapshot.handsFree && (!props.canAsk || snapshot.state === 'BLOCKED')} onChange={(event) => props.onHandsFree(event.target.checked)} />
        Hands-free: listen for “Hey HON” while this panel is open</label>
      : props.onDeviceStatus === 'downloadable'
        ? <button type="button" className={styles.secondary} data-voice="install" onClick={props.onInstall}>Set up private hands-free listening</button>
        : <p className={styles.meta}>Hands-free “Hey HON” needs speech recognition on this device (recent Chrome on a computer). Tap Talk to HON instead.</p>}
    <p role="status" aria-live="polite" className={styles.voiceStatus} data-voice-status="">
      <strong>{(props.who === 'team' ? TEAM_LABEL[snapshot.state] : undefined) ?? STATE_LABEL[snapshot.state]}</strong>
      {snapshot.heard ? <span data-hon-private=""> “{snapshot.heard}”</span> : null}
      {snapshot.message ? <span> {snapshot.message}</span> : null}
    </p>
    {!support.synthesis ? <p className={styles.meta}>This browser can’t read answers aloud. They appear on screen.</p> : null}
    {snapshot.handsFree ? <p className={styles.meta}>Hands-free listening happens on this device and stops when you leave this window. After {HON_VOICE_LIMITS.questionsInARow} spoken questions in a row HON pauses until you tap.</p> : null}
  </div>;
}

const STORAGE_KEY = 'hon.voice.v1';
const silentSpeech: SpeechAdapter = { speak: (_text, _lang, onDone) => { queueMicrotask(onDone); }, cancel: () => {} };
const IDLE: HonVoiceSnapshot = Object.freeze({ state: 'IDLE', handsFree: false, onDevice: false, heard: '', message: null });

/**
 * Owns one HonVoiceController for the mounted conversation. `ask` is read through a ref so the controller always hands the
 * question to the container's latest `send`. The controller is rebuilt when the language changes and shut down on unmount.
 */
export function useHonVoice(lang: HonVoiceLang, ask: (text: string) => boolean) {
  const askRef = useRef(ask); askRef.current = ask;
  const controller = useRef<HonVoiceController | null>(null);
  const [support, setSupport] = useState<HonVoiceSupport>({ checked: false, recognition: false, synthesis: false });
  const [enabled, setEnabled] = useState(false);
  const [onDeviceStatus, setOnDeviceStatus] = useState<OnDeviceSpeech>('unavailable');
  const [snapshot, setSnapshot] = useState<HonVoiceSnapshot>(IDLE);
  // The orb's energy: one signal for this mounted conversation. No audio is read; only words already recognised or spoken.
  const [orbSignal] = useState(() => createHonOrbSignal());
  const heardBefore = useRef('');
  useEffect(() => {
    const pulse = heardPulse(heardBefore.current, snapshot.heard);
    heardBefore.current = snapshot.heard;
    if (pulse > 0) orbSignal.pulse(pulse);
  }, [snapshot.heard, orbSignal]);

  useEffect(() => {
    const found = detectHonVoiceSupport(window as never);
    setSupport({ checked: true, ...found });
    try { setEnabled(window.localStorage.getItem(STORAGE_KEY) === 'on'); } catch { /* storage unavailable: voice stays off */ }
    if (!found.recognition) return;
    const voice = new HonVoiceController({
      recognition: browserRecognition(window as never), speech: found.synthesis ? browserSpeech(window as never, { onWord: () => orbSignal.pulse(0.55) }) : silentSpeech, timer: browserTimer, lang,
      ask: (text) => askRef.current(text),
    });
    controller.current = voice;
    const off = voice.subscribe(() => setSnapshot(voice.snapshot()));
    setSnapshot(voice.snapshot());
    let live = true;
    void onDeviceSpeech(window as never, lang).then((status) => { if (!live) return; setOnDeviceStatus(status); voice.setOnDevice(status === 'available'); });
    return () => { live = false; off(); voice.shutdown(); if (controller.current === voice) controller.current = null; setSnapshot(IDLE); };
  }, [lang, orbSignal]);

  const remember = (on: boolean) => { try { window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* per-device convenience only */ } };
  const shutdown = useCallback(() => { controller.current?.shutdown(); }, []);
  const reply = useCallback((text: string) => { controller.current?.reply(text); }, []);
  const replyParts = useCallback((parts: readonly HonSpokenPart[]) => { controller.current?.replyParts(parts); }, []);
  const install = useCallback(() => {
    // The answer counts only for the controller (and language) that asked: a language change meanwhile discards it.
    const asked = controller.current;
    void installOnDeviceSpeech(window as never, lang).then(() => onDeviceSpeech(window as never, lang)).then((status) => {
      if (!asked || controller.current !== asked) return;
      setOnDeviceStatus(status); asked.setOnDevice(status === 'available');
    });
  }, [lang]);

  return {
    snapshot, shutdown, reply, replyParts,
    controls: (canAsk: boolean): HonVoiceControlsProps => ({
      support, enabled, canAsk, onDeviceStatus, snapshot, orbSignal,
      onEnable: () => { remember(true); setEnabled(true); },
      onDisable: () => { remember(false); setEnabled(false); controller.current?.shutdown(); },
      onTalk: () => controller.current?.talk(),
      onCancelListening: () => controller.current?.cancelListening(),
      onHandsFree: (on) => controller.current?.setHandsFree(on),
      onStopSpeaking: () => controller.current?.stopSpeaking(),
      onInstall: install,
    }),
  };
}
