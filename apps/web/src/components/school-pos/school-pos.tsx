'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PosItem, PosMethod, PosRead, PosSale, PosSales, PosShipTo } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { peopleApi, type PersonSummary } from '../people/http';
import { PosError, keepPosForRetry, posApi, type PosApi, type PosCommand } from './http';
import { EMPTY_CART, refreshCart, saleInput, type Cart } from './model';
import { PosHistory, PosInventory, PosRegister, type Outcome, type StockSend } from './views';
import styles from './pos.module.css';

export type ReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: PosRead };
export type SalesState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; sales: PosSales };
type Tab = 'REGISTER' | 'HISTORY' | 'INVENTORY';
/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; command: PosCommand }>;

/**
 * Front-desk Point of Sale (0612), organized like the owner's current CRM: Register, History and Inventory on one page.
 * The database prices every sale; the register shows the same arithmetic and sends the total it showed, so staff never
 * take an amount they did not see. Card on the school's own terminal, cash, check and other are recorded only: HON moves
 * no money. Blur, a hidden tab, a school change or a session end hides the page; the last two also drop the cart.
 */
export function SchoolPos({ api = posApi, people = peopleApi }: { api?: PosApi; people?: Pick<typeof peopleApi, 'search'> }): React.ReactElement {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId?.toLowerCase() ?? null;
  const [tab, setTab] = useState<Tab>('REGISTER');
  const [read, setRead] = useState<ReadState>({ state: 'LOADING' });
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [receipt, setReceipt] = useState<PosSale | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const [refresh, setRefresh] = useState(0);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [sales, setSales] = useState<SalesState>({ state: 'IDLE' });
  const [selected, setSelected] = useState<PosSale | null>(null);
  const [found, setFound] = useState<readonly PersonSummary[] | null>(null);
  const searchTurn = useRef(0);
  const [stockSend, setStockSend] = useState<StockSend>('IDLE');
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false), lastSchool = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gen.current++; privacy.current++; pending.current = null; }; }, []);

  const forget = useCallback(() => { setCart(EMPTY_CART); setReceipt(null); setSelected(null); setFound(null); setOutcome(null); setRange(null); setSales({ state: 'IDLE' }); setStockSend('IDLE'); }, []);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++;
    setOutcome(null); setRead({ state: 'LOADING' });
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) { pending.current = null; setBusy(sending.current ? 'SENDING' : 'NONE'); forget(); }
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);
  useEffect(() => {
    if (schoolId !== null && lastSchool.current !== null && schoolId !== lastSchool.current) { pending.current = null; setBusy('NONE'); forget(); }
    if (schoolId !== null) lastSchool.current = schoolId;
  }, [schoolId, forget]);

  // Register read: catalog, settings, today's total.
  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(schoolId, signal, owned).then(
      (r) => { if (!owned()) return; setRead({ state: 'READY', read: r }); setCart(c => refreshCart(c, r.items, r.shopify.items)); setRange(x => x ?? { from: r.today, to: r.today }); },
      (e) => { if (owned() && !abort.signal.aborted) setRead({ state: e instanceof PosError && e.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, schoolId, refresh]);

  // History for the chosen days.
  useEffect(() => {
    if (tab !== 'HISTORY' || !schoolId || !range) return;
    const shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    setSales({ state: 'LOADING' });
    api.sales(schoolId, range.from, range.to, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(
      (s) => { if (owned()) setSales({ state: 'READY', sales: s }); },
      (e) => { if (owned()) setSales({ state: e instanceof PosError && e.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, tab, schoolId, range, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setBusy('SENDING'); setOutcome({ kind: 'SENDING', op: request.command.op });
    let next: Outcome = null, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const result = await api.command(request.command, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', op: request.command.op };
      if (mounted.current && 'sale' in result) {
        if (request.command.op === 'sale') { setReceipt(result.sale); setCart(EMPTY_CART); } else setSelected(result.sale);
      }
    } catch (error) {
      keep = keepPosForRetry(error);
      next = error instanceof PosError ? { kind: error.kind, op: request.command.op, detail: error.detail } : { kind: 'UNKNOWN', op: request.command.op };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setBusy(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (!keep) setRefresh(n => n + 1);
  }, [api]);

  const run = useCallback((command: PosCommand) => {
    if (pending.current || sending.current) return;
    pending.current = { key: globalThis.crypto.randomUUID(), command };
    void send();
  }, [send]);
  const onClearFound = useCallback(() => { searchTurn.current += 1; setFound(null); }, []);
  const onSearchPeople = useCallback((query: string) => {
    if (!orgId || !schoolId) return;
    // Search as you type: only the answer to the latest letters is shown.
    const shown = privacy.current, turn = ++searchTurn.current, current = () => mounted.current && shown === privacy.current && turn === searchTurn.current;
    people.search({ organizationId: orgId, schoolId }, query, AbortSignal.timeout(15000)).then(
      (list) => { if (current()) setFound(list.slice(0, 8)); },
      () => { if (current()) setFound([]); });
  }, [people, orgId, schoolId]);
  const onOpenSale = useCallback((saleId: string) => {
    if (!schoolId) return;
    const shown = privacy.current;
    api.sale(schoolId, saleId, AbortSignal.timeout(15000), () => mounted.current && shown === privacy.current).then(
      (s) => { if (mounted.current && shown === privacy.current) setSelected(s); }, () => { if (mounted.current) setSelected(null); });
  }, [api, schoolId]);
  // 0613/0614: a manager sends the Shopify stock changes and made-to-order orders that did not go through again. Not a sale: nothing is kept for retry.
  const onResendStock = useCallback(() => {
    if (!schoolId || stockSend === 'SENDING') return;
    const shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    setStockSend('SENDING');
    api.resendShopifyStock(schoolId, AbortSignal.timeout(60000), owned).then(
      (r) => { if (!owned()) return; setRead({ state: 'READY', read: r }); setCart(c => refreshCart(c, r.items, r.shopify.items)); setStockSend(r.shopify.unsent.waiting + r.shopify.unsent.failed + r.shopify.madeToOrder.unsent.waiting + r.shopify.madeToOrder.unsent.failed === 0 ? 'DONE' : 'LEFT'); },
      (e) => { if (owned()) setStockSend(e instanceof PosError && e.kind === 'DENIED' ? 'DENIED' : 'FAILED'); });
  }, [api, schoolId, stockSend]);
  const onTab = (t: Tab) => { if (busy !== 'SENDING') { setTab(t); setOutcome(null); } };

  const ready = read.state === 'READY' ? read.read : null;
  const locked = busy !== 'NONE';
  const body = (() => {
    if (shell.phase === 'CONCEALED') return <p className={styles.notice}>Hidden while you were away. Come back to this tab to continue.</p>;
    if (!schoolId) return <p className={styles.notice}>{shell.phase === 'IDLE' || shell.phase === 'LOADING' ? 'Loading…' : 'Choose a school first.'}</p>;
    if (read.state === 'LOADING' && !ready) return <p className={styles.notice}>Loading the register…</p>;
    if (read.state === 'DENIED') return <p className={styles.notice}>Your access does not include the Point of Sale at this school. The school owner can add it in Staff roles.</p>;
    if (!ready) return <p className={styles.notice}>The register could not be loaded. <button type="button" className={styles.link} onClick={() => setRefresh(n => n + 1)}>Try again</button></p>;
    if (tab === 'HISTORY') return <PosHistory read={ready} range={range} sales={sales} selected={selected} outcome={outcome} locked={locked} canRetry={busy === 'KEPT'}
      onRange={setRange} onOpen={onOpenSale} onClose={() => setSelected(null)} onRun={run} onTryAgain={() => void send()}/>;
    if (tab === 'INVENTORY') return <PosInventory read={ready} outcome={outcome} locked={locked} canRetry={busy === 'KEPT'} onRun={run} onTryAgain={() => void send()}/>;
    return <PosRegister read={ready} cart={cart} receipt={receipt} outcome={outcome} locked={locked} canRetry={busy === 'KEPT'} found={found}
      onCart={setCart} onSearchPeople={onSearchPeople} onClearFound={onClearFound} onNewSale={() => { setReceipt(null); setOutcome(null); }} stockSend={stockSend} onResendStock={onResendStock}
      onPay={(method: PosMethod, reference: string, note: string, shipTo: PosShipTo | null) => run({ op: 'sale', input: payInput(ready, cart, method, reference, note, shipTo) })}
      onTryAgain={() => void send()}/>;
  })();
  const lowCount = ready ? ready.items.filter((i: PosItem) => i.active && i.lowStock).length : 0;
  return <div key={shell.phase} data-shell-private="" className={styles.pos}>
    <nav className={styles.tabs} aria-label="Point of Sale">
      {(['REGISTER', 'HISTORY', 'INVENTORY'] as const).map(t => <button key={t} type="button" className={styles.tab} aria-current={tab === t ? 'page' : undefined} onClick={() => onTab(t)}>
        {t === 'REGISTER' ? 'Register' : t === 'HISTORY' ? 'History' : 'Inventory'}{t === 'INVENTORY' && lowCount > 0 ? <span className={styles.badge} aria-label={`${lowCount} low on stock`}>{lowCount}</span> : null}
      </button>)}
    </nav>
    {body}
  </div>;
}

function payInput(read: PosRead, cart: Cart, method: PosMethod, reference: string, note: string, shipTo: PosShipTo | null) {
  return saleInput(read.schoolId, cart, read.settings.taxRateBps, method, reference, note, shipTo);
}
