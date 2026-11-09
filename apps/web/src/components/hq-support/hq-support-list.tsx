'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqSupportListFilter } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { SupportError, supportApi, type SupportApi } from './http';
import { useConcealment, useSupportCommand, type SupportOutcome } from './model';
import { HqSupportListView, openInputFrom, type OpenDraft, type SchoolsState, type SupportListState } from './list-view';

/**
 * HQ support case list (B-HQ-2). Leaving the tab or a session end hides every case, drops the open form and any kept
 * command; "Show again" reads fresh. Every command answer is followed by a fresh read. The server decides who may read.
 */
export function HqSupportList({ api = supportApi }: { api?: SupportApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<SupportListState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<HqSupportListFilter | null>('ACTIVE');
  const [refresh, setRefresh] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [schools, setSchools] = useState<SchoolsState>({ state: 'IDLE' });
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const dropRef = useRef<() => void>(() => {});
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; dropRef.current(); setFormOpen(false); setSchools({ state: 'IDLE' }); setState({ state: 'LOADING' });
  });
  const after = useCallback((outcome: SupportOutcome) => {
    if (outcome?.kind === 'DONE' || outcome?.kind === 'DENIED') setFormOpen(false);
    setRefresh(n => n + 1);
  }, []);
  const command = useSupportCommand(privacy, after);
  dropRef.current = command.drop;
  const ownsRead = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;
  const denied = useCallback(() => { generation.current++; dropRef.current(); setFormOpen(false); setSchools({ state: 'IDLE' }); setState({ state: 'DENIED' }); }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = ownsRead(current, privacy.current);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list({ status: filter, organizationId: null, cursor: null }, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view, cases: view.cases, loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        if (error instanceof SupportError && error.kind === 'DENIED') denied(); else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filter, refresh, concealed, denied]);

  useEffect(() => {
    if (!formOpen || concealed || schools.state !== 'IDLE') return;
    const shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    setSchools({ state: 'LOADING' });
    api.schools(AbortSignal.timeout(15000), owned).then(
      view => { if (owned()) setSchools({ state: 'READY', view }); },
      error => { if (!owned()) return; if (error instanceof SupportError && error.kind === 'DENIED') denied(); else setSchools({ state: 'FAILED' }); });
  }, [api, formOpen, concealed, schools.state, privacy, denied]);

  const onMore = useCallback(() => {
    if (state.state !== 'READY' || !state.view.nextCursor || state.loadingMore) return;
    const owned = ownsRead(generation.current, privacy.current), cursor = state.view.nextCursor;
    setState({ ...state, loadingMore: true, moreFailed: false });
    api.list({ status: filter, organizationId: null, cursor }, AbortSignal.timeout(15000), owned).then(
      view => { if (owned()) setState(prior => prior.state !== 'READY' ? prior : { state: 'READY', view,
        cases: [...prior.cases, ...view.cases.filter(c => !prior.cases.some(p => p.caseId === c.caseId))], loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned()) return;
        if (error instanceof SupportError && error.kind === 'DENIED') denied();
        else setState(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filter, state, denied]);

  const { start, local, setOutcome } = command;
  const onOpen = useCallback((draft: OpenDraft) => {
    const input = openInputFrom(draft, schools.state === 'READY' ? schools.view : null);
    if (!input) { local('open'); return; }
    start((key, signal, owned) => api.open(input, key, signal, owned));
  }, [api, schools, start, local]);
  const onForm = useCallback((open: boolean) => { if (!command.locked) { setFormOpen(open); setOutcome(null); if (open) setSchools({ state: 'IDLE' }); } }, [command.locked, setOutcome]);
  const onFilter = useCallback((next: HqSupportListFilter | null) => { setFilter(next); setState({ state: 'LOADING' }); setOutcome(null); }, [setOutcome]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);

  return <HqSupportListView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    formOpen={formOpen} schools={schools} outcome={command.outcome} locked={command.locked} canRetry={command.canRetry}
    onFilter={onFilter} onMore={onMore} onRefresh={onRefresh} onReveal={reveal} onForm={onForm} onOpen={onOpen} onTryAgain={command.tryAgain}/>;
}
