'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  SCHOOL_MESSAGES_LIMITS, schoolMessagesSearchOk,
  type SchoolMessageChannel, type SchoolMessageCursor, type SchoolMessageHistoryQuery, type SchoolMessageHistoryRow,
  type SchoolMessageOrigin, type SchoolMessageOutcome, type SchoolMessageRange,
} from '@hon/contracts';
import { MessagesAccessError, loadHistory, type MessagesScope } from './messages-http';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { initials } from '../comms-kit/initials';
import { SentEmail } from './sent-email';
import s from '../comms-kit/comms.module.css';

export type Filters = Readonly<{ outcome: SchoolMessageOutcome | 'ALL'; origin: SchoolMessageOrigin | 'ALL'; range: SchoolMessageRange; search: string }>;
export const START: Filters = { outcome: 'ALL', origin: 'ALL', range: 'DAYS_30', search: '' };
type Load = 'LOADING' | 'READY' | 'DENIED' | 'SESSION' | 'UNAVAILABLE';

export const OUTCOME_LABEL: Record<SchoolMessageOutcome, string> = { DELIVERED: 'Delivered', FAILED: 'Failed', IN_PROGRESS: 'Sending', CANCELLED: 'Cancelled' };
export const OUTCOME_TONE: Record<SchoolMessageOutcome, string> = { DELIVERED: 'ok', FAILED: 'bad', IN_PROGRESS: 'warn', CANCELLED: '' };
export const ORIGIN_LABEL: Record<SchoolMessageOrigin, string> = { STAFF: 'Staff', CONVERSATION: 'Conversation reply', CAMPAIGN: 'Campaign', AUTOMATION: 'Automation' };
const RANGE_LABEL: Record<SchoolMessageRange, string> = { TODAY: 'Today', DAYS_7: 'Last 7 days', DAYS_30: 'Last 30 days', ALL: 'All time' };
const SEARCH_WAIT_MS = 300;

/** The list query for the chosen filters; "All" leaves the filter out, and an unusable search is left out rather than sent. */
export function historyQuery(channel: SchoolMessageChannel, filters: Filters, before?: SchoolMessageCursor): SchoolMessageHistoryQuery {
  const q: SchoolMessageHistoryQuery = { channel, range: filters.range };
  if (filters.outcome !== 'ALL') q.outcome = filters.outcome;
  if (filters.origin !== 'ALL') q.origin = filters.origin;
  const search = filters.search.trim().slice(0, SCHOOL_MESSAGES_LIMITS.searchMax).trim();
  if (search && schoolMessagesSearchOk(search)) q.search = search;
  if (before) q.before = before;
  return q;
}

export type WhenFormat = Readonly<{ short: (iso: string) => string; full: (iso: string) => string }>;
const NOUN: Record<SchoolMessageChannel, { one: string; many: string }> = { SMS: { one: 'text', many: 'texts' }, EMAIL: { one: 'email', many: 'emails' } };

/**
 * History tab (TE1 0585): every sent text or email of the school, newest first, as a table with a detail drawer. Read only:
 * the server checks communication.message.read for the shell's school; drafts and demo people never appear.
 */
export function MessageHistory({ scope, channel, when }: { scope: MessagesScope; channel: SchoolMessageChannel; when: WhenFormat }): React.ReactElement {
  const [filters, setFilters] = useState<Filters>(START);
  const [searchText, setSearchText] = useState('');
  const [rows, setRows] = useState<readonly SchoolMessageHistoryRow[]>([]);
  const [next, setNext] = useState<SchoolMessageCursor | null>(null);
  const [load, setLoad] = useState<Load>('LOADING');
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<SchoolMessageHistoryRow | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noun = NOUN[channel];

  function stopTimer(): void { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }
  async function fetchPage(nextFilters: Filters, before?: SchoolMessageCursor): Promise<void> {
    const token = ++generation.current;
    if (before) setMore(true); else { setLoad('LOADING'); setOpen(null); }
    try {
      const page = await loadHistory(scope, historyQuery(channel, nextFilters, before));
      if (generation.current !== token) return;
      setRows(before ? [...rows, ...page.messages.filter(m => !rows.some(r => r.messageId === m.messageId))] : page.messages);
      setNext(page.nextCursor); setLoad('READY');
    } catch (error) {
      if (generation.current !== token) return;
      if (!before) { setRows([]); setNext(null); }
      setLoad(error instanceof MessagesAccessError ? (error.reason === 'SESSION' ? 'SESSION' : 'DENIED') : 'UNAVAILABLE');
    } finally { if (generation.current === token) setMore(false); }
  }
  function apply(change: Partial<Filters>): void { stopTimer(); const nextFilters = { ...filters, ...change }; setFilters(nextFilters); void fetchPage(nextFilters); }
  function typeSearch(value: string): void {
    setSearchText(value); stopTimer();
    timer.current = setTimeout(() => { timer.current = null; apply({ search: value }); }, SEARCH_WAIT_MS);
  }
  useEffect(() => {
    void fetchPage(START);
    // A privacy hide or sign-out clears what is on screen; a late answer is dropped by the generation check.
    const off = typeof window === 'undefined' ? () => {} : onShellPrivacyEvent(() => { stopTimer(); ++generation.current; setRows([]); setOpen(null); setNext(null); setLoad('LOADING'); });
    return () => { off(); stopTimer(); ++generation.current; };
  }, []);

  const select = (label: string, name: string, value: string, options: readonly [string, string][], onChange: (v: string) => void) =>
    <label className={s.label}>{label}<select className={s.field} name={name} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;

  return <div className={s.stack} data-message-history={channel}>
    <form className={s.filters} role="search" aria-label={`Filter ${noun.many}`} onSubmit={event => { event.preventDefault(); apply({ search: searchText }); }}>
      <label className={s.label}>Search<input className={s.field} name="historySearch" value={searchText} maxLength={SCHOOL_MESSAGES_LIMITS.searchMax} autoComplete="off"
        placeholder={channel === 'SMS' ? 'Name, phone or words in the text' : 'Name, email, subject or words'} onChange={event => typeSearch(event.target.value)} /></label>
      {select('Status', 'historyOutcome', filters.outcome, [['ALL', 'Any status'], ...Object.entries(OUTCOME_LABEL)] as [string, string][], v => apply({ outcome: v as Filters['outcome'] }))}
      {select('Sent by', 'historyOrigin', filters.origin, [['ALL', 'Anyone'], ...Object.entries(ORIGIN_LABEL)] as [string, string][], v => apply({ origin: v as Filters['origin'] }))}
      {select('When', 'historyRange', filters.range, Object.entries(RANGE_LABEL) as [string, string][], v => apply({ range: v as SchoolMessageRange }))}
    </form>
    <div className={s.tableWrap} data-open={open ? 'true' : 'false'}>
      <section className={`${s.panel} ${s.tablePanel}`} aria-label={`Sent ${noun.many}`} aria-busy={load === 'LOADING'}>
        {load === 'LOADING' && <p className={s.muted} role="status">{`Loading ${noun.many}…`}</p>}
        {load === 'DENIED' && <p className={s.flash} data-tone="bad" role="alert">Your access does not include message history at this school.</p>}
        {load === 'SESSION' && <p className={s.flash} data-tone="bad" role="alert">Your session ended. Sign in again to see message history.</p>}
        {load === 'UNAVAILABLE' && <div className={s.flash} data-tone="bad" role="alert"><p>{`Sent ${noun.many} could not be loaded.`}</p>
          <p className={s.actions}><button type="button" className={s.button} onClick={() => void fetchPage(filters)}>Try again</button></p></div>}
        {load === 'READY' && rows.length === 0 && <div className={s.empty}><strong>{`No ${noun.many} match`}</strong><span>Try a longer time range or clear the filters.</span></div>}
        {load === 'READY' && rows.length > 0 && <table className={s.table}>
          <thead><tr><th scope="col">When</th><th scope="col">Contact</th><th scope="col">Message</th><th scope="col">Sent by</th><th scope="col">Status</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.messageId} aria-current={open?.messageId === row.messageId ? 'true' : undefined}>
            <td><time dateTime={row.at} title={when.full(row.at)}>{when.short(row.at)}</time></td>
            <td><button type="button" className={s.linkButton} data-message={row.messageId} onClick={() => setOpen(row)}>
              <span className={s.rowName}>{row.personName}</span><span className={s.rowSub}>{row.address ?? 'No address on file'}</span></button></td>
            <td className={s.cellPreview}><span>{row.subject ? <strong>{row.subject} </strong> : null}{row.preview}</span></td>
            <td>{ORIGIN_LABEL[row.origin]}</td>
            <td><span className={s.badge} data-tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</span></td>
          </tr>)}</tbody></table>}
        {load === 'READY' && next && <p className={s.more}><button type="button" className={s.ghost} disabled={more} onClick={() => void fetchPage(filters, next)}>{more ? 'Loading…' : 'Show older'}</button></p>}
      </section>
      {open && <aside className={`${s.panel} ${s.drawer}`} aria-label={`${noun.one} details`} data-drawer="">
        <div className={s.threadHead} style={{ padding: 0, border: 0 }}>
          <span className={s.picked} style={{ border: 0, padding: 0, background: 'none' }}><span className={s.avatar} aria-hidden="true">{initials(open.personName)}</span>
            <span className={s.rowMain}><strong>{open.personName}</strong><span className={s.rowSub}>{open.address ?? 'No address on file'}</span></span></span>
          <button type="button" className={s.ghost} onClick={() => setOpen(null)}>Close</button>
        </div>
        {channel === 'EMAIL' ? <SentEmail key={open.messageId} scope={scope} personId={open.personId} messageId={open.messageId} preview={open.preview} when={when} /> : <>
          {open.subject && <h3 style={{ margin: 0 }}>{open.subject}</h3>}
          <p className={s.bubble} data-from="out" style={{ margin: 0, maxWidth: '100%' }}>{open.preview}</p></>}
        <dl className={s.facts}>
          <div><dt>Status</dt><dd><span className={s.badge} data-tone={OUTCOME_TONE[open.outcome]}>{OUTCOME_LABEL[open.outcome]}</span></dd></div>
          <div><dt>Sent</dt><dd>{when.full(open.at)}</dd></div>
          <div><dt>Sent by</dt><dd>{open.by ? `${open.by} (${ORIGIN_LABEL[open.origin]})` : ORIGIN_LABEL[open.origin]}</dd></div>
          <div><dt>Address</dt><dd>{open.address ?? 'No address on file'}</dd></div>
        </dl>
        <p className={s.muted}>{channel === 'EMAIL' ? 'The address is the one on file now.' : `The preview shows the first ${SCHOOL_MESSAGES_LIMITS.previewMax} characters. The address is the one on file now.`}</p>
      </aside>}
    </div>
  </div>;
}
