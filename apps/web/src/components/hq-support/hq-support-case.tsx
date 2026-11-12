'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HQ_SUPPORT_NOTE_MAX } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { SupportError, supportApi, supportCaseId, type SupportApi } from './http';
import { useConcealment, useSupportCommand, type SupportOutcome } from './model';
import { HqSupportCaseView, changeInputFrom, type ChangeDraft, type SupportCaseState } from './case-view';

/**
 * One HQ support case (B-HQ-2): facts, history, add a note, change status, priority or assignee. Every command carries
 * the version that was read; any answer is followed by a fresh read. Leaving the tab or a session end hides the case,
 * its drafts and any kept command. The server decides who may read or write, every time.
 */
export function HqSupportCase({ caseId, api = supportApi }: { caseId: string; api?: SupportApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const valid = supportCaseId(caseId) !== null;
  const [state, setState] = useState<SupportCaseState>(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; dropRef.current(); setBusy(false); setState(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  });
  const after = useCallback((outcome: SupportOutcome) => {
    if (outcome?.kind === 'DONE') setFormKey(n => n + 1);
    setRefresh(n => n + 1);
  }, []);
  const command = useSupportCommand(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed || !valid) return;
    const current = ++generation.current, shown = privacy.current, owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setBusy(true);
    api.read(caseId, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof SupportError ? error.kind : 'UNKNOWN';
        if (kind === 'DENIED') dropRef.current();
        setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'INVALID' ? 'INVALID' : 'UNAVAILABLE' });
      }).finally(() => { if (owned()) setBusy(false); });
    return () => { abort.abort(); };
  }, [api, caseId, valid, refresh, concealed, privacy]);

  const view = state.state === 'READY' ? state.view : null;
  const { start, local } = command;
  const onNote = useCallback((note: string) => {
    if (!view || view.case.status === 'CLOSED') return;
    const clean = note.trim();
    if (!clean || clean.length > HQ_SUPPORT_NOTE_MAX) { local('note'); return; }
    const input = { expectedVersion: view.case.version, note: clean }, id = view.case.caseId;
    start((key, signal, owned) => api.note(id, input, key, signal, owned));
  }, [api, view, start, local]);
  const onChange = useCallback((draft: ChangeDraft) => {
    if (!view || view.case.status === 'CLOSED') return;
    const input = changeInputFrom(draft, view), id = view.case.caseId;
    if (!input) { local('change'); return; }
    start((key, signal, owned) => api.change(id, input, key, signal, owned));
  }, [api, view, start, local]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);

  return <HqSupportCaseView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} busy={busy}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} formKey={formKey}
    onRefresh={onRefresh} onReveal={reveal} onNote={onNote} onChange={onChange} onTryAgain={command.tryAgain}/>;
}
