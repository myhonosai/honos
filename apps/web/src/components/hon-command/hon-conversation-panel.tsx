'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HON_REPLY_CONCEALED_REASON, HON_REPLY_LIMITS, type HonConversationReadiness, type HonConversationSummary, type HonConversationThread,
  type HonConversationTurn, type HonReplyMode, type HonTurnReceipt,
} from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import {
  HON_CONVERSATION_API, HonConversationError, prepareConversation, prepareTurn, type HonConversationApi, type HonConversationFailure,
  type HonSchool, type PreparedHonCommand,
} from './hon-conversation-http';
import { honTurnStatusPresentation } from './hon-conversation';
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
};
/** Definitive refusals named by the server's error code; nothing was recorded for any of them. */
const CODE_TEXT: Record<string, string> = {
  HON_AI_SPEND_REFUSED: 'HON can’t answer right now: AI is paused by HON HQ, not active for this school, or this month’s included limit is reached. Nothing was sent and nothing is charged.',
  HON_CONVERSATION_FULL: 'This conversation is full. Start a new conversation to keep going. Nothing was sent.',
  HON_REPLY_NOT_CONTINUABLE: 'That answer can no longer be continued. Ask a new question instead. Nothing was sent.',
  HON_CONVERSATION_NOT_FOUND: 'That conversation is no longer available. Refresh to see your conversations. Nothing was sent.',
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
  first?: Readonly<{ text: string; replyMode: HonReplyMode }> };

export type HonConversationViewProps = {
  presentation: 'panel' | 'full'; phase: ConversationPhase; readiness: HonConversationReadiness | null; conversations: HonConversationSummary[];
  thread: HonConversationThread | null; threadPhase: 'NONE' | 'LOADING' | 'READY' | HonConversationFailure; pending: Pending | null;
  draft: string; mode: HonReplyMode;
  onDraft(text: string): void; onMode(mode: HonReplyMode): void; onSend(): void; onOpen(id: string): void; onNew(): void;
  onContinue(turn: HonConversationTurn): void; onRetry(): void; onDismiss(): void; onRefresh(): void;
};

function Turn({ turn, onContinue, locked }: { turn: HonConversationTurn; onContinue: (turn: HonConversationTurn) => void; locked: boolean }): React.ReactElement {
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
  </li>;
}

export function HonConversationView(props: HonConversationViewProps): React.ReactElement {
  const { phase, readiness, thread, pending } = props;
  const hidden = phase === 'CONCEALED' || phase === 'SESSION';
  const locked = pending !== null && pending.state === 'SENDING';
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
          {thread.turns.map((turn, index) => <Turn key={`${turn.turnId}-${index}`} turn={turn} onContinue={props.onContinue} locked={locked} />)}
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
  const generation = useRef(0), reads = useRef<AbortController | null>(null), concealed = useRef(false), ended = useRef(false), mounted = useRef(true);
  const openId = useRef<string | null>(null);

  const readThread = useCallback((conversationId: string, current: number, signal: AbortSignal) => {
    setThreadPhase('LOADING');
    api.thread(school, conversationId, signal).then(
      (next) => { if (current === generation.current && !concealed.current) { setThread(next); setThreadPhase('READY'); } },
      (error) => { if (current !== generation.current || signal.aborted) return; setThread(null); setThreadPhase(error instanceof HonConversationError ? error.kind : 'UNAVAILABLE'); });
  }, [api, school]);

  const load = useCallback(() => {
    if (ended.current) return;
    const current = ++generation.current; reads.current?.abort(); const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING'); setConversations([]); setThread(null); setThreadPhase('NONE');
    Promise.all([api.readiness(school, abort.signal), api.list(school, abort.signal)]).then(
      ([nextReadiness, page]) => {
        if (current !== generation.current || concealed.current || ended.current) return;
        setReadiness(nextReadiness); setConversations(page.items); setPhase('READY');
        const keep = openId.current && page.items.some((item) => item.id === openId.current) ? openId.current : null;
        openId.current = keep; if (keep) readThread(keep, current, abort.signal);
      },
      (error) => { if (current !== generation.current || abort.signal.aborted) return; const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
        if (kind === 'SESSION') ended.current = true; setReadiness(null); setPhase(kind); });
  }, [api, school, readThread]);

  useEffect(() => {
    mounted.current = true; load();
    const conceal = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState === 'visible') return;
      concealed.current = true; generation.current++; reads.current?.abort();
      for (const node of document.querySelectorAll<HTMLElement>('[data-hon-private]')) { node.hidden = true; node.inert = true; }
      setConversations([]); setThread(null); setThreadPhase('NONE');
      if (event.type === HON_SESSION_INVALIDATED_EVENT) { ended.current = true; setPhase('SESSION'); } else setPhase((now) => now === 'SESSION' ? now : 'CONCEALED');
    };
    const windowEvents = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT];
    for (const name of windowEvents) window.addEventListener(name, conceal);
    document.addEventListener('visibilitychange', conceal);
    return () => { mounted.current = false; generation.current++; reads.current?.abort(); for (const name of windowEvents) window.removeEventListener(name, conceal); document.removeEventListener('visibilitychange', conceal); };
  }, [load]);

  const afterSuccess = useCallback(() => { setPending(null); if (!concealed.current) load(); }, [load]);

  const run = useCallback((next: Pending) => {
    setPending({ ...next, state: 'SENDING', code: null });
    const work: Promise<HonConversationSummary | HonTurnReceipt> = next.kind === 'create' ? api.create(next.prepared) : api.sendTurn(next.prepared);
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
      if (kind === 'SESSION') ended.current = true;
      setPending({ ...next, state: kind, code: error instanceof HonConversationError ? error.code : null });
      if (kind !== 'UNKNOWN' && next.text) { const typed = next.text; setDraft((now) => now || typed); }
    });
  }, [api, school, afterSuccess]);

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
    onOpen={(conversationId) => { if (concealed.current) return; openId.current = conversationId; const abort = new AbortController(); reads.current?.abort(); reads.current = abort; readThread(conversationId, generation.current, abort.signal); }}
    onNew={() => { openId.current = null; setThread(null); setThreadPhase('NONE'); }}
    onContinue={(turn) => {
      if (!thread || concealed.current || !turn.replyDetail?.canContinue) return;
      try { run({ prepared: prepareTurn(school, thread.id, { text: 'Please continue.', delegation: null, continueTurnId: turn.turnId }), kind: 'turn', label: 'Continue HON’s answer', state: 'SENDING', conversationId: thread.id }); }
      catch { /* invalid continuation is never sent */ }
    }}
    onRetry={() => { if (pending && !concealed.current && pending.prepared.path) run({ ...pending, state: 'SENDING' }); }}
    onDismiss={() => { setPending(null); if (!concealed.current) load(); }}
    onRefresh={() => { concealed.current = false; load(); }} />;
}
