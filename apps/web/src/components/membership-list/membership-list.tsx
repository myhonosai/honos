'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MembershipListError, membershipListApi, type MembershipListApi, type MembershipListFilter, type MembershipListScope } from './http';
import { MembershipListView, type MembershipListState } from './view';

const kindOf = (error: unknown) => error instanceof MembershipListError ? error.kind : 'UNAVAILABLE';
const failed = (error: unknown): MembershipListState => {
  const kind = kindOf(error);
  return { state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' };
};

/**
 * Memberships (U6): every membership of the verified school, newest first, page by page, optionally one lifecycle state.
 * Read-only. Blur, a hidden tab, page hide, a school change or a session end hide the page at once and retire every read;
 * reads start again only after the shell re-verifies the school. A cursor the API refuses, or a row repeated across pages,
 * reads the list again from page one, once; nothing from the earlier pages is kept.
 */
export function MembershipList({ api = membershipListApi }: { api?: MembershipListApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: MembershipListScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const [filter, setFilter] = useState<MembershipListFilter>(null);
  const [list, setList] = useState<MembershipListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const moreAbort = useRef<AbortController | null>(null);
  const retire = () => { generation.current++; moreAbort.current?.abort(); moreAbort.current = null; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++;
    setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) setFilter(null);
    if (school !== null) lastSchool.current = school;
  }, [school]);

  // Page one for the current filter. A refused cursor or a repeated row while paging restarts here with restarted=true.
  const firstPage = useCallback((forFilter: MembershipListFilter, restarted: boolean) => {
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++generation.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!scope) return () => {};
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    api.page(scope, forFilter, null, signal, owned).then(
      (page) => { if (owned()) setList({ state: 'READY', filter: forFilter, ...page, more: 'IDLE', restarted }); },
      (error) => { if (owned() && !abort.signal.aborted) setList(failed(error)); });
    return () => { abort.abort(); };
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const restart = useRef<((forFilter: MembershipListFilter) => void) | null>(null);
  restart.current = (forFilter) => { firstPage(forFilter, true); };

  useEffect(() => firstPage(filter, false), [filter, refresh, firstPage]);

  const onMore = useCallback(() => {
    if (list.state !== 'READY' || !list.nextCursor || list.more === 'LOADING' || !scope) return;
    const prior = list, current = generation.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current && moreAbort.current === abort;
    setList({ ...prior, more: 'LOADING' });
    const changed = () => { if (prior.restarted) setList({ state: 'UNAVAILABLE' }); else restart.current?.(prior.filter); };
    api.page(scope, prior.filter, prior.nextCursor, signal, owned).then(
      (page) => {
        if (!owned()) return;
        moreAbort.current = null;
        const seen = new Set(prior.items.map((m) => m.membershipId.toLowerCase()));
        const last = prior.items[prior.items.length - 1];
        // A repeated row, a newer row after older ones, or a different school clock means the list moved: start again.
        if (page.items.some((m) => seen.has(m.membershipId.toLowerCase())) || (last && page.items[0] && page.items[0].createdAt > last.createdAt)
          || page.schoolTimezone !== prior.schoolTimezone) { changed(); return; }
        setList({ ...prior, items: [...prior.items, ...page.items], nextCursor: page.nextCursor, localToday: page.localToday, more: 'IDLE' });
      },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        moreAbort.current = null;
        const kind = kindOf(error);
        if (kind === 'CURSOR') { changed(); return; }
        setList(kind === 'DENIED' || kind === 'TIMEZONE' ? failed(error) : { ...prior, more: 'FAILED' });
      });
  }, [api, list, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFilter = useCallback((next: MembershipListFilter) => { setFilter(next); }, []);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <MembershipListView language={preferences.language} timeZone={preferences.timeZone} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      scope={scope} filter={filter} list={list} onFilter={onFilter} onRefresh={onRefresh} onMore={onMore}/>
  </div>;
}
