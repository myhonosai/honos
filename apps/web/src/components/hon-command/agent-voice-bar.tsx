'use client';

import React, { useEffect, useRef, useState } from 'react';
import { browserRecognition, browserSpeech, detectHonVoiceSupport, honAgentVoice, onDeviceSpeech, speakableText, type HonVoiceLang, type RecognitionAdapter, type SpeechAdapter } from './hon-voice';
import styles from './hon-command.module.css';

/**
 * A microphone and a read-aloud button for one AI teammate's own panel (owner ask 2026-11-22: voice for every agent). Browser
 * speech only, as in the HON panel (V1): the browser turns one spoken sentence into the panel's text box, where the person can
 * still edit it before pressing the panel's own button; and the teammate's answer can be read aloud in that teammate's voice.
 * Voice never presses a button, applies, approves or sends anything.
 */
export function appendHeard(current: string, heard: string, max: number): string {
  const said = heard.replace(/\s+/g, ' ').trim();
  if (!said) return current;
  const joined = current.trim() ? `${current.trimEnd()} ${said}` : said;
  return joined.slice(0, max);
}

type Recognizer = RecognitionAdapter;
export type AgentVoiceDeps = { recognition: Recognizer | null; speech: SpeechAdapter | null };
const browserDeps = (): AgentVoiceDeps => {
  if (typeof window === 'undefined') return { recognition: null, speech: null };
  const found = detectHonVoiceSupport(window as never);
  return { recognition: found.recognition ? browserRecognition(window as never) : null, speech: found.synthesis ? browserSpeech(window as never) : null };
};

export function AgentVoiceBar({ agentKey, name, value, max, onChange, answer = null, voiceChoice = 1, lang = 'en-US', deps }: {
  agentKey: string; name: string; value: string; max: number; onChange: (next: string) => void;
  answer?: string | null; voiceChoice?: number; lang?: HonVoiceLang; deps?: AgentVoiceDeps;
}): React.ReactElement | null {
  const [tools, setTools] = useState<AgentVoiceDeps | null>(deps ?? null);
  const [state, setState] = useState<'IDLE' | 'LISTENING' | 'SPEAKING' | 'BLOCKED'>('IDLE');
  const [heard, setHeard] = useState('');
  // Like the HON panel: when the browser can recognise speech on this device, audio stays on the device.
  const [onDevice, setOnDevice] = useState(false);
  const stop = useRef<null | (() => void)>(null);
  const latest = useRef(value); latest.current = value;
  useEffect(() => { if (!deps) setTools(browserDeps()); }, [deps]);
  useEffect(() => {
    if (deps || typeof window === 'undefined') return;
    let live = true;
    void onDeviceSpeech(window as never, lang).then((status) => { if (live) setOnDevice(status === 'available'); }, () => undefined);
    return () => { live = false; };
  }, [deps, lang]);
  useEffect(() => () => { stop.current?.(); tools?.speech?.cancel(); }, [tools]);
  if (!tools || (!tools.recognition && !tools.speech)) return null;

  const listen = () => {
    if (!tools.recognition) return;
    tools.speech?.cancel(); setHeard(''); setState('LISTENING');
    const session = tools.recognition.start({ lang, continuous: false, onDevice }, {
      onInterim: (text) => setHeard(text),
      onFinal: (text) => { setHeard(''); onChange(appendHeard(latest.current, text, max)); },
      onError: (error) => setState(error === 'not-allowed' || error === 'service-not-allowed' ? 'BLOCKED' : 'IDLE'),
      onEnd: () => { stop.current = null; setState((s) => (s === 'LISTENING' ? 'IDLE' : s)); },
    });
    stop.current = () => session.abort();
  };
  const read = () => {
    if (!tools.speech || !answer) return;
    tools.speech.cancel(); setState('SPEAKING');
    tools.speech.speak(speakableText(answer, lang), lang, () => setState('IDLE'), honAgentVoice(agentKey, voiceChoice));
  };
  return <div className={styles.alexActions} data-agent-voice={state}>
    {tools.recognition ? (state === 'LISTENING'
      ? <button type="button" className={styles.inlineLink} onClick={() => { stop.current?.(); setState('IDLE'); }} data-agent-voice-stop>Stop listening</button>
      : <button type="button" className={styles.inlineLink} onClick={listen} aria-label={`Speak to ${name}`} data-agent-voice-talk>Speak</button>) : null}
    {tools.speech && answer ? (state === 'SPEAKING'
      ? <button type="button" className={styles.inlineLink} onClick={() => { tools.speech?.cancel(); setState('IDLE'); }} data-agent-voice-quiet>Stop reading</button>
      : <button type="button" className={styles.inlineLink} onClick={read} aria-label={`Hear ${name}'s answer`} data-agent-voice-read>Hear {name}</button>) : null}
    {state === 'LISTENING' ? <span className={styles.meta} role="status">{heard || 'Listening…'}</span> : null}
    {state === 'BLOCKED' ? <span className={styles.meta} role="status">The microphone is blocked. Allow it in your browser’s site settings, or type instead.</span> : null}
  </div>;
}
