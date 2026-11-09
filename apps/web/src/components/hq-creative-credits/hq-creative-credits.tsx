'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SaasCreativeCostInput, SaasCreativeDebitInput, SaasCreativeGrantInput, SaasCreativeHqWallet, SaasCreativeHqWalletList, SaasCreativeResolveInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CreditsError, creditsApi, keepForRetry, toMicro, type CreditsApi } from './http';
import { DEBIT_REASONS, GRANT_REASONS, costable, debitable, settleable, type CreditForm, type CreditOutcome, type Fields } from './forms';
import { CreditsView, type DetailState, type ReadState } from './view';

const failed = (error: unknown): 'DENIED' | 'UNAVAILABLE' => error instanceof CreditsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE';

/** The exact correction to send, built once from the form and the wallet read it was opened on. Try again replays it with the same key. */
export type CreditRequest = Readonly<
  | { action: 'grant'; schoolId: string; body: SaasCreativeGrantInput }
  | { action: 'debit'; schoolId: string; lotId: string; body: SaasCreativeDebitInput }
  | { action: 'resolve'; schoolId: string; reservationId: string; body: SaasCreativeResolveInput }
  | { action: 'cost'; schoolId: string; reservationId: string; body: SaasCreativeCostInput }>;

const invalid = (): never => { throw new CreditsError('INVALID'); };
const whole = (v: string | undefined, min: number, max: number) => { const s = (v ?? '').trim(); const n = /^\d{1,10}$/.test(s) ? Number(s) : NaN; return n >= min && n <= max ? n : invalid(); };
const text = (v: string | undefined, max: number) => { const s = (v ?? '').trim(); return s.length >= 1 && s.length <= max ? s : invalid(); };
const micro = (v: string | undefined) => toMicro(v ?? '') ?? invalid();
const oneOf = <V extends string>(v: string | undefined, list: readonly V[]): V => (list as readonly string[]).includes(v ?? '') ? v as V : invalid();

/** The request for a form, from its fields and the school wallet it was opened on. It throws INVALID when the details are not acceptable. */
export function creditRequest(form: Exclude<CreditForm, null>, fields: Fields, wallet: SaasCreativeHqWallet): CreditRequest {
  if (fields.confirm !== 'on') invalid();
  const schoolId = wallet.schoolId.toLowerCase();
  const reservation = (id: string) => wallet.reservations.find((r) => r.reservationId.toLowerCase() === id.toLowerCase()) ?? invalid();
  switch (form.kind) {
    case 'grant':
      return { action: 'grant', schoolId, body: { kind: oneOf(fields.kind, ['PROMOTIONAL', 'ADJUSTMENT'] as const), credits: whole(fields.credits, 1, 1_000_000_000),
        reasonCode: oneOf(fields.reason, GRANT_REASONS), note: text(fields.note, 500) } };
    case 'debit': {
      const lot = wallet.lots.find((l) => l.lotId.toLowerCase() === form.lotId.toLowerCase()) ?? invalid();
      if (!debitable(lot)) invalid();
      return { action: 'debit', schoolId, lotId: lot.lotId.toLowerCase(), body: { credits: whole(fields.credits, 1, lot.availableCredits),
        reasonCode: oneOf(fields.reason, DEBIT_REASONS), note: text(fields.note, 500) } };
    }
    case 'resolve': {
      const r = reservation(form.reservationId);
      if (!settleable(r)) invalid();
      const evidenceReference = text(fields.evidence, 200);
      // The version read here: a settlement that raced this one makes the database refuse it as changed.
      const body: SaasCreativeResolveInput = form.resolution === 'SUCCEEDED'
        ? { resolution: 'SUCCEEDED', expectedVersion: r.version, finalUnits: whole(fields.units, 0, r.units), providerCostMicrounits: micro(fields.cost), evidenceReference }
        // A blank cost stays UNKNOWN for later reconciliation; it is never sent as zero.
        : { resolution: 'NOT_CHARGED', expectedVersion: r.version, finalUnits: null, providerCostMicrounits: (fields.cost ?? '').trim() === '' ? null : micro(fields.cost), evidenceReference };
      return { action: 'resolve', schoolId, reservationId: r.reservationId.toLowerCase(), body };
    }
    case 'cost': {
      const r = reservation(form.reservationId);
      if (!costable(r)) invalid();
      return { action: 'cost', schoolId, reservationId: r.reservationId.toLowerCase(), body: { expectedVersion: r.version, providerCostMicrounits: micro(fields.cost),
        evidenceReference: text(fields.evidence, 200) } };
    }
  }
}
function run(api: CreditsApi, r: CreditRequest, key: string, signal: AbortSignal, owned: () => boolean): Promise<{ replayed: boolean }> {
  switch (r.action) {
    case 'grant': return api.grant(r.schoolId, r.body, key, signal, owned);
    case 'debit': return api.debit(r.schoolId, r.lotId, r.body, key, signal, owned);
    case 'resolve': return api.resolve(r.schoolId, r.reservationId, r.body, key, signal, owned);
    case 'cost': return api.cost(r.schoolId, r.reservationId, r.body, key, signal, owned);
  }
}
type Pending = Readonly<{ key: string; request: CreditRequest }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * HQ Creative Credits: the program state, rates, packages and every school wallet, with the HQ owner's corrections on one
 * school's wallet (grant, remove, settle a generation, record a provider cost). Leaving the window or tab, or a session end,
 * hides everything, retires every read and drops a kept correction; "Show again" reads fresh. Every correction answer is
 * followed by a fresh read. Nothing here changes the program, the rates, a purchase or a payment.
 */
export function HqCreativeCredits({ api = creditsApi }: { api?: CreditsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [wallets, setWallets] = useState<ReadState<SaasCreativeHqWalletList>>({ state: 'LOADING' });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState<CreditForm>(null);
  const [outcome, setOutcome] = useState<CreditOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);
  useEffect(() => {
    // Per-school billing data: leaving the window or tab, or a session end, hides everything, retires every read and drops a kept correction.
    const conceal = () => {
      generation.current++; privacy.current++; pending.current = null;
      setConcealed(true); setWallets({ state: 'LOADING' }); setSelected(null); setDetail(null); setForm(null); setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE');
    };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  // The list and the open school's wallet are read together, fresh, on open, refresh and after every correction answer.
  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setWallets((w) => w.state === 'READY' ? w : { state: 'LOADING' });
    api.wallets(signal, owned).then((view) => { if (owned()) setWallets({ state: 'READY', view }); },
      (error) => { if (owned() && !abort.signal.aborted) setWallets({ state: failed(error) }); });
    if (selected) {
      setDetail({ state: 'LOADING', schoolId: selected });
      api.school(selected, signal, owned).then((wallet) => { if (owned()) setDetail({ state: 'READY', schoolId: selected, wallet }); },
        (error) => { if (owned() && !abort.signal.aborted) setDetail({ state: failed(error), schoolId: selected }); });
    } else setDetail(null);
    return () => { abort.abort(); };
  }, [api, refresh, concealed, selected]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.request.action });
    let next: NonNullable<CreditOutcome>, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await run(api, request.request, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', action: request.request.action, replayed: receipt.replayed };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof CreditsError ? error.kind : 'UNKNOWN', action: request.request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    // Any answer closes the form: Try again replays the stored request, never the form as edited since.
    setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const onSubmit = useCallback((fields: Fields) => {
    if (!form || lock !== 'NONE' || pending.current || sending.current || detail?.state !== 'READY') return;
    let request: CreditRequest;
    try { request = creditRequest(form, fields, detail.wallet); }
    catch { setOutcome({ kind: 'INVALID', action: form.kind }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), request };
    void send();
  }, [form, lock, detail, send]);
  const onStop = useCallback(() => {
    if (lock !== 'KEPT' || sending.current) return;
    pending.current = null; setLock('NONE'); setOutcome(null); setRefresh((n) => n + 1);
  }, [lock]);
  const onOpenForm = useCallback((next: Exclude<CreditForm, null>) => { if (lock === 'NONE') { setOutcome(null); setForm(next); } }, [lock]);
  const onOpen = useCallback((schoolId: string) => { if (lock === 'NONE') { setForm(null); setOutcome(null); setSelected(schoolId.toLowerCase()); setRefresh((n) => n + 1); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') { setForm(null); setOutcome(null); setSelected(null); } }, [lock]);

  return <CreditsView language={preferences.language} concealed={concealed} wallets={wallets} detail={detail}
    onRefresh={() => setRefresh((n) => n + 1)} onShowAgain={() => { setConcealed(false); setRefresh((n) => n + 1); }} onOpen={onOpen} onClose={onClose}
    form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onOpenForm={onOpenForm} onCloseForm={() => setForm(null)} onSubmit={onSubmit}
    onTryAgain={() => { void send(); }} onStop={onStop}/>;
}
