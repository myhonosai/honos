'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SocialAccount, SocialAccountChangeInput, SocialPlatform } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SocialError, keepForRetry, socialApi, type SocialApi, type SocialScope } from './http';
import { SocialReturnView, SocialView, type ListState, type ReturnState, type SocialAction, type SocialOutcome, type Switches } from './view';

/** A change whose outcome is not known: the exact change and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; action: Exclude<SocialAction, 'connect'>; scope: SocialScope; accountId: string; body: SocialAccountChangeInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * Social accounts (0347). Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire
 * every read and drop unsaved switches and any kept change. Every command answer is followed by a fresh read.
 */
export function SchoolSocial({ api = socialApi, navigate = (url: string) => window.location.assign(url) }: { api?: SocialApi; navigate?: (url: string) => void }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [edits, setEdits] = useState<Record<string, Switches>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SocialOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setEdits({}); setConfirming(null); setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', list: read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof SocialError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: SocialOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const r = await api.change(request.scope, request.accountId, request.body, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', action: request.action, removal: r.providerRemoval };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof SocialError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || next.kind === 'STALE' || next.kind === 'GONE') {
      setEdits((all) => { const copy = { ...all }; delete copy[request.accountId]; return copy; }); setConfirming(null);
    }
    setRefresh((n) => n + 1);
  }, [api]);

  const startChange = useCallback((action: Pending['action'], account: SocialAccount, body: SocialAccountChangeInput) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, accountId: account.accountId, body };
    void send();
  }, [lock, orgId, schoolId, send]);

  const onConnect = useCallback(async (platform: SocialPlatform) => {
    if (lock !== 'NONE' || sending.current || !orgId || !schoolId) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: 'connect' });
    try {
      // A new attempt each time: a lost answer only leaves an unused link that expires in 10 minutes.
      const r = await api.connect({ organizationId: orgId, schoolId }, platform, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000),
        () => mounted.current && shown === privacy.current);
      sending.current = false;
      if (shown === privacy.current && mounted.current) navigate(r.authUrl);
    } catch (error) {
      sending.current = false; setLock('NONE');
      if (shown === privacy.current && mounted.current) setOutcome({ kind: error instanceof SocialError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: 'connect' });
    }
  }, [api, lock, navigate, orgId, schoolId]);

  return <div key={shell.phase} data-shell-private="">
    <SocialView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} canManage list={list} edits={edits} confirming={confirming} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={() => setRefresh((n) => n + 1)} onConnect={(platform) => { void onConnect(platform); }}
      onEdit={(id, next) => { if (lock === 'NONE') { setEdits((all) => ({ ...all, [id]: next })); setOutcome(null); } }}
      onSave={(a) => { const d = edits[a.accountId]; if (d) startChange('change', a, { expectedVersion: a.version, ...d }); }}
      onConfirm={(id) => { if (lock === 'NONE') { setConfirming(id); setOutcome(null); } }}
      onDisconnect={(a) => startChange('disconnect', a, { expectedVersion: a.version, disconnect: true })}
      onTryAgain={() => { void send(); }} />
  </div>;
}

const STATE = /^[A-Za-z0-9_-]{43}$/;
/**
 * The page Facebook or Instagram returns to. The state is read once from the address and removed from it at once; the
 * server decides which accounts were connected (redirect values such as account ids are ignored). Sent exactly once.
 */
export function SchoolSocialReturn({ api = socialApi }: { api?: SocialApi }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [state, setState] = useState<ReturnState>({ state: 'WORKING' });
  const captured = useRef<string | null | undefined>(undefined), sent = useRef(false);
  useEffect(() => {
    if (captured.current !== undefined) return;
    const value = new URLSearchParams(window.location.search).get('state');
    captured.current = value && STATE.test(value) ? value : null;
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* the address keeps the state; it is single use anyway */ }
    if (!captured.current) setState({ state: 'MISSING' });
  }, []);
  useEffect(() => {
    if (sent.current || !orgId || !schoolId || !captured.current) return;
    sent.current = true; const stateValue = captured.current; captured.current = null;
    api.complete({ organizationId: orgId, schoolId }, stateValue, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000), () => true).then(
      (result) => setState({ state: 'DONE', result }),
      (error) => setState({ state: 'FAILED', kind: error instanceof SocialError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' }));
  }, [api, orgId, schoolId]);
  return <div data-shell-private=""><SocialReturnView language={locale.preferences.language} state={state} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} /></div>;
}
