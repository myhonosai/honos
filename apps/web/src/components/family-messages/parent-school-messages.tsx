'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FAMILY_MESSAGE_LIMITS, familyMessageBodyOk, type ParentFamilyMessages } from '@hon/contracts';
import { FamilyMessagesAccessError, FamilyMessagesRefusal, loadParentFamilyMessages, sendAttempt, sendParentFamilyMessage } from './http';
import s from '../testing-registration.module.css';

function when(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function failure(error: unknown) { return error instanceof Error ? error.message : 'Messages are unavailable right now.'; }

/**
 * 0330: the family's conversation with the school, inside HON. Guardians write; viewers read. Replies show as "the school",
 * never with a staff name. Nothing is texted or emailed. A hidden tab clears the conversation from the screen.
 */
export function ParentSchoolMessages(): React.ReactElement {
  const [view, setView] = useState<ParentFamilyMessages | null>(null), [text, setText] = useState('');
  const [busy, setBusy] = useState(true), [sending, setSending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [lost, setLost] = useState(false);
  const generation = useRef(0), attempt = useRef<{ text: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setBusy(true); setLost(false);
    try { const data = await loadParentFamilyMessages(); if (generation.current === token) { setView(data); setError(''); } }
    catch (problem) { if (generation.current === token) { setView(null); setError(failure(problem)); setLost(problem instanceof FamilyMessagesAccessError); } }
    finally { if (generation.current === token) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const visibility = () => { if (document.visibilityState === 'hidden') { ++generation.current; setView(null); } else void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { ++generation.current; document.removeEventListener('visibilitychange', visibility); };
  }, [load]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!view?.canWrite || sending || !familyMessageBodyOk(text)) return;
    attempt.current = sendAttempt(text, attempt.current, () => crypto.randomUUID());
    setSending(true); setError(''); setNotice('');
    try {
      await sendParentFamilyMessage(text, attempt.current.key);
      attempt.current = null; setText(''); setNotice('Sent to the school.');
      await load();
    } catch (problem) {
      setError(failure(problem));
      if (problem instanceof FamilyMessagesAccessError) { setLost(true); setView(null); attempt.current = null; }
      else if (problem instanceof FamilyMessagesRefusal) attempt.current = null;
    } finally { setSending(false); }
  }

  const tooLong = text.length > FAMILY_MESSAGE_LIMITS.bodyMax;
  return <section className={s.card} aria-labelledby="school-messages-title">
    <h2 id="school-messages-title">Messages with {view?.schoolName ?? 'your school'}</h2>
    <p className={s.subtle}>Write to the school here. Staff reply inside HON; nothing is sent by text or email.</p>
    <div aria-live="polite">{busy && !view && <p role="status">Loading your messages…</p>}
      {error && <div className={s.error} role="alert"><p>{error}</p>{lost && <a href="/auth/login">Sign in again</a>}</div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {view && <>
      {view.messages.length === 0 ? <p className={s.empty}>No messages yet.</p> : <ol className={s.list} aria-label="Conversation">
        {view.messages.map(m => <li key={m.messageId}><p><strong>{m.from === 'SCHOOL' ? view.schoolName : m.mine ? 'You' : 'Your family'}</strong> · <span className={s.subtle}>{when(m.sentAt)}</span></p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p></li>)}
      </ol>}
      {view.canWrite ? <form onSubmit={send}>
        <label htmlFor="school-message">Your message</label>
        <textarea id="school-message" rows={4} value={text} maxLength={FAMILY_MESSAGE_LIMITS.bodyMax + 1} onChange={e => setText(e.target.value)} disabled={sending} />
        <p className={s.subtle}>{text.length} / {FAMILY_MESSAGE_LIMITS.bodyMax}{tooLong ? ' · too long' : ''}</p>
        <p className={s.actions}><button type="submit" disabled={sending || !familyMessageBodyOk(text)}>{sending ? 'Sending…' : 'Send to the school'}</button>
          <button type="button" onClick={() => void load()} disabled={busy}>Refresh</button></p>
      </form> : <p className={s.notice}>Your access is view only. A guardian on your family account can write to the school.</p>}
    </>}
  </section>;
}
