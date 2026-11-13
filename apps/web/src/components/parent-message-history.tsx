'use client';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentMessageHistoryView } from '@hon/contracts';
import { loadParentMessageHistory, ParentMessageHistoryAccessError } from './parent-message-history-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }

/** A selector-free, view-only guardian message-history surface; queue intent is never presented as receipt. */
export function ParentMessageHistory(): React.ReactElement {
  const [view, setView] = useState<ParentMessageHistoryView | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [accessLost, setAccessLost] = useState(false);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => { ++generation.current; pending.current?.abort(); pending.current = null; setView(null); setBusy(false); }, []);
  const load = useCallback(async () => {
    const token = ++generation.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setView(null); setBusy(true); setError(''); setAccessLost(false);
    try { const data = await loadParentMessageHistory(controller.signal); if (generation.current === token) setView(data); }
    catch (reason) { if (generation.current === token) { setView(null); setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : 'School message history is unavailable.'); setAccessLost(reason instanceof ParentMessageHistoryAccessError); } }
    finally { if (generation.current === token) { setBusy(false); pending.current = null; } }
  }, []);
  useEffect(() => {
    void load();
    const hide = () => { clear(); setError('School message history is hidden. Return to reverify current guardian family access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void load(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('focus', focus); window.addEventListener('pagehide', hide);
    return () => { ++generation.current; pending.current?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [load, clear]);

  return <main className={`${s.page} ${s.parent}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Family navigation"><Link href="/parent" prefetch={false} className={s.wordmark}>HON <span>School messages</span></Link><Link href="/parent/journey" prefetch={false}>Student Journey</Link></nav>
    <header className={s.header}><p>YOUR FAMILY · VERIFIED GUARDIAN READ ONLY</p><h1>School message history</h1><p>Receipt evidence unavailable in the existing message queue means no content is shown. Only independently provable received school messages for your one verified guardian family could appear here. This section never chooses a family, child, recipient, or message.</p></header>
    <aside className={s.boundary}><strong>History only. Nothing changes here.</strong><p>This history section sends, replies to, drafts, queues, cancels, schedules and delivers nothing (use Messages with your school above to write to the school inside HON). It cannot change consent or opt-out state, create recipients, call a delivery provider, or use AI, Action Engine, voice, automation, payment, or any external service.</p></aside>
    <p className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying guardian access…' : 'Refresh verified message history'}</button></p>
    <div aria-live="polite" aria-atomic="true">{busy && <p className={s.state} role="status">Loading school message history from your current verified guardian family scope. No previous family content is retained.</p>}{error && <div className={s.error} role="alert"><strong>{accessLost ? 'Guardian family access unavailable' : 'No verified message history shown'}</strong><p>{error}</p>{accessLost && <Link href="/auth/login" prefetch={false}>Sign in again</Link>}</div>}</div>
    {!busy && view && <><p className={s.notice}><strong>Verified guardian family view</strong> · {label(view.accessLevel)} · Checked {dateTime(view.generatedAt)}</p><section className={s.card}><h2>Receipt evidence unavailable</h2><p className={s.empty}>No school message content is shown. The existing provider-neutral message queue records drafting and queueing intent, not provider delivery or recipient receipt. A queued message is not treated as received.</p><p className={s.subtle}>No sender, recipient, child, family, staff identity, contact address, consent record, provider metadata, delivery status, campaign, broadcast, internal note, or message content is exposed or inferred.</p></section></>}
    <footer className={s.footer}>Read-only guardian-family history availability. Receipt evidence must be independently recorded and separately reviewed before any redacted received-message content can be displayed.</footer>
  </div></main>;
}
