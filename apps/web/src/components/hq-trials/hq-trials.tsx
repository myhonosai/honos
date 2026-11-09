'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TrialGovernanceView } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { TrialsError, trialsApi, type TrialsApi } from './http';
import { TrialsView, type PreviewState, type ReadState } from './view';

const systemNow = () => Date.now();
const failed = (error: unknown): 'DENIED' | 'UNAVAILABLE' => error instanceof TrialsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE';

/**
 * HQ Free Trials: trial rules, decisions and campaign definitions, read only. A session end hides everything and retires
 * every read. A readiness check reads one campaign version's publication preview and changes nothing.
 */
export function HqTrials({ api = trialsApi, now = systemNow }: { api?: TrialsApi; now?: () => number }): React.ReactElement {
  const { preferences } = useLocale();
  const [governance, setGovernance] = useState<ReadState<TrialGovernanceView>>({ state: 'LOADING' });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(() => now());
  const generation = useRef(0), mounted = useRef(false), check = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; check.current?.abort(); }; }, []);
  useEffect(() => {
    const end = () => { generation.current++; check.current?.abort(); setConcealed(true); setGovernance({ state: 'LOADING' }); setPreview(null); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, end);
    return () => window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, end);
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    check.current?.abort(); setPreview(null); setGovernance({ state: 'LOADING' });
    api.governance(signal, owned).then((view) => { if (owned()) { setClock(now()); setGovernance({ state: 'READY', view }); } },
      (error) => { if (owned() && !abort.signal.aborted) setGovernance({ state: failed(error) }); });
    return () => { abort.abort(); };
  }, [api, now, refresh, concealed]);

  const onCheck = useCallback((versionId: string) => {
    check.current?.abort();
    const abort = new AbortController(); check.current = abort;
    const current = generation.current;
    const owned = () => mounted.current && current === generation.current && check.current === abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setPreview({ state: 'LOADING', versionId });
    api.preview(versionId, signal, owned).then((p) => { if (owned()) setPreview({ state: 'READY', versionId, preview: p }); },
      (error) => { if (owned() && !abort.signal.aborted) setPreview({ state: failed(error), versionId }); });
  }, [api]);

  return <TrialsView language={preferences.language} concealed={concealed} governance={governance} now={clock} preview={preview}
    onRefresh={() => setRefresh((n) => n + 1)} onCheck={onCheck}/>;
}
