'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FAMILY_MESSAGE_LIMITS, familyMessageBodyOk, type FamilyMessageInbox, type FamilyMessageThread } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  FamilyMessagesAccessError, FamilyMessagesRefusal, loadFamilyMessageInbox, loadFamilyMessageThread, markFamilyMessageThreadRead, replyFamilyMessage, sendAttempt,
  type FamilyMessagesScope,
} from './http';
import s from '../comms-kit/comms.module.css';
import { initials } from '../comms-kit/initials';
import { shortWhen } from '../comms-kit/short-when';

function when(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Family messages are unavailable right now.'; }

/**
 * Parent app page (David 2026-11-19: "own page like sms conversation page"), laid out like Texts > Conversations.
 * 0330 staff inbox: every family conversation of the verified school, newest first, with unread counts. Opening a thread
 * does not mark it read; "Mark read" and a reply do, up to the newest message on screen, so a later family message stays unread. The server checks family_messages.manage on every call. Nothing is
 * texted or emailed; families see the reply as from the school. A reply is also sent as a phone alert to that family only when staff
 * tick "Also send as a phone alert" (0658), unticked by default; the alert never shows the message text.
 */
export function StaffFamilyInbox(): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: FamilyMessagesScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const scopeKey = scope ? `${scope.organizationId}/${scope.schoolId}` : '';
  const [inbox, setInbox] = useState<FamilyMessageInbox | null>(null), [open, setOpen] = useState<FamilyMessageThread | null>(null), [text, setText] = useState(''), [phoneAlert, setPhoneAlert] = useState(false);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false);
  const generation = useRef(0), attempt = useRef<{ text: string; key: string } | null>(null);

  const clear = useCallback(() => { ++generation.current; setInbox(null); setOpen(null); setText(''); setPhoneAlert(false); attempt.current = null; }, []);
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
    attempt.current = sendAttempt(`${open.threadId}:${phoneAlert ? 'alert' : 'quiet'}:${text}`, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key, threadId = open.threadId, alert = phoneAlert;
    const done = alert ? `Reply sent to ${open.familyName}, with a phone alert.` : `Reply sent to ${open.familyName}.`;
    const result = await command(() => replyFamilyMessage(scope, threadId, text, key, seen, alert), done, threadId);
    if (result === true) { attempt.current = null; setText(''); setPhoneAlert(false); }
    else if (result instanceof FamilyMessagesRefusal) attempt.current = null;
  }

  if (!scope) return <p role="status">Choose a school to see parent app messages.</p>;
  const pick = (threadId: string | null) => { setText(''); setPhoneAlert(false); attempt.current = null; if (threadId) void refresh(threadId); else { setOpen(null); void refresh(); } };
  return <main className={s.page} data-parent-app="">
    <header className={s.head}><div><h1>Parent app</h1>
      <p>Messages families send from the HON parent app. Your replies stay inside the app and show as from the school; they are not texted or emailed. Tick "Also send as a phone alert" to let the family's phones know a reply is waiting.</p></div>
      {inbox && <button type="button" className={s.ghost} disabled={busy} onClick={() => void refresh(open?.threadId)}>Refresh</button>}</header>
    {hidden && !inbox && <p className={s.actions}><button type="button" className={s.button} onClick={show}>Show parent app messages</button></p>}
    <div aria-live="polite">{busy && !inbox && <p className={s.muted} role="status">Loading parent app messages…</p>}
      {error && <div className={s.flash} data-tone="bad" role="alert"><strong>{denied ? 'Not available for your role' : 'Parent app'}</strong><p>{denied ? 'You need the family messages permission at this school.' : error}</p></div>}
      {notice && <p className={s.flash} data-tone="ok" role="status">{notice}</p>}</div>
    {inbox && <div className={s.split} data-open={open ? 'true' : undefined}>
      <section className={s.listPane} aria-label="Inbox">
        <div className={s.listTools}><p className={s.muted}>{inbox.unreadThreads ? `${inbox.unreadThreads} unread` : 'All read'}</p></div>
        {inbox.threads.length === 0 ? <p className={s.empty}>No family has written yet.</p> : <ul className={s.rows}>
          {inbox.threads.map(t => <li key={t.threadId}>
            <button type="button" className={s.row} aria-current={open?.threadId === t.threadId ? 'true' : undefined} onClick={() => pick(t.threadId)}>
              <span className={s.avatar} aria-hidden="true">{initials(t.familyName)}</span>
              <span className={s.rowMain}><span className={s.rowName}>{t.familyName}</span><span className={s.rowPreview}>{t.lastFrom === 'FAMILY' ? 'Family wrote' : 'School replied'}</span></span>
              <span className={s.rowSide}><time dateTime={t.lastMessageAt} title={when(t.lastMessageAt)}>{shortWhen(t.lastMessageAt, {})}</time>{t.unreadCount ? <span className={s.badge} data-tone="accent">{t.unreadCount} new</span> : null}</span>
            </button>
          </li>)}
        </ul>}
      </section>
      {open ? <section className={s.thread} aria-label={`Conversation with ${open.familyName}`}>
        <header className={s.threadHead}>
          <div className={s.actions}><button type="button" className={`${s.ghost} ${s.back}`} onClick={() => pick(null)}>Back</button><h2>{open.familyName}</h2></div>
          {open.unreadCount > 0 && open.messages.length > 0 && <button type="button" className={s.button} disabled={acting}
            onClick={() => void command(() => markFamilyMessageThreadRead(scope, open.threadId, open.messages.at(-1)!.messageId), 'Marked read.', open.threadId)}>Mark read ({open.unreadCount} new)</button>}
        </header>
        <ol className={s.messages}>{open.messages.map(m => <li key={m.messageId} className={s.bubble} data-from={m.from === 'FAMILY' ? 'in' : 'out'}>
          <p>{m.body}</p>
          <span className={s.bubbleMeta}><span>{m.from === 'FAMILY' ? open.familyName : m.mine ? 'You' : 'School staff'}</span><span>{when(m.sentAt)}</span></span></li>)}</ol>
        <form className={s.composer} onSubmit={sendReply}>
          <label htmlFor="family-reply" className={s.label}>Reply to {open.familyName}</label>
          <textarea id="family-reply" className={s.field} rows={3} value={text} maxLength={FAMILY_MESSAGE_LIMITS.bodyMax + 1} onChange={e => setText(e.target.value)} disabled={acting} />
          <label htmlFor="family-reply-phone-alert" className={s.muted} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input id="family-reply-phone-alert" type="checkbox" checked={phoneAlert} disabled={acting} onChange={e => setPhoneAlert(e.target.checked)} />
            Also send as a phone alert (shows only "You have a new message from the school")</label>
          <div className={s.composerBar}><span className={s.composerTools}>{text.length} / {FAMILY_MESSAGE_LIMITS.bodyMax}</span>
            <button type="submit" className={s.primary} disabled={acting || !familyMessageBodyOk(text)}>{acting ? 'Sending…' : 'Send reply'}</button></div>
        </form>
      </section> : <section className={s.thread}><p className={s.empty}>Pick a family on the left.</p></section>}
    </div>}
  </main>;
}
