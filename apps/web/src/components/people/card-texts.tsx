'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CONVERSATION_LIMITS, conversationBodyOk, type ConversationDetail, type ConversationRow } from '@hon/contracts';
import type { Language } from '@hon/design-system';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  ConversationsAccessError, ConversationsRefusal, commandAttempt, loadConversation, loadConversations, markConversationRead, replyConversation,
  type ConversationsScope,
} from '../conversations/http';
import { conversationsCopy, type ConversationsCopy } from '../conversations/copy';
import { panelText } from './panel-copy';
import styles from './people.module.css';

/** The server already narrows the list to the person (0401); this drops anything else that would ever come back. */
export function personConversations(rows: readonly ConversationRow[], personId: string): ConversationRow[] {
  const id = personId.toLowerCase();
  return rows.filter(r => r.personId?.toLowerCase() === id);
}
/** A reply is offered only where the inbox offers one: manage, an SMS thread, a linked person who opted in, an active sender. */
export function canReplyTo(open: ConversationDetail): boolean {
  return open.canManage && open.conversation.channel === 'SMS' && Boolean(open.contact.person) && open.contact.person?.smsConsent === 'OPTED_IN'
    && open.contact.schoolCanText;
}

export type CardTextsState = Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; conversations: readonly ConversationRow[]; more: boolean }>;
export type CardTextsViewProps = Readonly<{
  language: string; state: CardTextsState; open: ConversationDetail | null; text?: string; busy?: boolean; notice?: string; error?: string;
  onOpen?: (conversationId: string) => void; onBack?: () => void; onText?: (text: string) => void; onSend?: () => void; onMarkRead?: () => void; onReload?: () => void;
}>;
const when = (language: string, at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
const copyOf = (language: string): ConversationsCopy => conversationsCopy(language as Language);

/** Pure view of this person's texts and one open conversation. */
export function CardTextsView(props: CardTextsViewProps): React.ReactElement {
  const { language, state, open } = props;
  const copy = copyOf(language);
  const text = props.text ?? '';
  let body: React.ReactNode;
  if (state.state === 'LOADING') body = <p className={styles.meta} role="status">{copy.loading}</p>;
  else if (state.state === 'DENIED') body = <p className={styles.meta} role="note">{copy.denied}</p>;
  else if (state.state === 'UNAVAILABLE') body = <div className={styles.actions}><p className={styles.meta} role="status">{copy.unavailable}</p>
    {props.onReload ? <button type="button" className={styles.secondary} onClick={props.onReload}>{panelText(language, 'retry')}</button> : null}</div>;
  else if (open) {
    const consent = open.contact.person?.smsConsent;
    body = <div className={styles.subsection} data-testid="card-text-open">
      <div className={styles.choice}><h4>{open.conversation.contactAddress}</h4>
        <button type="button" className={styles.secondary} onClick={props.onBack}>{panelText(language, 'back')}</button></div>
      {open.contact.person ? <p className={styles.meta}>{copy.consent}: {consent === 'OPTED_IN' ? copy.consentIn : consent === 'OPTED_OUT' ? copy.consentOut : copy.consentNone}</p> : null}
      {!open.contact.schoolCanText ? <p className={styles.meta}>{copy.noSender}</p> : null}
      <ol className={styles.messages}>{open.messages.map(m => <li key={m.messageId} data-from={m.author}>
        <p className={styles.meta}><strong>{m.author === 'CONTACT' ? (open.conversation.contactName ?? copy.unknownContact) : m.staffName ?? copy.staff}</strong>
          {' · '}{when(language, m.at)}{m.delivery ? ` · ${copy.delivery[m.delivery]}` : ''}</p>
        <p className={styles.messageBody}>{m.body}</p></li>)}</ol>
      {open.canManage && open.conversation.unread > 0 && open.messages.length > 0 ? <button type="button" className={styles.secondary} disabled={props.busy}
        onClick={props.onMarkRead}>{copy.markRead(open.conversation.unread)}</button> : null}
      {canReplyTo(open) ? <form className={styles.form} onSubmit={event => { event.preventDefault(); props.onSend?.(); }}>
        <label htmlFor="card-text-reply">{copy.reply(open.conversation.contactName ?? open.conversation.contactAddress)}</label>
        <textarea id="card-text-reply" rows={3} value={text} maxLength={CONVERSATION_LIMITS.bodyMax + 1} disabled={props.busy}
          onChange={event => props.onText?.(event.target.value)} aria-describedby="card-text-reply-hint"/>
        <p id="card-text-reply-hint" className={styles.meta}>{copy.replyHint} {copy.counter(text.length, CONVERSATION_LIMITS.bodyMax)}</p>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={props.busy || !conversationBodyOk(text)}>
          {props.busy ? copy.sending : copy.send}</button></div>
      </form> : <p className={styles.meta} data-testid="card-text-no-reply">{open.canManage ? copy.cannotReply : copy.readOnly}</p>}
    </div>;
  } else if (!state.conversations.length) body = <p className={styles.meta}>{panelText(language, 'textsNone')}</p>;
  else body = <><ul className={styles.plain}>{state.conversations.map(c => <li key={c.conversationId} data-testid="card-text-thread">
    <button type="button" className={styles.person} onClick={() => props.onOpen?.(c.conversationId)}>
      <span><strong>{c.contactAddress}</strong>{c.status === 'CLOSED' ? ` · ${copy.closedBadge}` : ''}
        {c.unread ? <> · <span className={styles.count}>{copy.newBadge(c.unread)}</span></> : null}</span>
      <small>{c.lastMessage ? `${c.lastMessage.direction === 'INBOUND' ? copy.theyWrote : copy.youReplied} ${c.lastMessage.preview} · ` : ''}{when(language, c.lastMessageAt)}</small>
    </button></li>)}</ul>
    {state.more ? <p className={styles.meta}><a href="/staff/conversations">{panelText(language, 'textsMore')}</a></p> : null}</>;
  return <section className={styles.subsection} aria-label={panelText(language, 'textsTitle')} data-testid="card-texts">
    <div className={styles.choice}><h3>{panelText(language, 'textsTitle')}</h3><a className={styles.secondary} href="/staff/conversations">{panelText(language, 'textsOpen')}</a></div>
    {props.error ? <p className={styles.notice} role="alert">{props.error}</p> : null}
    {props.notice ? <p className={styles.notice} role="status">{props.notice}</p> : null}
    {body}
  </section>;
}

function problemText(problem: unknown, copy: ConversationsCopy): string {
  if (problem instanceof ConversationsAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof ConversationsRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}

/**
 * This person's texts (0364 + 0401) inside the contact card. The list asks the server for this person's conversations
 * of any status; the server checks conversation.read on every read and conversation.manage on mark read and reply, and the
 * 0243 worker re-checks consent, quiet hours and the sender before anything is sent. A reply whose outcome is unknown keeps
 * its key, so sending the same text again repeats the same command once.
 */
export function CardTexts({ language, scope, personId }: { language: string; scope: ConversationsScope; personId: string }): React.ReactElement {
  const copy = copyOf(language);
  const [state, setState] = useState<CardTextsState>({ state: 'LOADING' });
  const [open, setOpen] = useState<ConversationDetail | null>(null);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const load = useCallback(async (conversationId?: string) => {
    const token = ++generation.current;
    if (!conversationId) setState({ state: 'LOADING' });
    try {
      const [list, detail] = await Promise.all([loadConversations(scope, { personId: personId.toLowerCase(), status: 'ALL' }),
        conversationId ? loadConversation(scope, conversationId) : Promise.resolve(null)]);
      if (token !== generation.current) return;
      const rows = personConversations(list.conversations, personId);
      setState({ state: 'READY', conversations: rows, more: list.nextCursor !== null });
      setOpen(detail && rows.some(r => r.conversationId === detail.conversation.conversationId) ? detail : null);
    } catch (problem) {
      if (token !== generation.current) return;
      setOpen(null); setState({ state: problem instanceof ConversationsAccessError ? 'DENIED' : 'UNAVAILABLE' });
    }
  }, [scope.organizationId, scope.schoolId, personId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  // Concealment retires every read and drops a kept reply; the card is read again when the page is shown.
  useEffect(() => onShellPrivacyEvent(() => { generation.current++; setOpen(null); setText(''); attempt.current = null; setNotice(''); setError(''); }), []);

  const send = async () => {
    if (!open || busy || !conversationBodyOk(text) || !canReplyTo(open)) return;
    const c = open.conversation;
    attempt.current = commandAttempt(`reply:${c.conversationId}:${c.version}:${text}`, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key, token = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await replyConversation(scope, c.conversationId, c.version, text, key);
      if (token !== generation.current) return;
      attempt.current = null; setText(''); setNotice(copy.queued); await load(c.conversationId);
    } catch (problem) {
      if (token !== generation.current) return;
      if (problem instanceof ConversationsAccessError) { attempt.current = null; setOpen(null); setState({ state: 'DENIED' }); }
      else if (problem instanceof ConversationsRefusal) {
        attempt.current = null; setError(problemText(problem, copy));
        if (problem.code === 'CONVERSATION_VERSION_CONFLICT') await load(c.conversationId);
      } else setError(copy.unknownSend);
    } finally { if (token === generation.current) setBusy(false); }
  };
  const markRead = async () => {
    const seen = open?.messages.at(-1)?.messageId;
    if (!open || !seen || busy) return;
    const token = generation.current; setBusy(true); setError('');
    try { await markConversationRead(scope, open.conversation.conversationId, seen); if (token === generation.current) { setNotice(copy.markedRead); await load(open.conversation.conversationId); } }
    catch (problem) { if (token === generation.current) setError(problemText(problem, copy)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <CardTextsView language={language} state={state} open={open} text={text} busy={busy} notice={notice} error={error}
    onOpen={conversationId => { setText(''); attempt.current = null; setNotice(''); setError(''); void load(conversationId); }}
    onBack={() => { setOpen(null); setText(''); attempt.current = null; }}
    onText={setText} onSend={() => void send()} onMarkRead={() => void markRead()} onReload={() => void load()}/>;
}
