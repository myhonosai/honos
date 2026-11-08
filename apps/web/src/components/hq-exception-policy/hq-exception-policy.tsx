'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SaasExceptionPolicyDecisionInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { PolicyError, policyApi, type PolicyApi } from './http';
import { decisionInput, decisionOutcome, endInput, type DecisionDraft, type PolicyCommand, type PolicyForm, type PolicyOutcome, type PolicyState } from './model';
import { HqExceptionPolicyView } from './view';

/**
 * A decision whose outcome is not known: the exact request and key, in memory only, so Try again replays it. Dropping it is
 * safe: every decision names the revision it was read at, so a second decision from the same read is refused, never applied twice.
 */
type Pending = Readonly<{ key: string; command: PolicyCommand; input: SaasExceptionPolicyDecisionInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const newKey = () => globalThis.crypto.randomUUID();

/**
 * HQ exception policy (D10). Leaving the tab (blur, hidden tab, page hide) or a session end hides the policy, retires reads and
 * drops any kept decision; "Show again" reads it fresh. Every decision answer is followed by a fresh read.
 */
export function HqExceptionPolicy({ api = policyApi }: { api?: PolicyApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [state, setState] = useState<PolicyState>({ state: 'LOADING' });
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [outcome, setOutcome] = useState<PolicyOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [form, setForm] = useState<PolicyForm>(null);
  const generation = useRef(0), privacy = useRef(0);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  // Cleared on unmount: nothing this view sent speaks for a later one.
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);

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
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    setState({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view }); },
      error => {
        if (!owned()) return;
        if (error instanceof PolicyError && error.kind === 'DENIED') {
          // No longer allowed to read: nothing private stays, including a decision's outcome, form or retry.
          pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setForm(null); setState({ state: 'DENIED' });
        } else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, refresh, concealed]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', command: request.command });
    let next: PolicyOutcome, keep: boolean;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.decide(request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', command: request.command }; keep = false;
    } catch (error) { ({ outcome: next, keep } = decisionOutcome(error, request.command)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) { setOutcome(prior => prior?.kind === 'SENDING' ? null : prior); return; }
    setOutcome(next); if (next?.kind === 'DONE' || next?.kind === 'CHANGED') setForm(null);
    // Every answer is followed by a fresh read: the policy, not this tab, says what is true now.
    setRefresh(value => value + 1);
  }, [api]);

  const ready = state.state === 'READY' ? state.view : null;
  const onDecide = useCallback((decision: 'PROPOSED' | 'APPROVED', draft: DecisionDraft) => {
    if (lock !== 'NONE' || pending.current || sending.current || !ready) return;
    const input = decisionInput(ready, decision, draft);
    if (!input) { setOutcome({ kind: 'LOCAL_INVALID', command: decision }); return; }
    pending.current = { key: newKey(), command: decision, input }; void send();
  }, [lock, ready, send]);
  const onEnd = useCallback((reason: string) => {
    if (lock !== 'NONE' || pending.current || sending.current || !ready) return;
    const input = endInput(ready, reason);
    const command: PolicyCommand = ready.current?.status === 'APPROVED' ? 'REVOKED' : 'WITHDRAWN';
    if (!input) { setOutcome({ kind: 'LOCAL_INVALID', command }); return; }
    pending.current = { key: newKey(), command: input.decision, input }; void send();
  }, [lock, ready, send]);
  const onOpenForm = useCallback((next: PolicyForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);
  const onReveal = useCallback(() => { setConcealed(false); }, []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  return <HqExceptionPolicyView language={preferences.language} concealed={concealed} state={state} outcome={outcome} locked={lock !== 'NONE'}
    canRetry={lock === 'KEPT'} form={form} onRefresh={onRefresh} onReveal={onReveal} onOpenForm={onOpenForm} onDecide={onDecide} onEnd={onEnd} onTryAgain={onTryAgain}/>;
}
