'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ShopifyError, shopifyApi, type Owned, type ShopifyApi } from './http';
import { brandingApi, type BrandingApi } from '../school-branding/http';
import { merchAiApi, type MerchAiApi } from './merch-ai-http';
import { reviewApi, type ReviewApi } from './review-http';
import type { BrandState } from './studio';
import type { ShopifyCatalog, ShopifyChangeResult, ShopifyFinanceView, ShopifyOrders, ShopifyProductChange, ShopifyProductChanges } from '@hon/contracts';
import type { ProposeRequest } from './editor';
import type { StorefrontCommand, StorefrontOutcome, StorefrontState } from './storefront';
import { SHOPIFY_SECTIONS, ShopifyReturnView, ShopifyView, type ListState, type OverviewState, type ReturnState, type ShopifyAction, type ShopifyOutcome, type ShopifySection } from './view';

const kindOf = (error: unknown) => error instanceof ShopifyError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN';

/**
 * The school's Shopify store (0405): connect, sync, disconnect, and the read-only mirror of products, stock, costs and
 * orders. Blur, a hidden tab, a school change or a session end hide the page at once and retire every read. Commands are
 * never replayed automatically: a sync or disconnect whose answer was lost is checked again with a fresh read.
 */
export function SchoolShopify({ api = shopifyApi, branding = brandingApi, merchAi = merchAiApi, review = reviewApi, navigate = (url: string) => window.location.assign(url) }: { api?: ShopifyApi; branding?: BrandingApi; merchAi?: MerchAiApi; review?: ReviewApi; navigate?: (url: string) => void }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const organizationId = shell.phase === 'READY' ? shell.selection?.organizationId ?? null : null;
  const [brand, setBrand] = useState<BrandState>({ state: 'LOADING' });
  const marcus = useMemo(() => schoolId && organizationId ? { api: merchAi, scope: { organizationId, schoolId } } : undefined, [merchAi, organizationId, schoolId]);
  const reviewer = useMemo(() => schoolId && organizationId ? { api: review, scope: { organizationId, schoolId } } : undefined, [review, organizationId, schoolId]);
  const [overview, setOverview] = useState<OverviewState>({ state: 'LOADING' });
  const [section, setSection] = useState<ShopifySection>('overview');
  const [catalog, setCatalog] = useState<ListState<ShopifyCatalog>>({ state: 'LOADING' });
  const [orders, setOrders] = useState<ListState<ShopifyOrders>>({ state: 'LOADING' });
  const [changes, setChanges] = useState<ListState<ShopifyProductChanges>>({ state: 'LOADING' });
  const [changesTick, setChangesTick] = useState(0);
  const [finance, setFinance] = useState<ListState<ShopifyFinanceView>>({ state: 'LOADING' });
  const [storefront, setStorefront] = useState<StorefrontState>({ state: 'LOADING' });
  const [storefrontOutcome, setStorefrontOutcome] = useState<StorefrontOutcome>(null);
  const [shop, setShop] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ShopifyOutcome>(null);
  const [locked, setLocked] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);
  // The open section lives in the address (#products …) so a refresh or a shared link opens the same place. Only known names.
  useEffect(() => {
    const read = () => { const h = window.location.hash.replace(/^#/, ''); setSection((SHOPIFY_SECTIONS as readonly string[]).includes(h) ? h as ShopifySection : 'overview'); };
    read(); window.addEventListener('hashchange', read); return () => window.removeEventListener('hashchange', read);
  }, []);
  const go = useCallback((next: ShopifySection) => {
    setSection(next);
    try { window.history.replaceState(null, '', next === 'overview' ? window.location.pathname : `#${next}`); } catch { /* the section still changes */ }
  }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++;
    setOutcome(null); setConfirming(false); setOverview({ state: 'LOADING' }); setCatalog({ state: 'LOADING' }); setOrders({ state: 'LOADING' }); setChanges({ state: 'LOADING' }); setFinance({ state: 'LOADING' }); setStorefront({ state: 'LOADING' }); setStorefrontOutcome(null); setBrand({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setOverview({ state: 'LOADING' });
    if (!schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.overview(schoolId, signal, owned).then(
      (read) => { if (!owned()) return; setOverview({ state: 'READY', read }); if (read.connection) setShop((s) => s || read.connection!.shopDomain); },
      (error) => { if (owned() && !abort.signal.aborted) setOverview({ state: error instanceof ShopifyError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, refresh]);

  const hasConnection = overview.state === 'READY' && overview.read.connection !== null;
  // Merch Studio shows the school's saved logo and brand color when this person may read them. A refusal shows nothing.
  useEffect(() => {
    if (!schoolId || !organizationId || !hasConnection) return;
    const shown = privacy.current;
    setBrand({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    branding.read({ organizationId, schoolId }, signal, owned).then(
      (b) => { if (owned()) setBrand({ state: 'READY', logoUrl: b.logoUrl, accentColor: b.accentColor }); },
      () => { if (owned()) setBrand({ state: 'NONE' }); });
    return () => { abort.abort(); };
  }, [branding, schoolId, organizationId, hasConnection]);
  // Products and orders are read together once a store is linked: the Overview needs both, and each section then opens at once.
  useEffect(() => {
    if (!schoolId || !hasConnection) return;
    const shown = privacy.current;
    setCatalog({ state: 'LOADING' }); setOrders({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    api.catalog(schoolId, signal, owned).then((value) => { if (owned()) setCatalog({ state: 'READY', value }); }, () => { if (owned()) setCatalog({ state: 'UNAVAILABLE' }); });
    api.orders(schoolId, signal, owned).then((value) => { if (owned()) setOrders({ state: 'READY', value }); }, () => { if (owned()) setOrders({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, hasConnection, refresh]);
  // SH4a: the edits waiting for approval and whether the store lets HON send them. Re-read after each edit command.
  useEffect(() => {
    if (!schoolId || !hasConnection) return;
    const shown = privacy.current;
    setChanges((c) => c.state === 'READY' ? c : { state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    api.changes(schoolId, signal, owned).then((value) => { if (owned()) setChanges({ state: 'READY', value }); }, () => { if (owned()) setChanges({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, hasConnection, refresh, changesTick]);

  // SH-F1: the Shopify Payments snapshot, read only for managers (others are refused by the server and never ask).
  const canManage = overview.state === 'READY' && overview.read.canManage;
  useEffect(() => {
    if (!schoolId || !hasConnection || !canManage) return;
    const shown = privacy.current;
    setFinance((f) => f.state === 'READY' ? f : { state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    api.finance(schoolId, signal, owned).then((value) => { if (owned()) setFinance({ state: 'READY', value }); }, () => { if (owned()) setFinance({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, hasConnection, canManage, refresh]);

  // TB2: the storefront settings and theme editor links, read only for managers.
  useEffect(() => {
    if (!schoolId || !hasConnection || !canManage) return;
    const shown = privacy.current;
    setStorefront((f) => f.state === 'READY' ? f : { state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    api.storefront(schoolId, signal, owned).then((value) => { if (owned()) setStorefront({ state: 'READY', value }); }, () => { if (owned()) setStorefront({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, hasConnection, canManage, refresh]);
  /** One storefront command at a time, never replayed. Each answer carries the storefront as read after the command. */
  const onStorefrontCommand = useCallback(async (command: StorefrontCommand) => {
    if (sending.current || !schoolId || storefront.state !== 'READY') return;
    const current = storefront.value;
    sending.current = true; const shown = privacy.current;
    setLocked(true); setOutcome(null); setStorefrontOutcome({ kind: 'SENDING', command });
    let next: StorefrontOutcome, value: typeof current | null = null;
    const owned = () => mounted.current && shown === privacy.current;
    try {
      if (command.kind === 'SAVE') {
        value = await api.saveStorefront(schoolId, current.settingsVersion, command.settings, AbortSignal.timeout(20000), owned);
        next = { kind: 'SAVED', command };
      } else {
        if (current.settingsVersion === null) throw new Error('unsaved');
        const result = await api.publishStorefront(schoolId, current.settingsVersion, AbortSignal.timeout(60000), owned);
        value = result.storefront; next = { kind: 'PUBLISHED', command, result };
      }
    } catch (error) { next = { kind: 'ERROR', command, error: kindOf(error) }; }
    finally { sending.current = false; }
    setLocked(false);
    if (shown !== privacy.current || !mounted.current) return;
    if (value) setStorefront({ state: 'READY', value });
    setStorefrontOutcome(next);
  }, [api, schoolId, storefront]);

  /**
   * One edit command at a time, never replayed. An approval re-reads everything (Shopify and the mirror changed);
   * a new edit or a cancel re-reads only the change list. A lost approval answer shows as "not sure" with Check again.
   */
  const change = useCallback(async (action: Extract<ShopifyAction, 'propose' | 'approve' | 'cancelChange'>, send: (owned: Owned) => Promise<ShopifyChangeResult>, target?: string): Promise<boolean> => {
    if (sending.current || !schoolId) return false;
    sending.current = true; const shown = privacy.current;
    setLocked(true); setOutcome({ kind: 'SENDING', action, ...(target ? { target } : {}) });
    let next: ShopifyOutcome;
    try { const r = await send(() => mounted.current && shown === privacy.current); next = { kind: 'DONE', action, change: r.change, ...(target ? { target } : {}) }; }
    catch (error) { next = { kind: kindOf(error), action, ...(target ? { target } : {}) }; }
    finally { sending.current = false; }
    setLocked(false);
    if (shown !== privacy.current || !mounted.current) return false;
    setOutcome(next);
    if (action === 'approve') setRefresh((n) => n + 1); else setChangesTick((n) => n + 1);
    if (action === 'propose' && next?.kind === 'DONE') go('changes');
    return next?.kind === 'DONE';
  }, [schoolId, go]);
  /** Resolves true only when the server confirmed the proposal (PENDING). */
  const onPropose = (r: ProposeRequest): Promise<boolean> => schoolId ? change('propose', (owned) => api.propose(schoolId, r, AbortSignal.timeout(30000), owned)) : Promise.resolve(false);
  const onApprove = (c: ShopifyProductChange) => { if (schoolId) void change('approve', (owned) => api.approveChange(schoolId, c.changeId, c.version, AbortSignal.timeout(150000), owned), c.changeId); };
  const onCancelChange = (c: ShopifyProductChange) => { if (schoolId) void change('cancelChange', (owned) => api.cancelChange(schoolId, c.changeId, c.version, AbortSignal.timeout(30000), owned), c.changeId); };

  const run = useCallback(async (action: 'sync' | 'disconnect') => {
    if (sending.current || !schoolId || overview.state !== 'READY' || !overview.read.connection) return;
    const c = overview.read.connection;
    sending.current = true; const shown = privacy.current;
    setLocked(true); setOutcome({ kind: 'SENDING', action });
    let next: ShopifyOutcome;
    try {
      const owned = () => mounted.current && shown === privacy.current;
      next = action === 'sync'
        ? { kind: 'DONE', action, sync: await api.sync(schoolId, AbortSignal.timeout(180000), owned) }
        : (await api.disconnect(schoolId, c.connectionId, c.version, AbortSignal.timeout(30000), owned), { kind: 'DONE', action });
    } catch (error) { next = { kind: kindOf(error), action }; }
    finally { sending.current = false; }
    setLocked(false);
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); setConfirming(false); setRefresh((n) => n + 1);
  }, [api, schoolId, overview]);

  const onConnect = useCallback(async (action: 'connect' | 'allowEditing' | 'allowFinance' | 'allowOrders' = 'connect') => {
    if (sending.current || !schoolId) return;
    // Allow editing / Allow finance reconnect the same store, asking Shopify for those permissions as well. Reconnecting
    // the same store keeps what it already allows (Shopify replaces the whole grant on each approval).
    const current = overview.state === 'READY' ? overview.read.connection?.shopDomain ?? '' : '';
    const domain = action === 'connect' ? shop.trim() : current;
    const same = !!current && (action !== 'connect' || shop.trim().toLowerCase().replace(/\.myshopify\.com$/, '') === current.replace(/\.myshopify\.com$/, ''));
    // Allow orders (0614) is for selling made-to-order items at the front desk, which also needs editing, so it asks for both.
    const allowOrders = action === 'allowOrders' || (same && overview.state === 'READY' && overview.read.connection?.ordersAllowed === true);
    const allowEditing = action === 'allowEditing' || action === 'allowOrders' || (same && changes.state === 'READY' && changes.value.editProducts);
    const allowFinance = action === 'allowFinance' || (same && finance.state === 'READY' && finance.value.financeAllowed);
    sending.current = true; const shown = privacy.current;
    setLocked(true); setOutcome({ kind: 'SENDING', action });
    try {
      // A new attempt each time: a lost answer only leaves an unused approval that expires in 10 minutes.
      const r = await api.connect(schoolId, domain, AbortSignal.timeout(30000), () => mounted.current && shown === privacy.current, allowEditing, allowFinance, allowOrders);
      sending.current = false;
      if (shown === privacy.current && mounted.current) navigate(r.authorizeUrl);
    } catch (error) {
      sending.current = false; setLocked(false);
      if (shown === privacy.current && mounted.current) setOutcome({ kind: kindOf(error), action });
    }
  }, [api, navigate, schoolId, shop, overview, changes, finance]);

  return <div key={shell.phase} data-shell-private="">
    <ShopifyView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} overview={overview} section={section} catalog={catalog} orders={orders} shop={shop} confirming={confirming}
      outcome={outcome} locked={locked}
      onRefresh={() => { setOutcome(null); setRefresh((n) => n + 1); }} onShop={(v) => { if (!locked) { setShop(v); setOutcome(null); } }}
      onConnect={() => { void onConnect(); }} onSync={() => { void run('sync'); }} onConfirm={(open) => { if (!locked) { setConfirming(open); setOutcome(null); } }}
      onDisconnect={() => { void run('disconnect'); }} onSection={go}
      changes={changes} onPropose={onPropose} onApprove={onApprove} onCancelChange={onCancelChange} onAllowEditing={() => { void onConnect('allowEditing'); }}
      finance={finance} onAllowFinance={() => { void onConnect('allowFinance'); }} onAllowOrders={() => { void onConnect('allowOrders'); }}
      storefront={storefront} storefrontOutcome={storefrontOutcome} onStorefrontCommand={(c) => { void onStorefrontCommand(c); }}
      schoolName={shell.schoolName} brand={brand} merchAi={marcus} review={reviewer} />
  </div>;
}

/** Only what Shopify sends back: the signed query, read once and removed from the address at once. */
const QUERY = /^[A-Za-z0-9_\-.~%=&+]{1,4096}$/;
/**
 * The page Shopify returns to after the owner approves. The whole signed query goes to the server, which checks
 * Shopify's signature and the single-use state before using any value in it. Sent exactly once.
 */
export function SchoolShopifyReturn({ api = shopifyApi }: { api?: ShopifyApi }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const [state, setState] = useState<ReturnState>({ state: 'WORKING' });
  const captured = useRef<string | null | undefined>(undefined), sent = useRef(false);
  useEffect(() => {
    if (captured.current !== undefined) return;
    const value = window.location.search.replace(/^\?/, '');
    captured.current = QUERY.test(value) && /(^|&)hmac=/.test(value) && /(^|&)state=/.test(value) ? value : null;
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* the approval is single use anyway */ }
    if (!captured.current) setState({ state: 'MISSING' });
  }, []);
  useEffect(() => {
    if (sent.current || !schoolId || !captured.current) return;
    sent.current = true; const query = captured.current; captured.current = null;
    api.complete(schoolId, query, AbortSignal.timeout(180000), () => true).then(
      (result) => setState({ state: 'DONE', result }),
      (error) => setState({ state: 'FAILED', kind: kindOf(error) }));
  }, [api, schoolId]);
  return <div data-shell-private=""><ShopifyReturnView language={locale.preferences.language} state={state} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
    concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} /></div>;
}
