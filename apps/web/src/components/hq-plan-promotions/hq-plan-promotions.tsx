'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqPlanPromotion, HqPlanPromotionListFilter, HqPlanPromotionReceipt, HqPlanPromotionTargetStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useConcealment, useMarketingCommand } from '../hq-marketing/model';
import { PromotionError, promotionsApi, type PromotionsApi } from './http';
import { createInputFrom, updateInputFrom, type PromotionDraft } from './model';
import { HqPlanPromotionsView, type PromotionForm, type PromotionListState, type PromotionOutcome, type PromotionPreviewState } from './view';

/**
 * HQ Plan promotions. Leaving the tab or a session end hides every promotion, drops the open form, the start check and any
 * kept command; "Show again" reads fresh. Start always echoes the digest of a preview read just now, so the database refuses
 * it if the wording, audience or offer changed since. Every command answer is followed by a fresh read. The server decides
 * who may read or write.
 */
export function HqPlanPromotions({ api = promotionsApi }: { api?: PromotionsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<PromotionListState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<HqPlanPromotionListFilter | null>('OPEN');
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState<PromotionForm>(null);
  const [preview, setPreview] = useState<PromotionPreviewState>(null);
  const generation = useRef(0), previewGeneration = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; previewGeneration.current++; }; }, []);
  const dropRef = useRef<() => void>(() => {});
  const clear = () => { generation.current++; previewGeneration.current++; dropRef.current(); setForm(null); setPreview(null); };
  const { concealed, privacy, reveal } = useConcealment(() => { clear(); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: PromotionOutcome) => {
    if (outcome?.kind === 'DONE' || outcome?.kind === 'DENIED' || outcome?.kind === 'CHANGED' || outcome?.kind === 'GONE') { setForm(null); }
    previewGeneration.current++; setPreview(null);
    setRefresh(n => n + 1);
  }, []);
  const command = useMarketingCommand<HqPlanPromotionReceipt>(privacy, after);
  dropRef.current = command.drop;
  const ownsRead = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const denied = useCallback(() => { clear(); setState({ state: 'DENIED' }); }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = ownsRead(current, privacy.current);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list({ status: filter, cursor: null }, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view, promotions: view.promotions, loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        if (error instanceof PromotionError && error.kind === 'DENIED') denied(); else setState({ state: 'UNAVAILABLE' });
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
        promotions: [...prior.promotions, ...view.promotions.filter(p => !prior.promotions.some(q => q.promotionId === p.promotionId))], loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned()) return;
        if (error instanceof PromotionError && error.kind === 'DENIED') denied();
        else setState(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filter, state, denied]);

  const onPreview = useCallback((promotion: HqPlanPromotion | null) => {
    const current = ++previewGeneration.current, shown = privacy.current;
    if (!promotion || command.locked) { setPreview(null); return; }
    const id = promotion.promotionId, owned = () => mounted.current && current === previewGeneration.current && shown === privacy.current;
    setForm(null); command.setOutcome(null); setPreview({ promotionId: id, state: 'LOADING' });
    api.read(id, AbortSignal.timeout(15000), owned).then(
      detail => {
        if (!owned()) return;
        // A promotion that is no longer a draft cannot be started from here; the fresh list shows what it is now.
        if (detail.promotion.status !== 'DRAFT') { setPreview(null); setRefresh(n => n + 1); return; }
        setPreview({ promotionId: id, state: 'READY', preview: detail.preview, version: detail.promotion.version });
      },
      error => {
        if (!owned()) return;
        if (error instanceof PromotionError && error.kind === 'DENIED') denied(); else setPreview({ promotionId: id, state: 'FAILED' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, command.locked, command.setOutcome, denied]);

  const { start, local, setOutcome } = command;
  const onCreate = useCallback((draft: PromotionDraft) => {
    const input = createInputFrom(draft);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.create(input, key, signal, owned));
  }, [api, start, local]);
  const onUpdate = useCallback((promotion: HqPlanPromotion, draft: PromotionDraft) => {
    const input = updateInputFrom(draft, promotion.version);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.update(promotion.promotionId, input, key, signal, owned));
  }, [api, start, local]);
  const onStart = useCallback((promotion: HqPlanPromotion) => {
    if (preview?.state !== 'READY' || preview.promotionId !== promotion.promotionId) return;
    const body = { expectedVersion: preview.version, status: 'ACTIVE' as const, previewDigest: preview.preview.digest };
    start((key, signal, owned) => api.status(promotion.promotionId, body, key, signal, owned));
  }, [api, start, preview]);
  const onStatus = useCallback((promotion: HqPlanPromotion, status: HqPlanPromotionTargetStatus) => {
    // Only a draft's first start needs a preview; resume, pause and end send none.
    if (promotion.status === 'DRAFT' && status === 'ACTIVE') return;
    previewGeneration.current++; setPreview(null);
    start((key, signal, owned) => api.status(promotion.promotionId, { expectedVersion: promotion.version, status, previewDigest: null }, key, signal, owned));
  }, [api, start]);
  const onForm = useCallback((next: PromotionForm) => {
    if (command.locked) return;
    previewGeneration.current++; setPreview(null); setForm(next); setOutcome(null);
  }, [command.locked, setOutcome]);
  const onFilter = useCallback((next: HqPlanPromotionListFilter | null) => {
    previewGeneration.current++; setPreview(null); setFilter(next); setState({ state: 'LOADING' }); setOutcome(null);
  }, [setOutcome]);
  const onRefresh = useCallback(() => { previewGeneration.current++; setPreview(null); setRefresh(n => n + 1); }, []);

  return <HqPlanPromotionsView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    form={form} preview={preview} outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} onFilter={onFilter} onMore={onMore}
    onRefresh={onRefresh} onReveal={reveal} onForm={onForm} onCreate={onCreate} onUpdate={onUpdate} onPreview={onPreview} onStart={onStart}
    onStatus={onStatus} onTryAgain={command.tryAgain}/>;
}
