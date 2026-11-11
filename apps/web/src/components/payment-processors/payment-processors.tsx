'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { validateDisconnectSchoolPayInput, validateFinishSchoolPayOnboardingInput, validateSchoolPayVersionInput, type SchoolPayProviderCode, type SchoolPaymentProcessors } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import {
  ProcessorError, keepForRetry, processorsApi, providerReturnFrom, type ProcessorCommand, type ProcessorErrorKind, type ProcessorScope, type ProcessorsApi, type ProviderReturn,
} from './http';
import { PaymentProcessorsView, type ProcessorForm, type ProcessorOutcome, type ProcessorsState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: ProcessorCommand; scope: ProcessorScope; targetId: string; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const FIXABLE: readonly ProcessorErrorKind[] = ['INVALID', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof ProcessorError ? error.kind : 'UNKNOWN';
const OPEN = (state: string) => state !== 'DISCONNECTED' && state !== 'ABANDONED';

/** The request body for a connection command, from the last verified read only; it throws when the details are not acceptable. */
export function processorBody(action: Exclude<ProcessorCommand, 'start'>, read: SchoolPaymentProcessors, connectionId: string,
  extra: Readonly<{ reason?: string; returned?: ProviderReturn | null }> = {}): unknown {
  const connection = read.connections.find((c) => c.connectionId === connectionId.toLowerCase() && OPEN(c.state));
  if (!connection || !read.canManage) throw new ProcessorError('INVALID');
  const expectedVersion = connection.version;
  if (action === 'disconnect') return validateDisconnectSchoolPayInput({ expectedVersion, reason: (extra.reason ?? '').replace(/\s+/g, ' ').trim() });
  if (action === 'finish') {
    const back = extra.returned;
    if (!back || back.connectionId !== connection.connectionId || back.providerError || connection.state !== 'PENDING_ONBOARDING') throw new ProcessorError('INVALID');
    return validateFinishSchoolPayOnboardingInput({ expectedVersion, state: back.state, ...(back.authorizationCode ? { authorizationCode: back.authorizationCode } : {}) });
  }
  return validateSchoolPayVersionInput({ expectedVersion });
}

/** Read the provider return once and take it out of the address bar, so the one-time state is not kept in history or shared. */
export function takeProviderReturn(location: Pick<Location, 'search' | 'pathname'>, history: Pick<History, 'replaceState'>): ProviderReturn | null {
  if (!location.search) return null;
  const back = providerReturnFrom(location.search);
  history.replaceState(null, '', location.pathname);
  return back;
}

/**
 * Payment processors (B-TUI-2 piece 1, 0258). A school owner connects the school's own Stripe or Square account (test mode),
 * checks its status, picks the default and disconnects it. Connecting sends the owner to the provider's hosted page; the
 * provider sends them back here with a one-time state, which this page removes from the address bar at once, keeps only in
 * memory, and sends to the server only when the owner chooses Finish connecting. Blur, a hidden tab, page hide, a school
 * change or a session end hide the page and retire every read; a school change or session end also drops the return.
 * Every command answer is followed by a fresh read: the server, not this tab, says what changed. HON takes no fee.
 */
export function PaymentProcessors({ api = processorsApi, navigate = (url: string) => window.location.assign(url) }: { api?: ProcessorsApi; navigate?: (url: string) => void }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ProcessorsState>({ state: 'LOADING' });
  const [returned, setReturned] = useState<ProviderReturn | null>(null);
  const [form, setForm] = useState<ProcessorForm>(null);
  const [outcome, setOutcome] = useState<ProcessorOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  // The provider return is read once, before anything else, and the query is removed from the address bar straight away.
  useEffect(() => { setReturned(takeProviderReturn(window.location, window.history)); }, []);

  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null); setList({ state: 'LOADING' });
    // Only blur or a hidden tab keeps the return; a session end or another school drops it.
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) setReturned(null);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setForm(null); setOutcome(null); setReturned(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.processors({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: readKind(error) === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: ProcessorOutcome, keep = false, follow: Pending | null = null, redirect: string | null = null;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000), body = request.body as never;
      switch (request.action) {
        case 'start': {
          const { connection } = await api.start(request.scope, request.targetId as SchoolPayProviderCode, request.key, signal, owned);
          // A new connection goes straight on to its hosted setup link, with its own key.
          follow = { key: globalThis.crypto.randomUUID(), action: 'link', scope: request.scope, targetId: connection.connectionId, body: { expectedVersion: connection.version } };
          next = { kind: 'SENDING', action: 'link' };
          break;
        }
        case 'link': {
          const link = await api.onboardingLink(request.scope, request.targetId, body, request.key, signal, owned);
          redirect = link.onboardingUrl;
          next = { kind: redirect ? 'REDIRECTING' : 'LINK_REPLAYED', action: 'link' };
          break;
        }
        case 'finish': await api.finish(request.scope, request.targetId, body, request.key, signal, owned); next = { kind: 'DONE', action: 'finish' }; break;
        case 'refresh': await api.refresh(request.scope, request.targetId, body, request.key, signal, owned); next = { kind: 'DONE', action: 'refresh' }; break;
        case 'default': await api.setDefault(request.scope, request.targetId, body, request.key, signal, owned); next = { kind: 'DONE', action: 'default' }; break;
        case 'disconnect': {
          const result = await api.disconnect(request.scope, request.targetId, body, request.key, signal, owned);
          next = { kind: 'DONE', action: 'disconnect', providerRevoked: result.providerRevoked };
          break;
        }
      }
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof ProcessorError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    const current = pending.current?.key === request.key;
    if (current) pending.current = keep ? request : follow;
    setLock(pending.current ? (follow && current ? 'SENDING' : 'KEPT') : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    // The return is used once: any definite answer to a finish (success or refusal) ends it; an unknown one keeps it for the retry.
    if (request.action === 'finish' && !keep) setReturned(null);
    if (follow && current) { void send(); return; }
    if (redirect) { navigate(redirect); return; }
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as ProcessorErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api, navigate]);

  const read = list.state === 'READY' ? list.read : null;
  const begin = useCallback((action: ProcessorCommand, targetId: string, build: () => unknown) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || !read || !read.canManage) return;
    let body: unknown;
    try { body = build(); } catch { setOutcome({ kind: 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, targetId, body };
    void send();
  }, [lock, orgId, schoolId, read, send]);

  const onConnect = useCallback((providerCode: string) => begin('start', providerCode, () => {
    if (!read?.providers.some((p) => p.providerCode === providerCode)) throw new ProcessorError('INVALID');
    return { providerCode };
  }), [begin, read]);
  const onContinue = useCallback((id: string) => begin('link', id, () => processorBody('link', read as SchoolPaymentProcessors, id)), [begin, read]);
  const onFinish = useCallback(() => {
    if (returned) begin('finish', returned.connectionId, () => processorBody('finish', read as SchoolPaymentProcessors, returned.connectionId, { returned }));
  }, [begin, read, returned]);
  const onCheck = useCallback((id: string) => begin('refresh', id, () => processorBody('refresh', read as SchoolPaymentProcessors, id)), [begin, read]);
  const onDefault = useCallback((id: string) => begin('default', id, () => processorBody('default', read as SchoolPaymentProcessors, id)), [begin, read]);
  const onDisconnect = useCallback((id: string, reason: string) => begin('disconnect', id, () => processorBody('disconnect', read as SchoolPaymentProcessors, id, { reason })), [begin, read]);
  const onOpen = useCallback((next: ProcessorForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onDismissReturn = useCallback(() => { if (lock === 'NONE') setReturned(null); }, [lock]);
  const onRefreshList = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <PaymentProcessorsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} returned={returned} form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefreshList={onRefreshList} onConnect={onConnect} onContinue={onContinue} onFinish={onFinish} onDismissReturn={onDismissReturn}
      onCheck={onCheck} onDefault={onDefault} onOpen={onOpen} onClose={onClose} onDisconnect={onDisconnect} onTryAgain={onTryAgain}/>
  </div>;
}
