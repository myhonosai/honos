'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AvailableSchoolNumber } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { NumberError, keepForRetry, numberApi, searchQuery, type NumberApi, type NumberScope, type SearchDraft } from './http';
import { EMPTY_SEARCH, NumberView, type NumberAction, type NumberOutcome, type OrdersState, type SearchState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; action: NumberAction; scope: NumberScope; phoneE164: string; orderId: string; version: number }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * The school's texting number (0352). A session end or a school change hides the page at once, retires every read and
 * drops the search, the pick and any kept command. Every command answer is followed by a fresh read of the orders.
 */
export function SchoolTextingNumber({ api = numberApi }: { api?: NumberApi }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [orders, setOrders] = useState<OrdersState>({ state: 'LOADING' });
  const [search, setSearch] = useState<SearchState>({ state: 'IDLE' });
  const [draft, setDraft] = useState<SearchDraft>(EMPTY_SEARCH);
  const [picked, setPicked] = useState<AvailableSchoolNumber | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [outcome, setOutcome] = useState<NumberOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), searchGen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; searchGen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; searchGen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setDraft(EMPTY_SEARCH); setPicked(null); setConfirmCancel(false);
    setSearch({ state: 'IDLE' }); setOrders({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setOrders({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.orders({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setOrders({ state: 'READY', orders: read }); },
      (error) => { if (owned() && !abort.signal.aborted) setOrders({ state: error instanceof NumberError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const onSearch = useCallback(() => {
    const query = searchQuery(draft);
    if (!query || !orgId || !schoolId || lock !== 'NONE') return;
    const current = ++searchGen.current, shown = privacy.current;
    const owned = () => mounted.current && current === searchGen.current && shown === privacy.current;
    setSearch({ state: 'SEARCHING' }); setPicked(null); setOutcome(null);
    api.search({ organizationId: orgId, schoolId }, query, AbortSignal.timeout(20000), owned).then(
      (r) => { if (!owned()) return; setSearch({ state: 'READY', numbers: r.numbers, hasOwnNumber: r.hasOwnNumber }); if (r.openOrder || r.hasOwnNumber) setRefresh((n) => n + 1); },
      (error) => {
        if (!owned()) return;
        const kind = error instanceof NumberError ? error.kind : 'UNKNOWN';
        setSearch({ state: kind === 'OFF' ? 'OFF' : kind === 'INVALID' ? 'INVALID' : 'FAILED' });
        if (kind === 'DENIED') setOrders({ state: 'DENIED' });
      });
  }, [api, draft, lock, orgId, schoolId]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: NumberOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      if (request.action === 'order') await api.order(request.scope, request.phoneE164, request.key, signal, owned);
      else await api.cancel(request.scope, request.orderId, request.version, request.key, signal, owned);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof NumberError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); setConfirmCancel(false);
    if (next.kind === 'DONE' || next.kind === 'TAKEN' || next.kind === 'CONFLICT' || next.kind === 'OFF') { setPicked(null); setSearch({ state: next.kind === 'OFF' ? 'OFF' : 'IDLE' }); }
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((request: Omit<Pending, 'key' | 'scope'>) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { ...request, key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId } };
    void send();
  }, [lock, orgId, schoolId, send]);

  const onOrder = useCallback(() => { if (picked) start({ action: 'order', phoneE164: picked.phoneE164, orderId: '', version: 0 }); }, [picked, start]);
  const onCancel = useCallback(() => {
    if (orders.state !== 'READY') return;
    const open = [...orders.orders].reverse().find((o) => o.status === 'REQUESTED' || o.status === 'APPROVED');
    if (open) start({ action: 'cancel', phoneE164: open.phoneE164, orderId: open.orderId, version: open.version });
  }, [orders, start]);
  const onDraft = useCallback((next: SearchDraft) => { if (lock === 'NONE') { setDraft(next); setOutcome(null); } }, [lock]);
  const onPick = useCallback((n: AvailableSchoolNumber | null) => { if (lock === 'NONE') { setPicked(n); setOutcome(null); } }, [lock]);
  const onConfirmCancel = useCallback((on: boolean) => { if (lock === 'NONE') { setConfirmCancel(on); setOutcome(null); } }, [lock]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <NumberView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} orders={orders} search={search} draft={draft} picked={picked} confirmCancel={confirmCancel}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={() => setRefresh((n) => n + 1)} onDraft={onDraft} onSearch={onSearch} onPick={onPick} onOrder={onOrder}
      onConfirmCancel={onConfirmCancel} onCancel={onCancel} onTryAgain={() => { void send(); }} />
  </div>;
}
