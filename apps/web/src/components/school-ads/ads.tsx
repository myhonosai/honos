'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SocialAd } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SocialError, socialApi, type SocialApi } from '../school-social/http';
import { AdsError, adsApi, keepAdsForRetry, toCents, type AdsApi, type AdsScope } from './http';
import { boostableFrom, type AdsAction, type AdsActionOutcome, type AdsReadState, type BudgetForm, type DraftForm } from './meta-ads';
import { AdsView, metaAdsState, type AdsListState, type AdsOutcome } from './view';

/** One ads write whose outcome is not known yet: the exact request and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; action: AdsAction; scope: AdsScope; send: (api: AdsApi, key: string, signal: AbortSignal, owned: () => boolean) => Promise<unknown> }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const systemNow = () => new Date();
const EMPTY_DRAFT: DraftForm = { targetId: '', amount: '', startsOn: '', endsOn: '' };

/**
 * Marketing > Ads. Reads the school's social connections (0347) and, once a Facebook Page is connected, its Meta ads
 * (0437) and published posts. Every write is one human command with its own key; the server decides permission, the
 * monthly limit and whether ads are on. Blur, a school change or a session end hide the page, retire every read and
 * drop forms and any kept request.
 */
export function SchoolAds({ api = socialApi, ads = adsApi, navigate = (url: string) => window.location.assign(url), now = systemNow }:
  { api?: SocialApi; ads?: AdsApi; navigate?: (url: string) => void; now?: () => Date }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<AdsListState>({ state: 'LOADING' });
  const [adsRead, setAdsRead] = useState<AdsReadState>({ state: 'LOADING' });
  const [connecting, setConnecting] = useState(false);
  const [outcome, setOutcome] = useState<AdsOutcome>(null);
  const [actionOutcome, setActionOutcome] = useState<AdsActionOutcome>(null);
  const [budgetForm, setBudgetForm] = useState<BudgetForm>({ amount: '', currency: '' });
  const [draftForm, setDraftForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setActionOutcome(null); setConfirming(null);
    setBudgetForm({ amount: '', currency: '' }); setDraftForm(EMPTY_DRAFT); setList({ state: 'LOADING' }); setAdsRead({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' }); setAdsRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const scope = { organizationId: orgId, schoolId };
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list(scope, signal, owned).then(
      (read) => {
        if (!owned()) return;
        setList({ state: 'READY', list: read });
        if (metaAdsState(read) === 'NOT_CONNECTED') return;
        Promise.all([ads.read(scope, signal, owned), ads.posts(scope, now(), signal, owned)]).then(
          ([view, posts]) => {
            if (!owned()) return;
            setAdsRead({ state: 'READY', view, boostable: boostableFrom(posts) });
            setBudgetForm((f) => f.amount || f.currency ? f : { amount: view.budget && view.budget.monthlyCapCents > 0 ? (view.budget.monthlyCapCents / 100).toFixed(2) : '', currency: view.budget?.currency ?? '' });
            setDraftForm((f) => f.startsOn ? f : { ...f, startsOn: view.today, endsOn: view.today });
          },
          (error) => { if (owned() && !abort.signal.aborted) setAdsRead({ state: error instanceof AdsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
      },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof SocialError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, ads, now, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setActionOutcome({ kind: 'SENDING', action: request.action });
    let next: AdsActionOutcome, keep = false;
    try {
      await request.send(ads, request.key, AbortSignal.timeout(60000), () => mounted.current && shown === privacy.current && pending.current?.key === request.key);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepAdsForRetry(error) || !(error instanceof AdsError);
      next = { kind: error instanceof AdsError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setActionOutcome(next); setConfirming(null);
    if (next?.kind === 'DONE' && request.action === 'draft') setDraftForm((f) => ({ ...EMPTY_DRAFT, startsOn: f.startsOn, endsOn: f.startsOn }));
    setRefresh((n) => n + 1);
  }, [ads]);

  const start = useCallback((action: AdsAction, run: Pending['send']) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, send: run };
    void send();
  }, [lock, orgId, schoolId, send]);

  const scope = (): AdsScope | null => orgId && schoolId ? { organizationId: orgId, schoolId } : null;
  const invalid = (action: AdsAction) => { setActionOutcome({ kind: 'INVALID', action }); };

  const onSaveBudget = () => {
    const s = scope(), cents = toCents(budgetForm.amount), currency = budgetForm.currency.trim().toUpperCase();
    if (!s || cents === null || !/^[A-Z]{3}$/.test(currency) || adsRead.state !== 'READY') return invalid('budget');
    const version = adsRead.view.budget?.version;
    start('budget', (a, key, signal, owned) => a.budget(s, { monthlyCapCents: cents, currency, ...(version ? { expectedVersion: version } : {}) }, key, signal, owned));
  };
  const onSaveDraft = () => {
    const s = scope(), cents = toCents(draftForm.amount);
    if (!s || cents === null || !draftForm.targetId || !draftForm.startsOn || !draftForm.endsOn) return invalid('draft');
    const input = { targetId: draftForm.targetId, budgetCents: cents, startsOn: draftForm.startsOn, endsOn: draftForm.endsOn };
    start('draft', (a, key, signal, owned) => a.draft(s, input, key, signal, owned));
  };
  const onOperation = (ad: SocialAd, operation: 'CREATE' | 'ACTIVATE' | 'PAUSE') => {
    const s = scope(); if (!s) return;
    start(operation, (a, key, signal, owned) => a.operation(s, ad.adId, { operation, expectedVersion: ad.version }, key, signal, owned));
  };
  const onCancel = (ad: SocialAd) => { const s = scope(); if (s) start('cancel', (a, key, signal, owned) => a.cancel(s, ad.adId, ad.version, key, signal, owned)); };
  const onResolve = (ad: SocialAd, state: 'NOT_CREATED' | 'ACTIVE' | 'PAUSED') => {
    const s = scope(); if (s) start('resolve', (a, key, signal, owned) => a.resolve(s, ad.adId, { state, expectedVersion: ad.version }, key, signal, owned));
  };

  const onConnectMeta = useCallback(async () => {
    if (sending.current || !orgId || !schoolId) return;
    sending.current = true; const shown = privacy.current;
    setConnecting(true); setOutcome(null);
    try {
      // A new attempt each time: a lost answer only leaves an unused link that expires by itself.
      const r = await api.connect({ organizationId: orgId, schoolId }, 'FACEBOOK', globalThis.crypto.randomUUID(), AbortSignal.timeout(30000),
        () => mounted.current && shown === privacy.current);
      if (shown === privacy.current && mounted.current) navigate(r.authUrl);
    } catch (error) {
      if (shown === privacy.current && mounted.current) {
        const kind = error instanceof SocialError ? error.kind : 'UNKNOWN';
        setOutcome(kind === 'DENIED' || kind === 'NOT_ENABLED' || kind === 'LIMIT' || kind === 'PROVIDER' || kind === 'INVALID' ? kind : 'UNKNOWN');
        setConnecting(false);
      }
    } finally { sending.current = false; }
  }, [api, navigate, orgId, schoolId]);

  return <div key={shell.phase} data-shell-private="">
    <AdsView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} connecting={connecting} outcome={outcome}
      onRefresh={() => setRefresh((n) => n + 1)} onConnectMeta={() => { void onConnectMeta(); }}
      run={{ ads: adsRead, budgetForm, draftForm, confirming, outcome: actionOutcome, locked: lock !== 'NONE', canRetry: lock === 'KEPT',
        onBudgetForm: (f) => { if (lock === 'NONE') setBudgetForm(f); }, onSaveBudget,
        onDraftForm: (f) => { if (lock === 'NONE') setDraftForm(f); }, onSaveDraft,
        onOperation, onCancel, onResolve, onConfirm: (id) => { if (lock === 'NONE') { setConfirming(id); setActionOutcome(null); } },
        onTryAgain: () => { void send(); } }} />
  </div>;
}
