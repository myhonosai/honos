'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { RosterError, rosterApi, type RosterApi, type RosterPage, type RosterScope } from './http';
import { RosterView, type RosterState, type SessionListState, type SessionTab } from './view';

const kindOf = (error: unknown) => error instanceof RosterError ? error.kind : 'UNAVAILABLE';

/**
 * Class rosters (U5): the school's classes and one class's roster with booking and attendance per student, page by page.
 * Read-only. Blur, a hidden tab, page hide, a school change or a session end hide the page at once and retire every read;
 * reads start again only after the shell re-verifies the school. A roster that changed between pages is read again from
 * page one, once; nothing from the earlier pages is kept.
 */
export function ClassRoster({ api = rosterApi }: { api?: RosterApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: RosterScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const [tab, setTab] = useState<SessionTab>('UPCOMING');
  const [list, setList] = useState<SessionListState>({ state: 'LOADING' });
  const [now, setNow] = useState(() => Date.now());
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterState>({ state: 'NONE' });
  const [rosterRefresh, setRosterRefresh] = useState(0);
  const listGeneration = useRef(0), rosterGeneration = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const moreAbort = useRef<AbortController | null>(null);
  const retire = () => { listGeneration.current++; rosterGeneration.current++; moreAbort.current?.abort(); moreAbort.current = null; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++;
    setList({ state: 'LOADING' }); setRoster({ state: 'NONE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelectedId(null); setTab('UPCOMING'); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++listGeneration.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!scope) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === listGeneration.current && shown === privacy.current;
    api.sessions(scope, signal, owned).then(
      (items) => { if (owned()) { setNow(Date.now()); setList({ state: 'READY', items }); setSelectedId((id) => id && items.some((s) => s.sessionId === id) ? id : null); } },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: kindOf(error) === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, listRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page one of the selected class's roster. A changed roster while paging restarts here with restarted=true.
  const firstPage = useCallback((sessionId: string, restarted: boolean) => {
    if (!scope) return () => {};
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++rosterGeneration.current, shown = privacy.current;
    setRoster({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === rosterGeneration.current && shown === privacy.current;
    api.roster(scope, sessionId, null, signal, owned).then(
      (page) => { if (owned()) setRoster({ state: 'READY', sessionId, session: page.session, entries: page.entries, nextCursor: page.nextCursor, more: 'IDLE', restarted }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = kindOf(error);
        setRoster({ state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const restart = useRef<((sessionId: string) => void) | null>(null);
  restart.current = (sessionId) => { firstPage(sessionId, true); };

  useEffect(() => {
    if (!selectedId || !scope) { rosterGeneration.current++; setRoster({ state: 'NONE' }); return; }
    return firstPage(selectedId, false);
  }, [selection?.organizationId, selection?.schoolId, selectedId, rosterRefresh, firstPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMore = useCallback(() => {
    if (roster.state !== 'READY' || !roster.nextCursor || roster.more === 'LOADING' || !scope) return;
    const prior = roster, current = rosterGeneration.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === rosterGeneration.current && shown === privacy.current && moreAbort.current === abort;
    setRoster({ ...prior, more: 'LOADING' });
    const changed = () => { if (prior.restarted) setRoster({ state: 'UNAVAILABLE' }); else restart.current?.(prior.sessionId); };
    api.roster(scope, prior.sessionId, prior.nextCursor, signal, owned).then(
      (page: RosterPage) => {
        if (!owned()) return;
        moreAbort.current = null;
        const seen = new Set(prior.entries.map((e) => e.studentProfileId.toLowerCase()));
        // A student already shown on an earlier page means the roster moved under the cursor: start again.
        if (page.entries.some((e) => seen.has(e.studentProfileId.toLowerCase()))) { changed(); return; }
        setRoster({ ...prior, session: page.session, entries: [...prior.entries, ...page.entries], nextCursor: page.nextCursor, more: 'IDLE' });
      },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        moreAbort.current = null;
        const kind = kindOf(error);
        if (kind === 'CURSOR') { changed(); return; }
        setRoster(kind === 'DENIED' ? { state: 'DENIED' } : kind === 'MISSING' ? { state: 'MISSING' } : { ...prior, more: 'FAILED' });
      });
  }, [api, roster, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTab = useCallback((next: SessionTab) => setTab(next), []);
  const onOpen = useCallback((id: string) => { setSelectedId(id); setRosterRefresh((n) => n + 1); }, []);
  const onRefresh = useCallback(() => { setListRefresh((n) => n + 1); setRosterRefresh((n) => n + 1); }, []);
  const onReloadRoster = useCallback(() => setRosterRefresh((n) => n + 1), []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <RosterView language={preferences.language} timeZone={preferences.timeZone} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      scope={scope} now={now} tab={tab} list={list} selectedId={selectedId} roster={roster}
      onTab={onTab} onOpen={onOpen} onRefresh={onRefresh} onMore={onMore} onReloadRoster={onReloadRoster}/>
  </div>;
}
