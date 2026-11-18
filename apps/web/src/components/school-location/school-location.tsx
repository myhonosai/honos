'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveSchoolLocationInput, SchoolLocationView } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { LocationError, locationApi, keepForRetry, type LocationApi, type LocationScope } from './http';
import { draftFrom, draftProblems, sameDraft, saveInput, type LocationDraft, type LocationField } from './draft';
import { locationCopy } from './copy';
import { SchoolLocationSettingsView, type LocationOutcome, type LocationReadState } from './view';

/** A save whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: LocationScope; input: SaveSchoolLocationInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * School location (0392). A school owner sets the school address; the server answers with the face check-in notice for it.
 * Unsaved edits stay in memory only; blur or a hidden tab hides the page but keeps them, while a school change or a session
 * end drops them. Every save answer is followed by a fresh read.
 */
export function SchoolLocationSettings({ api = locationApi }: { api?: LocationApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [read, setRead] = useState<LocationReadState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<LocationDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [outcome, setOutcome] = useState<LocationOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), dirtyRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);
  const markDirty = useCallback((value: boolean) => { dirtyRef.current = value; setDirty(value); }, []);

  const forget = useCallback(() => { setDraft(null); markDirty(false); setOutcome(null); }, [markDirty]);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setRead({ state: 'LOADING' });
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read({ organizationId: orgId, schoolId }, signal, owned).then(
      (view: SchoolLocationView) => { if (!owned()) return; setRead({ state: 'READY', read: view }); setDraft((d) => dirtyRef.current && d ? d : draftFrom(view.location)); },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof LocationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: LocationOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.save(request.scope, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE' };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof LocationError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    // A saved address is clean again, even when a privacy event hid the answer: the next read shows what the server now holds.
    if (next.kind === 'DONE' && mounted.current) markDirty(false);
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (!keep) setRefresh((n) => n + 1);
  }, [api, markDirty]);

  const current = read.state === 'READY' ? read.read : null;
  const c = locationCopy(preferences.language);
  const problems = useMemo(() => draft ? draftProblems(draft, c) : [], [draft, c]);
  const onSave = useCallback(() => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || !current || !draft) return;
    let input: SaveSchoolLocationInput;
    try { input = saveInput(current.location, draft, c); } catch { setOutcome({ kind: 'INVALID' }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, current, draft, send, c]);
  const onEdit = useCallback((field: LocationField, value: string) => {
    if (lock !== 'NONE' || !current) return;
    setDraft((d) => { const next = { ...(d ?? draftFrom(current.location)), [field]: value }; markDirty(!sameDraft(next, draftFrom(current.location))); return next; });
  }, [lock, current, markDirty]);
  const onDiscard = useCallback(() => { if (lock === 'NONE' && current) { setDraft(draftFrom(current.location)); markDirty(false); setOutcome(null); } }, [lock, current, markDirty]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolLocationSettingsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} read={read} draft={draft} dirty={dirty} problems={problems}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onEdit={onEdit} onSave={onSave} onDiscard={onDiscard} onRefresh={onRefresh} onTryAgain={onTryAgain}/>
  </div>;
}
