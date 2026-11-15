'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FAMILY_MESSAGE_LIMITS, familyMessageBodyOk, type FamilyMessageInbox, type FamilyMessageThread } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  FamilyMessagesAccessError, FamilyMessagesRefusal, loadFamilyMessageInbox, loadFamilyMessageThread, markFamilyMessageThreadRead, replyFamilyMessage, sendAttempt,
  type FamilyMessagesScope,
} from './http';
import s from '../testing-registration.module.css';

function when(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Family messages are unavailable right now.'; }

/**
 * 0330 staff inbox: every family conversation of the verified school, newest first, with unread counts. Opening a thread
 * does not mark it read; "Mark read" and a reply do, up to the newest message on screen, so a later family message stays unread. The server checks family_messages.manage on every call. Nothing is
 * texted or emailed; families see the reply as from the school.
 */
export function StaffFamilyInbox(): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: FamilyMessagesScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const scopeKey = scope ? `${scope.organizationId}/${scope.schoolId}` : '';
  const [inbox, setInbox] = useState<FamilyMessageInbox | null>(null), [open, setOpen] = useState<FamilyMessageThread | null>(null), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false);
  const generation = useRef(0), attempt = useRef<{ text: string; key: string } | null>(null);

  const clear = useCallback(() => { ++generation.current; setInbox(null); setOpen(null); setText(''); attempt.current = null; }, []);
  const refresh = useCallback(async (threadId?: string) => {
    const [organizationId, schoolId] = scopeKey.split('/');
    if (!organizationId || !schoolId) return;
    const scope = { organizationId, schoolId };
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const [box, thread] = await Promise.all([loadFamilyMessageInbox(scope), threadId ? loadFamilyMessageThread(scope, threadId) : Promise.resolve(null)]);
      if (generation.current !== token) return;
      setInbox(box); setOpen(thread); setError(''); setHidden(false);
    } catch (problem) {
      if (generation.current !== token) return;
      setInbox(null); setOpen(null); setError(failure(problem)); setDenied(problem instanceof FamilyMessagesAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeKey]); // scopeKey is the scope's identity
  useEffect(() => { clear(); void refresh(); }, [scopeKey, clear, refresh]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => onShellPrivacyEvent(() => { clear(); setError(''); setNotice(''); setHidden(true); }), [clear]);
  const show = () => { setHidden(false); void refresh(); };

  async function command(run: () => Promise<unknown>, done: string, threadId: string) {
    setActing(true); setError(''); setNotice('');
    try { await run(); setNotice(done); await refresh(threadId); return true; }
    catch (problem) { setError(failure(problem)); if (problem instanceof FamilyMessagesAccessError) { clear(); setDenied(true); } return problem; }
    finally { setActing(false); }
  }
  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    const seen = open?.messages.at(-1)?.messageId;
    if (!scope || !open || !seen || acting || !familyMessageBodyOk(text)) return;
    attempt.current = sendAttempt(`${open.threadId}:${text}`, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key, threadId = open.threadId;
    const result = await command(() => replyFamilyMessage(scope, threadId, text, key, seen), `Reply sent to ${open.familyName}.`, threadId);
    if (result === true) { attempt.current = null; setText(''); }
    else if (result instanceof FamilyMessagesRefusal) attempt.current = null;
  }

  if (!scope) return <p role="status">Choose a school to see family messages.</p>;
  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><h1>Family messages</h1>
      <p>Messages families send from the HON parent app. Replies stay inside HON and show to the family as from the school. Nothing is texted or emailed.</p></header>
    {hidden && !inbox && <p className={s.actions}><button type="button" onClick={show}>Show family messages</button></p>}
    <div aria-live="polite">{busy && !inbox && <p role="status">Loading family messages…</p>}
      {error && <div className={s.error} role="alert"><strong>{denied ? 'Not available for your role' : 'Family messages'}</strong><p>{denied ? 'You need the family messages permission at this school.' : error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {inbox && <section className={s.card} aria-label="Inbox">
      <h2>Conversations{inbox.unreadThreads ? ` · ${inbox.unreadThreads} unread` : ''}</h2>
      {inbox.threads.length === 0 ? <p className={s.empty}>No family has written yet.</p> : <ul className={s.list}>
        {inbox.threads.map(t => <li key={t.threadId}>
          <button type="button" aria-current={open?.threadId === t.threadId ? 'true' : undefined} onClick={() => { setText(''); attempt.current = null; void refresh(t.threadId); }}>
            {t.familyName}{t.unreadCount ? <span className={s.badge}> {t.unreadCount} new</span> : null}
          </button> <span className={s.subtle}>{t.lastFrom === 'FAMILY' ? 'Family wrote' : 'School replied'} · {when(t.lastMessageAt)}</span>
        </li>)}
      </ul>}
      <p className={s.actions}><button type="button" disabled={busy} onClick={() => void refresh(open?.threadId)}>Refresh</button></p>
    </section>}
    {open && <section className={s.card} aria-label={`Conversation with ${open.familyName}`}>
      <h2>{open.familyName}</h2>
      <ol className={s.list}>{open.messages.map(m => <li key={m.messageId}>
        <p><strong>{m.from === 'FAMILY' ? open.familyName : m.mine ? 'You' : 'School staff'}</strong> · <span className={s.subtle}>{when(m.sentAt)}</span></p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p></li>)}</ol>
      {open.unreadCount > 0 && open.messages.length > 0 && <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(() => markFamilyMessageThreadRead(scope, open.threadId, open.messages.at(-1)!.messageId), 'Marked read.', open.threadId)}>Mark read ({open.unreadCount} new)</button></p>}
      <form onSubmit={sendReply}>
        <label htmlFor="family-reply">Reply to {open.familyName}</label>
        <textarea id="family-reply" rows={4} value={text} maxLength={FAMILY_MESSAGE_LIMITS.bodyMax + 1} onChange={e => setText(e.target.value)} disabled={acting} />
        <p className={s.subtle}>{text.length} / {FAMILY_MESSAGE_LIMITS.bodyMax}</p>
        <p className={s.actions}><button type="submit" disabled={acting || !familyMessageBodyOk(text)}>{acting ? 'Sending…' : 'Send reply'}</button></p>
      </form>
    </section>}
  </div></main>;
}
