'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { RosterError, rosterApi, type RosterApi, type RosterScope, type SessionPage } from './http';
import { RosterView, type SessionListState } from './view';
import { useRosterDetail } from './use-roster-detail';

const kindOf = (error: unknown) => error instanceof RosterError ? error.kind : 'UNAVAILABLE';

/**
 * Class rosters (U5): the school's classes from a school-local date (default the school's today), page by page, and one
 * class's roster with booking and attendance per student, page by page. Read-only. Blur, a hidden tab, page hide, a school change or a session end hide the page at once and retire every read;
 * reads start again only after the shell re-verifies the school. A class list or roster that changed between pages is read
 * again from page one, once; nothing from the earlier pages is kept.
 */
export function ClassRoster({ api = rosterApi }: { api?: RosterApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: RosterScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const [from, setFrom] = useState<string | null>(null);
  const [list, setList] = useState<SessionListState>({ state: 'LOADING' });
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listGeneration = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const classesAbort = useRef<AbortController | null>(null);
  const detail = useRosterDetail(api, scope, selectedId, privacy, mounted);
  const { roster, marks, onMore, onMark } = detail;
  const retire = () => { detail.retire(); listGeneration.current++; classesAbort.current?.abort(); classesAbort.current = null; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++;
    setList({ state: 'LOADING' }); detail.clear();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelectedId(null); setFrom(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  // Page one of the class list from the chosen date. A refused cursor or a moved list while paging restarts here, once.
  const firstClasses = useCallback((forFrom: string | null, restarted: boolean) => {
    classesAbort.current?.abort(); classesAbort.current = null;
    const current = ++listGeneration.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!scope) return () => {};
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === listGeneration.current && shown === privacy.current;
    api.sessions(scope, forFrom, null, signal, owned).then(
      (page) => { if (owned()) { setList({ state: 'READY', from: forFrom, ...page, more: 'IDLE', restarted }); setSelectedId((id) => id && page.items.some((s) => s.sessionId === id) ? id : null); } },
      (error) => { if (owned() && !abort.signal.aborted) { const kind = kindOf(error); setList({ state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' }); } });
    return () => { abort.abort(); };
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const restartClasses = useRef<((forFrom: string | null) => void) | null>(null);
  restartClasses.current = (forFrom) => { firstClasses(forFrom, true); };
  useEffect(() => firstClasses(from, false), [from, listRefresh, firstClasses]);

  const onMoreClasses = useCallback(() => {
    if (list.state !== 'READY' || !list.nextCursor || list.more === 'LOADING' || !scope) return;
    const prior = list, current = listGeneration.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    classesAbort.current?.abort(); classesAbort.current = abort;
    const owned = () => mounted.current && current === listGeneration.current && shown === privacy.current && classesAbort.current === abort;
    setList({ ...prior, more: 'LOADING' });
    const changed = () => { if (prior.restarted) setList({ state: 'UNAVAILABLE' }); else restartClasses.current?.(prior.from); };
    api.sessions(scope, prior.from, prior.nextCursor, signal, owned).then(
      (page: SessionPage) => {
        if (!owned()) return;
        classesAbort.current = null;
        const seen = new Set(prior.items.map((s) => s.sessionId));
        const last = prior.items[prior.items.length - 1], first = page.items[0];
        // A repeated class, a class before the last one shown, or a different school clock means the list moved. A default
        // (school today) list keeps its page-one dates: a later page read after the school's midnight reports the new day.
        if (page.items.some((s) => seen.has(s.sessionId)) || (last && first && Date.parse(first.startsAt) < Date.parse(last.startsAt))
          || (prior.from !== null && page.fromDate !== prior.fromDate) || page.schoolTimezone !== prior.schoolTimezone) { changed(); return; }
        setList({ ...prior, items: [...prior.items, ...page.items], nextCursor: page.nextCursor, more: 'IDLE' });
      },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        classesAbort.current = null;
        const kind = kindOf(error);
        if (kind === 'CURSOR') { changed(); return; }
        setList(kind === 'DENIED' ? { state: 'DENIED' } : kind === 'TIMEZONE' ? { state: 'TIMEZONE' } : { ...prior, more: 'FAILED' });
      });
  }, [api, list, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFrom = useCallback((next: string | null) => { setFrom(next); }, []);
  const reloadRoster = detail.reload;
  const onOpen = useCallback((id: string) => { setSelectedId(id); reloadRoster(); }, [reloadRoster]);
  const onRefresh = useCallback(() => { setListRefresh((n) => n + 1); reloadRoster(); }, [reloadRoster]);
  const onReloadRoster = reloadRoster;

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <RosterView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      scope={scope} from={from} list={list} selectedId={selectedId} roster={roster}
      onFrom={onFrom} onOpen={onOpen} onRefresh={onRefresh} onMoreClasses={onMoreClasses} onMore={onMore} onReloadRoster={onReloadRoster}
      marks={marks} onMark={onMark}/>
  </div>;
}
