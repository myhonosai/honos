'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONVERSATION_LIMITS, conversationBodyOk, conversationTagsOk,
  type ConversationDetail, type ConversationList, type ConversationListQuery, type ConversationRow,
} from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { useLocale } from '../localization/provider';
import { conversationsCopy, type ConversationsCopy } from './copy';
import {
  ConversationsAccessError, ConversationsRefusal, commandAttempt, loadConversation, loadConversations, markConversationRead, replyConversation,
  updateConversation, type ConversationsScope,
} from './http';
import s from '../testing-registration.module.css';

type Filters = { status: 'OPEN' | 'CLOSED' | 'ALL'; unreadOnly: boolean; search: string };
const START: Filters = { status: 'OPEN', unreadOnly: false, search: '' };

function query(filters: Filters, before?: { at: string; id: string }): ConversationListQuery {
  const q: ConversationListQuery = { status: filters.status };
  if (filters.unreadOnly) q.unreadOnly = true;
  const search = filters.search.trim();
  if (search) q.search = search.slice(0, CONVERSATION_LIMITS.searchMax);
  if (before) q.before = before;
  return q;
}
function name(row: ConversationRow, copy: ConversationsCopy): string { return row.contactName ?? `${copy.unknownContact} ${row.contactAddress}`; }
function message(problem: unknown, copy: ConversationsCopy): string {
  if (problem instanceof ConversationsAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof ConversationsRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}
export function parseTags(text: string): string[] | null {
  const tags = text.split(',').map(t => t.trim()).filter(Boolean);
  return conversationTagsOk(tags) ? tags : null;
}

/**
 * 0364 staff inbox. Every call carries the shell's school scope, which the server re-checks with conversation.read (reading)
 * or conversation.manage (changing). Opening a conversation does not mark it read; "Mark read" moves the mark only to the
 * newest message on screen. A reply only queues a text; delivery re-checks consent, quiet hours and the number.
 */
export function StaffConversations(): React.ReactElement {
  const shell = useSchoolShell();
  const { preferences, date } = useLocale();
  const copy = conversationsCopy(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [list, setList] = useState<ConversationList | null>(null), [open, setOpen] = useState<ConversationDetail | null>(null);
  const [filters, setFilters] = useState<Filters>(START), [draft, setDraft] = useState<Filters>(START);
  const [text, setText] = useState(''), [tagText, setTagText] = useState('');
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false);
  const generation = useRef(0);
  // One retry key per command kind, so an update never replaces the key an unconfirmed reply must retry with.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null), updateAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const scopeOf = useCallback((): ConversationsScope | null => {
    const [organizationId, schoolId] = scopeKey.split('/');
    return organizationId && schoolId ? { organizationId, schoolId } : null;
  }, [scopeKey]);
  const clear = useCallback(() => { ++generation.current; setList(null); setOpen(null); setText(''); setTagText(''); attempt.current = null; updateAttempt.current = null; }, []);
  const refresh = useCallback(async (conversationId?: string, nextFilters?: Filters) => {
    const scope = scopeOf();
    if (!scope) return;
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const [inbox, detail] = await Promise.all([loadConversations(scope, query(nextFilters ?? filters)),
        conversationId ? loadConversation(scope, conversationId) : Promise.resolve(null)]);
      if (generation.current !== token) return;
      setList(inbox); setOpen(detail); setTagText(detail ? detail.conversation.tags.join(', ') : ''); setError(''); setHidden(false);
    } catch (problem) {
      if (generation.current !== token) return;
      setList(null); setOpen(null); setError(message(problem, copy)); setDenied(problem instanceof ConversationsAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeOf, filters, copy]);
  useEffect(() => { clear(); void refresh(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on a new school only
  useEffect(() => onShellPrivacyEvent(() => { clear(); setError(''); setNotice(''); setHidden(true); }), [clear]);

  async function more() {
    const scope = scopeOf();
    if (!scope || !list?.nextCursor) return;
    const token = generation.current;
    try {
      const page = await loadConversations(scope, query(filters, list.nextCursor));
      if (generation.current !== token) return;
      setList({ ...page, conversations: [...list.conversations, ...page.conversations.filter(c => !list.conversations.some(x => x.conversationId === c.conversationId))] });
    } catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  async function older() {
    const scope = scopeOf();
    const first = open?.messages[0];
    if (!scope || !open || !first) return;
    const token = generation.current;
    try {
      const page = await loadConversation(scope, open.conversation.conversationId, first.messageId);
      if (generation.current !== token) return;
      setOpen({ ...page, messages: [...page.messages, ...open.messages] });
    } catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }
  async function command(run: (scope: ConversationsScope) => Promise<unknown>, done: string, conversationId: string): Promise<true | unknown> {
    const scope = scopeOf();
    if (!scope) return false;
    setActing(true); setError(''); setNotice('');
    try { await run(scope); setNotice(done); await refresh(conversationId); return true; }
    catch (problem) {
      setError(message(problem, copy));
      if (problem instanceof ConversationsAccessError) { clear(); setDenied(true); }
      else if (problem instanceof ConversationsRefusal && problem.code === 'CONVERSATION_VERSION_CONFLICT') await refresh(conversationId);
      return problem;
    } finally { setActing(false); }
  }
  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!open || acting || !conversationBodyOk(text)) return;
    const c = open.conversation;
    attempt.current = commandAttempt(`reply:${c.conversationId}:${c.version}:${text}`, attempt.current, () => crypto.randomUUID());
    const key = attempt.current.key;
    const result = await command(scope => replyConversation(scope, c.conversationId, c.version, text, key), copy.queued, c.conversationId);
    if (result === true) { attempt.current = null; setText(''); }
    else if (result instanceof ConversationsRefusal) attempt.current = null;
    else if (!(result instanceof ConversationsAccessError)) setError(copy.unknownSend);
  }
  async function change(c: ConversationRow, body: { status?: 'OPEN' | 'CLOSED'; tags?: string[] }, done: string) {
    const fingerprint = `update:${c.conversationId}:${c.version}:${JSON.stringify(body)}`;
    updateAttempt.current = commandAttempt(fingerprint, updateAttempt.current, () => crypto.randomUUID());
    const key = updateAttempt.current.key;
    const result = await command(scope => updateConversation(scope, c.conversationId, c.version, body, key), done, c.conversationId);
    if (result === true || result instanceof ConversationsRefusal) updateAttempt.current = null;
    else if (!(result instanceof ConversationsAccessError)) setError(copy.unknownUpdate);
  }
  function applyFilters(event: React.FormEvent) { event.preventDefault(); setFilters(draft); void refresh(open?.conversation.conversationId, draft); }

  if (!selection) return <p role="status">{copy.chooseSchool}</p>;
  const canManage = Boolean(open?.canManage);
  const consent = open?.contact.person?.smsConsent;
  const canReply = Boolean(open && canManage && open.conversation.channel === 'SMS' && open.contact.person && consent === 'OPTED_IN' && open.contact.schoolCanText);
  const tags = parseTags(tagText);
  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><h1>{copy.title}</h1><p>{copy.intro}</p></header>
    {hidden && !list && <p className={s.actions}><span className={s.subtle}>{copy.hidden}</span> <button type="button" onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !list && <p role="status">{copy.loading}</p>}
      {error && <div className={s.error} role="alert"><strong>{denied ? copy.deniedTitle : copy.title}</strong><p>{error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {list && <section className={s.card} aria-label={copy.inbox}>
      <h2>{copy.inbox}{list.unreadConversations ? ` · ${copy.unread(list.unreadConversations)}` : ''}</h2>
      <form onSubmit={applyFilters} className={s.actions} aria-label={copy.filterStatus}>
        <label>{copy.filterStatus} <select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as Filters['status'] })}>
          <option value="OPEN">{copy.statusOpen}</option><option value="CLOSED">{copy.statusClosed}</option><option value="ALL">{copy.statusAll}</option></select></label>
        <label><input type="checkbox" checked={draft.unreadOnly} onChange={e => setDraft({ ...draft, unreadOnly: e.target.checked })} /> {copy.unreadOnly}</label>
        <label>{copy.search} <input type="search" value={draft.search} maxLength={CONVERSATION_LIMITS.searchMax} placeholder={copy.searchHint}
          onChange={e => setDraft({ ...draft, search: e.target.value })} /></label>
        <button type="submit" disabled={busy}>{copy.apply}</button>
        <button type="button" disabled={busy} onClick={() => void refresh(open?.conversation.conversationId)}>{copy.refresh}</button>
      </form>
      {list.conversations.length === 0 ? <p className={s.empty}>{filters === START ? copy.empty : copy.emptyFiltered}</p> : <ul className={s.list}>
        {list.conversations.map(c => <li key={c.conversationId}>
          <button type="button" aria-current={open?.conversation.conversationId === c.conversationId ? 'true' : undefined}
            onClick={() => { setText(''); attempt.current = null; void refresh(c.conversationId); }}>
            {name(c, copy)}{c.unread ? <span className={s.badge}> {copy.newBadge(c.unread)}</span> : null}{c.status === 'CLOSED' ? <span className={s.subtle}> · {copy.closedBadge}</span> : null}
          </button>{' '}
          <span className={s.subtle}>{c.lastMessage ? `${c.lastMessage.direction === 'INBOUND' ? copy.theyWrote : copy.youReplied}: ${c.lastMessage.preview}${c.lastMessage.mediaCount ? ` (${copy.media(c.lastMessage.mediaCount)})` : ''} · ` : ''}{date(c.lastMessageAt)}</span>
          {c.tags.length > 0 && <span className={s.subtle}> · {c.tags.join(', ')}</span>}
        </li>)}
      </ul>}
      {list.nextCursor && <p className={s.actions}><button type="button" disabled={busy} onClick={() => void more()}>{copy.more}</button></p>}
    </section>}
    {open && <section className={s.card} aria-label={copy.thread(name(open.conversation, copy))}>
      <h2>{name(open.conversation, copy)}</h2>
      <aside aria-label={copy.contact}>
        <h3>{copy.contact}</h3>
        <p><strong>{copy.person}:</strong> {open.contact.person ? `${open.contact.person.givenName} ${open.contact.person.familyName}` : open.contact.peopleWithNumber > 1 ? copy.twoPeople(open.contact.peopleWithNumber) : copy.noPerson}</p>
        {open.contact.person && <p><strong>{copy.consent}:</strong> {consent === 'OPTED_IN' ? copy.consentIn : consent === 'OPTED_OUT' ? copy.consentOut : copy.consentNone}</p>}
        <p><strong>{copy.lead}:</strong> {open.contact.lead ? `${open.contact.lead.pipeline} · ${open.contact.lead.stage}` : copy.noLead}</p>
        <p><strong>{copy.appointment}:</strong> {open.contact.nextAppointment ? `${open.contact.nextAppointment.type} · ${date(open.contact.nextAppointment.startsAt)}` : copy.noAppointment}</p>
        {!open.contact.schoolCanText && <p className={s.subtle}>{copy.noSender}</p>}
        <p className={s.actions}><a href="/staff/crm/leads">{copy.openLeads}</a> <a href="/staff/people">{copy.openPeople}</a></p>
      </aside>
      {open.hasOlder && <p className={s.actions}><button type="button" onClick={() => void older()}>{copy.older}</button></p>}
      <ol className={s.list}>{open.messages.map(m => <li key={m.messageId}>
        <p><strong>{m.author === 'CONTACT' ? name(open.conversation, copy) : m.staffName ?? copy.staff}</strong> · <span className={s.subtle}>{date(m.at)}{m.delivery ? ` · ${copy.delivery[m.delivery]}` : ''}</span></p>
        {m.body && <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>}
        {m.mediaCount > 0 && <p className={s.subtle}>{copy.media(m.mediaCount)}</p>}
      </li>)}</ol>
      {open.conversation.unread > 0 && open.messages.length > 0 && <p className={s.actions}><button type="button" disabled={acting}
        onClick={() => void command(scope => markConversationRead(scope, open.conversation.conversationId, open.messages.at(-1)!.messageId), copy.markedRead, open.conversation.conversationId)}>
        {copy.markRead(open.conversation.unread)}</button></p>}
      {!canManage && <p className={s.subtle}>{copy.readOnly}</p>}
      {canManage && <>
        <p className={s.actions}>{open.conversation.status === 'OPEN'
          ? <button type="button" disabled={acting} onClick={() => void change(open.conversation, { status: 'CLOSED' }, copy.closed)}>{copy.close}</button>
          : <button type="button" disabled={acting} onClick={() => void change(open.conversation, { status: 'OPEN' }, copy.reopened)}>{copy.reopen}</button>}</p>
        <form onSubmit={e => { e.preventDefault(); if (tags) void change(open.conversation, { tags }, copy.tagsSaved); }}>
          <label htmlFor="conversation-tags">{copy.tags}</label>
          <input id="conversation-tags" value={tagText} onChange={e => setTagText(e.target.value)} disabled={acting} aria-describedby="conversation-tags-hint" />
          <p id="conversation-tags-hint" className={s.subtle}>{copy.tagsHint}</p>
          <p className={s.actions}><button type="submit" disabled={acting || !tags}>{copy.saveTags}</button></p>
        </form>
        {canReply ? <form onSubmit={sendReply}>
          <label htmlFor="conversation-reply">{copy.reply(name(open.conversation, copy))}</label>
          <textarea id="conversation-reply" rows={4} value={text} maxLength={CONVERSATION_LIMITS.bodyMax + 1} onChange={e => setText(e.target.value)} disabled={acting}
            aria-describedby="conversation-reply-hint" />
          <p id="conversation-reply-hint" className={s.subtle}>{copy.replyHint} {copy.counter(text.length, CONVERSATION_LIMITS.bodyMax)}</p>
          <p className={s.actions}><button type="submit" disabled={acting || !conversationBodyOk(text)}>{acting ? copy.sending : copy.send}</button></p>
        </form> : <p className={s.subtle}>{copy.cannotReply}</p>}
      </>}
    </section>}
  </div></main>;
}
