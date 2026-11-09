'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SaasCreativeHqWalletList } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CreditsError, creditsApi, type CreditsApi } from './http';
import { CreditsView, type DetailState, type ReadState } from './view';

const failed = (error: unknown): 'DENIED' | 'UNAVAILABLE' => error instanceof CreditsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE';

/**
 * HQ Creative Credits: the program state, rates, packages and every school wallet, read only. Leaving the window or
 * tab, or a session end, hides everything and retires every read; "Show again" reads fresh. Opening a school reads that school's wallet only.
 */
export function HqCreativeCredits({ api = creditsApi }: { api?: CreditsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [wallets, setWallets] = useState<ReadState<SaasCreativeHqWalletList>>({ state: 'LOADING' });
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), mounted = useRef(false), open = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; open.current?.abort(); }; }, []);
  useEffect(() => {
    // Per-school billing data: leaving the window or tab, or a session end, hides everything and retires every read.
    const conceal = () => { generation.current++; open.current?.abort(); setConcealed(true); setWallets({ state: 'LOADING' }); setDetail(null); };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    open.current?.abort(); setDetail(null); setWallets({ state: 'LOADING' });
    api.wallets(signal, owned).then((view) => { if (owned()) setWallets({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setWallets({ state: failed(error) }); });
    return () => { abort.abort(); };
  }, [api, refresh, concealed]);

  const onOpen = useCallback((schoolId: string) => {
    open.current?.abort();
    const abort = new AbortController(); open.current = abort;
    const current = generation.current;
    const owned = () => mounted.current && current === generation.current && open.current === abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setDetail({ state: 'LOADING', schoolId });
    api.school(schoolId, signal, owned).then((wallet) => { if (owned()) setDetail({ state: 'READY', schoolId, wallet }); },
      (error) => { if (owned() && !abort.signal.aborted) setDetail({ state: failed(error), schoolId }); });
  }, [api]);
  const onClose = useCallback(() => { open.current?.abort(); open.current = null; setDetail(null); }, []);

  return <CreditsView language={preferences.language} concealed={concealed} wallets={wallets} detail={detail}
    onRefresh={() => setRefresh((n) => n + 1)} onShowAgain={() => { setConcealed(false); setRefresh((n) => n + 1); }} onOpen={onOpen} onClose={onClose}/>;
}
