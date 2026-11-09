'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HON_REPLY_CONCEALED_REASON, HON_REPLY_LIMITS, type FollowUpDraftPurpose, type HonConversationReadiness, type HonConversationSummary,
  type HonConversationThread, type HonConversationTurn, type HonDelegateAgentKey, type HonOrchestration, type HonReplyMode, type HonTurnReceipt,
} from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import {
  HON_CONVERSATION_API, HonConversationError, prepareConversation, prepareTurn, type HonConversationApi, type HonConversationFailure,
  type HonSchool, type Owned, type PreparedHonCommand,
} from './hon-conversation-http';
import { honTurnStatusPresentation } from './hon-conversation';
import {
  ORCHESTRATION_PRESENTATION, PURPOSE_LABEL, SUGGESTION_AGENT, SUGGESTION_PURPOSES, orchestrationsBySource, suggestionDelegation, textLimit,
  type HonDelegateTarget,
} from './hon-suggestions';
import styles from './hon-conversation.module.css';

const AGENT_NAME: Record<string, string> = { hon: 'HON', marcus: 'Marcus', claire: 'Kai', kai: 'Kai', chad: 'Chad', HUMAN: 'You' };
const FAILURE: Record<HonConversationFailure, string> = {
  SESSION: 'Your session ended. Sign in again.',
  FORBIDDEN: 'This account cannot use HON at this school. Nothing was sent.',
  INVALID: 'HON could not accept that message. Keep it under 2,000 characters, without passwords, card numbers or other secrets.',
  CONFLICT: 'This request was already used for different content. Nothing new was sent. Refresh and try again.',
  UNAVAILABLE: 'HON conversations could not be verified right now. Nothing is shown in their place.',
  UNKNOWN: 'The outcome is unknown: HON may or may not have received it. Retry sends the exact same request and cannot create a second reply or charge.',
};
const REASON: Record<string, string> = {
  [HON_REPLY_CONCEALED_REASON]: 'HON’s answer is hidden because it could not be shown safely. Nothing else happened.',
  CONFIGURATION_REQUIRED: 'HON’s AI provider is not activated yet, so no answer was generated. Nothing is charged.',
  UNSUPPORTED_PROVIDER: 'HON’s AI provider is not activated yet, so no answer was generated. Nothing is charged.',
  AI_ACCESS_REFUSED: 'HON could not answer: the included AI team is not active for this school, is paused by HON HQ, or reached this month’s included limit. Nothing is charged.',
  SOURCE_ACCESS_REFUSED: 'HON could not answer: this question needs school reporting access your role does not have. Nothing is charged.',
  SOURCE_ACCESS_LAPSED: 'HON’s answer is held because reporting access changed. It shows again once access returns. Nothing is charged.',
  ACCESS_LAPSED: 'HON’s answer is held because AI access changed. It shows again once access returns. Nothing is charged.',
  RESULT_HELD: 'HON’s answer is held until access is confirmed again. Nothing is charged.',
  RESULT_BUDGET_EXCEEDED: 'HON stopped this answer because it went over its safety limit. It was not shown. Nothing is charged.',
  INVALID_REQUEST: 'HON could not process this question. Try rephrasing it. Nothing is charged.',
  PROVIDER_REJECTED: 'The AI provider declined to answer this question. Try rephrasing it. Nothing is charged.',
  PROVIDER_UNKNOWN: 'HON could not confirm whether an answer was produced. HON HQ reviews it; it will not be sent twice.',
  HANDOFF_NOT_CONFIRMED: 'HON could not confirm this message was handed over. Retry sends the exact same request.',
  AGENT_NOT_AUTHORIZED: 'The specialist could not take this request: your role or this school’s AI access does not allow it. Nothing was drafted and nothing is charged.',
  AGENT_REQUEST_INVALID: 'The specialist could not accept this request. Nothing was drafted and nothing is charged.',
  AGENT_TARGET_NOT_FOUND: 'The chosen campaign, curriculum or lead is no longer available to this specialist. Nothing was drafted and nothing is charged.',
  AGENT_REQUEST_CONFLICT: 'That record changed or already has a request in progress. Nothing new was drafted and nothing is charged.',
};
/** Definitive refusals named by the server's error code; nothing was recorded for any of them. */
const CODE_TEXT: Record<string, string> = {
  HON_AI_SPEND_REFUSED: 'HON can’t answer right now: AI is paused by HON HQ, not active for this school, or this month’s included limit is reached. Nothing was sent and nothing is charged.',
  HON_CONVERSATION_FULL: 'This conversation is full. Start a new conversation to keep going. Nothing was sent.',
  HON_REPLY_NOT_CONTINUABLE: 'That answer can no longer be continued. Ask a new question instead. Nothing was sent.',
  HON_CONVERSATION_NOT_FOUND: 'That conversation is no longer available. Refresh to see your conversations. Nothing was sent.',
  HON_SUGGESTION_NOT_CONFIRMABLE: 'That suggestion can no longer be confirmed: this specialist was already asked from this answer, or the answer or the specialist’s access changed. Nothing was sent.',
};
const failureText = (state: HonConversationFailure, code: string | null | undefined) => (code && state !== 'UNKNOWN' ? CODE_TEXT[code] : undefined) ?? FAILURE[state];
const reasonText = (reason: string | null) => reason === null ? null : REASON[reason] ?? `HON could not answer (${reason.toLowerCase().replaceAll('_', ' ')}). Nothing is charged.`;
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export type { Pending as HonConversationPending };
export type ConversationPhase = 'LOADING' | 'READY' | 'CONCEALED' | HonConversationFailure;
/** A create carries the first question (`first`) so it is sent as its own frozen turn once the conversation exists. */
type Pending = { prepared: PreparedHonCommand; kind: 'create' | 'turn'; label: string; state: 'SENDING' | HonConversationFailure; conversationId: string | null; code?: string | null;
  /** The question as typed, restored to the composer after a definitive refusal so nothing typed is lost. */
  text?: string;
  first?: Readonly<{ text: string; replyMode: HonReplyMode }>;
  /** A confirmed suggestion, reopened with what was chosen after a definitive refusal (the target list is read again). */
  confirm?: ConfirmChoice };

/** What the human chose for one suggestion. Ids are selectors only; the server re-checks the human, school and target. */
export type ConfirmChoice = Readonly<{ sourceTurnId: string; agent: HonDelegateAgentKey; targetId: string; purpose: FollowUpDraftPurpose | null; text: string }>;
export type SuggestionConfirm = ConfirmChoice & { seq: number; targets: 'LOADING' | HonConversationFailure | readonly HonDelegateTarget[] };
export type GroupPhase = 'NONE' | 'LOADING' | 'READY' | HonConversationFailure;

export type HonConversationViewProps = {
  presentation: 'panel' | 'full'; phase: ConversationPhase; readiness: HonConversationReadiness | null; conversations: HonConversationSummary[];
  thread: HonConversationThread | null; threadPhase: 'NONE' | 'LOADING' | 'READY' | HonConversationFailure; pending: Pending | null;
  draft: string; mode: HonReplyMode;
  /** C3a grouped confirmations of this thread's HON answers, by source turn id (lower case). */
  groups: ReadonlyMap<string, HonOrchestration>; groupPhase: GroupPhase; confirm: SuggestionConfirm | null;
  onSuggest(sourceTurnId: string, agent: HonDelegateAgentKey): void; onConfirmChange(patch: Partial<ConfirmChoice>): void; onConfirmSend(): void; onConfirmCancel(): void;
  onDraft(text: string): void; onMode(mode: HonReplyMode): void; onSend(): void; onOpen(id: string): void; onNew(): void;
  onContinue(turn: HonConversationTurn): void; onRetry(): void; onDismiss(): void; onRefresh(): void;
};

const TARGET_FAILURE: Partial<Record<HonConversationFailure, string>> = {
  FORBIDDEN: 'Your role cannot see this specialist’s list at this school, so it can’t be asked from here. Nothing was sent.',
  SESSION: 'Your session ended. Sign in again.',
};

function ConfirmForm({ confirm, locked, onChange, onSend, onCancel }: {
  confirm: SuggestionConfirm; locked: boolean; onChange: (patch: Partial<ConfirmChoice>) => void; onSend: () => void; onCancel: () => void;
}): React.ReactElement {
  const agent = SUGGESTION_AGENT[confirm.agent];
  const limit = textLimit(confirm.agent);
  const base = `hon-confirm-${confirm.sourceTurnId}-${confirm.agent}`;
  const targets = Array.isArray(confirm.targets) ? confirm.targets as readonly HonDelegateTarget[] : null;
  const chosen = targets?.some((target) => target.id === confirm.targetId) ?? false;
  const ready = chosen && confirm.text.trim().length > 0 && confirm.text.length <= limit && (confirm.agent !== 'chad' || confirm.purpose !== null) && !locked;
  return <form className={styles.confirm} aria-label={`Ask ${agent.name}`} data-confirm={confirm.agent}
    onSubmit={(event) => { event.preventDefault(); if (ready) onSend(); }}>
    {confirm.targets === 'LOADING' ? <p role="status" className={styles.note}>Loading {agent.target.toLowerCase()} choices for {agent.name}…</p> : null}
    {typeof confirm.targets === 'string' && confirm.targets !== 'LOADING'
      ? <p role="alert" className={styles.note}>{TARGET_FAILURE[confirm.targets] ?? `${agent.name}’s ${agent.target.toLowerCase()} list could not be verified right now. Nothing is shown in its place and nothing was sent.`}</p> : null}
    {targets && targets.length === 0 ? <p className={styles.note}>{agent.empty}</p> : null}
    {targets && targets.length > 0 ? <label htmlFor={`${base}-target`}>{agent.target}
      <select id={`${base}-target`} required value={chosen ? confirm.targetId : ''} disabled={locked} onChange={(event) => onChange({ targetId: event.target.value })}>
        <option value="">Choose a {agent.target.toLowerCase()}</option>
        {targets.map((target) => <option key={target.id} value={target.id}>{target.detail ? `${target.label} (${target.detail})` : target.label}</option>)}
      </select></label> : null}
    {confirm.agent === 'chad' && targets && targets.length > 0 ? <fieldset className={styles.modes} disabled={locked}><legend>Follow-up type</legend>
      {SUGGESTION_PURPOSES.map((purpose) => <label key={purpose}><input type="radio" name={`${base}-purpose`} checked={confirm.purpose === purpose} onChange={() => onChange({ purpose })} />{PURPOSE_LABEL[purpose]}</label>)}
    </fieldset> : null}
    {targets && targets.length > 0 ? <>
      <label htmlFor={`${base}-text`}>What should {agent.name} draft?</label>
      <textarea id={`${base}-text`} rows={2} maxLength={limit} value={confirm.text} disabled={locked} aria-describedby={`${base}-help`} onChange={(event) => onChange({ text: event.target.value })} />
      <p id={`${base}-help`} className={styles.meta}>{(limit - confirm.text.length).toLocaleString()} characters left. Don’t include passwords, card numbers or medical details.</p>
    </> : null}
    <p className={styles.meta}>{agent.name} drafts only. Anything consequential goes to Action Center for a human decision. Included in HON OS; nothing here is charged.</p>
    <div className={styles.actions}>
      {targets && targets.length > 0 ? <button type="submit" disabled={!ready}>Send to {agent.name}</button> : null}
      <button type="button" className={styles.secondary} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function Suggestions({ turn, group, groupPhase, available, locked, confirm, onSuggest, onConfirmChange, onConfirmSend, onConfirmCancel }: {
  turn: HonConversationTurn; group: HonOrchestration | undefined; groupPhase: GroupPhase; available: readonly HonDelegateAgentKey[]; locked: boolean;
  confirm: SuggestionConfirm | null; onSuggest: HonConversationViewProps['onSuggest']; onConfirmChange: HonConversationViewProps['onConfirmChange'];
  onConfirmSend: () => void; onConfirmCancel: () => void;
}): React.ReactElement | null {
  const suggested = turn.status === 'COMPLETED' && turn.reason !== HON_REPLY_CONCEALED_REASON ? turn.replyDetail?.suggestions ?? [] : [];
  if (suggested.length === 0 && !group) return null;
  const asked = new Set(group?.members.map((member) => member.agentKey) ?? []);
  const verified = groupPhase === 'READY';
  const status = group ? ORCHESTRATION_PRESENTATION[group.status] : null;
  return <div className={styles.suggestions} data-hon-suggestions={turn.turnId}>
    {group && status ? <div className={styles.group} data-orchestration={group.status}>
      <div className={styles.turnHead}><strong>Specialists you asked</strong><span className={styles.status} data-tone={status.tone}>{status.label}</span></div>
      <p className={styles.note}>{status.detail}</p>
      <ul className={styles.members}>{group.members.map((member) => {
        const memberStatus = honTurnStatusPresentation(member.status);
        return <li key={member.turnId}><span>{SUGGESTION_AGENT[member.agentKey].name}</span><span className={styles.status} data-tone={memberStatus.tone}>{memberStatus.label}</span></li>;
      })}</ul>
      {group.status === 'NEEDS_REVIEW' || group.status === 'PARTIAL' ? <a className={styles.link} href="/staff/action-center/approvals">Review drafts in Action Center →</a> : null}
    </div> : null}
    {suggested.length > 0 ? <>
      <p className={styles.meta}>HON suggests asking {suggested.length === 1 ? 'a specialist' : 'these specialists'}. Nothing runs until you choose what they work on and confirm.</p>
      {!verified && groupPhase !== 'LOADING' && groupPhase !== 'NONE'
        ? <p role="alert" className={styles.note}>Whether you already asked these specialists could not be verified, so they can’t be asked from here right now. Refresh to try again.</p> : null}
      <ul className={styles.cards} aria-label="Specialists HON suggests">{suggested.map((key) => {
        const agent = SUGGESTION_AGENT[key];
        const open = confirm !== null && confirm.sourceTurnId === turn.turnId && confirm.agent === key;
        return <li key={key} className={styles.card} data-suggestion={key}>
          <div className={styles.turnHead}><strong>{agent.name}</strong><span className={styles.meta}>{agent.role}</span></div>
          <p className={styles.note}>{agent.does}</p>
          {asked.has(key) ? <p className={styles.meta} data-asked="">Asked from this answer. See its status above.</p>
            : !available.includes(key) ? <p className={styles.meta}>{agent.name} isn’t available for your role at this school right now.</p>
            : open && confirm ? <ConfirmForm confirm={confirm} locked={locked} onChange={onConfirmChange} onSend={onConfirmSend} onCancel={onConfirmCancel} />
            : <button type="button" className={styles.secondary} disabled={locked || !verified || confirm !== null} onClick={() => onSuggest(turn.turnId, key)}>Ask {agent.name}</button>}
        </li>;
      })}</ul>
    </> : null}
  </div>;
}

function Turn({ turn, onContinue, locked, children }: { turn: HonConversationTurn; onContinue: (turn: HonConversationTurn) => void; locked: boolean; children?: React.ReactNode }): React.ReactElement {
  const status = honTurnStatusPresentation(turn.status);
  const human = turn.role === 'HUMAN';
  const detail = turn.replyDetail;
  return <li className={styles.turn} data-role={human ? 'human' : turn.role} data-status={turn.status}>
    <div className={styles.turnHead}><strong>{AGENT_NAME[turn.role] ?? turn.role}</strong>{human ? null : <span className={styles.status} data-tone={status.tone}>{status.label}</span>}
      <time dateTime={turn.createdAt}>{when(turn.createdAt)}</time></div>
    {turn.text !== null ? <p className={styles.text}>{turn.text}</p> : null}
    {!human && turn.text === null && turn.status !== 'COMPLETED' ? <p className={styles.note}>{reasonText(turn.reason) ?? status.detail}</p> : null}
    {!human && turn.status === 'COMPLETED' && turn.reason !== null ? <p className={styles.note}>{reasonText(turn.reason)}</p> : null}
    {turn.role !== 'HUMAN' && turn.role !== 'hon' && turn.references.actionRequestId
      ? <a className={styles.link} href="/staff/action-center/approvals">Review this proposal in Action Center →</a> : null}
    {detail?.truncated ? <p className={styles.note} data-incomplete="">This answer is incomplete: it reached its length limit (part {detail.step} of {detail.maxSteps}).</p> : null}
    {detail?.canContinue ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onContinue(turn)}>Continue this answer</button> : null}
    {children}
  </li>;
}

export function HonConversationView(props: HonConversationViewProps): React.ReactElement {
  const { phase, readiness, thread, pending } = props;
  const hidden = phase === 'CONCEALED' || phase === 'SESSION';
  const locked = pending !== null && pending.state === 'SENDING';
  // A specialist request whose outcome is unknown keeps its one exact retry; no second request is offered meanwhile.
  const suggestLocked = pending !== null && (pending.state === 'SENDING' || pending.state === 'UNKNOWN');
  const available = readiness?.availableAgentKeys ?? [];
  const canAsk = phase === 'READY' && readiness?.honReply === true && !locked;
  const id = `hon-ask-${props.presentation}`;
  const left = HON_REPLY_LIMITS.questionCharacters - props.draft.length;
  return <section className={styles.conversation} aria-labelledby={`${id}-title`} data-hon-conversation={phase} data-presentation={props.presentation}>
    <div className={styles.head}>
      <h3 id={`${id}-title`}>Ask HON</h3>
      <span className={styles.status} data-tone={readiness?.honReply ? 'ready' : 'blocked'}>{phase !== 'READY' ? 'Not shown' : readiness?.honReply ? 'Connected' : 'Not available'}</span>
      {phase !== 'LOADING' ? <button type="button" className={styles.secondary} onClick={props.onRefresh}>Refresh</button> : null}
    </div>
    <p className={styles.note}>HON answers from this school’s records and recommends next steps. It never acts on its own: anything consequential goes to Action Center for a human decision. HON is included in HON OS; nothing here is charged.</p>
    {phase === 'LOADING' ? <p role="status" className={styles.note}>Checking HON for this school…</p> : null}
    {phase === 'CONCEALED' ? <p role="status" className={styles.note}>Conversations are hidden while you were away. Refresh to show them again.</p> : null}
    {phase !== 'READY' && phase !== 'LOADING' && phase !== 'CONCEALED' ? <p role="alert" className={styles.note}>{FAILURE[phase]}</p> : null}
    {pending && hidden ? <p key="pending-hidden" role="status" className={styles.note} data-pending-hidden="">A message you sent is still tracked. Refresh to see it again.</p> : null}
    {pending && !hidden ? <div key="pending" role={pending.state === 'SENDING' ? 'status' : 'alert'} className={styles.pending} data-pending={pending.state} data-hon-private="">
      <strong>{pending.label}</strong><p>{pending.state === 'SENDING' ? 'HON is working on it…' : failureText(pending.state, pending.code)}</p>
      {pending.state === 'UNKNOWN' && phase === 'READY' ? <div className={styles.actions}><button type="button" onClick={props.onRetry}>Retry the same request</button><button type="button" className={styles.secondary} onClick={props.onDismiss}>Stop and refresh</button></div> : null}
      {pending.state !== 'SENDING' && pending.state !== 'UNKNOWN' ? <button type="button" className={styles.secondary} onClick={props.onDismiss}>Dismiss</button> : null}
    </div> : null}
    {phase === 'READY' && readiness && !readiness.honReply
      ? <p className={styles.note} data-readiness="">HON can’t answer questions at this school right now: {!readiness.authorization ? 'your role does not include HON.' : !readiness.entitlement ? 'the included AI team is not active or the monthly included limit is reached.' : !readiness.providerRoute ? 'the AI provider is not activated yet.' : 'HON is not ready yet.'} Nothing is charged.</p> : null}
    {phase === 'READY' ? <div key="records" className={styles.body} data-hon-private="">
      <nav className={styles.history} aria-label="Your HON conversations">
        <button type="button" className={styles.secondary} disabled={locked} onClick={props.onNew} aria-pressed={thread === null}>New conversation</button>
        {props.conversations.length === 0 ? <p className={styles.note}>No conversations yet.</p>
          : <ul>{props.conversations.map((item) => <li key={item.id}><button type="button" disabled={locked} aria-current={thread?.id === item.id ? 'true' : undefined} onClick={() => props.onOpen(item.id)}>
            <span>{item.title}</span><small>{when(item.updatedAt)} · {item.turnCount} {item.turnCount === 1 ? 'question' : 'questions'}</small></button></li>)}</ul>}
      </nav>
      <div className={styles.thread}>
        {props.threadPhase === 'LOADING' ? <p role="status" className={styles.note}>Loading conversation…</p> : null}
        {props.threadPhase !== 'NONE' && props.threadPhase !== 'LOADING' && props.threadPhase !== 'READY' ? <p role="alert" className={styles.note}>{FAILURE[props.threadPhase]}</p> : null}
        {thread && props.threadPhase === 'READY' ? <ol className={styles.turns} aria-label={thread.title}>
          {thread.turns.map((turn, index) => <Turn key={`${turn.turnId}-${index}`} turn={turn} onContinue={props.onContinue} locked={locked}>
            {turn.role === 'hon' ? <Suggestions turn={turn} group={props.groups.get(turn.turnId.toLowerCase())} groupPhase={props.groupPhase} available={available} locked={suggestLocked}
              confirm={props.confirm} onSuggest={props.onSuggest} onConfirmChange={props.onConfirmChange} onConfirmSend={props.onConfirmSend} onConfirmCancel={props.onConfirmCancel} /> : null}
          </Turn>)}
        </ol> : null}
        {thread === null && props.threadPhase === 'NONE' ? <p className={styles.note}>Ask about leads, trials, memberships, attendance or what to do next. Your first message starts a new conversation.</p> : null}
        <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (canAsk && props.draft.trim()) props.onSend(); }}>
          <label htmlFor={`${id}-text`}>Message HON</label>
          <textarea id={`${id}-text`} rows={props.presentation === 'full' ? 3 : 2} maxLength={HON_REPLY_LIMITS.questionCharacters} value={props.draft} disabled={!canAsk}
            onChange={(event) => props.onDraft(event.target.value)} aria-describedby={`${id}-help`} placeholder={canAsk ? 'How can I help you today?' : 'HON is not available right now'} />
          <div className={styles.composerRow}>
            <fieldset className={styles.modes} disabled={!canAsk}><legend>Answer</legend>
              {(['STANDARD', 'DETAILED'] as const).map((mode) => <label key={mode}><input type="radio" name={`${id}-mode`} checked={props.mode === mode} onChange={() => props.onMode(mode)} />{mode === 'STANDARD' ? 'Quick' : 'Detailed'}</label>)}
            </fieldset>
            <button type="submit" disabled={!canAsk || props.draft.trim().length === 0}>Send</button>
          </div>
          <p id={`${id}-help`} className={styles.meta}>{left.toLocaleString()} characters left. Don’t include passwords, card numbers or medical details.</p>
        </form>
      </div>
    </div> : null}
  </section>;
}

/**
 * Container. Every read is for exactly the verified school passed in; a school change remounts it (keyed by the parent).
 * Private conversation content is concealed synchronously on blur, a hidden tab, page hide or session end, and shown again
 * only after an explicit Refresh. A sent message is never cancelled: its outcome and exact retry are kept.
 */
export function HonConversation({ school, presentation, api = HON_CONVERSATION_API }: { school: HonSchool; presentation: 'panel' | 'full'; api?: HonConversationApi }): React.ReactElement {
  const [phase, setPhase] = useState<ConversationPhase>('LOADING');
  const [readiness, setReadiness] = useState<HonConversationReadiness | null>(null);
  const [conversations, setConversations] = useState<HonConversationSummary[]>([]);
  const [thread, setThread] = useState<HonConversationThread | null>(null);
  const [threadPhase, setThreadPhase] = useState<HonConversationViewProps['threadPhase']>('NONE');
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<HonReplyMode>('STANDARD');
  const [groups, setGroups] = useState<ReadonlyMap<string, HonOrchestration>>(new Map());
  const [groupPhase, setGroupPhase] = useState<GroupPhase>('NONE');
  const [confirm, setConfirm] = useState<SuggestionConfirm | null>(null);
  const generation = useRef(0), reads = useRef<AbortController | null>(null), concealed = useRef(false), ended = useRef(false), mounted = useRef(true);
  const openId = useRef<string | null>(null);
  // Ownership for 401s: the privacy epoch advances on conceal and unmount; the pending key names the one command in flight;
  // the confirm sequence names the one open target list. A retired request never ends this session.
  const privacy = useRef(0), pendingKey = useRef<string | null>(null), confirmSeq = useRef(0), targetRead = useRef<AbortController | null>(null);
  const readOwned = (current: number, shown: number): Owned => () => mounted.current && current === generation.current && shown === privacy.current;

  const closeConfirm = useCallback(() => { confirmSeq.current++; targetRead.current?.abort(); targetRead.current = null; setConfirm(null); }, []);

  const readThread = useCallback((conversationId: string, current: number, signal: AbortSignal) => {
    const shown = privacy.current;
    setThreadPhase('LOADING'); setGroupPhase('LOADING'); setGroups(new Map());
    api.thread(school, conversationId, signal, readOwned(current, shown)).then(
      (next) => { if (current === generation.current && !concealed.current) { setThread(next); setThreadPhase('READY'); } },
      (error) => { if (current !== generation.current || signal.aborted) return; setThread(null); setThreadPhase(error instanceof HonConversationError ? error.kind : 'UNAVAILABLE'); });
    api.orchestrations(school, conversationId, signal, readOwned(current, shown)).then(
      (list) => { if (current === generation.current && !concealed.current) { setGroups(orchestrationsBySource(list)); setGroupPhase('READY'); } },
      (error) => { if (current !== generation.current || signal.aborted) return; setGroups(new Map()); setGroupPhase(error instanceof HonConversationError ? error.kind : 'UNAVAILABLE'); });
  }, [api, school]);

  const load = useCallback(() => {
    if (ended.current) return;
    const current = ++generation.current; reads.current?.abort(); const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING'); setConversations([]); setThread(null); setThreadPhase('NONE'); setGroups(new Map()); setGroupPhase('NONE'); closeConfirm();
    const owned = readOwned(current, privacy.current);
    Promise.all([api.readiness(school, abort.signal, owned), api.list(school, abort.signal, null, owned)]).then(
      ([nextReadiness, page]) => {
        if (current !== generation.current || concealed.current || ended.current) return;
        setReadiness(nextReadiness); setConversations(page.items); setPhase('READY');
        const keep = openId.current && page.items.some((item) => item.id === openId.current) ? openId.current : null;
        openId.current = keep; if (keep) readThread(keep, current, abort.signal);
      },
      (error) => { if (current !== generation.current || abort.signal.aborted) return; const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
        if (kind === 'SESSION') ended.current = true; setReadiness(null); setPhase(kind); });
  }, [api, school, readThread, closeConfirm]);

  useEffect(() => {
    mounted.current = true; load();
    const conceal = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState === 'visible') return;
      concealed.current = true; generation.current++; privacy.current++; reads.current?.abort(); closeConfirm();
      for (const node of document.querySelectorAll<HTMLElement>('[data-hon-private]')) { node.hidden = true; node.inert = true; }
      setConversations([]); setThread(null); setThreadPhase('NONE'); setGroups(new Map()); setGroupPhase('NONE');
      if (event.type === HON_SESSION_INVALIDATED_EVENT) { ended.current = true; setPhase('SESSION'); } else setPhase((now) => now === 'SESSION' ? now : 'CONCEALED');
    };
    const windowEvents = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT];
    for (const name of windowEvents) window.addEventListener(name, conceal);
    document.addEventListener('visibilitychange', conceal);
    return () => { mounted.current = false; generation.current++; privacy.current++; pendingKey.current = null; confirmSeq.current++; targetRead.current?.abort(); reads.current?.abort(); for (const name of windowEvents) window.removeEventListener(name, conceal); document.removeEventListener('visibilitychange', conceal); };
  }, [load, closeConfirm]);

  const afterSuccess = useCallback(() => { pendingKey.current = null; setPending(null); if (!concealed.current) load(); }, [load]);

  /** Opens the confirmation for one suggestion and reads that specialist's targets for this human. */
  const openConfirm = useCallback((choice: ConfirmChoice) => {
    if (concealed.current || ended.current) return;
    targetRead.current?.abort();
    const seq = ++confirmSeq.current, shown = privacy.current, abort = new AbortController(); targetRead.current = abort;
    setConfirm({ ...choice, seq, targets: 'LOADING' });
    const owned: Owned = () => mounted.current && seq === confirmSeq.current && shown === privacy.current;
    api.targets(choice.agent, school, abort.signal, owned).then(
      (targets) => { if (owned() && !concealed.current) setConfirm((now) => now && now.seq === seq ? { ...now, targets, targetId: targets.some((t) => t.id === now.targetId) ? now.targetId : '' } : now); },
      (error) => { if (!owned() || abort.signal.aborted) return; const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
        setConfirm((now) => now && now.seq === seq ? { ...now, targets: kind } : now); });
  }, [api, school]);

  const run = useCallback((next: Pending) => {
    setPending({ ...next, state: 'SENDING', code: null });
    pendingKey.current = next.prepared.key;
    const shown = privacy.current, key = next.prepared.key;
    const owned: Owned = () => mounted.current && shown === privacy.current && pendingKey.current === key;
    const work: Promise<HonConversationSummary | HonTurnReceipt> = next.kind === 'create' ? api.create(next.prepared, owned) : api.sendTurn(next.prepared, owned);
    work.then((result) => {
      if (!mounted.current) return;
      if (next.kind === 'create') {
        // The conversation exists; send the waiting first message as its own frozen turn.
        const created = result as HonConversationSummary; openId.current = created.id;
        const first = next.first;
        if (first) {
          try { run({ prepared: prepareTurn(school, created.id, { text: first.text, delegation: null, replyMode: first.replyMode }), kind: 'turn', label: 'Your message to HON', state: 'SENDING', conversationId: created.id, text: first.text }); return; }
          catch { /* fall through to refresh */ }
        }
      }
      afterSuccess();
    }, (error) => {
      if (!mounted.current) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNKNOWN';
      if (kind === 'SESSION' && owned()) ended.current = true;
      setPending({ ...next, state: kind, code: error instanceof HonConversationError ? error.code : null });
      if (kind === 'UNKNOWN') return;
      // A definitive refusal recorded nothing: give back what was typed (a question to the composer, a request to its form).
      if (next.confirm) { if (kind !== 'SESSION' && !concealed.current && openId.current === next.conversationId) openConfirm(next.confirm); }
      else if (next.text) { const typed = next.text; setDraft((now) => now || typed); }
    });
  }, [api, school, afterSuccess, openConfirm]);

  const sendConfirm = () => {
    const current = confirm;
    if (!thread || !current || concealed.current || !Array.isArray(current.targets)) return;
    const target = (current.targets as readonly HonDelegateTarget[]).find((item) => item.id === current.targetId);
    const text = current.text.trim();
    if (!target || !text) return;
    const choice: ConfirmChoice = Object.freeze({ sourceTurnId: current.sourceTurnId, agent: current.agent, targetId: current.targetId, purpose: current.purpose, text: current.text });
    let prepared: PreparedHonCommand;
    try { prepared = prepareTurn(school, thread.id, { text, delegation: suggestionDelegation(current.agent, target, current.purpose), fromSuggestionTurnId: current.sourceTurnId }); }
    catch { return; }
    closeConfirm();
    openId.current = thread.id;
    run({ prepared, kind: 'turn', label: `Your request to ${SUGGESTION_AGENT[current.agent].name}`, state: 'SENDING', conversationId: thread.id, confirm: choice });
  };

  const send = () => {
    const text = draft.trim();
    if (!text || concealed.current) return;
    try {
      if (thread) {
        openId.current = thread.id;
        run({ prepared: prepareTurn(school, thread.id, { text, delegation: null, replyMode: mode }), kind: 'turn', label: 'Your message to HON', state: 'SENDING', conversationId: thread.id, text });
      } else {
        const title = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
        const pendingCreate: Pending = { prepared: prepareConversation(school, title), kind: 'create', label: 'Starting a conversation with HON', state: 'SENDING', conversationId: null, text,
          first: Object.freeze({ text, replyMode: mode }) };
        run(pendingCreate);
      }
      setDraft('');
    } catch { setPending({ prepared: { path: '', key: '', body: '' }, kind: 'turn', label: 'Your message to HON', state: 'INVALID', conversationId: null }); return; }
  };

  return <HonConversationView presentation={presentation} phase={phase} readiness={readiness} conversations={conversations} thread={thread} threadPhase={threadPhase}
    pending={pending} draft={draft} mode={mode} onDraft={setDraft} onMode={setMode} onSend={send}
    groups={groups} groupPhase={groupPhase} confirm={confirm}
    onSuggest={(sourceTurnId, agent) => {
      if (!thread || (pending && (pending.state === 'SENDING' || pending.state === 'UNKNOWN')) || groupPhase !== 'READY') return;
      openConfirm({ sourceTurnId, agent, targetId: '', purpose: null, text: '' });
    }}
    onConfirmChange={(patch) => setConfirm((now) => now ? { ...now, ...patch } : now)}
    onConfirmSend={sendConfirm} onConfirmCancel={closeConfirm}
    onOpen={(conversationId) => { if (concealed.current) return; closeConfirm(); openId.current = conversationId; const abort = new AbortController(); reads.current?.abort(); reads.current = abort; readThread(conversationId, generation.current, abort.signal); }}
    onNew={() => { closeConfirm(); openId.current = null; setThread(null); setThreadPhase('NONE'); setGroups(new Map()); setGroupPhase('NONE'); }}
    onContinue={(turn) => {
      if (!thread || concealed.current || !turn.replyDetail?.canContinue) return;
      try { run({ prepared: prepareTurn(school, thread.id, { text: 'Please continue.', delegation: null, continueTurnId: turn.turnId }), kind: 'turn', label: 'Continue HON’s answer', state: 'SENDING', conversationId: thread.id }); }
      catch { /* invalid continuation is never sent */ }
    }}
    onRetry={() => { if (pending && !concealed.current && pending.prepared.path) run({ ...pending, state: 'SENDING' }); }}
    onDismiss={() => { pendingKey.current = null; setPending(null); if (!concealed.current) load(); }}
    onRefresh={() => { concealed.current = false; load(); }} />;
}
