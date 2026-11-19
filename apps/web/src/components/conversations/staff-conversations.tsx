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
import { ContactMessageHistory } from '../contact-history/contact-history';
import {
  ConversationsAccessError, ConversationsRefusal, commandAttempt, loadConversation, loadConversations, markConversationRead, replyConversation,
  updateConversation, type ConversationsScope,
} from './http';
import s from '../comms-kit/comms.module.css';
import { initials } from '../comms-kit/initials';
import { smsSegments } from '../comms-kit/sms-segments';
import { shortWhen } from '../comms-kit/short-when';

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
  const { preferences, date, formattingLocale } = useLocale();
  const copy = conversationsCopy(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [list, setList] = useState<ConversationList | null>(null), [open, setOpen] = useState<ConversationDetail | null>(null);
  const [filters, setFilters] = useState<Filters>(START), [draft, setDraft] = useState<Filters>(START);
  const [text, setText] = useState(''), [tagText, setTagText] = useState('');
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false), [side, setSide] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  /** Filters apply at once; typing in search waits a moment so each keystroke is not a request. */
  function filter(next: Filters, wait = 0) {
    setDraft(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const run = () => { setFilters(next); void refresh(open?.conversation.conversationId, next); };
    if (wait) searchTimer.current = setTimeout(run, wait); else run();
  }
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  function pick(conversationId: string | null) {
    setText(''); attempt.current = null;
    if (conversationId) void refresh(conversationId); else { ++generation.current; setOpen(null); void refresh(); }
  }

  if (!selection) return <p role="status">{copy.chooseSchool}</p>;
  const canManage = Boolean(open?.canManage);
  const consent = open?.contact.person?.smsConsent;
  const canReply = Boolean(open && canManage && open.conversation.channel === 'SMS' && open.contact.person && consent === 'OPTED_IN' && open.contact.schoolCanText);
  const tags = parseTags(tagText);
  const parts = smsSegments(text).segments;
  const statusChip = (value: Filters['status'], label: string) =>
    <li key={value}><button type="button" className={s.chip} aria-pressed={draft.status === value} onClick={() => filter({ ...draft, status: value })}>{label}</button></li>;
  return <main className={s.page} data-texts-conversations="">
    <header className={s.head}><div><h1>{copy.title}</h1><p>{copy.intro}</p></div>
      <button type="button" className={s.ghost} disabled={busy} onClick={() => void refresh(open?.conversation.conversationId)}>{copy.refresh}</button></header>
    {hidden && !list && <p className={s.actions}><span className={s.muted}>{copy.hidden}</span> <button type="button" className={s.button} onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !list && <p className={s.muted} role="status">{copy.loading}</p>}
      {error && <div className={s.flash} data-tone="bad" role="alert"><strong>{denied ? copy.deniedTitle : copy.title}</strong><p>{error}</p></div>}
      {notice && <p className={s.flash} data-tone="ok" role="status">{notice}</p>}</div>
    {list && <div className={s.split} data-open={open ? 'true' : undefined} data-side={open && side ? 'open' : undefined}>
      <section className={s.listPane} aria-label={copy.inbox}>
        <div className={s.listTools}>
          <input className={s.field} type="search" aria-label={copy.search} value={draft.search} maxLength={CONVERSATION_LIMITS.searchMax} placeholder={copy.searchHint}
            onChange={e => filter({ ...draft, search: e.target.value }, 350)} />
          <ul className={s.chips} aria-label={copy.filterStatus}>
            {statusChip('OPEN', copy.statusOpen)}{statusChip('CLOSED', copy.statusClosed)}{statusChip('ALL', copy.statusAll)}
            <li><button type="button" className={s.chip} aria-pressed={draft.unreadOnly} onClick={() => filter({ ...draft, unreadOnly: !draft.unreadOnly })}>
              {copy.unreadOnly}{list.unreadConversations ? ` (${list.unreadConversations})` : ''}</button></li>
          </ul>
        </div>
        {list.conversations.length === 0 ? <p className={s.empty}>{JSON.stringify(filters) === JSON.stringify(START) ? copy.empty : copy.emptyFiltered}</p> : <ul className={s.rows}>
          {list.conversations.map(c => <li key={c.conversationId}>
            <button type="button" className={s.row} aria-current={open?.conversation.conversationId === c.conversationId ? 'true' : undefined} onClick={() => pick(c.conversationId)}>
              <span className={s.avatar} aria-hidden="true">{initials(c.contactName ?? '#')}</span>
              <span className={s.rowMain}><span className={s.rowName}>{name(c, copy)}</span>
                {c.contactName && <span className={s.rowSub}>{c.contactAddress}</span>}
                {c.lastMessage && <span className={s.rowPreview}>{c.lastMessage.direction === 'INBOUND' ? '' : `${copy.you}: `}{c.lastMessage.preview}{c.lastMessage.mediaCount ? ` (${copy.media(c.lastMessage.mediaCount)})` : ''}</span>}
                {(c.status === 'CLOSED' || c.tags.length > 0) && <span className={s.rowSub}>{[c.status === 'CLOSED' ? copy.closedBadge : '', ...c.tags].filter(Boolean).join(' · ')}</span>}</span>
              <span className={s.rowSide}><time dateTime={c.lastMessageAt} title={date(c.lastMessageAt)}>{shortWhen(c.lastMessageAt, { locale: formattingLocale, timeZone: preferences.timeZone })}</time>{c.unread ? <span className={s.badge} data-tone="accent">{copy.newBadge(c.unread)}</span> : null}</span>
            </button>
          </li>)}
        </ul>}
        {list.nextCursor && <p className={s.more}><button type="button" className={s.ghost} disabled={busy} onClick={() => void more()}>{copy.more}</button></p>}
      </section>
      {open ? <section className={s.thread} aria-label={copy.thread(name(open.conversation, copy))}>
        <header className={s.threadHead}>
          <div className={s.actions}><button type="button" className={`${s.ghost} ${s.back}`} onClick={() => pick(null)}>{copy.back}</button>
            <div><h2>{name(open.conversation, copy)}</h2><p>{open.conversation.contactAddress}</p></div></div>
          <div className={s.actions}>
            {open.conversation.unread > 0 && open.messages.length > 0 && <button type="button" className={s.button} disabled={acting}
              onClick={() => void command(scope => markConversationRead(scope, open.conversation.conversationId, open.messages.at(-1)!.messageId), copy.markedRead, open.conversation.conversationId)}>
              {copy.markRead(open.conversation.unread)}</button>}
            {canManage && (open.conversation.status === 'OPEN'
              ? <button type="button" className={s.button} disabled={acting} onClick={() => void change(open.conversation, { status: 'CLOSED' }, copy.closed)}>{copy.close}</button>
              : <button type="button" className={s.button} disabled={acting} onClick={() => void change(open.conversation, { status: 'OPEN' }, copy.reopened)}>{copy.reopen}</button>)}
            <button type="button" className={s.ghost} aria-expanded={side} onClick={() => setSide(!side)}>{side ? copy.hideContact : copy.showContact}</button>
          </div>
        </header>
        <ol className={s.messages}>
          {open.hasOlder && <li className={s.actions}><button type="button" className={s.ghost} onClick={() => void older()}>{copy.older}</button></li>}
          {open.messages.length === 0 && <li className={s.empty}>{copy.noMessages}</li>}
          {open.messages.map(m => <li key={m.messageId} className={s.bubble} data-from={m.author === 'CONTACT' ? 'in' : 'out'}>
            {m.body && <p>{m.body}</p>}
            {m.mediaCount > 0 && <p className={s.muted}>{copy.media(m.mediaCount)}</p>}
            <span className={s.bubbleMeta}><span>{m.author === 'CONTACT' ? name(open.conversation, copy) : m.staffName ?? copy.staff}</span><span>{date(m.at)}</span>
              {m.delivery && <span>{copy.delivery[m.delivery]}</span>}</span>
          </li>)}
        </ol>
        {!canManage ? <p className={`${s.composer} ${s.muted}`}>{copy.readOnly}</p> : canReply ? <form className={s.composer} onSubmit={sendReply}>
          <label htmlFor="conversation-reply" className={s.label}>{copy.reply(name(open.conversation, copy))}</label>
          <textarea id="conversation-reply" className={s.field} rows={3} value={text} maxLength={CONVERSATION_LIMITS.bodyMax + 1} onChange={e => setText(e.target.value)} disabled={acting}
            aria-describedby="conversation-reply-hint" />
          <div className={s.composerBar}>
            <span id="conversation-reply-hint" className={s.composerTools}>{copy.counter(text.length, CONVERSATION_LIMITS.bodyMax)}{parts > 1 ? ` · ${copy.segments(parts)}` : ''}</span>
            <button type="submit" className={s.primary} disabled={acting || !conversationBodyOk(text)}>{acting ? copy.sending : copy.send}</button>
          </div>
        </form> : <p className={`${s.composer} ${s.muted}`}>{copy.cannotReply}</p>}
      </section> : <section className={s.thread}><p className={s.empty}>{copy.pickConversation}</p></section>}
      {open && side && <aside className={s.side} aria-label={copy.contact}>
        <h3>{copy.contact}</h3>
        <dl className={s.facts}>
          <div><dt>{copy.person}</dt><dd>{open.contact.person ? `${open.contact.person.givenName} ${open.contact.person.familyName}` : open.contact.peopleWithNumber > 1 ? copy.twoPeople(open.contact.peopleWithNumber) : copy.noPerson}</dd></div>
          {open.contact.person && <div><dt>{copy.consent}</dt><dd><span className={s.badge} data-tone={consent === 'OPTED_IN' ? 'ok' : consent === 'OPTED_OUT' ? 'bad' : 'warn'}>
            {consent === 'OPTED_IN' ? copy.consentIn : consent === 'OPTED_OUT' ? copy.consentOut : copy.consentNone}</span></dd></div>}
          <div><dt>{copy.lead}</dt><dd>{open.contact.lead ? `${open.contact.lead.pipeline} · ${open.contact.lead.stage}` : copy.noLead}</dd></div>
          <div><dt>{copy.appointment}</dt><dd>{open.contact.nextAppointment ? `${open.contact.nextAppointment.type} · ${date(open.contact.nextAppointment.startsAt)}` : copy.noAppointment}</dd></div>
        </dl>
        {!open.contact.schoolCanText && <p className={s.muted}>{copy.noSender}</p>}
        <p className={s.actions}><a className={s.button} href="/staff/people">{copy.openPeople}</a> <a className={s.ghost} href="/staff/crm">{copy.openLeads}</a></p>
        {canManage && <form className={s.stack} onSubmit={e => { e.preventDefault(); if (tags) void change(open.conversation, { tags }, copy.tagsSaved); }}>
          <label htmlFor="conversation-tags" className={s.label}>{copy.tags}
            <input id="conversation-tags" className={s.field} value={tagText} onChange={e => setTagText(e.target.value)} disabled={acting} aria-describedby="conversation-tags-hint" /></label>
          <p id="conversation-tags-hint" className={s.muted}>{copy.tagsHint}</p>
          <p className={s.actions}><button type="submit" className={s.button} disabled={acting || !tags}>{copy.saveTags}</button></p>
        </form>}
        {open.contact.person && selection && <details><summary>{copy.history}</summary>
          <ContactMessageHistory key={`${scopeKey}/${open.contact.person.personId}`} scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} personId={open.contact.person.personId}/>
        </details>}
      </aside>}
    </div>}
  </main>;
}
