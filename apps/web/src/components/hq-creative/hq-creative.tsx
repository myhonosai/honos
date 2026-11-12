'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqCreativeGeneration, HqMarketingCampaign } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { MarketingError, marketingApi, type MarketingApi } from '../hq-marketing/http';
import { useConcealment, useMarketingCommand } from '../hq-marketing/model';
import { creativeApi, type CreativeApi } from './http';
import { budgetInputFrom, requestInputFrom, resolveInputFrom, type BudgetDraft, type RequestDraft, type ResolveDraft } from './model';
import { HqCreativeView, type CreativeDone, type CreativeOutcome, type CreativeState } from './view';

/**
 * HQ Creative Studio (M2). Leaving the tab or a session end hides everything and drops any kept command; "Show again"
 * reads fresh. Every command answer is followed by a fresh read. The server decides who may read, request, set the cap or
 * resolve; the open HQ campaigns are only offered as an optional link.
 */
export function HqCreative({ api = creativeApi, campaignsApi = marketingApi }: { api?: CreativeApi; campaignsApi?: MarketingApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<CreativeState>({ state: 'LOADING' });
  const [campaigns, setCampaigns] = useState<readonly HqMarketingCampaign[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [resolving, setResolving] = useState<string | null>(null);
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const dropRef = useRef<() => void>(() => {});
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setResolving(null); setCampaigns([]); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: CreativeOutcome) => {
    if (outcome?.kind !== 'UNKNOWN') setResolving(null);
    setRefresh(n => n + 1);
  }, []);
  const command = useMarketingCommand<{ done: CreativeDone; receipt: Awaited<ReturnType<CreativeApi['create']>> | Awaited<ReturnType<CreativeApi['setBudget']>> }>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.studio(signal, owned).then(
      view => {
        if (!owned()) return;
        setState({ state: 'READY', view });
        // Open campaigns only feed the optional link; a failure here leaves the list empty and changes nothing else.
        if (view.viewer.canManage) campaignsApi.list({ status: 'OPEN', cursor: null }, signal, owned).then(l => { if (owned()) setCampaigns(l.campaigns); }, () => {});
      },
      error => {
        if (!owned() || abort.signal.aborted) return;
        if (error instanceof MarketingError && error.kind === 'DENIED') { dropRef.current(); setState({ state: 'DENIED' }); } else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, campaignsApi, refresh, concealed]);

  const { start, local } = command;
  const view = state.state === 'READY' ? state.view : null;
  const onRequest = useCallback((d: RequestDraft) => {
    const input = requestInputFrom(d);
    if (!input) { local(); return; }
    start(async (key, signal, owned) => ({ done: 'REQUEST', receipt: await api.create(input, key, signal, owned) }));
  }, [api, start, local]);
  const onBudget = useCallback((d: BudgetDraft) => {
    const input = view ? budgetInputFrom(d, view.budget) : null;
    if (!input) { local(); return; }
    start(async (key, signal, owned) => ({ done: 'BUDGET', receipt: await api.setBudget(input, key, signal, owned) }));
  }, [api, start, local, view]);
  const onResolve = useCallback((g: HqCreativeGeneration, d: ResolveDraft) => {
    const input = resolveInputFrom(d, g);
    if (!input) { local(); return; }
    start(async (key, signal, owned) => ({ done: 'RESOLVE', receipt: await api.resolve(g.generationId, input, key, signal, owned) }));
  }, [api, start, local]);
  const onResolveOpen = useCallback((id: string | null) => { if (!command.locked) { setResolving(id); command.setOutcome(null); } }, [command]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);

  return <HqCreativeView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} campaigns={campaigns}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} resolving={resolving} onRefresh={onRefresh} onReveal={reveal}
    onRequest={onRequest} onBudget={onBudget} onResolveOpen={onResolveOpen} onResolve={onResolve} onTryAgain={command.tryAgain}/>;
}
