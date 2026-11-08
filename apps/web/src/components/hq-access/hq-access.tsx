'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SaasAccessExceptionGrantInput, SaasAccessOverviewOrganization, SaasAccessOverviewStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AccessOverviewError, accessApi, type AccessApi } from './http';
import { commandOutcome, grantInput, revokeReason, type AccessOutcome, type GrantDraft, type OverviewState } from './model';
import { HqAccessView, type OpenForm } from './view';

/**
 * A grant or revoke whose outcome is not known: the exact request and key, in memory only, so Try again replays it.
 * Dropping it is safe: a grant carries the entitlement version it was read at and the database refuses a second
 * active exception, and a second revoke of an ended exception is refused, so nothing is ever applied twice.
 */
type Pending = Readonly<{ key: string; organization: string }>
  & ({ command: 'grant'; organizationId: string; input: SaasAccessExceptionGrantInput } | { command: 'revoke'; exceptionId: string; reason: string });
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const newKey = () => globalThis.crypto.randomUUID();

/**
 * HQ access overview. Leaving the tab (blur, hidden tab) or a session end hides every customer fact, retires reads
 * and drops any kept command; "Show again" reads the overview fresh. Every command answer is followed by a fresh read.
 */
export function HqAccess({ api = accessApi }: { api?: AccessApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [state, setState] = useState<OverviewState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<SaasAccessOverviewStatus | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [outcome, setOutcome] = useState<AccessOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [form, setForm] = useState<OpenForm>(null);
  const generation = useRef(0), privacy = useRef(0);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  // Cleared on unmount: nothing this view sent speaks for a later one.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);
  /** A read is owned while it is the latest read of this mounted, unconcealed view. */
  const ownsRead = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;

  useEffect(() => {
    const conceal = () => {
      generation.current++; privacy.current++; pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE');
      setConcealed(true); setState({ state: 'LOADING' }); setOutcome(null); setForm(null);
    };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = ownsRead(current, privacy.current);
    setState({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.overview({ status: filter, cursor: null }, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view, organizations: view.organizations, loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned()) return;
        if (error instanceof AccessOverviewError && error.kind === 'DENIED') {
          // No longer allowed to read: nothing private stays, including a command's outcome, form or retry. The outcome
          // of a command still in doubt is not shown as undone; it is simply no longer this view's to show.
          privacy.current++; pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setForm(null);
          setState({ state: 'DENIED' });
        } else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, filter, refresh, concealed]);

  const onMore = useCallback(() => {
    if (state.state !== 'READY' || !state.view.nextCursor || state.loadingMore) return;
    const current = generation.current, cursor = state.view.nextCursor, owned = ownsRead(current, privacy.current);
    setState({ ...state, loadingMore: true, moreFailed: false });
    api.overview({ status: filter, cursor }, AbortSignal.timeout(15000), owned).then(
      view => { if (owned()) setState(prior => prior.state !== 'READY' ? prior : { state: 'READY', view: { ...view, organizations: [] },
        organizations: [...prior.organizations, ...view.organizations.filter(o => !prior.organizations.some(p => p.organizationId === o.organizationId))], loadingMore: false, moreFailed: false }); },
      () => { if (owned()) setState(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true }); });
  }, [api, filter, state]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', command: request.command, organization: request.organization });
    let next: AccessOutcome, keep: boolean;
    try {
      const signal = AbortSignal.timeout(30000), owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      if (request.command === 'grant') await api.grant(request.organizationId, request.input, request.key, signal, owned);
      else await api.revoke(request.exceptionId, request.reason, request.key, signal, owned);
      next = { kind: 'DONE', command: request.command, organization: request.organization }; keep = false;
    } catch (error) { ({ outcome: next, keep } = commandOutcome(error, request.command, request.organization)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) { setOutcome(prior => prior?.kind === 'SENDING' ? null : prior); return; }
    setOutcome(next); setForm(next?.kind === 'DONE' || next?.kind === 'CHANGED' ? null : form => form);
    // Every answer is followed by a fresh read: the list, not this tab, says what is true now.
    setRefresh(value => value + 1);
  }, [api]);

  const ready = state.state === 'READY' ? state.view : null;
  const onGrant = useCallback((org: SaasAccessOverviewOrganization, draft: GrantDraft) => {
    if (lock !== 'NONE' || pending.current || sending.current || !ready?.viewer.canGrantAndRevokeExceptions) return;
    const input = grantInput(org, ready.exceptionPolicy.ready ? ready.exceptionPolicy.maxDays : null, draft);
    if (!input) { setOutcome({ kind: 'LOCAL_INVALID', command: 'grant', organization: org.organizationDisplayName }); return; }
    pending.current = { key: newKey(), organization: org.organizationDisplayName, command: 'grant', organizationId: org.organizationId, input };
    void send();
  }, [lock, ready, send]);
  const onRevoke = useCallback((org: SaasAccessOverviewOrganization, reason: string) => {
    if (lock !== 'NONE' || pending.current || sending.current || !ready?.viewer.canGrantAndRevokeExceptions || !org.currentException?.revocable) return;
    const clean = revokeReason(reason);
    if (!clean) { setOutcome({ kind: 'LOCAL_INVALID', command: 'revoke', organization: org.organizationDisplayName }); return; }
    pending.current = { key: newKey(), organization: org.organizationDisplayName, command: 'revoke', exceptionId: org.currentException.exceptionId, reason: clean };
    void send();
  }, [lock, ready, send]);
  const onOpenForm = useCallback((next: OpenForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onFilter = useCallback((next: SaasAccessOverviewStatus | null) => { setFilter(next); setForm(null); }, []);
  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);
  const onReveal = useCallback(() => { setConcealed(false); }, []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  return <HqAccessView language={preferences.language} concealed={concealed} state={state} filter={filter} outcome={outcome} locked={lock !== 'NONE'}
    canRetry={lock === 'KEPT'} form={form} onFilter={onFilter} onMore={onMore} onRefresh={onRefresh} onReveal={onReveal} onOpenForm={onOpenForm}
    onGrant={onGrant} onRevoke={onRevoke} onTryAgain={onTryAgain}/>;
}
