'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqProspectReceipt, HqProspectStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { CommsError } from '../hq-communications/http';
import { useCommsCommand, useConcealment, type CommsOutcome } from '../hq-communications/model';
import { prospectsApi, type ProspectsApi } from './http';
import type { ProspectKey } from './copy';
import { ProspectDetailView, ProspectListView, consentInputFrom, createInputFrom, updateInputFrom, type ConsentDraft, type ProspectDetailState,
  type ProspectDraft, type ProspectListState } from './view';

const readFailure = (error: unknown) => error instanceof CommsError ? error.kind : 'UNKNOWN';

/** HON prospects (HQ-COMM E1): add one and see the list. Leaving the tab hides contact details and drops any kept command. */
export function HqProspects({ api = prospectsApi }: { api?: ProspectsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<ProspectListState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<HqProspectStatus | null>('ACTIVE');
  const [refresh, setRefresh] = useState(0), [formKey, setFormKey] = useState(0), [localInvalid, setLocalInvalid] = useState<ProspectKey | null>(null);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setFormKey(n => n + 1); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: CommsOutcome<HqProspectReceipt>) => { if (outcome?.kind === 'DONE') setFormKey(n => n + 1); setRefresh(n => n + 1); }, []);
  const command = useCommsCommand<HqProspectReceipt>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    // A refresh keeps the list on screen; any 'Show more' still running belongs to the old read and is dropped, so clear its spinner.
    setState(prior => prior.state === 'READY' ? { ...prior, loadingMore: false } : { state: 'LOADING' });
    api.list({ status: filter, cursor: null }, signal, owned).then(list => {
      if (owned()) setState({ state: 'READY', list, prospects: list.prospects, loadingMore: false, moreFailed: false });
    }, (error: unknown) => {
      if (!owned()) return; const kind = readFailure(error);
      if (kind !== 'SESSION') setState(kind === 'DENIED' ? { state: 'DENIED' } : { state: 'UNAVAILABLE' });
    });
    return () => abort.abort();
  }, [api, filter, refresh, concealed, privacy]);

  const onMore = useCallback(() => {
    if (state.state !== 'READY' || !state.list.nextCursor || state.loadingMore) return;
    const current = generation.current, shown = privacy.current, cursor = state.list.nextCursor;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    setState({ ...state, loadingMore: true, moreFailed: false });
    api.list({ status: filter, cursor }, AbortSignal.timeout(15000), owned).then(list => {
      if (owned()) setState(prior => prior.state === 'READY' ? { state: 'READY', list, prospects: [...prior.prospects, ...list.prospects], loadingMore: false, moreFailed: false } : prior);
    }, () => { if (owned()) setState(prior => prior.state === 'READY' ? { ...prior, loadingMore: false, moreFailed: true } : prior); });
  }, [api, filter, state, privacy]);

  const onAdd = useCallback((d: ProspectDraft) => {
    const input = createInputFrom(d);
    if (!input) { setLocalInvalid('localInvalid'); return; }
    setLocalInvalid(null);
    command.start((key, signal, owned) => api.create(input, key, signal, owned));
  }, [api, command]);

  return <ProspectListView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} localInvalid={localInvalid} formKey={formKey}
    onFilter={(f) => { if (f === filter) return; generation.current++; setFilter(f); setState({ state: 'LOADING' }); }} onMore={onMore} onRefresh={() => setRefresh(n => n + 1)}
    onReveal={() => { reveal(); setRefresh(n => n + 1); }} onAdd={onAdd} onTryAgain={command.tryAgain}/>;
}

/** One prospect: correct details, archive or restore, and record a consent answer HQ is allowed to record. */
export function HqProspect({ prospectId, api = prospectsApi }: { prospectId: string; api?: ProspectsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<ProspectDetailState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0), [formKey, setFormKey] = useState(0), [localInvalid, setLocalInvalid] = useState<ProspectKey | null>(null);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setFormKey(n => n + 1); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: CommsOutcome<HqProspectReceipt>) => { if (outcome?.kind === 'DONE') setFormKey(n => n + 1); setRefresh(n => n + 1); }, []);
  const command = useCommsCommand<HqProspectReceipt>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(prospectId, signal, owned).then(detail => { if (owned()) setState({ state: 'READY', detail }); }, (error: unknown) => {
      if (!owned()) return; const kind = readFailure(error);
      if (kind === 'SESSION') return;
      setState(kind === 'DENIED' ? { state: 'DENIED' } : kind === 'GONE' ? { state: 'GONE' } : kind === 'INVALID' ? { state: 'INVALID' } : { state: 'UNAVAILABLE' });
    });
    return () => abort.abort();
  }, [api, prospectId, refresh, concealed, privacy]);

  const current = state.state === 'READY' ? state.detail.prospect : null;
  const run = useCallback((input: unknown, invalid: ProspectKey, send: (key: string, signal: AbortSignal, owned: () => boolean) => Promise<HqProspectReceipt>) => {
    if (!input) { setLocalInvalid(invalid); return; }
    setLocalInvalid(null); command.start(send);
  }, [command]);
  const onEdit = useCallback((d: ProspectDraft) => {
    if (!current) return; const input = updateInputFrom(current, d, current.status);
    run(input, 'localInvalid', (key, signal, owned) => api.update(prospectId, input!, key, signal, owned));
  }, [api, current, prospectId, run]);
  const onStatus = useCallback((status: HqProspectStatus) => {
    if (!current) return; const input = updateInputFrom(current, null, status);
    run(input, 'localInvalid', (key, signal, owned) => api.update(prospectId, input!, key, signal, owned));
  }, [api, current, prospectId, run]);
  const onConsent = useCallback((d: ConsentDraft) => {
    if (!current) return; const input = consentInputFrom(current, d);
    run(input, 'consentInvalid', (key, signal, owned) => api.consent(prospectId, input!, key, signal, owned));
  }, [api, current, prospectId, run]);

  return <ProspectDetailView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} localInvalid={localInvalid} formKey={formKey}
    onRefresh={() => setRefresh(n => n + 1)} onReveal={() => { reveal(); setRefresh(n => n + 1); }} onEdit={onEdit} onStatus={onStatus} onConsent={onConsent}
    onTryAgain={command.tryAgain}/>;
}
