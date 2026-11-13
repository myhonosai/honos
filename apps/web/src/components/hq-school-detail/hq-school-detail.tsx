'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SchoolDetailError, schoolDetailApi, schoolDetailId, type SchoolDetailApi } from './http';
import { HqSchoolDetailView, type SchoolDetailState } from './view';

/**
 * HQ school detail (C-HQ-3). Read only. Leaving the tab (blur, hidden tab, page hide) or a session end hides every fact
 * and retires the read; "Show again" reads fresh. The server decides who may read, on every read.
 */
export function HqSchoolDetail({ schoolId, api = schoolDetailApi }: { schoolId: string; api?: SchoolDetailApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const valid = schoolDetailId(schoolId) !== null;
  const [state, setState] = useState<SchoolDetailState>(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  useEffect(() => {
    const conceal = () => { generation.current++; setConcealed(true); setBusy(false); setState(valid ? { state: 'LOADING' } : { state: 'INVALID' }); };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, [valid]);

  useEffect(() => {
    if (concealed || !valid) return;
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState({ state: 'LOADING' }); setBusy(true);
    api.read(schoolId, signal, owned).then(
      (view) => { if (owned()) setState({ state: 'READY', view }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof SchoolDetailError ? error.kind : 'UNKNOWN';
        setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'INVALID' ? 'INVALID' : 'UNAVAILABLE' });
      }).finally(() => { if (owned()) setBusy(false); });
    return () => { abort.abort(); };
  }, [api, schoolId, valid, refresh, concealed]);

  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onReveal = useCallback(() => setConcealed(false), []);
  return <HqSchoolDetailView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} busy={busy}
    onRefresh={onRefresh} onReveal={onReveal}/>;
}
