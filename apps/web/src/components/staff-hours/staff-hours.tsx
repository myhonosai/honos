'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveTimeEntryInput, TimeClockAction, TimeClockPunchInput, TimeEntry, TimesheetDecisionInput, TimesheetPerson } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { addDays, weekStart as mondayOf } from '../school-calendar/range';
import { HoursError, hoursApi, keepForRetry, type HoursApi, type HoursScope } from './http';
import { hoursCopy, type HoursOutcomeKind } from './copy';
import { entryDraftOf, entryInput, entryProblems, newEntryDraft, timesheetCsv, type EntryDraft, type EntryField } from './format';
import { StaffHoursView, type ClockRead, type HoursOutcome, type SheetRead } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: HoursScope } & (
  { kind: 'punch'; input: TimeClockPunchInput } | { kind: 'entry'; input: SaveTimeEntryInput } | { kind: 'decide'; input: TimesheetDecisionInput })>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const browserToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const readState = (error: unknown) => error instanceof HoursError && error.kind === 'DENIED' ? 'DENIED' as const : 'UNAVAILABLE' as const;

/** Save a CSV in the browser. Nothing leaves the device. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Staff > Hours (0478). Anyone with staff.time.clock clocks in and out here at the server's clock; managers with
 * staff.timesheet.manage see everyone's week, fix entries with a reason, approve or reopen, and export CSV. The form stays
 * in memory only; a school change or session end drops it. Every command answer is followed by a fresh read.
 */
export function StaffHours({ api = hoursApi, initialToday, save = download }: { api?: HoursApi; initialToday?: string; save?: (name: string, text: string) => void }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [weekStart, setWeekStart] = useState(() => mondayOf(initialToday ?? browserToday()));
  const [clock, setClock] = useState<ClockRead>({ state: 'LOADING' });
  const [sheet, setSheet] = useState<SheetRead>({ state: 'LOADING' });
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [outcome, setOutcome] = useState<HoursOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  const forget = useCallback(() => { setDraft(null); setOutcome(null); }, []);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setClock({ state: 'LOADING' }); setSheet({ state: 'LOADING' });
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setClock({ state: 'LOADING' }); setSheet({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const scope = { organizationId: orgId, schoolId };
    api.clock(scope, signal, owned).then((c) => { if (owned()) setClock({ state: 'READY', clock: c }); },
      (error) => { if (owned() && !abort.signal.aborted) setClock({ state: readState(error) }); });
    api.timesheet(scope, weekStart, signal, owned).then((w) => { if (owned()) setSheet({ state: 'READY', week: w }); },
      (error) => { if (owned() && !abort.signal.aborted) setSheet({ state: readState(error) }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, weekStart, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SAVING' });
    let next: HoursOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      let done: HoursOutcomeKind;
      if (request.kind === 'punch') { await api.punch(request.scope, request.input, request.key, signal, owned); done = 'PUNCHED'; }
      else if (request.kind === 'entry') { await api.saveEntry(request.scope, request.input, request.key, signal, owned); done = 'SAVED'; }
      else { await api.decide(request.scope, request.input, request.key, signal, owned); done = request.input.action === 'APPROVE' ? 'APPROVED_WEEK' : 'REOPENED'; }
      next = { kind: done };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof HoursError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (request.kind === 'entry' && (next?.kind === 'SAVED' || next?.kind === 'CHANGED' || next?.kind === 'GONE')) setDraft(null);
    if (!keep) setRefresh((n) => n + 1);
  }, [api]);

  const c = hoursCopy(preferences.language);
  const problems = useMemo(() => draft ? entryProblems(draft, c) : [], [draft, c]);
  const queue = useCallback((command: Omit<Pending, 'key' | 'scope'>) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { ...command, key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId } } as Pending;
    void send();
  }, [lock, orgId, schoolId, send]);
  const onPunch = useCallback((action: TimeClockAction) => {
    if (clock.state !== 'READY') return;
    const open = clock.clock.open;
    queue({ kind: 'punch', input: { action, expectedVersion: action === 'CLOCK_IN' ? 0 : open?.version ?? 0 } });
  }, [clock, queue]);
  const timezone = sheet.state === 'READY' ? sheet.week.timezone : null;
  const onAdd = useCallback((principalId: string) => { if (lock === 'NONE') { setDraft(newEntryDraft(principalId, weekStart)); setOutcome(null); } }, [lock, weekStart]);
  const onFix = useCallback((entry: TimeEntry) => { if (lock === 'NONE' && timezone) { setDraft(entryDraftOf(entry, timezone)); setOutcome(null); } }, [lock, timezone]);
  const onEdit = useCallback((field: EntryField, value: string) => { if (lock === 'NONE') setDraft((d) => d ? { ...d, [field]: value } : d); }, [lock]);
  const onSave = useCallback(() => { if (draft && !problems.length) queue({ kind: 'entry', input: entryInput(draft) }); }, [draft, problems, queue]);
  const onDecide = useCallback((person: TimesheetPerson, action: 'APPROVE' | 'REOPEN') => {
    queue({ kind: 'decide', input: { staffPrincipalId: person.principalId, weekStart, action, expectedVersion: person.approval?.version ?? 0 } });
  }, [queue, weekStart]);
  const onExport = useCallback(() => { if (sheet.state === 'READY') save(c.csv.fileName(sheet.week.weekStart), timesheetCsv(sheet.week, c)); }, [sheet, save, c]);
  const onWeek = useCallback((step: -1 | 0 | 1) => {
    if (lock !== 'NONE') return;
    setDraft(null); setOutcome(null);
    setWeekStart((w) => step === 0 ? mondayOf(initialToday ?? browserToday()) : addDays(w, 7 * step));
  }, [lock, initialToday]);

  return <div key={shell.phase} data-shell-private="">
    <StaffHoursView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} clock={clock} sheet={sheet} weekStart={weekStart} draft={draft} problems={problems} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onPunch={onPunch} onWeek={onWeek} onAdd={onAdd} onFix={onFix} onEdit={onEdit}
      onSave={onSave} onClose={() => { if (lock === 'NONE') setDraft(null); }}
      onDecide={onDecide} onExport={onExport} onRefresh={() => setRefresh((n) => n + 1)} onTryAgain={() => { void send(); }}/>
  </div>;
}
