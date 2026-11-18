'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CONTACT_HISTORY_LIMITS, contactHistorySearchOk, type ContactEmailView, type ContactHistory, type ContactHistoryQuery, type ContactHistoryRange } from '@hon/contracts';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { useLocale } from '../localization/provider';
import { contactHistoryCopy, type ContactHistoryCopy } from './copy';
import {
  ContactHistoryAccessError, ContactHistoryRefusal, loadContactEmail, loadContactHistory, resendContactEmail, type ContactHistoryScope,
} from './http';
import s from '../testing-registration.module.css';

type Filters = { range: ContactHistoryRange; search: string };
const START: Filters = { range: 'ALL', search: '' };

export function historyQuery(filters: Filters, before?: { at: string; id: string }): ContactHistoryQuery {
  const q: ContactHistoryQuery = {};
  if (filters.range !== 'ALL') q.range = filters.range;
  const search = filters.search.trim().slice(0, CONTACT_HISTORY_LIMITS.searchMax);
  if (contactHistorySearchOk(search)) q.search = search;
  if (before) q.before = before;
  return q;
}
function message(problem: unknown, copy: ContactHistoryCopy): string {
  if (problem instanceof ContactHistoryAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof ContactHistoryRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}

/**
 * 0424 one person's message history (the contact card's Comms view) with the exact email view and "Resend to saved address".
 * Nothing loads until it is opened. The server re-checks conversation.read for every read and conversation.manage plus
 * communication.message.queue for a resend; the screen only shows what the server answered. A resend only queues a copy.
 */
export function ContactMessageHistory({ scope, personId, startOpen = false }: { scope: ContactHistoryScope; personId: string; startOpen?: boolean }): React.ReactElement {
  const { preferences, date } = useLocale();
  const copy = contactHistoryCopy(preferences.language);
  const ids = useId();
  const [open, setOpen] = useState(startOpen), [data, setData] = useState<ContactHistory | null>(null), [email, setEmail] = useState<ContactEmailView | null>(null);
  const [filters, setFilters] = useState<Filters>(START), [draft, setDraft] = useState<Filters>(START);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0);
  // One key per resend target, kept only while the same resend is retried after an unknown outcome.
  const attempt = useRef<{ messageId: string; key: string } | null>(null);
  const scopeKey = `${scope.organizationId}/${scope.schoolId}/${personId}`;

  const clear = useCallback(() => { ++generation.current; setData(null); setEmail(null); attempt.current = null; }, []);
  const refresh = useCallback(async (next?: Filters, emailId?: string) => {
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      const [history, view] = await Promise.all([loadContactHistory(scope, personId, historyQuery(next ?? filters)),
        emailId ? loadContactEmail(scope, personId, emailId) : Promise.resolve(null)]);
      if (generation.current !== token) return;
      setData(history); setEmail(view);
    } catch (problem) {
      if (generation.current !== token) return;
      setData(null); setEmail(null); setError(message(problem, copy));
    } finally { if (generation.current === token) setBusy(false); }
  }, [scope, personId, filters, copy]);
  useEffect(() => { clear(); setNotice(''); setError(''); setFilters(START); setDraft(START); if (open) void refresh(START); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- a new person or school starts over
  useEffect(() => onShellPrivacyEvent(() => { clear(); setOpen(false); setError(''); setNotice(''); }), [clear]);

  function toggle() { if (open) { clear(); setOpen(false); return; } setOpen(true); void refresh(filters); }
  function apply(event: React.FormEvent) { event.preventDefault(); setFilters(draft); setEmail(null); void refresh(draft); }
  async function more() {
    if (!data?.nextCursor) return;
    const token = generation.current;
    try {
      const page = await loadContactHistory(scope, personId, historyQuery(filters, data.nextCursor));
      if (generation.current !== token) return;
      setData({ ...page, messages: [...data.messages, ...page.messages.filter(m => !data.messages.some(x => x.messageId === m.messageId))] });
    } catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  async function view(messageId: string) {
    const token = generation.current;
    setError(''); setNotice('');
    try { const v = await loadContactEmail(scope, personId, messageId); if (generation.current === token) setEmail(v); }
    catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  async function resend(current: ContactEmailView) {
    if (acting || !current.canResend) return;
    const messageId = current.message.messageId;
    if (attempt.current?.messageId !== messageId) attempt.current = { messageId, key: crypto.randomUUID() };
    const key = attempt.current.key;
    setActing(true); setError(''); setNotice('');
    try {
      await resendContactEmail(scope, personId, messageId, key);
      attempt.current = null; setNotice(copy.resendQueued); await refresh(filters, messageId);
    } catch (problem) {
      if (problem instanceof ContactHistoryRefusal) { attempt.current = null; setError(message(problem, copy)); await refresh(filters, messageId); }
      else if (problem instanceof ContactHistoryAccessError) { attempt.current = null; clear(); setError(message(problem, copy)); }
      else setError(copy.unknownResend);
    } finally { setActing(false); }
  }

  const filtered = filters.range !== 'ALL' || filters.search.trim() !== '';
  return <section className={s.card} aria-label={copy.title}>
    <h3>{copy.title}</h3>
    <p className={s.subtle}>{copy.intro}</p>
    <p className={s.actions}><button type="button" aria-expanded={open} onClick={toggle}>{open ? copy.hide : copy.show}</button>
      {open && <button type="button" disabled={busy} onClick={() => void refresh(filters, email?.message.messageId)}>{copy.refresh}</button>}</p>
    <div aria-live="polite">
      {busy && !data && open && <p role="status">{copy.loading}</p>}
      {error && <p className={s.error} role="alert">{error}</p>}
      {notice && <p className={s.notice} role="status">{notice}</p>}
    </div>
    {open && data && <>
      <form onSubmit={apply} className={s.actions} aria-label={copy.search}>
        <label>{copy.range} <select value={draft.range} onChange={e => setDraft({ ...draft, range: e.target.value as ContactHistoryRange })}>
          {(['ALL', 'TODAY', 'DAYS_7', 'DAYS_30'] as const).map(r => <option key={r} value={r}>{copy.ranges[r]}</option>)}</select></label>
        <label>{copy.search} <input type="search" value={draft.search} maxLength={CONTACT_HISTORY_LIMITS.searchMax} placeholder={copy.searchHint}
          onChange={e => setDraft({ ...draft, search: e.target.value })} /></label>
        <button type="submit" disabled={busy}>{copy.apply}</button>
      </form>
      <p className={s.subtle}>{copy.total(data.total)}{data.includesFamily ? '' : ` · ${copy.familyHidden}`}</p>
      {data.messages.length === 0 ? <p className={s.empty}>{filtered ? copy.emptyFiltered : copy.empty}</p> : <ol className={s.list}>
        {data.messages.map(m => <li key={m.messageId}>
          <p><strong>{m.direction === 'SENT' ? copy.sent : copy.received}</strong> · {copy.channel[m.channel]} · {copy.origin[m.origin]}
            {' · '}<span className={s.subtle}>{date(m.at)}{m.delivery ? ` · ${copy.delivery[m.delivery]}` : ''}{m.by ? ` · ${m.by}` : ''}{m.resentFrom ? ` · ${copy.resentCopy}` : ''}</span></p>
          {m.subject && <p><strong>{m.subject}</strong></p>}
          {m.preview && <p>{m.preview}</p>}
          {m.source === 'QUEUE' && m.channel === 'EMAIL' && <p className={s.actions}><button type="button" onClick={() => void view(m.messageId)}
            aria-controls={`${ids}-email`}>{copy.viewEmail}</button></p>}
        </li>)}
      </ol>}
      {data.nextCursor && <p className={s.actions}><button type="button" disabled={busy} onClick={() => void more()}>{copy.more}</button></p>}
    </>}
    {open && email && <section id={`${ids}-email`} className={s.card} aria-label={copy.emailTitle}>
      <h4>{copy.emailTitle}</h4>
      <p><strong>{copy.subject}:</strong> {email.message.subject}{email.message.subjectStandard ? <span className={s.subtle}> ({copy.standardSubject})</span> : null}</p>
      <p className={s.subtle}>{copy.sentAt}: {date(email.message.at)}{email.message.by ? ` · ${copy.by}: ${email.message.by}` : ''} · {copy.origin[email.message.origin]}</p>
      {email.resentFrom && <p className={s.subtle}>{copy.resentFrom}</p>}
      <p><strong>{copy.body}</strong></p>
      {/* Plain text exactly as stored: rendered as text, never as HTML. */}
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{email.message.body}</pre>
      <p className={s.subtle}>{copy.plainNote}</p>
      <p><strong>{copy.deliveryLabel}:</strong> {copy.delivery[email.delivery.status]}</p>
      <p><strong>{copy.events}:</strong> {email.delivery.events.length ? email.delivery.events.map(e => `${e.type} ${date(e.at)}`).join(' · ') : copy.noEvents}</p>
      {email.resends.length > 0 && <p><strong>{copy.resends}:</strong> {email.resends.map(r => `${date(r.at)}${r.by ? ` (${r.by})` : ''}`).join(' · ')}</p>}
      <p><strong>{copy.savedAddress}:</strong> {email.savedAddress ?? copy.noAddress}</p>
      {email.canResend
        ? <><p className={s.actions}><button type="button" disabled={acting} onClick={() => void resend(email)} aria-describedby={`${ids}-resend-hint`}>{acting ? copy.resending : copy.resend}</button></p>
          <p id={`${ids}-resend-hint`} className={s.subtle}>{copy.resendHint}</p></>
        : <p className={s.subtle}>{email.resendBlocked ? copy.blocked[email.resendBlocked] : ''}</p>}
      <p className={s.actions}><button type="button" onClick={() => setEmail(null)}>{copy.closeEmail}</button></p>
    </section>}
  </section>;
}
