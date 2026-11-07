'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AccountStatusError, readSchoolCreativeWallet } from '../account-status/http';
import { studioWallet, type StudioState, type StudioWallet } from './model';
import { CreativeStudioView } from './view';

export type CreativeStudioApi = { wallet(scope: Readonly<{ organizationId: string; schoolId: string }>, signal: AbortSignal): Promise<StudioWallet> };
/** GET only. The server authorizes the exact school; nothing here opens a window, buys a top-up or creates media. */
export const CREATIVE_STUDIO_API: CreativeStudioApi = {
  wallet: async (scope, signal) => studioWallet(await readSchoolCreativeWallet(scope, signal)),
};

/**
 * Reads the wallet of the school the shell verified. Blur, a hidden tab, page hide, a school change or a
 * session end hide the page at once and retire any pending read; it reads again only after the shell re-verifies.
 */
export function CreativeStudio({ api = CREATIVE_STUDIO_API }: { api?: CreativeStudioApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [studio, setStudio] = useState<StudioState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; setStudio({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current;
    setStudio({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController();
    api.wallet({ organizationId: selection.organizationId, schoolId: selection.schoolId }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then(
      wallet => { if (current === generation.current) setStudio({ state: 'READY', wallet }); },
      error => { if (current === generation.current) setStudio({ state: error instanceof AccountStatusError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, api, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);
  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <CreativeStudioView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} studio={studio} onRefresh={onRefresh}/>
  </div>;
}
