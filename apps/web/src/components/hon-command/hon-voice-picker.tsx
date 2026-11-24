'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HON_VOICE_AGENT_KEYS, type HonAgentVoiceChoice, type HonAgentVoiceChoices, type HonInterfaceTheme, type HonVoiceAgentKey } from '@hon/contracts';
import { AGENT_VOICE_API, AGENT_VOICE_DEFAULTS, AgentVoicePreferenceError, type AgentVoiceApi, type AgentVoiceScope } from './agent-voice-preference';
import { HON_AGENT_VOICE_OPTIONS, browserSpeech, detectHonVoiceSupport, honAgentVoice, type HonVoiceLang, type SpeechAdapter } from './hon-voice';
import { teamChatText } from './hon-team-chat-copy';
import { TEAM_NAMES } from './hon-team-chat-model';
import styles from './hon-team-chat.module.css';

export type AgentVoicesState = {
  choices: HonAgentVoiceChoices;
  status: 'LOADING' | 'READY' | 'UNAVAILABLE';
  saving: HonVoiceAgentKey | null;
  failed: HonVoiceAgentKey | null;
};

/**
 * The person's saved voice per teammate. Until it loads (or when it cannot), every teammate keeps their original voice.
 * A change shows at once and is saved with its own retry key; if saving fails the previous voice comes back. Only the
 * newest request may change what is shown, so a slow older answer never undoes a newer choice.
 */
export function useAgentVoices(school: AgentVoiceScope | null, api: AgentVoiceApi = AGENT_VOICE_API) {
  const [state, setState] = useState<AgentVoicesState>({ choices: AGENT_VOICE_DEFAULTS, status: 'LOADING', saving: null, failed: null });
  const latest = useRef(0);
  const shown = useRef(state.choices); shown.current = state.choices;
  const scopeKey = school ? `${school.organizationId}:${school.schoolId}` : '';
  useEffect(() => {
    const ticket = ++latest.current;
    setState({ choices: AGENT_VOICE_DEFAULTS, status: 'LOADING', saving: null, failed: null });
    if (!school) return;
    const abort = new AbortController();
    api.load(school, abort.signal).then((choices) => { if (ticket === latest.current) setState({ choices, status: 'READY', saving: null, failed: null }); },
      () => { if (ticket === latest.current) setState((s) => ({ ...s, status: 'UNAVAILABLE' })); });
    return () => { abort.abort(); latest.current++; };
  }, [scopeKey, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = useCallback((agent: HonVoiceAgentKey, choice: HonAgentVoiceChoice) => {
    if (!school) return;
    const ticket = ++latest.current;
    const before = shown.current[agent];
    setState((s) => ({ ...s, choices: { ...s.choices, [agent]: choice }, saving: agent, failed: null }));
    let request: Promise<HonAgentVoiceChoices>;
    try { request = api.save(school, agent, choice, crypto.randomUUID()); } catch (error) { request = Promise.reject(error); }
    request.then((choices) => { if (ticket === latest.current) setState({ choices, status: 'READY', saving: null, failed: null }); },
      (error: unknown) => {
        if (ticket !== latest.current) return;
        setState((s) => ({ ...s, choices: { ...s.choices, [agent]: before }, saving: null, failed: agent,
          status: error instanceof AgentVoicePreferenceError && (error.status === 401 || error.status === 403) ? 'UNAVAILABLE' : s.status }));
      });
  }, [scopeKey, api]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, choose };
}

const ORDER: readonly HonVoiceAgentKey[] = HON_VOICE_AGENT_KEYS;
const ROLE: Readonly<Record<HonVoiceAgentKey, Parameters<typeof teamChatText>[1]>> = {
  hon: 'roleHon', claire: 'roleClaire', alex: 'roleAlex', jordan: 'roleJordan', lena: 'roleLena', marcus: 'roleMarcus', chad: 'roleChad', maya: 'roleMaya', kai: 'roleKai',
};

/** Pure view: three voices per teammate, the chosen one pressed, and "Hear it" to try a voice before keeping it. */
export function HonVoicePickerView(props: {
  language: string; mode: HonInterfaceTheme; state: AgentVoicesState; canPreview: boolean;
  onChoose(agent: HonVoiceAgentKey, choice: HonAgentVoiceChoice): void; onPreview(agent: HonVoiceAgentKey, choice: HonAgentVoiceChoice): void;
}): React.ReactElement {
  const t = (key: Parameters<typeof teamChatText>[1], values?: Record<string, string>) => teamChatText(props.language, key, values);
  const locked = props.state.status !== 'READY';
  return <details className={styles.voicePicker} data-voice-picker data-status={props.state.status}>
    <summary>{t('voicesTitle')}</summary>
    <p className={styles.meta}>{t('voicesLead')}</p>
    {props.state.status === 'LOADING' && <p className={styles.meta} role="status">{t('voicesLoading')}</p>}
    {props.state.status === 'UNAVAILABLE' && <p className={styles.notice} role="status">{t('voicesUnavailable')}</p>}
    <ul className={styles.voiceList}>
      {ORDER.map((agent) => <li key={agent} data-voice-agent={agent}>
        <div className={styles.voiceWho}><strong>{TEAM_NAMES[agent]}</strong> <span>{t(ROLE[agent])}</span></div>
        <div className={styles.voiceChoices} role="group" aria-label={t('voiceFor', { name: TEAM_NAMES[agent] })}>
          {HON_AGENT_VOICE_OPTIONS[agent]!.map((option, index) => {
            const choice = (index + 1) as HonAgentVoiceChoice;
            const pressed = props.state.choices[agent] === choice;
            return <span key={choice} className={styles.voiceChoice}>
              <button type="button" className={pressed ? undefined : styles.secondary} aria-pressed={pressed} disabled={locked}
                data-voice-choice={choice} onClick={() => { if (!pressed) props.onChoose(agent, choice); }}>
                {t(`voice_${option.style}` as Parameters<typeof teamChatText>[1])}
              </button>
              {props.canPreview && <button type="button" className={styles.voiceHear} data-voice-hear={choice}
                aria-label={t('hearVoice', { name: TEAM_NAMES[agent], voice: t(`voice_${option.style}` as Parameters<typeof teamChatText>[1]) })}
                onClick={() => props.onPreview(agent, choice)}>▶</button>}
            </span>;
          })}
        </div>
        {props.state.saving === agent && <small role="status">{t('voiceSaving')}</small>}
        {props.state.failed === agent && <small role="alert" className={styles.voiceFailed}>{t('voiceNotSaved')}</small>}
      </li>)}
    </ul>
    <p className={styles.meta}>{props.canPreview ? t('voicesFree') : t('voicesNoSpeech')}</p>
  </details>;
}

/** The picker with "Hear it" through the browser's own speech (free; nothing leaves the device for a preview). */
export function HonVoicePicker({ language, lang, mode, voices }: {
  language: string; lang: HonVoiceLang; mode: HonInterfaceTheme; voices: ReturnType<typeof useAgentVoices>;
}): React.ReactElement {
  const speech = useRef<SpeechAdapter | null>(null);
  const [canPreview, setCanPreview] = useState(false);
  useEffect(() => {
    if (!detectHonVoiceSupport(window as never).synthesis) return;
    speech.current = browserSpeech(window as never); setCanPreview(true);
    return () => { speech.current?.cancel(); speech.current = null; };
  }, []);
  const preview = useCallback((agent: HonVoiceAgentKey, choice: HonAgentVoiceChoice) => {
    const s = speech.current; if (!s) return;
    s.cancel(); s.speak(teamChatText(language, 'voiceSample', { name: TEAM_NAMES[agent] }), lang, () => {}, honAgentVoice(agent, choice));
  }, [language, lang]);
  return <HonVoicePickerView language={language} mode={mode} state={voices} canPreview={canPreview} onChoose={voices.choose} onPreview={preview} />;
}
