'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveStaffShiftInput, StaffShift, StaffShiftWeek } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { addDays, localDateOf, weekStart as mondayOf } from '../school-calendar/range';
import { ShiftError, shiftApi, keepForRetry, type ShiftApi, type ShiftScope } from './http';
import { shiftCopy } from './copy';
import { draftOf, draftProblems, newDraft, saveInput, type ShiftDraft, type ShiftField } from './draft';
import { StaffShiftsView, type ShiftOutcome, type ShiftReadState } from './view';

/** A save whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: ShiftScope; input: SaveStaffShiftInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const browserToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Staff > Shifts (0464). Managers put staff on shifts in a Monday-to-Sunday week; staff with view_own see their own row.
 * The form stays in memory only; a school change or session end drops it. Every save answer is followed by a fresh read.
 */
export function StaffShifts({ api = shiftApi, initialToday }: { api?: ShiftApi; initialToday?: string }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [today, setToday] = useState(() => initialToday ?? browserToday());
  const [weekStart, setWeekStart] = useState(() => mondayOf(initialToday ?? browserToday()));
  const [read, setRead] = useState<ShiftReadState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<ShiftDraft | null>(null);
  const [original, setOriginal] = useState<StaffShift | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [outcome, setOutcome] = useState<ShiftOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  const forget = useCallback(() => { setDraft(null); setOriginal(null); setConfirming(false); setOutcome(null); }, []);
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
    api.week({ organizationId: orgId, schoolId }, weekStart, signal, owned).then(
      (week: StaffShiftWeek) => {
        if (!owned()) return;
        setRead({ state: 'READY', week });
        if (!initialToday) { try { setToday(localDateOf(new Date().toISOString(), week.timezone)); } catch { /* keep the browser date */ } }
      },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof ShiftError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, weekStart, refresh, initialToday]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SAVING' });
    let next: ShiftOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.save(request.scope, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: request.input.status === 'CANCELLED' ? 'CANCELLED' : 'SAVED' };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof ShiftError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next?.kind === 'SAVED' || next?.kind === 'CANCELLED' || next?.kind === 'CHANGED' || next?.kind === 'GONE') { setDraft(null); setOriginal(null); setConfirming(false); }
    if (!keep) setRefresh((n) => n + 1);
  }, [api]);

  const c = shiftCopy(preferences.language);
  const problems = useMemo(() => draft ? draftProblems(draft, c) : [], [draft, c]);
  const queue = useCallback((input: SaveStaffShiftInput) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, send]);
  const onSave = useCallback(() => { if (draft && !problems.length) queue(saveInput(draft)); }, [draft, problems, queue]);
  // Cancelling sends the shift exactly as it was read, whatever the form now holds.
  const onConfirmCancel = useCallback(() => { if (original) queue(saveInput(draftOf(original), true)); }, [original, queue]);
  const onEdit = useCallback((field: ShiftField, value: string) => {
    if (lock !== 'NONE') return;
    // A time input cannot hold 24:00: an end of 00:00 means midnight at the end of the day.
    const v = field === 'end' && value === '00:00' ? '24:00' : value;
    setDraft((d) => d ? { ...d, [field]: v } : d);
  }, [lock]);
  const onAdd = useCallback((principalId: string, date: string) => { if (lock === 'NONE') { setDraft(newDraft(principalId, date)); setOriginal(null); setConfirming(false); setOutcome(null); } }, [lock]);
  const onOpen = useCallback((shift: StaffShift) => { if (lock === 'NONE') { setDraft(draftOf(shift)); setOriginal(shift); setConfirming(false); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') { setDraft(null); setOriginal(null); setConfirming(false); } }, [lock]);
  const onWeek = useCallback((step: -1 | 0 | 1) => {
    if (lock !== 'NONE') return;
    setDraft(null); setOriginal(null); setConfirming(false); setOutcome(null);
    setWeekStart((w) => step === 0 ? mondayOf(today) : addDays(w, 7 * step));
  }, [lock, today]);

  return <div key={shell.phase} data-shell-private="">
    <StaffShiftsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} today={today} weekStart={weekStart} read={read} showCancelled={showCancelled}
      draft={draft} problems={problems} confirmingCancel={confirming} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onWeek={onWeek} onToggleCancelled={() => setShowCancelled((v) => !v)} onAdd={onAdd} onOpen={onOpen} onEdit={onEdit} onSave={onSave} onClose={onClose}
      onAskCancel={() => setConfirming(true)} onConfirmCancel={onConfirmCancel} onKeep={() => setConfirming(false)}
      onRefresh={() => setRefresh((n) => n + 1)} onTryAgain={() => { void send(); }}/>
  </div>;
}
