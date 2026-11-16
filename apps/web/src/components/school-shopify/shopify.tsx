'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ShopifyError, shopifyApi, type ShopifyApi } from './http';
import { ShopifyReturnView, ShopifyView, type OverviewState, type ReturnState, type ShopifyOutcome, type ShopifyTab, type TabState } from './view';

const kindOf = (error: unknown) => error instanceof ShopifyError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN';

/**
 * The school's Shopify store (0405): connect, sync, disconnect, and the read-only mirror of products, stock, costs and
 * orders. Blur, a hidden tab, a school change or a session end hide the page at once and retire every read. Commands are
 * never replayed automatically: a sync or disconnect whose answer was lost is checked again with a fresh read.
 */
export function SchoolShopify({ api = shopifyApi, navigate = (url: string) => window.location.assign(url) }: { api?: ShopifyApi; navigate?: (url: string) => void }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const [overview, setOverview] = useState<OverviewState>({ state: 'LOADING' });
  const [tab, setTab] = useState<ShopifyTab>('catalog');
  const [list, setList] = useState<TabState>({ state: 'LOADING' });
  const [shop, setShop] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ShopifyOutcome>(null);
  const [locked, setLocked] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++;
    setOutcome(null); setConfirming(false); setOverview({ state: 'LOADING' }); setList({ state: 'LOADING' });
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
  useEffect(() => {
    if (!schoolId || !hasConnection) return;
    const shown = privacy.current;
    setList({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    const read: Promise<TabState> = tab === 'catalog'
      ? api.catalog(schoolId, signal, owned).then((catalog) => ({ state: 'CATALOG', catalog }))
      : api.orders(schoolId, signal, owned).then((orders) => ({ state: 'ORDERS', orders }));
    read.then((next) => { if (owned()) setList(next); }, () => { if (owned()) setList({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, hasConnection, tab, refresh]);

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

  const onConnect = useCallback(async () => {
    if (sending.current || !schoolId) return;
    sending.current = true; const shown = privacy.current;
    setLocked(true); setOutcome({ kind: 'SENDING', action: 'connect' });
    try {
      // A new attempt each time: a lost answer only leaves an unused approval that expires in 10 minutes.
      const r = await api.connect(schoolId, shop.trim(), AbortSignal.timeout(30000), () => mounted.current && shown === privacy.current);
      sending.current = false;
      if (shown === privacy.current && mounted.current) navigate(r.authorizeUrl);
    } catch (error) {
      sending.current = false; setLocked(false);
      if (shown === privacy.current && mounted.current) setOutcome({ kind: kindOf(error), action: 'connect' });
    }
  }, [api, navigate, schoolId, shop]);

  return <div key={shell.phase} data-shell-private="">
    <ShopifyView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} overview={overview} tab={tab} list={list} shop={shop} confirming={confirming}
      outcome={outcome} locked={locked}
      onRefresh={() => { setOutcome(null); setRefresh((n) => n + 1); }} onShop={(v) => { if (!locked) { setShop(v); setOutcome(null); } }}
      onConnect={() => { void onConnect(); }} onSync={() => { void run('sync'); }} onConfirm={(open) => { if (!locked) { setConfirming(open); setOutcome(null); } }}
      onDisconnect={() => { void run('disconnect'); }} onTab={(next) => setTab(next)} />
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
