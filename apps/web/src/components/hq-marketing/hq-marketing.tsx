'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqMarketingCampaign, HqMarketingListFilter, HqMarketingTargetStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { MarketingError, marketingApi, type MarketingApi } from './http';
import { createInputFrom, updateInputFrom, useConcealment, useMarketingCommand, type MarketingOutcome, type PlanDraft } from './model';
import { HqMarketingView, type MarketingForm, type MarketingListState } from './view';

/**
 * HQ Marketing & Creative (M1). Leaving the tab or a session end hides every campaign, drops the open form and any kept
 * command; "Show again" reads fresh. Every command answer is followed by a fresh read. The server decides who may read or write.
 */
export function HqMarketing({ api = marketingApi }: { api?: MarketingApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<MarketingListState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<HqMarketingListFilter | null>('OPEN');
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState<MarketingForm>(null);
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const dropRef = useRef<() => void>(() => {});
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setForm(null); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: MarketingOutcome) => {
    if (outcome?.kind === 'DONE' || outcome?.kind === 'DENIED' || outcome?.kind === 'CHANGED' || outcome?.kind === 'GONE') setForm(null);
    setRefresh(n => n + 1);
  }, []);
  const command = useMarketingCommand(privacy, after);
  dropRef.current = command.drop;
  const ownsRead = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;
  const denied = useCallback(() => { generation.current++; dropRef.current(); setForm(null); setState({ state: 'DENIED' }); }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = ownsRead(current, privacy.current);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list({ status: filter, cursor: null }, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view, campaigns: view.campaigns, loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        if (error instanceof MarketingError && error.kind === 'DENIED') denied(); else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filter, refresh, concealed, denied]);

  const onMore = useCallback(() => {
    if (state.state !== 'READY' || !state.view.nextCursor || state.loadingMore) return;
    const owned = ownsRead(generation.current, privacy.current), cursor = state.view.nextCursor;
    setState({ ...state, loadingMore: true, moreFailed: false });
    api.list({ status: filter, cursor }, AbortSignal.timeout(15000), owned).then(
      view => { if (owned()) setState(prior => prior.state !== 'READY' ? prior : { state: 'READY', view,
        campaigns: [...prior.campaigns, ...view.campaigns.filter(c => !prior.campaigns.some(p => p.campaignId === c.campaignId))], loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned()) return;
        if (error instanceof MarketingError && error.kind === 'DENIED') denied();
        else setState(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filter, state, denied]);

  const { start, local, setOutcome } = command;
  const onCreate = useCallback((draft: PlanDraft) => {
    const input = createInputFrom(draft);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.create(input, key, signal, owned));
  }, [api, start, local]);
  const onUpdate = useCallback((campaign: HqMarketingCampaign, draft: PlanDraft) => {
    const input = updateInputFrom(draft, campaign.version);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.update(campaign.campaignId, input, key, signal, owned));
  }, [api, start, local]);
  const onStatus = useCallback((campaign: HqMarketingCampaign, status: HqMarketingTargetStatus) => {
    start((key, signal, owned) => api.status(campaign.campaignId, { expectedVersion: campaign.version, status }, key, signal, owned));
  }, [api, start]);
  const onForm = useCallback((next: MarketingForm) => { if (!command.locked) { setForm(next); setOutcome(null); } }, [command.locked, setOutcome]);
  const onFilter = useCallback((next: HqMarketingListFilter | null) => { setFilter(next); setState({ state: 'LOADING' }); setOutcome(null); }, [setOutcome]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);

  return <HqMarketingView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    form={form} outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} onFilter={onFilter} onMore={onMore} onRefresh={onRefresh}
    onReveal={reveal} onForm={onForm} onCreate={onCreate} onUpdate={onUpdate} onStatus={onStatus} onTryAgain={command.tryAgain}/>;
}
