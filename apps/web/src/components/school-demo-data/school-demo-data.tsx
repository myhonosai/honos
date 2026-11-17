'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoveSchoolDemoDataInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { DemoError, HON_DEMO_DATA_CHANGED_EVENT, demoDataApi, keepForRetry, type DemoDataApi, type DemoScope } from './http';
import { SchoolDemoDataSettingsView, type DemoOutcome, type DemoReadState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ kind: 'LOAD'; key: string; scope: DemoScope } | { kind: 'REMOVE'; key: string; scope: DemoScope; input: RemoveSchoolDemoDataInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * Settings > Demo data (0459). Load and Remove are each one command with its own key; Remove asks once first. Every answer
 * is followed by a fresh read and tells the staff banner to read again. A school change or session end drops a kept retry.
 */
export function SchoolDemoDataSettings({ api = demoDataApi }: { api?: DemoDataApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [read, setRead] = useState<DemoReadState>({ state: 'LOADING' });
  const [outcome, setOutcome] = useState<DemoOutcome>(null);
  const [confirming, setConfirming] = useState(false);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setConfirming(false); setRead({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read({ organizationId: orgId, schoolId }, signal, owned).then(
      view => { if (owned()) setRead({ state: 'READY', read: view }); },
      error => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof DemoError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: request.kind === 'LOAD' ? 'LOADING' : 'REMOVING' });
    let next: DemoOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      // Load writes a whole demo school; give it longer than an ordinary save.
      const signal = AbortSignal.timeout(90000);
      if (request.kind === 'LOAD') await api.load(request.scope, request.key, signal, owned);
      else await api.remove(request.scope, request.input, request.key, signal, owned);
      next = { kind: request.kind === 'LOAD' ? 'LOADED' : 'REMOVED' };
    } catch (error) {
      keep = keepForRetry(error);
      next = error instanceof DemoError && error.kind !== 'SESSION' ? { kind: error.kind, tables: error.tables } : { kind: error instanceof DemoError ? 'SESSION' : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HON_DEMO_DATA_CHANGED_EVENT));
    if (shown !== privacy.current || !mounted.current) return;
    setConfirming(false);
    setOutcome(next);
    if (!keep) setRefresh(n => n + 1);
  }, [api]);

  const current = read.state === 'READY' ? read.read : null;
  const ready = lock === 'NONE' && !pending.current && !sending.current && !!orgId && !!schoolId && !!current;
  const onLoad = useCallback(() => {
    if (!ready || current?.status !== 'NONE') return;
    pending.current = { kind: 'LOAD', key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId!, schoolId: schoolId! } };
    void send();
  }, [ready, current, orgId, schoolId, send]);
  const onAskRemove = useCallback(() => { if (ready && current?.status === 'LOADED') { setOutcome(null); setConfirming(true); } }, [ready, current]);
  const onCancelRemove = useCallback(() => setConfirming(false), []);
  const onConfirmRemove = useCallback(() => {
    if (!ready || current?.status !== 'LOADED') return;
    pending.current = { kind: 'REMOVE', key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId!, schoolId: schoolId! },
      input: { setId: current.setId, expectedVersion: current.version } };
    void send();
  }, [ready, current, orgId, schoolId, send]);
  const onRefresh = useCallback(() => { setConfirming(false); setRefresh(n => n + 1); }, []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolDemoDataSettingsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} read={read} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} confirming={confirming}
      onLoad={onLoad} onAskRemove={onAskRemove} onConfirmRemove={onConfirmRemove} onCancelRemove={onCancelRemove} onRefresh={onRefresh} onTryAgain={onTryAgain} />
  </div>;
}
