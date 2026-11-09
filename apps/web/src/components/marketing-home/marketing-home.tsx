'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MarketingError, marketingApi, type MarketingApi } from './http';
import { MarketingView, type CampaignListState, type CampaignTab, type FunnelState } from './view';

/**
 * Marketing home (U7): the school's campaign plans by status and one campaign's last-30-day recorded lead counts, with
 * links into the existing planner, Marcus, forms and intake. Read-only. Blur, a hidden tab, page hide, a school change or
 * a session end hide the page at once and retire every read; reads start again only after the shell re-verifies the school.
 */
export function MarketingHome({ api = marketingApi }: { api?: MarketingApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [tab, setTab] = useState<CampaignTab>('ACTIVE');
  const [list, setList] = useState<CampaignListState>({ state: 'LOADING' });
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<FunnelState>({ state: 'NONE' });
  const [funnelRefresh, setFunnelRefresh] = useState(0);
  const listGeneration = useRef(0), funnelGeneration = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; listGeneration.current++; funnelGeneration.current++; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); listGeneration.current++; funnelGeneration.current++; privacy.current++;
    setList({ state: 'LOADING' }); setFunnel({ state: 'NONE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = selection ? selection.schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelectedId(null); setTab('ACTIVE'); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++listGeneration.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!selection) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === listGeneration.current && shown === privacy.current;
    api.campaigns(selection.schoolId, signal, owned).then(
      (items) => { if (owned()) { setList({ state: 'READY', items }); setSelectedId((now) => now && items.some((c) => c.id === now) ? now : null); } },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof MarketingError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, listRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = ++funnelGeneration.current, shown = privacy.current;
    if (!selectedId || !selection) { setFunnel({ state: 'NONE' }); return; }
    setFunnel({ state: 'LOADING' });
    const abort = new AbortController(), campaignId = selectedId, signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === funnelGeneration.current && shown === privacy.current;
    api.funnel(selection.schoolId, campaignId, signal, owned).then(
      (value) => { if (owned()) setFunnel({ state: 'READY', campaignId, funnel: value }); },
      (error) => { if (owned() && !abort.signal.aborted) setFunnel({ state: error instanceof MarketingError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, selectedId, funnelRefresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTab = useCallback((next: CampaignTab) => setTab(next), []);
  const onOpen = useCallback((id: string) => { setSelectedId(id); setFunnelRefresh((n) => n + 1); }, []);
  const onRefresh = useCallback(() => { setListRefresh((n) => n + 1); setFunnelRefresh((n) => n + 1); }, []);
  const onReloadFunnel = useCallback(() => setFunnelRefresh((n) => n + 1), []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <MarketingView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} tab={tab} list={list} selectedId={selectedId} funnel={funnel}
      onTab={onTab} onOpen={onOpen} onRefresh={onRefresh} onReloadFunnel={onReloadFunnel}/>
  </div>;
}
