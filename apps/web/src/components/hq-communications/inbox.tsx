'use client';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HQ_MESSAGE_CHANNELS, hqMessageMaxLength, type HqMessage, type HqMessageChannel, type HqMessagePurpose, type HqSchoolDirectoryEntry } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { loadHqSchoolDirectory } from '../hq-school-directory-http';
import { schoolDetailApi } from '../hq-school-detail/http';
import { initials } from '../comms-kit/initials';
import { shortWhen } from '../comms-kit/short-when';
import s from '../comms-kit/comms.module.css';
import { CommsError, commsApi, type CommsApi, type Owned } from './http';
import { useConcealment } from './model';
import { commsText, type CommsKey } from './copy';
import { PieceCounter } from './view';
import { inboxText, inboxWhyKey, type InboxKey } from './inbox-copy';
import { HqSendFlow, filterConversations, groupConversations, threadOrder, type HqConversation, type SendState } from './inbox-model';

/** Which school's owners the open conversation is with. The ids only point the composer; the server confirms them on save. */
export type InboxTarget = Readonly<{ organizationId: string; schoolId: string; supportCaseId: string | null }>;
export type OpenSchool = Readonly<{ organizationId: string; schoolId: string; schoolDisplayName: string; supportCaseId: string | null }>;
export type InboxDeps = Readonly<{
  api: CommsApi;
  loadSchools: (signal: AbortSignal) => Promise<readonly HqSchoolDirectoryEntry[]>;
  readSchool: (schoolId: string, signal: AbortSignal, owned: Owned) => Promise<{ organizationId: string; schoolId: string; schoolDisplayName: string }>;
}>;
const defaultDeps: InboxDeps = {
  api: commsApi,
  loadSchools: async signal => (await loadHqSchoolDirectory(signal)).schools,
  readSchool: async (schoolId, signal, owned) => {
    const v = await schoolDetailApi.read(schoolId, signal, owned);
    return { organizationId: v.organization.organizationId, schoolId: v.school.schoolId, schoolDisplayName: v.school.schoolDisplayName };
  },
};

export type InboxListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; messages: readonly HqMessage[]; purposes: readonly HqMessagePurpose[]; next: boolean; loadingMore: boolean; moreFailed: boolean };
export type ThreadState = { state: 'LOADING' } | { state: 'FAILED' } | { state: 'READY'; messages: readonly HqMessage[]; next: boolean; loadingMore: boolean };
export type PickerState = null | { state: 'LOADING' } | { state: 'FAILED' } | { state: 'READY'; schools: readonly HqSchoolDirectoryEntry[] };
export type Opening = null | { school: string; failed: boolean; schoolId: string; supportCaseId: string | null };

/**
 * HQ texts and email as an inbox, like the school CRM's Texts page: conversations by school on the left, the thread with
 * that school's owners on the right, and a composer that saves and sends in one step. A session end hides everything and
 * drops any kept send. Leaving the tab hides nothing (owner, 2026-11-26). The server decides who may read or write.
 */
export function HqInbox({ target, deps = defaultDeps }: { target: InboxTarget | null; deps?: InboxDeps }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const language = preferences.language;
  const { api } = deps;
  const [list, setList] = useState<InboxListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState<OpenSchool | null>(null);
  const [thread, setThread] = useState<ThreadState>({ state: 'LOADING' });
  const [picker, setPicker] = useState<PickerState>(null);
  const [opening, setOpening] = useState<Opening>(null);
  const [search, setSearch] = useState('');
  const generation = useRef(0), mounted = useRef(false), threadCursor = useRef<{ createdAt: string; messageId: string } | null>(null);
  const listCursor = useRef<{ createdAt: string; messageId: string } | null>(null);
  const [flow] = useState(() => new HqSendFlow(api, () => setRefresh(n => n + 1)));
  const send = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; flow.drop(); }; }, [flow]);
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; flow.drop(); setOpen(null); setPicker(null); setOpening(null); setList({ state: 'LOADING' }); setThread({ state: 'LOADING' });
  });
  const owns = (g: number, p: number) => () => mounted.current && g === generation.current && p === privacy.current;

  // The conversation list: every HQ message the reader may see, newest first, grouped by school on screen.
  useEffect(() => {
    if (concealed) return;
    const owned = owns(generation.current, privacy.current), abort = new AbortController();
    api.list({ schoolId: null, cursor: null }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(view => {
      if (!owned()) return;
      listCursor.current = view.nextCursor;
      setList({ state: 'READY', messages: view.messages, purposes: view.viewer.purposes, next: view.nextCursor !== null, loadingMore: false, moreFailed: false });
    }, error => {
      if (!owned() || abort.signal.aborted) return;
      setList(error instanceof CommsError && error.kind === 'DENIED' ? { state: 'DENIED' } : { state: 'UNAVAILABLE' });
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refresh, concealed]);

  // The open thread: that school's messages only.
  const schoolId = open?.schoolId ?? null;
  useEffect(() => {
    if (concealed || !schoolId) return;
    const owned = owns(generation.current, privacy.current), abort = new AbortController();
    setThread(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list({ schoolId, cursor: null }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(view => {
      if (!owned()) return;
      threadCursor.current = view.nextCursor;
      setThread({ state: 'READY', messages: view.messages, next: view.nextCursor !== null, loadingMore: false });
    }, () => { if (owned() && !abort.signal.aborted) setThread({ state: 'FAILED' }); });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, schoolId, refresh, concealed]);

  const openSchool = useCallback((school: OpenSchool) => {
    if (flow.locked && open && open.schoolId.toLowerCase() !== school.schoolId.toLowerCase()) { setPicker(null); setOpening(null); return; }
    if (!flow.locked) flow.reset();
    setPicker(null); setOpening(null); setThread({ state: 'LOADING' }); setOpen(school);
  }, [flow, open]);

  // A school chosen in New message (or from a page link): read it so the composer knows its organization and name.
  const resolve = useCallback((schoolId: string, label: string, supportCaseId: string | null) => {
    const owned = owns(generation.current, privacy.current);
    setOpening({ school: label, failed: false, schoolId, supportCaseId });
    deps.readSchool(schoolId, AbortSignal.timeout(15000), owned).then(
      school => { if (owned()) openSchool({ ...school, supportCaseId }); },
      () => { if (owned()) setOpening({ school: label, failed: true, schoolId, supportCaseId }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, openSchool]);

  const targetKey = target ? `${target.organizationId}:${target.schoolId}:${target.supportCaseId ?? ''}` : '';
  useEffect(() => {
    if (!target || concealed) return;
    resolve(target.schoolId, '…', target.supportCaseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, concealed]);

  const startPicker = useCallback(() => {
    const owned = owns(generation.current, privacy.current);
    setPicker({ state: 'LOADING' });
    deps.loadSchools(AbortSignal.timeout(15000)).then(
      schools => { if (owned()) setPicker(prior => prior ? { state: 'READY', schools: schools.filter(x => x.schoolOperationalStatus !== 'ARCHIVED') } : prior); },
      () => { if (owned()) setPicker(prior => prior ? { state: 'FAILED' } : prior); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps]);

  const more = useCallback(() => {
    if (list.state !== 'READY' || !listCursor.current || list.loadingMore) return;
    const owned = owns(generation.current, privacy.current), c = listCursor.current;
    setList({ ...list, loadingMore: true, moreFailed: false });
    api.list({ schoolId: null, cursor: c }, AbortSignal.timeout(15000), owned).then(view => {
      if (!owned()) return;
      listCursor.current = view.nextCursor;
      setList(prior => prior.state !== 'READY' ? prior : { ...prior, next: view.nextCursor !== null, loadingMore: false,
        messages: [...prior.messages, ...view.messages.filter(m => !prior.messages.some(p => p.messageId === m.messageId))] });
    }, () => { if (owned()) setList(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, list]);

  const older = useCallback(() => {
    if (thread.state !== 'READY' || !threadCursor.current || !schoolId || thread.loadingMore) return;
    const owned = owns(generation.current, privacy.current), c = threadCursor.current;
    setThread({ ...thread, loadingMore: true });
    api.list({ schoolId, cursor: c }, AbortSignal.timeout(15000), owned).then(view => {
      if (!owned()) return;
      threadCursor.current = view.nextCursor;
      setThread(prior => prior.state !== 'READY' ? prior : { state: 'READY', next: view.nextCursor !== null, loadingMore: false,
        messages: [...prior.messages, ...view.messages.filter(m => !prior.messages.some(p => p.messageId === m.messageId))] });
    }, () => { if (owned()) setThread(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, thread, schoolId]);

  return <HqInboxView language={language} formattingLocale={formattingLocale} timeZone={preferences.timeZone} concealed={concealed} list={list}
    open={open} thread={thread} picker={picker} opening={opening} search={search} send={send} locked={flow.locked} canRetry={flow.canRetry}
    onSearch={setSearch} onRefresh={() => setRefresh(n => n + 1)} onReveal={reveal} onMore={more} onOlder={older}
    onOpen={c => openSchool({ organizationId: c.organizationId, schoolId: c.schoolId, schoolDisplayName: c.schoolDisplayName, supportCaseId: null })}
    onBack={() => { if (!flow.locked) { flow.reset(); setOpen(null); } }} onNew={startPicker} onPickCancel={() => setPicker(null)}
    onPick={x => resolve(x.schoolId, x.schoolDisplayName, null)} onRetryOpen={() => opening && resolve(opening.schoolId, opening.school, opening.supportCaseId)}
    onSend={d => {
      if (!open || list.state !== 'READY') return false;
      const content = d.content.trim();
      if (!list.purposes.includes(d.purpose) || content.length < 1 || content.length > hqMessageMaxLength(d.channel)) return false;
      return flow.send({ organizationId: open.organizationId, schoolId: open.schoolId, purpose: d.purpose, channel: d.channel, content, supportCaseId: open.supportCaseId });
    }}
    onTryAgain={() => flow.tryAgain()} onDismiss={() => flow.reset()}/>;
}

export type Draft = Readonly<{ channel: HqMessageChannel; purpose: HqMessagePurpose; content: string }>;
export type InboxViewProps = Readonly<{
  language: string; formattingLocale: string; timeZone?: string; concealed: boolean; list: InboxListState; open: OpenSchool | null; thread: ThreadState;
  picker: PickerState; opening: Opening; search: string; send: SendState; locked: boolean; canRetry: boolean;
  onSearch: (v: string) => void; onRefresh: () => void; onReveal: () => void; onMore: () => void; onOlder: () => void;
  onOpen: (c: HqConversation) => void; onBack: () => void; onNew: () => void; onPickCancel: () => void; onPick: (x: HqSchoolDirectoryEntry) => void;
  onRetryOpen: () => void; onSend: (d: Draft) => boolean; onTryAgain: () => void; onDismiss: () => void;
}>;

const deliveryLine = (t: (k: InboxKey, v?: Record<string, string>) => string, m: HqMessage): string => {
  const d = m.deliverySummary, parts: string[] = [];
  if (d.delivered + d.accepted) parts.push(`${d.delivered + d.accepted} ${t('delivered')}`);
  if (d.pending + d.unknown) parts.push(`${d.pending + d.unknown} ${t('pending')}`);
  if (d.suppressed) parts.push(`${d.suppressed} ${t('heldBack')}`);
  if (d.failed) parts.push(`${d.failed} ${t('failedCount')}`);
  return parts.join(' · ');
};

/** Presentation only. Every fact comes from the verified server answer. */
export function HqInboxView(p: InboxViewProps): React.ReactElement {
  const t = (k: InboxKey, v?: Record<string, string>) => inboxText(p.language, k, v);
  const c = (k: CommsKey) => commsText(p.language, k);
  const when = (at: string) => shortWhen(at, p.timeZone ? { locale: p.formattingLocale, timeZone: p.timeZone } : { locale: p.formattingLocale });
  const head = <header className={s.head}><div><h1>{t('title')}</h1><p>{t('intro')}</p>
    <p className={s.actions}><a className={s.ghost} href="/hq/communications/settings">{t('settings')}</a><a className={s.ghost} href="/hq/communications/numbers">{t('numbers')}</a></p></div>
    {!p.concealed && <p className={s.actions}><button type="button" className={s.ghost} onClick={p.onRefresh}>{t('refresh')}</button>
      {p.list.state === 'READY' && <button type="button" className={`${s.button} ${s.primary}`} disabled={p.locked} onClick={p.onNew}>{t('newMessage')}</button>}</p>}</header>;
  if (p.concealed) return <main className={s.page} data-hq-inbox="concealed">{head}
    <p className={s.actions} role="status"><span className={s.muted}>{t('concealed')}</span> <button type="button" className={s.button} onClick={p.onReveal}>{t('reveal')}</button></p></main>;
  if (p.list.state !== 'READY') return <main className={s.page} data-hq-inbox={p.list.state.toLowerCase()} aria-busy={p.list.state === 'LOADING'}>{head}
    <p className={s.muted} role="status">{t(p.list.state === 'LOADING' ? 'loading' : p.list.state === 'DENIED' ? 'denied' : 'unavailable')}</p></main>;
  const list = p.list, conversations = filterConversations(groupConversations(list.messages), p.search);
  const picker = p.picker && <section className={s.panel} aria-label={t('pickTitle')} data-hq-inbox-picker={p.picker.state.toLowerCase()}>
    <PickerBody t={t} picker={p.picker} onPick={p.onPick} onCancel={p.onPickCancel}/></section>;
  const opening = p.opening && <p className={s.flash} data-tone={p.opening.failed ? 'bad' : undefined} role={p.opening.failed ? 'alert' : 'status'}>
    {p.opening.failed ? <>{t('openFailed')} <button type="button" className={s.ghost} onClick={p.onRetryOpen}>{t('tryAgain')}</button></> : t('opening', { school: p.opening.school })}</p>;
  return <main className={s.page} data-hq-inbox="ready">{head}{picker}{opening}
    <div className={s.split} data-open={p.open ? 'true' : undefined}>
      <section className={s.listPane} aria-label={t('conversations')}>
        <div className={s.listTools}><input className={s.field} type="search" aria-label={t('search')} placeholder={t('search')} value={p.search}
          maxLength={120} onChange={e => p.onSearch(e.currentTarget.value)}/></div>
        {conversations.length === 0 ? <p className={s.empty}>{t(list.messages.length === 0 ? 'empty' : 'emptySearch')}</p> : <ul className={s.rows}>
          {conversations.map(x => <li key={x.schoolId}><button type="button" className={s.row} data-hq-conversation={x.schoolId}
            aria-current={p.open?.schoolId.toLowerCase() === x.schoolId.toLowerCase() ? 'true' : undefined} onClick={() => p.onOpen(x)}>
            <span className={s.avatar} aria-hidden="true">{initials(x.schoolDisplayName)}</span>
            <span className={s.rowMain}><span className={s.rowName}>{x.schoolDisplayName}</span>
              <span className={s.rowSub}>{x.organizationDisplayName}</span>
              <span className={s.rowPreview}>{`${c(x.latest.channel)}: ${x.latest.content.slice(0, 120)}`}</span></span>
            <span className={s.rowSide}><time dateTime={x.latest.createdAt}>{when(x.latest.createdAt)}</time></span></button></li>)}</ul>}
        {list.moreFailed && <p className={s.muted} role="alert">{t('moreFailed')}</p>}
        {list.next && <p className={s.more}><button type="button" className={s.ghost} disabled={list.loadingMore} onClick={p.onMore}>{t('more')}</button></p>}
      </section>
      {p.open ? <Thread {...p} open={p.open} t={t} c={c} when={when}/> : <section className={s.thread}><p className={s.empty}>{t('pickHelp')}</p></section>}
    </div></main>;
}

function PickerBody({ t, picker, onPick, onCancel }: { t: (k: InboxKey) => string; picker: Exclude<PickerState, null>; onPick: (x: HqSchoolDirectoryEntry) => void;
  onCancel: () => void }): React.ReactElement {
  const [q, setQ] = useState('');
  const found = picker.state === 'READY' ? picker.schools.filter(x => `${x.schoolDisplayName} ${x.organizationDisplayName}`.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase())).slice(0, 50) : [];
  return <>
    <div className={s.actions}><h2>{t('pickTitle')}</h2><button type="button" className={s.ghost} onClick={onCancel}>{t('pickCancel')}</button></div>
    <p className={s.muted}>{t('pickHelp')}</p>
    {picker.state === 'LOADING' && <p className={s.muted} role="status">{t('pickLoading')}</p>}
    {picker.state === 'FAILED' && <p className={s.flash} data-tone="bad" role="alert">{t('pickFailed')}</p>}
    {picker.state === 'READY' && <>
      <input className={s.field} type="search" aria-label={t('pickSearch')} placeholder={t('pickSearch')} value={q} maxLength={120} onChange={e => setQ(e.currentTarget.value)}/>
      {found.length === 0 ? <p className={s.empty}>{t('pickNone')}</p> : <ul className={s.rows}>{found.map(x => <li key={x.schoolId}>
        <button type="button" className={s.row} data-hq-pick={x.schoolId} onClick={() => onPick(x)}>
          <span className={s.avatar} aria-hidden="true">{initials(x.schoolDisplayName)}</span>
          <span className={s.rowMain}><span className={s.rowName}>{x.schoolDisplayName}</span><span className={s.rowSub}>{x.organizationDisplayName}</span></span></button></li>)}</ul>}
    </>}
  </>;
}

function Thread(p: InboxViewProps & { open: OpenSchool; t: (k: InboxKey, v?: Record<string, string>) => string; c: (k: CommsKey) => string; when: (at: string) => string }): React.ReactElement {
  const { t, c, open } = p, purposes = p.list.state === 'READY' ? p.list.purposes : [];
  const name = open.schoolDisplayName;
  return <section className={s.thread} aria-label={t('owners', { school: name })} data-hq-thread={open.schoolId}>
    <header className={s.threadHead}><div className={s.actions}>
      <button type="button" className={`${s.ghost} ${s.back}`} disabled={p.locked} onClick={p.onBack}>{t('back')}</button>
      <h2>{t('owners', { school: name })}</h2></div>
      {open.supportCaseId && <span className={s.badge}>{t('supportCase')}</span>}</header>
    <ol className={s.messages} aria-live="polite">
      {p.thread.state === 'LOADING' && <li className={s.muted} role="status">{t('threadLoading')}</li>}
      {p.thread.state === 'FAILED' && <li className={s.flash} data-tone="bad" role="alert">{t('threadFailed')}</li>}
      {p.thread.state === 'READY' && p.thread.next && <li className={s.actions}><button type="button" className={s.ghost} disabled={p.thread.loadingMore} onClick={p.onOlder}>{t('older')}</button></li>}
      {p.thread.state === 'READY' && p.thread.messages.length === 0 && <li className={s.empty}>{t('threadEmpty')}</li>}
      {p.thread.state === 'READY' && threadOrder(p.thread.messages).map(m => <li key={m.messageId} className={s.bubble} data-from="out" data-hq-message={m.messageId}>
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{m.content}</p>
        <span className={s.bubbleMeta}><span>{`${m.createdBy.displayName} · ${c(m.channel)} · ${c(m.purpose)}`}</span>
          <time dateTime={m.createdAt}>{p.when(m.createdAt)}</time></span>
        <span className={s.bubbleMeta}><span>{m.status === 'QUEUED' ? deliveryLine(t, m) || c('QUEUED') : c(m.status)}</span>
          <a href={`/hq/communications/${m.messageId}`}>{t('details')}</a></span></li>)}
    </ol>
    {purposes.length === 0 ? <p className={`${s.composer} ${s.muted}`}>{t('noPurposes')}</p>
      : <Composer key={open.schoolId} {...p} t={t} c={c} purposes={purposes} school={name}/>}
  </section>;
}

function Composer(p: InboxViewProps & { t: (k: InboxKey, v?: Record<string, string>) => string; c: (k: CommsKey) => string; purposes: readonly HqMessagePurpose[]; school: string }): React.ReactElement {
  const { t, c } = p;
  const [channel, setChannel] = useState<HqMessageChannel>('EMAIL');
  const [purpose, setPurpose] = useState<HqMessagePurpose>(p.open?.supportCaseId && p.purposes.includes('SUPPORT') ? 'SUPPORT' : p.purposes[0]!);
  const [content, setContent] = useState('');
  const [local, setLocal] = useState(false);
  const sentId = p.send.phase === 'SENT' ? p.send.message.messageId : null;
  useEffect(() => { if (sentId) setContent(''); }, [sentId]);
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); setLocal(!p.onSend({ channel, purpose, content })); };
  const st = p.send;
  return <form className={s.composer} onSubmit={submit} data-hq-composer="">
    <div className={s.composerTools}>
      <span>{t('sendAs')}</span>
      <span className={s.chips} role="group" aria-label={t('sendAs')}>{HQ_MESSAGE_CHANNELS.map(ch => <button key={ch} type="button" className={s.chip}
        aria-pressed={channel === ch} disabled={p.locked} onClick={() => setChannel(ch)}>{c(ch)}</button>)}</span>
      <label htmlFor="hq-inbox-purpose">{t('purpose')}</label>
      <select id="hq-inbox-purpose" value={purpose} disabled={p.locked} onChange={e => setPurpose(e.currentTarget.value as HqMessagePurpose)}>
        {p.purposes.map(x => <option key={x} value={x}>{c(x)}</option>)}</select>
    </div>
    <label htmlFor="hq-inbox-content" className={s.label}>{t('message', { school: p.school })}</label>
    <textarea id="hq-inbox-content" className={s.field} rows={3} value={content} disabled={p.locked} onChange={e => { setContent(e.currentTarget.value); setLocal(false); }}/>
    <div className={s.composerBar}>
      <PieceCounter language={p.language} channel={channel} content={content}/>
      <button type="submit" className={`${s.button} ${s.primary}`} disabled={p.locked || content.trim().length === 0}>{t('send')}</button>
    </div>
    <div aria-live="polite">
      {local && <p className={s.flash} data-tone="bad" role="alert">{t('localInvalid')}</p>}
      {st.phase === 'SAVING' && <p className={s.muted} role="status">{t('saving')}</p>}
      {st.phase === 'SENDING' && <p className={s.muted} role="status">{t('sending')}</p>}
      {st.phase === 'SENT' && <p className={s.flash} data-tone="ok" role="status" data-hq-send="sent">{t('sent', { n: String(st.message.recipientCount) })}</p>}
      {st.phase === 'SAVED' && <p className={s.flash} data-tone="bad" role="alert" data-hq-send="saved">{t('saved', { why: t(inboxWhyKey(st.kind, st.code)) })}</p>}
      {st.phase === 'FAILED' && <p className={s.flash} data-tone="bad" role="alert" data-hq-send="failed">{t('failed', { why: t(inboxWhyKey(st.kind, st.code)) })}</p>}
      {st.phase === 'UNKNOWN' && <div className={s.flash} role="alert" data-hq-send="unknown"><p>{t('unknown')}</p>
        {p.canRetry && <button type="button" className={s.button} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    </div>
  </form>;
}
