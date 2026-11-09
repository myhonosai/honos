'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { OwnershipError, ownershipApi, type OwnershipApi } from './http';
import { OwnerOwnershipView, type OwnerOwnershipState } from './view';

/**
 * School owners, for an owner of the verified school (B-ID-4). Read only. Blur, a hidden tab, page hide, a school change or a
 * session end hide it at once and retire the read; it reads again only after the shell re-verifies the school. The server
 * decides whether the reader is a live owner of this school.
 */
export function OwnerSchoolOwnership({ api = ownershipApi }: { api?: OwnershipApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' && shell.selection ? shell.selection.schoolId : null;
  const [state, setState] = useState<OwnerOwnershipState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; privacy.current++; setState({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current, shown = privacy.current;
    setState({ state: 'LOADING' });
    if (!schoolId) return;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.ownerRead(schoolId, signal, owned).then(
      (view) => { if (owned()) setState({ state: 'READY', view }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof OwnershipError ? error.kind : 'UNKNOWN';
        setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, schoolId, refresh, shell.phase]);

  const onRefresh = useCallback(() => setRefresh((value) => value + 1), []);
  return <div key={shell.phase} data-shell-private="">
    <OwnerOwnershipView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      schoolId={schoolId} state={state} onRefresh={onRefresh}/>
  </div>;
}
