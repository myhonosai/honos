'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqShopifyStoreRequest } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useConcealment } from '../hq-support/model';
import { MakeShopError, hqShopRequestsApi, type HqShopRequestsApi } from '../school-shopify/make-shop-http';
import { HqShopRequestsView, type HqShopRequestsOutcome, type HqShopRequestsState } from './view';

/**
 * HQ's Shopify store requests (0655). Leaving the tab or a session end hides every request (they hold owners' emails);
 * "Show again" reads fresh. One command at a time, never replayed; every answer is followed by a fresh read. The server
 * decides who is HQ. Nothing here reaches Shopify: HQ creates the store by hand in the Partner Dashboard.
 */
export function HqShopRequests({ api = hqShopRequestsApi }: { api?: HqShopRequestsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<HqShopRequestsState>({ state: 'LOADING' });
  const [outcome, setOutcome] = useState<HqShopRequestsOutcome>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; setOutcome(null); setState({ state: 'LOADING' }); });
  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list(signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); },
      error => { if (owned() && !abort.signal.aborted) setState({ state: error instanceof MakeShopError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refresh, concealed]);
  const onSettle = useCallback(async (request: HqShopifyStoreRequest, result: 'CREATED' | 'DECLINED', shopDomain: string | null) => {
    if (sending.current) return;
    sending.current = true; const shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    setOutcome({ kind: 'SENDING', requestId: request.requestId });
    let next: HqShopRequestsOutcome;
    try { await api.settle(request.requestId, request.version, result, shopDomain, AbortSignal.timeout(20000), owned); next = { kind: 'DONE', outcome: result }; }
    catch (e) { next = { kind: 'ERROR', error: e instanceof MakeShopError ? e.kind : 'UNKNOWN' }; }
    finally { sending.current = false; }
    if (!owned()) return;
    setOutcome(next); setRefresh(n => n + 1);
  }, [api, privacy]);
  return <HqShopRequestsView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} outcome={outcome}
    onSettle={(r, o, d) => { void onSettle(r, o, d); }} onRefresh={() => { setOutcome(null); setRefresh(n => n + 1); }} onReveal={() => { reveal(); setRefresh(n => n + 1); }} />;
}
