'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  SCHOOL_MESSAGES_LIMITS, schoolMessagesSearchOk,
  type SchoolMessageChannel, type SchoolMessageCursor, type SchoolOptOutSource, type SchoolOptedOutQuery, type SchoolOptedOutRow,
} from '@hon/contracts';
import { MessagesAccessError, loadOptedOut, type MessagesScope } from './messages-http';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { initials } from '../comms-kit/initials';
import type { WhenFormat } from './message-history';
import s from '../comms-kit/comms.module.css';

type Load = 'LOADING' | 'READY' | 'DENIED' | 'SESSION' | 'UNAVAILABLE';
export const SOURCE_LABEL: Record<SchoolOptOutSource, string> = { RECIPIENT: 'Replied STOP', PARENT: 'Parent app', STAFF: 'Staff recorded', IMPORT: 'Imported' };
const SEARCH_WAIT_MS = 300;

export function optedOutQuery(channel: SchoolMessageChannel, search: string, before?: SchoolMessageCursor): SchoolOptedOutQuery {
  const q: SchoolOptedOutQuery = { channel };
  const text = search.trim().slice(0, SCHOOL_MESSAGES_LIMITS.searchMax).trim();
  if (text && schoolMessagesSearchOk(text)) q.search = text;
  if (before) q.before = before;
  return q;
}

/**
 * Opted out tab (TE1 0585): contacts whose consent for this channel is OPTED_OUT now, newest first, with how they opted out.
 * Read only (communication.consent.read); HON never sends them this channel until they opt back in on their contact card.
 */
export function OptedOutList({ scope, channel, when }: { scope: MessagesScope; channel: SchoolMessageChannel; when: WhenFormat }): React.ReactElement {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<readonly SchoolOptedOutRow[]>([]);
  const [next, setNext] = useState<SchoolMessageCursor | null>(null);
  const [load, setLoad] = useState<Load>('LOADING');
  const [more, setMore] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noun = channel === 'SMS' ? 'texts' : 'emails';

  function stopTimer(): void { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }
  async function fetchPage(text: string, before?: SchoolMessageCursor): Promise<void> {
    const token = ++generation.current;
    if (before) setMore(true); else setLoad('LOADING');
    try {
      const page = await loadOptedOut(scope, optedOutQuery(channel, text, before));
      if (generation.current !== token) return;
      setRows(before ? [...rows, ...page.contacts.filter(c => !rows.some(r => r.consentId === c.consentId))] : page.contacts);
      setNext(page.nextCursor); setLoad('READY');
    } catch (error) {
      if (generation.current !== token) return;
      if (!before) { setRows([]); setNext(null); }
      setLoad(error instanceof MessagesAccessError ? (error.reason === 'SESSION' ? 'SESSION' : 'DENIED') : 'UNAVAILABLE');
    } finally { if (generation.current === token) setMore(false); }
  }
  function apply(text: string): void { stopTimer(); setApplied(text); void fetchPage(text); }
  function type(value: string): void { setSearch(value); stopTimer(); timer.current = setTimeout(() => { timer.current = null; apply(value); }, SEARCH_WAIT_MS); }
  useEffect(() => {
    void fetchPage('');
    const off = typeof window === 'undefined' ? () => {} : onShellPrivacyEvent(() => { stopTimer(); ++generation.current; setRows([]); setNext(null); setLoad('LOADING'); });
    return () => { off(); stopTimer(); ++generation.current; };
  }, []);

  return <section className={`${s.panel} ${s.stack}`} aria-label="Opted out" data-opted-out={channel}>
    <p className={s.muted}>{`These contacts asked not to get ${noun} from the school. HON will not send them ${noun} until they opt back in, which is recorded on their contact card.`}</p>
    <form role="search" aria-label="Find an opted-out contact" onSubmit={event => { event.preventDefault(); apply(search); }}>
      <label className={s.label}>Search<input className={s.field} name="optedOutSearch" value={search} maxLength={SCHOOL_MESSAGES_LIMITS.searchMax} autoComplete="off"
        placeholder={channel === 'SMS' ? 'Name or phone' : 'Name or email'} onChange={event => type(event.target.value)} /></label>
    </form>
    {load === 'LOADING' && <p className={s.muted} role="status">Loading…</p>}
    {load === 'DENIED' && <p className={s.flash} data-tone="bad" role="alert">Your access does not include contact consent at this school.</p>}
    {load === 'SESSION' && <p className={s.flash} data-tone="bad" role="alert">Your session ended. Sign in again to see who opted out.</p>}
    {load === 'UNAVAILABLE' && <div className={s.flash} data-tone="bad" role="alert"><p>The opted-out list could not be loaded.</p>
      <p className={s.actions}><button type="button" className={s.button} onClick={() => void fetchPage(applied)}>Try again</button></p></div>}
    {load === 'READY' && rows.length === 0 && <div className={s.empty}><strong>{applied.trim() ? 'No opted-out contact matches' : 'Nobody has opted out'}</strong>
      <span>{applied.trim() ? 'Check the spelling or clear the search.' : `Everyone with consent can get ${noun}.`}</span></div>}
    {load === 'READY' && rows.length > 0 && <ul className={s.rows} style={{ flex: 'none', overflow: 'visible' }}>{rows.map(row =>
      <li key={row.consentId} className={s.row} style={{ cursor: 'default' }} data-consent={row.consentId}>
        <span className={s.avatar} aria-hidden="true">{initials(row.personName)}</span>
        <span className={s.rowMain}><span className={s.rowName}>{row.personName}</span><span className={s.rowSub}>{row.address ?? 'No address on file'}</span></span>
        <span className={s.rowSide}><span className={s.badge}>{SOURCE_LABEL[row.source]}</span>
          <time dateTime={row.optedOutAt} title={when.full(row.optedOutAt)}>{`Since ${when.short(row.optedOutAt)}`}</time></span>
      </li>)}</ul>}
    {load === 'READY' && next && <p className={s.more}><button type="button" className={s.ghost} disabled={more} onClick={() => void fetchPage(applied, next)}>{more ? 'Loading…' : 'Show more'}</button></p>}
  </section>;
}
