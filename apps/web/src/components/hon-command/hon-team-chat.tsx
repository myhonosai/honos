'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { HonConversationReadiness, HonConversationThread, HonTurnRequest } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { onAppPutAway } from '../school-shell/screensaver';
import {
  HON_CONVERSATION_API, HonConversationError, prepareConversation, prepareTurn, type HonConversationApi, type HonConversationFailure, type HonSchool, type Owned,
  type PreparedHonCommand,
} from './hon-conversation-http';
import { HonVoiceControls, useHonVoice } from './hon-voice-controls';
import { HonVoicePicker, useAgentVoices } from './hon-voice-picker';
import { AGENT_VOICE_API, type AgentVoiceApi } from './agent-voice-preference';
import { honVoiceLang } from './hon-voice';
import { HON_CORE_SOURCE, aiTeamPortrait, defaultArtStyle, type HonArtStyle } from './roster';
import {
  TEAM_MEMBERS, TEAM_NAMES, latestTeamChat, parseTeamAddress, teamCanPlan, teamChatMessages, teamChatTitle, teamMemberState, teamPlanRequest, teamRoundTargets,
  teamSpokenParts, teamTalkers, teamTurnRequest, type TeamAddress, type TeamChatMessage, type TeamMemberKey, type TeamTalker,
} from './hon-team-chat-model';
import { teamChatText, type TeamChatKey } from './hon-team-chat-copy';
import { newTeamRound, runTeamRound, type TeamBusy, type TeamRound } from './hon-team-chat-round';
import styles from './hon-team-chat.module.css';

export type TeamChatApi = Pick<HonConversationApi, 'readiness' | 'list' | 'thread' | 'create' | 'sendTurn'>;
type Phase = 'LOADING' | 'READY' | 'CONCEALED' | HonConversationFailure;

type Stalled = Readonly<{ round: TeamRound; state: HonConversationFailure; who: TeamTalker | null }>;

const ROLE_KEY: Record<TeamMemberKey, TeamChatKey> = { hon: 'roleHon', claire: 'roleClaire', alex: 'roleAlex', jordan: 'roleJordan', lena: 'roleLena',
  marcus: 'roleMarcus', chad: 'roleChad', maya: 'roleMaya', kai: 'roleKai' };
const WHO_KEY: Partial<Record<TeamMemberKey, TeamChatKey>> = { marcus: 'whoMarcus', chad: 'whoChad', maya: 'whoMaya', kai: 'whoKai' };
const WHO_HREF: Partial<Record<TeamMemberKey, string>> = { maya: '/staff/retention', kai: '/staff/teaching-assistant' };
const COLOR: Record<TeamMemberKey, string> = { hon: '#8de3d8', claire: '#ffc65b', alex: '#37a7ff', jordan: '#41e2c1', lena: '#d881ff', marcus: '#9a71ff', chad: '#ff5876', maya: '#ff70c1', kai: '#34d6e8' };
const portrait = (key: TeamMemberKey, style: HonArtStyle) => key === 'hon' ? HON_CORE_SOURCE : aiTeamPortrait(key, style) ?? HON_CORE_SOURCE;
const HIDDEN_REASONS = new Set(['RESULT_CONCEALED', 'SOURCE_ACCESS_LAPSED', 'ACCESS_LAPSED', 'RESULT_HELD']);

/** The view: pure, so every mode and state can be rendered in tests. */
export type HonTeamChatViewProps = {
  language: string; mode: HonInterfaceTheme; artStyle: HonArtStyle; phase: Phase; talkers: readonly TeamTalker[]; messages: readonly TeamChatMessage[];
  to: TeamAddress; draft: string; busy: TeamBusy; stalled: Stalled | null; voice?: React.ReactNode; voicePicker?: React.ReactNode;
  onTo(to: TeamAddress): void; onDraft(text: string): void; onSend(): void; onPlan(): void; onNew(): void; onRetry(): void; onDismiss(): void; onRefresh(): void;
};

export function HonTeamChatView(props: HonTeamChatViewProps): React.ReactElement {
  const t = (key: TeamChatKey, values?: Record<string, string>) => teamChatText(props.language, key, values);
  const ready = props.phase === 'READY';
  const canTalk = ready && props.talkers.length > 0;
  const locked = props.busy !== null || (props.stalled !== null && props.stalled.state === 'UNKNOWN');
  const canPlan = canTalk && !locked && props.talkers.includes('hon') && teamCanPlan(props.messages);
  const phaseText: Partial<Record<Phase, TeamChatKey>> = { LOADING: 'loading', SESSION: 'session', FORBIDDEN: 'forbidden', CONCEALED: 'concealed', UNAVAILABLE: 'unavailable', INVALID: 'unavailable', CONFLICT: 'unavailable', UNKNOWN: 'unavailable' };
  return <section id="team-chat" className={styles.chat} data-mode={props.mode} data-team-chat={props.phase} aria-labelledby="team-chat-title">
    <header className={styles.head}>
      <div>
        <h2 id="team-chat-title">{t('title')}</h2>
        <p className={styles.lead}>{t('lead')}</p>
      </div>
      {ready && props.messages.length > 0 && <button type="button" className={styles.secondary} disabled={locked} onClick={props.onNew}>{t('newChat')}</button>}
    </header>

    <ul className={styles.members} aria-label={t('talkTo')}>
      <li><button type="button" className={styles.member} data-member="everyone" aria-pressed={props.to === 'everyone'} disabled={!canTalk} onClick={() => props.onTo('everyone')}>
        <span className={styles.group} aria-hidden="true">{TEAM_MEMBERS.slice(0, 4).map((k) => <img key={k} src={portrait(k, props.artStyle)} alt="" width={28} height={28} />)}</span>
        <strong>{t('everyone')}</strong><small>{props.talkers.length > 0 ? props.talkers.map((k) => TEAM_NAMES[k]).join(' · ') : '—'}</small>
      </button></li>
      {TEAM_MEMBERS.map((key) => {
        const state = ready ? teamMemberState(key, props.talkers) : 'NOT_AVAILABLE';
        const talks = state === 'TALKS';
        return <li key={key}>
          <button type="button" className={styles.member} data-member={key} data-member-state={state} aria-pressed={props.to === key} disabled={!talks}
            style={{ '--member': COLOR[key] } as React.CSSProperties} onClick={() => talks && props.onTo(key as TeamTalker)}
            aria-describedby={`team-member-${key}`}>
            <img src={portrait(key, props.artStyle)} alt="" width={44} height={44} />
            <strong>{TEAM_NAMES[key]}</strong><small>{t(ROLE_KEY[key])}</small>
          </button>
          <p id={`team-member-${key}`} className={styles.memberState} data-tone={talks ? 'ready' : state === 'THROUGH_HON' ? 'neutral' : 'blocked'}>
            {t(talks ? 'talks' : state === 'THROUGH_HON' ? 'throughHon' : 'notAvailable')}
          </p>
        </li>;
      })}
    </ul>

    {!ready ? <p className={styles.notice} role="status" data-phase={props.phase}>{t(phaseText[props.phase] ?? 'unavailable')}
      {props.phase !== 'LOADING' && props.phase !== 'SESSION' && <button type="button" className={styles.secondary} onClick={props.onRefresh}>{t('retry')}</button>}</p>
      : props.talkers.length === 0 ? <p className={styles.notice} role="status" data-phase="not-ready">{t('notReady')}</p> : null}

    {ready && <ol className={styles.messages} aria-live="polite" data-hon-private="">
      {props.messages.length === 0 && <li className={styles.empty}>{t('empty')}</li>}
      {props.messages.map((m) => m.kind === 'you'
        ? <li key={m.id} className={styles.you} data-message="you">
          <p className={styles.byline}><strong>{t('you')}</strong> <span>{m.to.length > 1 ? t('toEveryone') : `${t('to')} ${TEAM_NAMES[m.to[0] ?? 'hon']}`}</span></p>
          <p className={styles.text}>{m.text}</p>
        </li>
        : <li key={m.id} className={styles.agent} data-message={m.key} data-plan={m.plan ? 'true' : undefined} style={{ '--member': COLOR[m.key] } as React.CSSProperties}>
          <img src={portrait(m.key, props.artStyle)} alt="" width={36} height={36} />
          <div>
            <p className={styles.byline}><strong>{TEAM_NAMES[m.key]}</strong> <span>{m.plan ? t('planLabel') : t(ROLE_KEY[m.key])}</span></p>
            {m.text ? <p className={styles.text}>{m.text}</p>
              : m.status === 'READY' || m.status === 'PROCESSING' || m.status === 'DELEGATING' ? <p className={styles.meta}>{t('asking', { name: TEAM_NAMES[m.key] })}</p>
              : <p className={styles.meta}>{t(m.reason && HIDDEN_REASONS.has(m.reason) ? 'hidden' : 'notAnswered', { name: TEAM_NAMES[m.key] })}</p>}
          </div>
        </li>)}
      {props.busy && (props.busy === 'create' || props.busy.length > 0) && <li className={styles.typing} role="status">{props.busy === 'create' ? t('waiting')
        : t('asking', { name: props.busy.map((k) => TEAM_NAMES[k]).join(', ') })}</li>}
    </ol>}

    {props.stalled && <div className={styles.stalled} role="alert" data-stalled={props.stalled.state}>
      <p>{props.stalled.state === 'UNKNOWN' ? t('unknown', { name: props.stalled.who ? TEAM_NAMES[props.stalled.who] : 'HON' })
        : props.stalled.state === 'SESSION' ? t('session') : t('refused', { name: props.stalled.who ? TEAM_NAMES[props.stalled.who] : 'HON' })}</p>
      <div className={styles.actions}>
        {props.stalled.state !== 'SESSION' && <button type="button" onClick={props.onRetry}>{t('retry')}</button>}
        <button type="button" className={styles.secondary} onClick={props.onDismiss}>{t('dismiss')}</button>
      </div>
    </div>}

    {canTalk && <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!locked) props.onSend(); }}>
      <label htmlFor="team-chat-draft" className={styles.visuallyHidden}>{t('placeholder')}</label>
      <textarea id="team-chat-draft" rows={props.mode === 'big-button' ? 3 : 2} maxLength={2000} value={props.draft} placeholder={t('placeholder')} disabled={locked}
        onChange={(event) => props.onDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!locked && props.draft.trim()) props.onSend(); } }} />
      <div className={styles.actions}>
        <button type="submit" disabled={locked || !props.draft.trim()}>{t('send')} · {props.to === 'everyone' ? t('everyone') : TEAM_NAMES[props.to]}</button>
        <button type="button" className={styles.planButton} disabled={!canPlan} aria-describedby="team-plan-help" onClick={props.onPlan}>{t('plan')}</button>
      </div>
      <p id="team-plan-help" className={styles.meta}>{t('planHelp')} {t('tipAddress')}</p>
    </form>}
    {canTalk && props.voice}
    {canTalk && props.voicePicker}

    <details className={styles.whoElse}>
      <summary>{t('throughHon')}: Marcus, Chad, Maya, Kai</summary>
      <ul>{(['marcus', 'chad', 'maya', 'kai'] as const).map((k) => <li key={k}><strong>{TEAM_NAMES[k]}</strong> {t(WHO_KEY[k]!)}
        {WHO_HREF[k] && <> <a href={WHO_HREF[k]}>{t('open')} →</a></>}</li>)}</ul>
    </details>
    <p className={styles.meta}>{t('help')}</p>
  </section>;
}

/**
 * The live team chat for one verified school. Reads readiness and the person's newest team chat; every message is an
 * ordinary turn (the server re-checks everything). A school change, session end or unmount retires all reads and
 * pending answers; nothing is shown for another school or person.
 */
export function HonTeamChat({ school, mode, language, artStyle, api = HON_CONVERSATION_API, voiceApi = AGENT_VOICE_API }: {
  school: HonSchool; mode: HonInterfaceTheme; language: string; artStyle?: HonArtStyle; api?: TeamChatApi; voiceApi?: AgentVoiceApi;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('LOADING');
  const [readiness, setReadiness] = useState<HonConversationReadiness | null>(null);
  const [thread, setThread] = useState<HonConversationThread | null>(null);
  const [to, setTo] = useState<TeamAddress>('everyone');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<TeamBusy>(null);
  const [stalled, setStalled] = useState<Stalled | null>(null);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(true), concealed = useRef(false), running = useRef(false);
  const conversationId = useRef<string | null>(null);
  const talkers = teamTalkers(readiness);

  const lang = honVoiceLang(language);
  const sendRef = useRef<(text: string, spoken: boolean) => boolean>(() => false);
  const voice = useHonVoice(lang, (text) => sendRef.current(text, true), school);
  const { shutdown: voiceShutdown, replyParts } = voice;
  // 0460: each teammate speaks in the voice this person chose (their usual voice until the choices load).
  const voices = useAgentVoices(school, voiceApi);
  const chosen = useRef(voices.choices); chosen.current = voices.choices;

  const owned = (shown: number): Owned => () => mounted.current && shown === privacy.current;

  const readThread = useCallback(async (id: string, shown: number) => {
    const abort = new AbortController();
    const next = await api.thread(school, id, abort.signal, owned(shown));
    if (shown === privacy.current && !concealed.current) { setThread(next); conversationId.current = next.id; }
  }, [api, school]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    const current = ++generation.current, shown = privacy.current, abort = new AbortController();
    setPhase('LOADING');
    Promise.all([api.readiness(school, abort.signal, owned(shown)), api.list(school, abort.signal, null, owned(shown))]).then(async ([nextReadiness, page]) => {
      if (current !== generation.current || concealed.current) return;
      setReadiness(nextReadiness);
      const latest = conversationId.current ? page.items.find((item) => item.id === conversationId.current) ?? latestTeamChat(page.items) : latestTeamChat(page.items);
      if (latest) await readThread(latest.id, shown); else { setThread(null); conversationId.current = null; }
      if (current === generation.current && !concealed.current) setPhase('READY');
    }, (error) => { if (current === generation.current) { setReadiness(null); setPhase(error instanceof HonConversationError ? error.kind : 'UNAVAILABLE'); } });
    return () => abort.abort();
  }, [api, school, readThread]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mounted.current = true; concealed.current = false; conversationId.current = null; setThread(null);
    const stop = load();
    const conceal = () => {
      concealed.current = true; generation.current++; privacy.current++; running.current = false; voiceShutdown();
      setThread(null); setStalled(null); setBusy(null); setPhase('SESSION');
    };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { mounted.current = false; generation.current++; privacy.current++; running.current = false; stop(); window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, [load, voiceShutdown]);
  // Voice never keeps listening or speaking behind the screensaver; a person turns it on again.
  useEffect(() => onAppPutAway(voiceShutdown), [voiceShutdown]);

  /** Runs (or resumes) a round: every teammate at once. A refusal or unknown outcome keeps the exact commands for Retry. */
  const run = useCallback(async (round: TeamRound) => {
    if (running.current) return;
    running.current = true; setStalled(null);
    const shown = privacy.current;
    const live = () => mounted.current && shown === privacy.current;
    try {
      const outcome = await runTeamRound(round, {
        create: (prepared) => api.create(prepared, owned(shown)), sendTurn: (prepared) => api.sendTurn(prepared, owned(shown)),
        prepare: (id, request) => prepareTurn(school, id, request), refresh: (id) => readThread(id, shown), live,
        onBusy: (who) => { if (live()) setBusy(who); }, onConversation: (id) => { conversationId.current = id; },
      });
      if (outcome.kind === 'DONE') {
        if (round.spoken) replyParts(teamSpokenParts(outcome.answers, (name) => teamChatText(language, 'said', { name }), chosen.current));
      } else if (outcome.kind === 'STALLED') {
        if (round.spoken) replyParts([{ text: teamChatText(language, 'notAnswered', { name: outcome.who ? TEAM_NAMES[outcome.who] : 'HON' }) }]);
        setStalled({ round, state: outcome.state, who: outcome.who });
        // A definitive refusal recorded nothing for that teammate: give the words back so nothing typed is lost.
        if (outcome.state !== 'UNKNOWN') setDraft((now) => now || round.text);
      }
    } finally { running.current = false; }
  }, [api, school, readThread, replyParts, language]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (raw: string, spoken: boolean): boolean => {
    if (concealed.current || running.current || phase !== 'READY' || (stalled && stalled.state === 'UNKNOWN')) return false;
    const parsed = parseTeamAddress(raw);
    const who = parsed.to ?? to;
    const targets = teamRoundTargets(who, talkers);
    const text = parsed.text.trim();
    if (!text || targets.length === 0) return false;
    if (parsed.to) setTo(parsed.to);
    let create: PreparedHonCommand | null = null;
    try { if (!conversationId.current) create = prepareConversation(school, teamChatTitle(text)); } catch { return false; }
    void run(newTeamRound({ create, conversationId: conversationId.current, text, request: (key) => teamTurnRequest(key, text), targets, spoken }));
    return true;
  };
  sendRef.current = send;

  const plan = () => {
    if (!conversationId.current || running.current || !talkers.includes('hon')) return;
    const request = teamPlanRequest();
    void run(newTeamRound({ create: null, conversationId: conversationId.current, text: request.text, request: () => request, targets: ['hon'], spoken: false }));
  };

  return <HonTeamChatView language={language} mode={mode} artStyle={artStyle ?? defaultArtStyle(mode)} phase={phase} talkers={talkers} messages={teamChatMessages(thread)}
    to={talkers.length > 0 && (to === 'everyone' || talkers.includes(to)) ? to : 'everyone'} draft={draft} busy={busy} stalled={stalled}
    voice={<HonVoiceControls {...voice.controls(phase === 'READY' && talkers.length > 0 && busy === null && !(stalled && stalled.state === 'UNKNOWN'))} who="team" />}
    voicePicker={<HonVoicePicker language={language} lang={lang} mode={mode} voices={voices} />}
    onTo={setTo} onDraft={setDraft} onSend={() => { if (send(draft, false)) setDraft(''); }} onPlan={plan}
    onNew={() => { if (running.current) return; conversationId.current = null; setThread(null); setStalled(null); }}
    onRetry={() => { if (stalled) void run(stalled.round); }}
    onDismiss={() => { setStalled(null); load(); }}
    onRefresh={() => { concealed.current = false; load(); }} />;
}
