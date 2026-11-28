'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqHonAgentKey, HqHonConversation } from '@hon/contracts';
import type { Language } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { MarketingError } from '../hq-marketing/http';
import { hqHonApi, type HqHonApi } from './http';
import { hqHonText, type HqHonCopyKey } from './copy';
import { hqTeamChatText, type HqTeamChatKey } from './hq-team-chat-copy';
import {
  HQ_TEAM_NAMES, HQ_TEAM_VOICE, hqTeamMessages, hqTeamTalkers, hqTeamTargets, newHqTeamRound, parseHqTeamAddress, prepareHqTeamRetry, runHqTeamRound,
  type HqTeamAddress, type HqTeamMessage, type HqTeamRound,
} from './hq-team-chat-model';
import { HonVoiceControls, useHonVoice } from '../hon-command/hon-voice-controls';
import { honAgentVoice, honVoiceLang } from '../hon-command/hon-voice';
import { HON_CORE_SOURCE } from '../hon-command/roster';
import { HQ_HON_AGENTS } from '@hon/contracts';
import styles from '../hon-command/hon-team-chat.module.css';

type Phase = 'LOADING' | 'READY' | 'DENIED' | 'UNAVAILABLE';
export type HqTeamStalled = Readonly<{ round: HqTeamRound; error: MarketingError; who: HqHonAgentKey }>;

const ROLE: Record<HqHonAgentKey, HqTeamChatKey> = { hon: 'roleHon', chase: 'roleChase', mia: 'roleMia', ethan: 'roleEthan', olivia: 'roleOlivia', ryan: 'roleRyan', sophia: 'roleSophia' };
const COLOR: Record<HqHonAgentKey, string> = { hon: '#8de3d8', chase: '#ff9f5a', mia: '#ff70c1', ethan: '#37a7ff', olivia: '#ffc65b', ryan: '#41e2c1', sophia: '#d881ff' };
export const hqTeamPortrait = (key: HqHonAgentKey, art: string): string => key === 'hon' ? HON_CORE_SOURCE : `/hq-assets/${art === 'anime' ? 'anime' : 'chibi'}/${key}.webp`;

export type HqTeamChatViewProps = {
  language: Language | string; art: string; phase: Phase; view: HqHonConversation | null; talkers: readonly HqHonAgentKey[]; messages: readonly HqTeamMessage[];
  to: HqTeamAddress; draft: string; busy: readonly HqHonAgentKey[] | null; stalled: HqTeamStalled | null; voice?: React.ReactNode;
  onTo(to: HqTeamAddress): void; onDraft(text: string): void; onSend(): void; onRetry(): void; onDismiss(): void; onRefresh(): void;
};

/** Pure view: everything it shows comes from the props; it decides nothing. */
export function HqTeamChatView(props: HqTeamChatViewProps): React.ReactElement {
  const t = (key: HqTeamChatKey, values?: Record<string, string>) => hqTeamChatText(props.language, key, values);
  const view = props.view;
  const ready = props.phase === 'READY' && view !== null;
  const connected = ready && view.provider === 'CONNECTED';
  const budgeted = ready && view.budget.creditCap !== null;
  const canTalk = connected && budgeted && props.talkers.length > 0;
  const locked = props.busy !== null || (props.stalled !== null && (props.stalled.error.kind === 'UNKNOWN' || props.stalled.error.kind === 'CHANGED'));
  const reason = (e: MarketingError) => e.code === 'HQ_HON_TOO_MANY_IN_PROGRESS' ? t('busyServer')
    : e.kind === 'REFUSED' && e.code ? hqHonText(props.language as Language, e.code as HqHonCopyKey) : hqHonText(props.language as Language, (['DENIED', 'GONE'].includes(e.kind) ? 'denied' : e.kind) as HqHonCopyKey, { name: '' });
  return <section id="hq-team-chat" className={styles.chat} data-mode="modern" data-hq-team-chat={props.phase} aria-labelledby="hq-team-chat-title">
    <header className={styles.head}><div><h2 id="hq-team-chat-title">{t('title')}</h2><p className={styles.lead}>{t('lead')}</p></div></header>

    <ul className={styles.members} aria-label={t('talkTo')}>
      <li><button type="button" className={styles.member} data-member="everyone" aria-pressed={props.to === 'everyone'} disabled={!canTalk} onClick={() => props.onTo('everyone')}>
        <span className={styles.group} aria-hidden="true">{HQ_HON_AGENTS.slice(0, 4).map((k) => <img key={k} src={hqTeamPortrait(k, props.art)} alt="" width={28} height={28}/>)}</span>
        <strong>{t('everyone')}</strong>{props.talkers.length > 0 && <small>{props.talkers.map((k) => HQ_TEAM_NAMES[k]).join(' · ')}</small>}
      </button></li>
      {HQ_HON_AGENTS.map((key) => {
        const talks = canTalk && props.talkers.includes(key);
        return <li key={key}><button type="button" className={styles.member} data-member={key} aria-pressed={props.to === key} disabled={!talks}
          style={{ '--member': COLOR[key] } as React.CSSProperties} onClick={() => talks && props.onTo(key)}>
          <img src={hqTeamPortrait(key, props.art)} alt="" width={44} height={44}/><strong>{HQ_TEAM_NAMES[key]}</strong><small>{t(ROLE[key])}</small>
        </button></li>;
      })}
    </ul>

    {props.phase === 'LOADING' ? <p className={styles.notice} role="status">{t('loading')}</p>
      : props.phase === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p>
      : props.phase === 'UNAVAILABLE' ? <p className={styles.notice} role="alert">{t('unavailable')} <button type="button" className={styles.secondary} onClick={props.onRefresh}>{t('refresh')}</button></p>
      : !connected ? <p className={styles.notice} role="status">{t('providerOff')}</p>
      : !budgeted ? <p className={styles.notice} role="status">{t('noBudget')}</p> : null}

    {ready && <ol className={styles.messages} aria-live="polite" data-hon-private="">
      {props.messages.length === 0 && <li className={styles.empty}>{t('empty')}</li>}
      {props.messages.map((m) => m.kind === 'you'
        ? <li key={m.id} className={styles.you} data-message="you">
          <p className={styles.byline}><strong>{t('you')}</strong> <span>{m.to.length > 1 ? t('toEveryone') : `${t('to')} ${HQ_TEAM_NAMES[m.to[0] ?? 'hon']}`}</span></p>
          <p className={styles.text}>{m.text}</p>
        </li>
        : <li key={m.id} className={styles.agent} data-message={m.key} data-turn-status={m.turn.status} style={{ '--member': COLOR[m.key] } as React.CSSProperties}>
          <img src={hqTeamPortrait(m.key, props.art)} alt="" width={36} height={36}/>
          <div>
            <p className={styles.byline}><strong>{HQ_TEAM_NAMES[m.key]}</strong> <span>{t(ROLE[m.key])}</span></p>
            {m.turn.status === 'ANSWERED' ? (m.turn.concealed ? <p className={styles.meta}>{t('hidden')}</p> : <p className={styles.text}>{m.turn.reply}</p>)
              : <p className={styles.meta}>{t(m.turn.status === 'ANSWERING' ? 'answering' : m.turn.status === 'FAILED' || m.turn.status === 'RESOLVED_NOT_CHARGED' ? 'failed' : 'held')}</p>}
          </div>
        </li>)}
      {props.busy && props.busy.length > 0 && <li className={styles.typing} role="status">{t('asking', { name: props.busy.map((k) => HQ_TEAM_NAMES[k]).join(', ') })}</li>}
    </ol>}

    {props.stalled && <div className={styles.stalled} role="alert" data-stalled={props.stalled.error.kind}>
      <p>{props.stalled.error.kind === 'UNKNOWN' ? t('unknown', { name: HQ_TEAM_NAMES[props.stalled.who] })
        : t('refused', { name: HQ_TEAM_NAMES[props.stalled.who], reason: reason(props.stalled.error) })}</p>
      <div className={styles.actions}>
        {props.stalled.error.kind !== 'SESSION' && props.stalled.error.kind !== 'DENIED' && <button type="button" onClick={props.onRetry}>{t('retry')}</button>}
        <button type="button" className={styles.secondary} onClick={props.onDismiss}>{t('dismiss')}</button>
      </div>
    </div>}

    {canTalk && <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!locked) props.onSend(); }}>
      <label htmlFor="hq-team-chat-draft" className={styles.visuallyHidden}>{t('placeholder')}</label>
      <textarea id="hq-team-chat-draft" rows={2} maxLength={2000} value={props.draft} placeholder={t('placeholder')} disabled={locked}
        onChange={(event) => props.onDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!locked && props.draft.trim()) props.onSend(); } }}/>
      <div className={styles.actions}>
        <button type="submit" disabled={locked || !props.draft.trim()}>{t('send')} · {props.to === 'everyone' ? t('everyone') : HQ_TEAM_NAMES[props.to]}</button>
      </div>
      <p className={styles.meta}>{t('tipAddress')}</p>
    </form>}
    {canTalk && props.voice}
  </section>;
}

/**
 * The live HQ team chat. Reads the HQ Ask HON conversation (0263); every message is an ordinary HQ question with its
 * own Idempotency-Key, so the server re-checks the person, the agent, the budget and the route for each one. Unmount
 * retires every pending read and answer.
 */
export function HqTeamChat({ art = 'chibi', api = hqHonApi }: { art?: string; api?: HqHonApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const [phase, setPhase] = useState<Phase>('LOADING');
  const [view, setView] = useState<HqHonConversation | null>(null);
  const [to, setTo] = useState<HqTeamAddress>('everyone');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<readonly HqHonAgentKey[] | null>(null);
  const [stalled, setStalled] = useState<HqTeamStalled | null>(null);
  const mounted = useRef(true), generation = useRef(0), running = useRef(false);
  const talkers = view && view.provider === 'CONNECTED' && view.budget.creditCap !== null ? hqTeamTalkers(view.availableAgents) : [];

  const read = useCallback(async () => {
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const next = await api.conversation(AbortSignal.timeout(15000), owned);
    if (owned()) { setView(next); setPhase('READY'); }
  }, [api]);
  const load = useCallback(() => {
    read().catch((error) => { if (mounted.current) setPhase(error instanceof MarketingError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE'); });
  }, [read]);
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; generation.current++; running.current = false; }; }, [load]);

  const lang = honVoiceLang(language);
  const sendRef = useRef<(text: string, spoken: boolean) => boolean>(() => false);
  // No school here: HQ answers are read with this browser's own voice, each executive in a voice of their own.
  const voice = useHonVoice(lang, (text) => sendRef.current(text, true));
  const { replyParts, shutdown } = voice;
  useEffect(() => () => shutdown(), [shutdown]);

  const run = useCallback(async (round: HqTeamRound) => {
    if (running.current) return;
    running.current = true; setStalled(null);
    try {
      const outcome = await runHqTeamRound(round, {
        ask: (step, text) => api.ask({ question: text, replyMode: 'STANDARD', agentKey: step.key }, step.idempotencyKey, AbortSignal.timeout(60000), () => mounted.current),
        refresh: read, live: () => mounted.current, onBusy: (who) => { if (mounted.current) setBusy(who); },
      });
      if (outcome.kind === 'DONE') {
        if (round.spoken) replyParts(outcome.answers.filter((a) => a.reply && a.reply.trim())
          .map((a) => ({ text: `${hqTeamChatText(language, 'said', { name: HQ_TEAM_NAMES[a.key] })} ${a.reply!.trim()}`, profile: honAgentVoice(HQ_TEAM_VOICE[a.key]) })));
      } else if (outcome.kind === 'STALLED') {
        if (round.spoken) replyParts([{ text: hqTeamChatText(language, 'notAnswered', { name: HQ_TEAM_NAMES[outcome.who] }) }]);
        setStalled({ round, error: outcome.error, who: outcome.who });
      }
    } finally { running.current = false; }
  }, [api, read, replyParts, language]);

  const send = (raw: string, spoken: boolean): boolean => {
    if (running.current || phase !== 'READY' || (stalled && (stalled.error.kind === 'UNKNOWN' || stalled.error.kind === 'CHANGED'))) return false;
    const parsed = parseHqTeamAddress(raw);
    const targets = hqTeamTargets(parsed.to ?? to, talkers);
    const text = parsed.text.trim();
    if (!text || text.length > 2000 || targets.length === 0) return false;
    if (parsed.to) setTo(parsed.to);
    void run(newHqTeamRound(text, targets, spoken, () => crypto.randomUUID()));
    return true;
  };
  sendRef.current = send;

  const canVoice = phase === 'READY' && talkers.length > 0 && busy === null && !(stalled && (stalled.error.kind === 'UNKNOWN' || stalled.error.kind === 'CHANGED'));
  return <HqTeamChatView language={language} art={art} phase={phase} view={view} talkers={talkers}
    messages={view ? hqTeamMessages(view.turns, view.viewer.principalId) : []}
    to={to === 'everyone' || talkers.includes(to) ? to : 'everyone'} draft={draft} busy={busy} stalled={stalled}
    voice={<HonVoiceControls {...voice.controls(canVoice)} who="team"/>}
    onTo={setTo} onDraft={setDraft} onSend={() => { if (send(draft, false)) setDraft(''); }}
    onRetry={() => { if (stalled) void run(prepareHqTeamRetry(stalled.round, () => crypto.randomUUID())); }}
    onDismiss={() => { setStalled(null); load(); }} onRefresh={load}/>;
}
