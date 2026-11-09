'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { HqSchoolDirectoryAccessError, loadHqSchoolDirectory } from '../hq-school-directory-http';
import { OwnershipError, keepForRetry, ownershipApi, type OwnershipApi } from './http';
import { HqOwnershipView, type HqOwnershipState, type HqSchoolsState, type OwnershipOutcome, type OwnershipOutcomeKind, type SchoolChoice } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; schoolId: string; ownerGrantId: string; name: string }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
export type SchoolsLoader = (signal: AbortSignal) => Promise<readonly SchoolChoice[]>;
const loadSchools: SchoolsLoader = async (signal) => (await loadHqSchoolDirectory(signal)).schools
  .map((s) => ({ schoolId: s.schoolId, label: `${s.organizationDisplayName} — ${s.schoolDisplayName}` }));
const failKind = (error: unknown): OwnershipOutcomeKind => error instanceof OwnershipError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN';

/**
 * HQ school owners (B-ID-4). The HQ owner chooses a school, sees its owners, primary, HQ seats and notices, and can make
 * another owner primary after an explicit confirmation. Leaving the tab (blur, hidden tab, page hide) or a session end
 * hides everything, retires reads and drops any kept command; "Show again" reads fresh. Every command answer is followed by
 * a fresh read: the server, not this tab, says who is primary.
 */
export function HqSchoolOwnership({ api = ownershipApi, schoolsLoader = loadSchools }: { api?: OwnershipApi; schoolsLoader?: SchoolsLoader }): React.ReactElement {
  const { preferences } = useLocale();
  const [concealed, setConcealed] = useState(false);
  const [schools, setSchools] = useState<HqSchoolsState>({ state: 'LOADING' });
  const [selected, setSelected] = useState<string | null>(null);
  const [ownership, setOwnership] = useState<HqOwnershipState>({ state: 'IDLE' });
  const [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OwnershipOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; }; }, []);

  useEffect(() => {
    const conceal = () => {
      generation.current++; privacy.current++; pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE');
      setConcealed(true); setSchools({ state: 'LOADING' }); setSelected(null); setOwnership({ state: 'IDLE' }); setConfirming(null); setOutcome(null);
    };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  // The school list (HQ directory). Read again after each reveal.
  useEffect(() => {
    if (concealed) return;
    const shown = privacy.current, abort = new AbortController();
    setSchools({ state: 'LOADING' });
    schoolsLoader(abort.signal).then(
      (list) => { if (mounted.current && shown === privacy.current) setSchools({ state: 'READY', schools: list }); },
      (error) => { if (mounted.current && shown === privacy.current && !abort.signal.aborted)
        setSchools({ state: error instanceof HqSchoolDirectoryAccessError && error.status === 403 ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [concealed, schoolsLoader]);

  // The chosen school's ownership.
  useEffect(() => {
    if (concealed || !selected) { generation.current++; setOwnership({ state: 'IDLE' }); return; }
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    setOwnership({ state: 'LOADING' });
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.hqRead(selected, signal, owned).then(
      (view) => { if (owned()) setOwnership({ state: 'READY', view }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof OwnershipError ? error.kind : 'UNKNOWN';
        if (kind === 'DENIED') { pending.current = null; setLock(sending.current ? 'SENDING' : 'NONE'); setConfirming(null); setOutcome(null); }
        setOwnership({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, selected, refresh, concealed]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', name: request.name });
    let next: OwnershipOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await api.setPrimary({ schoolId: request.schoolId, ownerGrantId: request.ownerGrantId }, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: receipt.changed ? 'DONE' : 'UNCHANGED', name: request.name };
    } catch (error) { keep = keepForRetry(error); next = { kind: failKind(error), name: request.name }; }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); if (!keep) setConfirming(null);
    setRefresh((value) => value + 1);
  }, [api]);

  const view = ownership.state === 'READY' ? ownership.view : null;
  const onSelect = useCallback((schoolId: string | null) => { if (lock !== 'NONE') return; setSelected(schoolId); setConfirming(null); setOutcome(null); }, [lock]);
  const onAsk = useCallback((grantId: string) => { if (lock === 'NONE') { setConfirming(grantId); setOutcome(null); } }, [lock]);
  const onCancel = useCallback(() => { if (lock === 'NONE') setConfirming(null); }, [lock]);
  const onConfirm = useCallback(() => {
    if (lock !== 'NONE' || pending.current || sending.current || !view || !confirming) return;
    const target = view.owners.find((o) => o.ownerGrantId === confirming);
    if (!target || target.primary) { setConfirming(null); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), schoolId: view.schoolId, ownerGrantId: target.ownerGrantId, name: target.displayName };
    void send();
  }, [lock, view, confirming, send]);
  const onRefresh = useCallback(() => setRefresh((value) => value + 1), []);
  const onReveal = useCallback(() => setConcealed(false), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  return <HqOwnershipView language={preferences.language} concealed={concealed} schools={schools} selected={selected} ownership={ownership}
    confirming={confirming} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
    onSelect={onSelect} onRefresh={onRefresh} onReveal={onReveal} onAsk={onAsk} onCancel={onCancel} onConfirm={onConfirm} onTryAgain={onTryAgain}/>;
}
