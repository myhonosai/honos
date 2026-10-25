'use client';

import React from 'react';
import { HON_CONVERSATION_BOUNDARY, honComposerEnabled, honTurnStatusPresentation, type HonTurnStatus } from './hon-conversation';
import { HON_MESSAGE_MAX, HON_REFERENCE_DESTINATIONS, type HonTurn } from './hon-conversation-contract';
import { HON_READINESS_LABELS, type HonConversationSnapshot } from './hon-conversation-data';
import { AgentPortrait, HonMark } from './hon-portraits';
import { honAgent } from './roster';
import styles from './hon-command.module.css';

/** Starting points offered only while the server reports the conversation READY. They fill the composer and never send. */
export const HON_CONVERSATION_STARTERS = [
  'How is my school doing this month?',
  'Ask Chad to review enrollment follow-ups.',
  'Have Marcus prepare a campaign for next week.',
  'Show me what needs approval.',
  'Summarize attendance problems.',
] as const;

export interface HonConversationActions {
  onDraft?: ((text: string) => void) | undefined;
  onSend?: (() => void) | undefined;
  onNew?: (() => void) | undefined;
  onSelect?: ((threadId: string) => void) | undefined;
  onCheck?: (() => void) | undefined;
}

export interface HonConversationViewProps extends HonConversationActions {
  snapshot: HonConversationSnapshot;
  presentation: 'panel' | 'full';
}

function when(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function StatusChip({ status }: { status: HonTurnStatus }): React.ReactElement {
  const view = honTurnStatusPresentation(status);
  return <span className={styles.badge} data-tone={view.tone} data-turn-status={view.status}>{view.label}</span>;
}

/** Proposals, approvals, failures and unknown outcomes always say plainly that nothing is assumed to have run. */
function StatusNotice({ status }: { status: HonTurnStatus }): React.ReactElement | null {
  const view = honTurnStatusPresentation(status);
  if (view.status === 'AWAITING_APPROVAL') {
    return <div className={styles.turnNotice} data-turn-status="AWAITING_APPROVAL">
      <strong>Approval required. Nothing has run.</strong>
      <p>A qualified person at this school must decide in Action Center before anything happens.</p>
      <a className={styles.inlineLink} href={HON_REFERENCE_DESTINATIONS.ACTION_REQUEST.href}>{HON_REFERENCE_DESTINATIONS.ACTION_REQUEST.label} →</a>
    </div>;
  }
  if (view.status === 'PROPOSED' || view.status === 'FAILED' || view.status === 'UNKNOWN') {
    return <p className={styles.turnNotice} data-turn-status={view.status}>{view.detail}</p>;
  }
  return null;
}

function Turn({ turn }: { turn: HonTurn }): React.ReactElement {
  const agent = turn.role === 'AGENT' ? honAgent(turn.agentKey) : null;
  const speaker = turn.role === 'HUMAN' ? 'You' : agent ? agent.name : 'HON';
  return <li className={styles.turn} data-role={turn.role} style={agent ? { '--agent': agent.color } as React.CSSProperties : undefined}>
    <div className={styles.turnAvatar}>
      {turn.role === 'HUMAN' ? <span className={styles.youMark} aria-hidden="true">You</span> : agent ? <AgentPortrait agent={agent} size="sm" /> : <HonMark size="sm" />}
    </div>
    <div className={styles.turnBody}>
      <p className={styles.turnMeta}>
        <strong>{speaker}</strong>
        {agent ? <span> · {agent.title}</span> : null}
        <span> · <time dateTime={turn.createdAt}>{when(turn.createdAt)}</time></span>
      </p>
      {turn.text ? <p className={styles.turnText}>{turn.text}</p> : null}
      {turn.role !== 'HUMAN' ? <StatusChip status={turn.status} /> : null}
      {turn.delegations.length ? <ul className={styles.delegations} aria-label="Handed to specialists">
        {turn.delegations.map((delegation, index) => {
          const delegate = honAgent(delegation.agentKey);
          if (!delegate) return null;
          return <li key={`${delegation.agentKey}-${index}`} style={{ '--agent': delegate.color } as React.CSSProperties}>
            <AgentPortrait agent={delegate} size="sm" />
            <div>
              <p className={styles.turnMeta}><strong>HON → {delegate.name}</strong> <span>· {delegate.title}</span></p>
              <p>{delegation.summary}</p>
              <StatusChip status={delegation.status} />
            </div>
          </li>;
        })}
      </ul> : null}
      {turn.role !== 'HUMAN' ? <StatusNotice status={turn.status} /> : null}
      {turn.references.length ? <ul className={styles.references} aria-label="Linked records">
        {turn.references.map((reference) => {
          const destination = HON_REFERENCE_DESTINATIONS[reference.kind];
          return <li key={`${reference.kind}-${reference.id}`}>
            <a href={destination.href}>{destination.label} →</a>
            <span className={styles.meta}>Record {reference.id.slice(0, 8)} · access is checked again there</span>
          </li>;
        })}
      </ul> : null}
    </div>
  </li>;
}

function Readiness({ snapshot }: { snapshot: HonConversationSnapshot }): React.ReactElement {
  const readiness = snapshot.connection.readiness;
  return <ul className={styles.readiness} aria-label="Server checks required before HON can converse">
    {(Object.keys(HON_READINESS_LABELS) as (keyof typeof HON_READINESS_LABELS)[]).map((key) => {
      const confirmed = readiness?.[key] === true;
      return <li key={key} data-confirmed={confirmed ? 'true' : 'false'}>
        <span aria-hidden="true">{confirmed ? '✓' : '○'}</span> {HON_READINESS_LABELS[key]}: {readiness === null ? 'not confirmed' : confirmed ? 'confirmed by the server' : 'not ready'}
      </li>;
    })}
  </ul>;
}

function History(props: HonConversationViewProps & { ready: boolean }): React.ReactElement {
  const { snapshot, presentation, ready } = props;
  const threads = snapshot.threads;
  const list = <>
    <button type="button" disabled={!ready || snapshot.send.state === 'SENDING'} onClick={props.onNew}>New conversation</button>
    {threads.state === 'LOADING' ? <p className={styles.meta} role="status">{threads.message}</p> : null}
    {threads.state === 'ERROR' ? <p className={styles.meta} role="alert">{threads.message}</p> : null}
    {threads.state === 'IDLE' || threads.state === 'EMPTY' ? <p className={styles.meta}>{threads.message}</p> : null}
    {threads.items.length ? <ul className={styles.threadList}>
      {threads.items.map((item) => <li key={item.id}>
        <button type="button" aria-current={snapshot.active.threadId === item.id ? 'true' : undefined} disabled={snapshot.send.state === 'SENDING'} onClick={() => props.onSelect?.(item.id)}>
          <strong>{item.title}</strong>
          <span className={styles.meta}><time dateTime={item.updatedAt}>{when(item.updatedAt)}</time></span>
          <StatusChip status={item.status} />
        </button>
      </li>)}
    </ul> : null}
    {threads.more ? <p className={styles.meta}>Older conversations are not shown yet.</p> : null}
  </>;
  const heading = threads.items.length ? `Your conversations (${threads.items.length}${threads.more ? '+' : ''})` : 'Your conversations';
  return presentation === 'full'
    ? <nav className={styles.history} aria-label="Your HON conversations"><h4>{heading}</h4>{list}</nav>
    : <details className={styles.history}><summary>{heading}</summary>{list}</details>;
}

function Transcript({ snapshot }: { snapshot: HonConversationSnapshot }): React.ReactElement {
  const active = snapshot.active;
  return <div className={styles.transcript} role="log" aria-live="polite" aria-label="Conversation with HON">
    {active.state === 'LOADING' ? <p className={styles.meta} role="status">{active.message}</p> : null}
    {active.state === 'ERROR' ? <p className={styles.state} role="alert" data-state="ERROR">{active.message}</p> : null}
    {active.state === 'NEW' ? <p className={styles.meta}>New conversation. HON answers only from verified school records and turns anything consequential into a proposal for human approval.</p> : null}
    {active.thread ? <>
      <h4 className={styles.threadTitle}>{active.thread.title}</h4>
      {active.thread.turns.length
        ? <ol className={styles.turns}>{active.thread.turns.map((turn) => <Turn key={turn.id} turn={turn} />)}</ol>
        : <p className={styles.meta}>This conversation has no messages yet.</p>}
    </> : null}
  </div>;
}

/**
 * HON conversation surface shared by the panel, the full workspace and all three
 * modes. It renders only what the controller verified; with no server-confirmed
 * readiness it stays "Not connected" with the composer disabled.
 */
export function HonConversationView(props: HonConversationViewProps): React.ReactElement {
  const { snapshot, presentation } = props;
  const connection = snapshot.connection;
  const ready = connection.state === 'READY' && honComposerEnabled(connection.readiness);
  const sending = snapshot.send.state === 'SENDING';
  const canType = ready && !sending && (snapshot.active.state === 'NEW' || snapshot.active.state === 'READY');
  const id = `hon-conversation-${presentation}`;
  const badge = ready ? { tone: 'ready', label: 'Connected' }
    : connection.state === 'CHECKING' ? { tone: 'neutral', label: 'Checking' }
      : connection.state === 'DENIED' ? { tone: 'blocked', label: 'Not available' }
        : connection.state === 'ERROR' ? { tone: 'blocked', label: 'Check failed' }
          : { tone: 'blocked', label: 'Not connected' };
  return <section className={styles.conversation} data-presentation={presentation} data-connection={connection.state} aria-labelledby={id}>
    <div className={styles.conversationHead}>
      <h3 id={id}>Ask HON</h3>
      <span className={styles.badge} data-tone={badge.tone}>{badge.label}</span>
    </div>
    {connection.state === 'NOT_CONNECTED'
      ? <p className={styles.conversationNote}><strong>{HON_CONVERSATION_BOUNDARY.headline}.</strong> {HON_CONVERSATION_BOUNDARY.detail}</p>
      : <p className={styles.conversationNote} role={connection.state === 'ERROR' ? 'alert' : connection.state === 'CHECKING' ? 'status' : undefined}>{connection.message}</p>}
    {!ready && connection.state !== 'DENIED' ? <Readiness snapshot={snapshot} /> : null}
    {connection.state !== 'DENIED' ? <div className={styles.conversationGrid}>
      <History {...props} ready={ready} />
      <div className={styles.conversationMain}>
        {ready ? <Transcript snapshot={snapshot} /> : null}
        {ready && snapshot.active.state === 'NEW' && !snapshot.send.text ? <div className={styles.starters}>
          <p className={styles.meta}>Try asking. A starter only fills the message box.</p>
          <ul>{HON_CONVERSATION_STARTERS.map((starter) => <li key={starter}><button type="button" onClick={() => props.onDraft?.(starter)}>{starter}</button></li>)}</ul>
        </div> : null}
        <div className={styles.composer}>
          <label htmlFor={`hon-composer-${presentation}`} className={styles.visuallyHidden}>{ready ? 'Message HON' : 'Message HON (not connected)'}</label>
          <textarea
            id={`hon-composer-${presentation}`}
            rows={presentation === 'full' ? 3 : 2}
            disabled={!canType}
            maxLength={HON_MESSAGE_MAX}
            value={ready ? snapshot.send.text : ''}
            readOnly={!props.onDraft}
            placeholder={ready ? 'Ask HON about your school…' : 'Conversation is not connected yet'}
            aria-describedby={`hon-composer-help-${presentation}`}
            onChange={(event) => props.onDraft?.(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); props.onSend?.(); } }}
          />
          <button type="button" disabled={!canType || !snapshot.send.text.trim()} onClick={props.onSend}>{snapshot.send.state === 'UNKNOWN' ? 'Retry' : 'Send'}</button>
        </div>
        <p id={`hon-composer-help-${presentation}`} className={styles.meta}>
          {ready ? `Up to ${HON_MESSAGE_MAX} characters. Ctrl or ⌘ + Enter sends. Nothing runs without the approvals your school requires.` : 'The composer stays off until the server confirms every check above for you and this school.'}
        </p>
        {sending ? <p className={styles.sendState} role="status" data-send="SENDING">{snapshot.send.message}</p> : null}
        {snapshot.send.state === 'FAILED' ? <div className={styles.sendState} role="alert" data-send="FAILED"><strong>Not sent.</strong> {snapshot.send.message}</div> : null}
        {snapshot.send.state === 'UNKNOWN' ? <div className={styles.sendState} role="alert" data-send="UNKNOWN">
          <strong>Outcome unknown.</strong> {snapshot.send.message}
          <button type="button" onClick={props.onCheck}>Check the conversation</button>
        </div> : null}
      </div>
    </div> : null}
    {!ready ? <>
      <a className={styles.inlineLink} href={HON_CONVERSATION_BOUNDARY.handoff.href}>{HON_CONVERSATION_BOUNDARY.handoff.label} →</a>
      <p className={styles.meta}>{HON_CONVERSATION_BOUNDARY.handoff.detail}</p>
    </> : null}
  </section>;
}
