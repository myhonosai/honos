'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SchoolMembershipListItem, SchoolPayMethodKind, SchoolPayPayerMethodsView } from '@hon/contracts';
import { loadInvoiceableMemberships } from '../invoice-pickers';
import { useLocale } from '../localization/provider';
import { membershipListApi, type MembershipListApi } from '../membership-list/http';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MethodError, keepForRetry, methodsQueryFrom, savedMethodsApi, type MethodCommand, type MethodErrorKind, type MethodScope, type SavedMethodsApi, type SetupReturn } from './http';
import { CONSENT, SavedMethodsView, type ExpiringState, type MethodForm, type MethodOutcome, type PayerOption, type PayersState, type PayerState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: MethodCommand; scope: MethodScope; payerId: string; targetId: string; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const FIXABLE: readonly MethodErrorKind[] = ['INVALID', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof MethodError ? error.kind : 'UNKNOWN';

/** One option per payer (billing account), named from the memberships it pays for. */
export function payerOptions(items: readonly SchoolMembershipListItem[]): PayerOption[] {
  const names = new Map<string, string[]>();
  for (const item of items) {
    const list = names.get(item.billingAccountId) ?? [];
    const who = item.participant ? `${item.participant.givenName} ${item.participant.familyName}`.trim() : '';
    if (who && !list.includes(who)) list.push(who);
    names.set(item.billingAccountId, list);
  }
  return [...names].map(([payerId, list]) => ({ payerId, label: list.length ? list.join(', ') : 'Payer with no participant recorded' }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The request body for a command, from the last verified payer read only; it throws when the details are not acceptable. */
export function methodBody(action: MethodCommand, read: SchoolPayPayerMethodsView, targetId: string,
  extra: Readonly<{ kind?: SchoolPayMethodKind; reason?: string; returned?: SetupReturn | null }> = {}): unknown {
  if (!read.canManage) throw new MethodError('INVALID');
  const target = targetId.toLowerCase();
  if (action === 'setup') {
    const connection = read.connections.find((c) => c.connectionId === target);
    const kind = extra.kind ?? 'CARD';
    if (!connection || (kind === 'US_BANK_ACCOUNT' && !connection.bankDebit)) throw new MethodError('INVALID');
    return { connectionId: connection.connectionId, methodKinds: [kind], consentTextVersion: CONSENT[kind].version };
  }
  if (action === 'finish') {
    const back = extra.returned, setup = read.setups.find((s) => s.setupId === target);
    if (!back || back.setupId !== target || back.payerId !== read.billingAccountId || !setup || setup.state !== 'PENDING') throw new MethodError('INVALID');
    return { expectedVersion: setup.version, setupState: back.setupState };
  }
  const method = read.methods.find((m) => m.methodId === target && m.status === 'ACTIVE');
  if (!method) throw new MethodError('INVALID');
  if (action === 'remove') return { expectedVersion: method.version, reason: (extra.reason ?? '').replace(/\s+/g, ' ').trim() };
  return { expectedVersion: method.version };
}

/** Read the link once and take it out of the address bar, so the one-time setup state is not kept in history or shared. */
export function takeMethodsQuery(location: Pick<Location, 'search' | 'pathname'>, history: Pick<History, 'replaceState'>): ReturnType<typeof methodsQueryFrom> {
  if (!location.search) return { payerId: null, returned: null };
  const query = methodsQueryFrom(location.search);
  history.replaceState(null, '', location.pathname);
  return query;
}

/**
 * Saved payment methods (B-TUI-2 piece 3, 0265), test mode only. Staff choose a payer, see the cards and bank accounts
 * saved with the school's own payment processor, add one through the processor's hosted page, pick the default and remove
 * one. The processor sends the staff member back here with a one-time state, which this page removes from the address bar
 * at once, keeps only in memory, and sends to the server only when they choose Finish saving. Blur, a hidden tab, page
 * hide, a school change or a session end hide the page and retire every read; a school change or session end also drops
 * the return. Every command answer is followed by a fresh read. HON never sees a card number and takes no fee.
 */
export function SavedMethods({ api = savedMethodsApi, listApi = membershipListApi, navigate = (url: string) => window.location.assign(url) }: {
  api?: SavedMethodsApi; listApi?: Pick<MembershipListApi, 'page'>; navigate?: (url: string) => void;
}): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [payers, setPayers] = useState<PayersState>({ state: 'LOADING' });
  const [payerId, setPayerId] = useState<string | null>(null);
  const [payer, setPayer] = useState<PayerState>({ state: 'NONE' });
  const [expiring, setExpiring] = useState<ExpiringState>({ state: 'LOADING' });
  const [returned, setReturned] = useState<SetupReturn | null>(null);
  const [form, setForm] = useState<MethodForm>(null);
  const [outcome, setOutcome] = useState<MethodOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  // The link is read once, before anything else, and the query is removed from the address bar straight away.
  useEffect(() => {
    const query = takeMethodsQuery(window.location, window.history);
    if (query.payerId) setPayerId(query.payerId);
    setReturned(query.returned);
  }, []);

  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null);
    setPayers({ state: 'LOADING' }); setPayer((p) => p.state === 'NONE' ? p : { state: 'LOADING' }); setExpiring({ state: 'LOADING' });
    // Only blur or a hidden tab keeps the return and the chosen payer; a session end or another school drops them.
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) { setReturned(null); setPayerId(null); setPayer({ state: 'NONE' }); }
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setForm(null); setOutcome(null); setReturned(null); setPayerId(null); setPayer({ state: 'NONE' }); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  // The payer list, the chosen payer and the expiring list are read together and retired together.
  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setPayers({ state: 'LOADING' }); setExpiring({ state: 'LOADING' }); setPayer(payerId ? { state: 'LOADING' } : { state: 'NONE' });
    if (!orgId || !schoolId) return;
    const scope = { organizationId: orgId, schoolId };
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const failed = (error: unknown) => readKind(error) === 'DENIED' ? 'DENIED' as const : 'UNAVAILABLE' as const;
    loadInvoiceableMemberships(listApi, scope, signal, owned).then(
      ({ items }) => { if (owned()) setPayers({ state: 'READY', payers: payerOptions(items) }); },
      () => { if (owned() && !abort.signal.aborted) setPayers({ state: 'UNAVAILABLE' }); });
    api.expiring(scope, signal, owned).then(
      (read) => { if (owned()) setExpiring({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setExpiring({ state: failed(error) }); });
    if (payerId) api.payer(scope, payerId, signal, owned).then(
      (read) => { if (owned()) setPayer({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setPayer({ state: readKind(error) === 'GONE' ? 'GONE' : failed(error) }); });
    return () => { abort.abort(); };
  }, [api, listApi, orgId, schoolId, payerId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: MethodOutcome, keep = false, redirect: string | null = null;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000), body = request.body as never;
      switch (request.action) {
        case 'setup': {
          const start = await api.startSetup(request.scope, request.payerId, body, request.key, signal, owned);
          redirect = start.setupUrl;
          next = { kind: redirect ? 'REDIRECTING' : 'LINK_REPLAYED', action: 'setup' };
          break;
        }
        case 'finish': await api.finishSetup(request.scope, request.payerId, request.targetId, body, request.key, signal, owned); next = { kind: 'DONE', action: 'finish' }; break;
        case 'default': await api.setDefault(request.scope, request.payerId, request.targetId, body, request.key, signal, owned); next = { kind: 'DONE', action: 'default' }; break;
        case 'remove': {
          const result = await api.remove(request.scope, request.payerId, request.targetId, body, request.key, signal, owned);
          next = { kind: 'DONE', action: 'remove', providerDetached: result.providerDetached };
          break;
        }
      }
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof MethodError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    // The return is used once: any definite answer to a finish (success or refusal) ends it; an unknown one keeps it for the retry.
    if (request.action === 'finish' && !keep) setReturned(null);
    if (redirect) { navigate(redirect); return; }
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as MethodErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api, navigate]);

  const read = payer.state === 'READY' ? payer.read : null;
  const begin = useCallback((action: MethodCommand, targetId: string, build: (r: SchoolPayPayerMethodsView) => unknown) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || !read || !read.canManage) return;
    let body: unknown;
    try { body = build(read); } catch { setOutcome({ kind: 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, payerId: read.billingAccountId, targetId, body };
    void send();
  }, [lock, orgId, schoolId, read, send]);

  const onPickPayer = useCallback((id: string) => {
    if (lock !== 'NONE') return;
    setForm(null); setOutcome(null);
    // A return belongs to one payer; choosing another drops it.
    setReturned((r) => r && r.payerId === id.toLowerCase() ? r : null);
    setPayerId(id.toLowerCase());
  }, [lock]);
  const onStart = useCallback((connectionId: string, kind: SchoolPayMethodKind) => begin('setup', connectionId, (r) => methodBody('setup', r, connectionId, { kind })), [begin]);
  const onFinish = useCallback(() => { if (returned) begin('finish', returned.setupId, (r) => methodBody('finish', r, returned.setupId, { returned })); }, [begin, returned]);
  const onDefault = useCallback((id: string) => begin('default', id, (r) => methodBody('default', r, id)), [begin]);
  const onRemove = useCallback((id: string, reason: string) => begin('remove', id, (r) => methodBody('remove', r, id, { reason })), [begin]);
  const onOpen = useCallback((next: MethodForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onDismissReturn = useCallback(() => { if (lock === 'NONE') setReturned(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SavedMethodsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} schoolName={shell.schoolName ?? ''} payers={payers} payerId={payerId} payer={payer} expiring={expiring} returned={returned}
      form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onPickPayer={onPickPayer} onRefresh={onRefresh} onOpen={onOpen} onClose={onClose} onStart={onStart} onFinish={onFinish}
      onDismissReturn={onDismissReturn} onDefault={onDefault} onRemove={onRemove} onTryAgain={onTryAgain}/>
  </div>;
}
