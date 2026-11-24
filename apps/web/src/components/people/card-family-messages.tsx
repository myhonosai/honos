'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FAMILY_MESSAGE_LIMITS, familyMessageBodyOk, type FamilyMessageInbox, type FamilyMessageInboxThread, type FamilyMessageThread } from '@hon/contracts';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  FamilyMessagesAccessError, FamilyMessagesRefusal, loadFamilyMessageInbox, loadFamilyMessageThread, markFamilyMessageThreadRead, replyFamilyMessage, sendAttempt,
  type FamilyMessagesScope,
} from '../family-messages/http';
import { panelText, type PanelKey } from './panel-copy';
import styles from './people.module.css';

/** Only the threads of the families the card names; another family's thread is never shown here. */
export function familyThreads(inbox: FamilyMessageInbox, familyIds: readonly string[]): FamilyMessageInboxThread[] {
  const wanted = new Set(familyIds.map(f => f.toLowerCase()));
  return inbox.threads.filter(t => wanted.has(t.familyId.toLowerCase()));
}

export type FamilyThreadsState = Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; threads: readonly FamilyMessageInboxThread[] }>;
export type CardFamilyMessagesViewProps = Readonly<{
  language: string; state: FamilyThreadsState; open: FamilyMessageThread | null; text?: string; busy?: boolean; notice?: string; error?: string; canRetry?: boolean;
  onOpen?: (threadId: string) => void; onBack?: () => void; onText?: (text: string) => void; onSend?: () => void; onMarkRead?: () => void; onReload?: () => void;
}>;
const when = (language: string, at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));

/** Pure view of this person's family threads and one open thread. */
export function CardFamilyMessagesView(props: CardFamilyMessagesViewProps): React.ReactElement {
  const { language, state, open } = props;
  const p = (key: PanelKey, vars?: Readonly<Record<string, string | number>>) => panelText(language, key, vars);
  const text = props.text ?? '';
  let body: React.ReactNode;
  if (state.state === 'LOADING') body = <p className={styles.meta} role="status">{p('familyMessagesLoading')}</p>;
  else if (state.state === 'DENIED') body = <p className={styles.meta} role="note">{p('familyMessagesDenied')}</p>;
  else if (state.state === 'UNAVAILABLE') body = <div className={styles.actions}><p className={styles.meta} role="status">{p('familyMessagesUnavailable')}</p>
    {props.onReload ? <button type="button" className={styles.secondary} onClick={props.onReload}>{p('retry')}</button> : null}</div>;
  else if (open) body = <div className={styles.subsection} data-testid="card-family-open">
    <div className={styles.choice}><h4>{open.familyName}</h4><button type="button" className={styles.secondary} onClick={props.onBack}>{p('back')}</button></div>
    <ol className={styles.messages}>{open.messages.map(m => <li key={m.messageId} data-from={m.from}>
      <p className={styles.meta}><strong>{m.from === 'FAMILY' ? open.familyName : m.mine ? p('you') : p('schoolStaff')}</strong> · {when(language, m.sentAt)}</p>
      <p className={styles.messageBody}>{m.body}</p></li>)}</ol>
    {open.unreadCount > 0 && open.messages.length > 0 ? <button type="button" className={styles.secondary} disabled={props.busy} onClick={props.onMarkRead}>
      {p('markRead')} ({p('newCount', { n: open.unreadCount })})</button> : null}
    <form className={styles.form} onSubmit={event => { event.preventDefault(); props.onSend?.(); }}>
      <label htmlFor="card-family-reply">{p('reply')}</label>
      <textarea id="card-family-reply" rows={3} value={text} maxLength={FAMILY_MESSAGE_LIMITS.bodyMax + 1} disabled={props.busy}
        onChange={event => props.onText?.(event.target.value)} aria-describedby="card-family-reply-hint"/>
      <p id="card-family-reply-hint" className={styles.meta}>{p('replyHint')} {text.length} / {FAMILY_MESSAGE_LIMITS.bodyMax}</p>
      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={props.busy || !familyMessageBodyOk(text)}>
        {props.busy ? p('sending') : props.canRetry ? p('retry') : p('send')}</button></div>
    </form>
  </div>;
  else if (!state.threads.length) body = <p className={styles.meta}>{p('familyMessagesNone')}</p>;
  else body = <ul className={styles.plain}>{state.threads.map(t => <li key={t.threadId} data-testid="card-family-thread">
    <button type="button" className={styles.person} onClick={() => props.onOpen?.(t.threadId)}>
      <span><strong>{t.familyName}</strong>{t.unreadCount ? <> · <span className={styles.count}>{p('newCount', { n: t.unreadCount })}</span></> : null}</span>
      <small>{p(t.lastFrom === 'FAMILY' ? 'familyWrote' : 'schoolReplied')} · {when(language, t.lastMessageAt)}</small>
    </button></li>)}</ul>;
  return <section className={styles.subsection} aria-label={p('familyMessagesTitle')} data-testid="card-family-messages">
    <h3>{p('familyMessagesTitle')}</h3>
    {props.error ? <p className={styles.notice} role="alert">{props.error}</p> : null}
    {props.notice ? <p className={styles.notice} role="status">{props.notice}</p> : null}
    {body}
  </section>;
}

/**
 * This person's family messages (0330) inside the contact card. The school inbox read is the same one the Family
 * messages page uses, and the server checks family_messages.manage on every call; the browser only narrows it to the
 * card's families. A reply whose outcome is unknown keeps its key, so "Try again" repeats the same send once.
 */
export function CardFamilyMessages({ language, scope, familyIds }: { language: string; scope: FamilyMessagesScope; familyIds: readonly string[] }): React.ReactElement {
  const [state, setState] = useState<FamilyThreadsState>({ state: 'LOADING' });
  const [open, setOpen] = useState<FamilyMessageThread | null>(null);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const generation = useRef(0), attempt = useRef<{ text: string; key: string } | null>(null);
  const families = familyIds.join(',');
  const load = useCallback(async (threadId?: string) => {
    const token = ++generation.current;
    if (!threadId) setState({ state: 'LOADING' });
    try {
      const [inbox, thread] = await Promise.all([loadFamilyMessageInbox(scope), threadId ? loadFamilyMessageThread(scope, threadId) : Promise.resolve(null)]);
      if (token !== generation.current) return;
      const threads = familyThreads(inbox, families ? families.split(',') : []);
      setState({ state: 'READY', threads });
      setOpen(thread && threads.some(t => t.threadId === thread.threadId) ? thread : null);
    } catch (problem) {
      if (token !== generation.current) return;
      setOpen(null); setState({ state: problem instanceof FamilyMessagesAccessError ? 'DENIED' : 'UNAVAILABLE' });
    }
  }, [scope.organizationId, scope.schoolId, families]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  // Concealment retires every read and drops a kept send; the card is read again when the page is shown.
  useEffect(() => onShellPrivacyEvent(() => { generation.current++; setOpen(null); setText(''); attempt.current = null; setCanRetry(false); setNotice(''); setError(''); }), []);

  const send = async () => {
    const seen = open?.messages.at(-1)?.messageId;
    if (!open || !seen || busy || !familyMessageBodyOk(text)) return;
    attempt.current = sendAttempt(`${open.threadId}:${text}`, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key, threadId = open.threadId, token = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await replyFamilyMessage(scope, threadId, text, key, seen);
      if (token !== generation.current) return;
      attempt.current = null; setCanRetry(false); setText(''); setNotice(panelText(language, 'sent')); await load(threadId);
    } catch (problem) {
      if (token !== generation.current) return;
      if (problem instanceof FamilyMessagesAccessError) { attempt.current = null; setCanRetry(false); setOpen(null); setState({ state: 'DENIED' }); }
      else if (problem instanceof FamilyMessagesRefusal) { attempt.current = null; setCanRetry(false); setError(problem.message); }
      else { setCanRetry(true); setError(panelText(language, 'sendUnknown')); }
    } finally { if (token === generation.current) setBusy(false); }
  };
  const markRead = async () => {
    const seen = open?.messages.at(-1)?.messageId;
    if (!open || !seen || busy) return;
    const token = generation.current; setBusy(true); setError('');
    try { await markFamilyMessageThreadRead(scope, open.threadId, seen); if (token === generation.current) await load(open.threadId); }
    catch (problem) { if (token === generation.current) setError(problem instanceof Error ? problem.message : panelText(language, 'familyMessagesUnavailable')); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <CardFamilyMessagesView language={language} state={state} open={open} text={text} busy={busy} notice={notice} error={error} canRetry={canRetry}
    onOpen={threadId => { setText(''); attempt.current = null; setCanRetry(false); setNotice(''); setError(''); void load(threadId); }}
    onBack={() => { setOpen(null); setText(''); attempt.current = null; setCanRetry(false); }}
    onText={value => { setText(value); if (attempt.current && attempt.current.text !== `${open?.threadId}:${value}`) setCanRetry(false); }}
    onSend={() => void send()} onMarkRead={() => void markRead()} onReload={() => void load()}/>;
}
