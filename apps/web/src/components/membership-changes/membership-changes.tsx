'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  validatePauseMembershipInput, validateRecordMembershipRefundInput, validateResumeMembershipInput, validateSetSchoolMembershipPausePolicyInput,
  type MembershipRefundMethod, type SchoolMembershipPausePolicy,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MembershipListError, membershipListApi, type MembershipListApi } from '../membership-list/http';
import { ChangeError, cancellationReason, keepForRetry, membershipChangesApi, toMinor, type ChangeErrorKind, type ChangeScope, type MembershipChangesApi } from './http';
import { MembershipChangesView, type ChangeAction, type ChangeFields, type ChangeFilter, type ChangeListState, type ChangeOutcome, type HistoryState, type PolicyState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: ChangeAction; scope: ChangeScope; membershipId: string | null; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const NEXT_FILTER: Partial<Record<ChangeAction, ChangeFilter>> = { pause: 'FROZEN', resume: 'ACTIVE', cancel: 'CANCELLED' };
/** Failures the person can fix in the open form; every other answer closes it and reads again. */
const FIXABLE: readonly ChangeErrorKind[] = ['INVALID', 'TOO_LONG', 'YEARLY', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof ChangeError ? error.kind : 'UNKNOWN';
const int = (value: string | undefined): number | null => value !== undefined && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : null;

/** The request body for an action, from the form and the last verified reads; it throws when the details are not acceptable. */
export function changeBody(action: ChangeAction, fields: ChangeFields, version: number, policy: SchoolMembershipPausePolicy | null): unknown {
  if (action === 'policy') {
    const allowed = fields.allowed === 'on', currency = (fields.feeCurrency ?? '').trim().toUpperCase();
    const fee = allowed && fields.fee === 'on' ? { amountMinor: toMinor(fields.feeAmount ?? '', currency), currency } : null;
    if (fee && fee.amountMinor === null) throw new ChangeError('INVALID');
    return validateSetSchoolMembershipPausePolicyInput({ expectedVersion: policy?.version ?? 0, pausesAllowed: allowed,
      maxPauseDays: allowed ? int(fields.max) : null, maxPausedDaysPerYear: allowed ? int(fields.year) : null, holdFee: fee });
  }
  if (action === 'pause') return validatePauseMembershipInput({ expectedVersion: version, resumeOn: fields.resumeOn ?? '', pauseReason: (fields.pauseReason ?? '').trim() });
  if (action === 'resume') {
    const note = (fields.resumeReason ?? '').trim();
    return validateResumeMembershipInput(note ? { expectedVersion: version, resumeReason: note } : { expectedVersion: version });
  }
  if (action === 'cancel') return { expectedVersion: version, cancellationReason: cancellationReason(fields.cancellationReason ?? '') };
  const currency = (fields.currency ?? '').trim().toUpperCase(), amountMinor = toMinor(fields.amount ?? '', currency);
  if (amountMinor === null) throw new ChangeError('INVALID');
  return validateRecordMembershipRefundInput({ amountMinor, currency, refundedOn: fields.refundedOn ?? '', method: (fields.method ?? '') as MembershipRefundMethod,
    reason: (fields.reason ?? '').trim() });
}

/**
 * Pause, cancel & refunds (0224). Staff choose a membership of the verified school, see its pauses and refund records, and
 * pause, resume, cancel or record a refund made outside HON; a pause-rules form sets the school's limits. Blur, a hidden tab,
 * page hide, a school change or a session end hide the page at once, retire every read and drop any kept command; reads start
 * again only after the shell re-verifies the school. Every command answer is followed by fresh reads: the server, not this
 * tab, says what changed. Nothing here charges, refunds or moves money.
 */
export function MembershipChanges({ api = membershipChangesApi, listApi = membershipListApi }: { api?: MembershipChangesApi; listApi?: MembershipListApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [policy, setPolicy] = useState<PolicyState>({ state: 'LOADING' });
  const [list, setList] = useState<ChangeListState>({ state: 'LOADING' });
  const [history, setHistory] = useState<HistoryState>({ state: 'IDLE' });
  const [filter, setFilter] = useState<ChangeFilter>('ACTIVE');
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [form, setForm] = useState<ChangeAction | null>(null);
  const [outcome, setOutcome] = useState<ChangeOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef({ policy: 0, list: 0, history: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), moreAbort = useRef<AbortController | null>(null);
  const retire = () => { gen.current.policy++; gen.current.list++; gen.current.history++; moreAbort.current?.abort(); moreAbort.current = null; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null);
    setPolicy({ state: 'LOADING' }); setList({ state: 'LOADING' }); setHistory({ state: 'IDLE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing chosen at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setFilter('ACTIVE'); setSelected(null); setForm(null); setOutcome(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++gen.current.policy, shown = privacy.current;
    setPolicy({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.policy && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.policy({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setPolicy({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setPolicy({ state: readKind(error) === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  useEffect(() => {
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++gen.current.list, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    listApi.page({ organizationId: orgId, schoolId }, filter, null, signal, owned).then(
      (page) => { if (owned()) setList({ state: 'READY', filter, items: page.items, nextCursor: page.nextCursor, more: 'IDLE' }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof MembershipListError ? error.kind : 'UNAVAILABLE';
        setList({ state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [listApi, orgId, schoolId, filter, refresh]);

  const selectedId = selected?.id ?? null;
  useEffect(() => {
    const current = ++gen.current.history, shown = privacy.current;
    if (!orgId || !schoolId || !selectedId) { setHistory({ state: 'IDLE' }); return; }
    setHistory({ state: 'LOADING' });
    const owned = () => mounted.current && current === gen.current.history && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.history({ organizationId: orgId, schoolId }, selectedId, signal, owned).then(
      (view) => { if (owned()) setHistory({ state: 'READY', view }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = readKind(error);
        setHistory({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, selectedId, refresh]);

  const onMore = useCallback(() => {
    if (list.state !== 'READY' || !list.nextCursor || list.more === 'LOADING' || !orgId || !schoolId) return;
    const prior = list, current = gen.current.list, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current && moreAbort.current === abort;
    setList({ ...prior, more: 'LOADING' });
    listApi.page({ organizationId: orgId, schoolId }, prior.filter, prior.nextCursor, signal, owned).then(
      (page) => {
        if (!owned()) return;
        moreAbort.current = null;
        const seen = new Set(prior.items.map((m) => m.membershipId.toLowerCase()));
        // A repeated row means the list moved: read it again from the start.
        if (page.items.some((m) => seen.has(m.membershipId.toLowerCase()))) { setRefresh((n) => n + 1); return; }
        setList({ ...prior, items: [...prior.items, ...page.items], nextCursor: page.nextCursor, more: 'IDLE' });
      },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        moreAbort.current = null;
        if (error instanceof MembershipListError && error.kind === 'CURSOR') { setRefresh((n) => n + 1); return; }
        setList({ ...prior, more: 'FAILED' });
      });
  }, [listApi, list, orgId, schoolId]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: ChangeOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000), id = request.membershipId ?? '';
      // Each body was built by changeBody and is validated again by the API module before it is sent.
      if (request.action === 'policy') await api.setPolicy(request.scope, request.body as never, request.key, signal, owned);
      else if (request.action === 'pause') await api.pause(request.scope, id, request.body as never, request.key, signal, owned);
      else if (request.action === 'resume') await api.resume(request.scope, id, request.body as never, request.key, signal, owned);
      else if (request.action === 'cancel') await api.cancel(request.scope, id, request.body as never, request.key, signal, owned);
      else await api.recordRefund(request.scope, id, request.body as never, request.key, signal, owned);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof ChangeError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE') { setForm(null); const f = NEXT_FILTER[request.action]; if (f) setFilter(f); }
    else if (!FIXABLE.includes(next.kind as ChangeErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const view = history.state === 'READY' && history.view.membershipId.toLowerCase() === selectedId?.toLowerCase() ? history.view : null;
  const currentPolicy = policy.state === 'READY' ? policy.read.policy : null;
  const onSubmit = useCallback((action: ChangeAction, fields: ChangeFields) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    if (action !== 'policy' && !view) return;
    let body: unknown;
    try { body = changeBody(action, fields, view?.version ?? 0, currentPolicy); }
    catch { setOutcome({ kind: 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, membershipId: action === 'policy' ? null : view!.membershipId, body };
    void send();
  }, [lock, orgId, schoolId, view, currentPolicy, send]);

  const onFilter = useCallback((next: ChangeFilter) => { if (lock === 'NONE') { setFilter(next); setForm(null); } }, [lock]);
  const onSelect = useCallback((id: string | null, label: string | null) => {
    if (lock !== 'NONE') return;
    setSelected(id && label ? { id, label } : null); setForm(null); setOutcome(null);
  }, [lock]);
  const onOpen = useCallback((next: ChangeAction) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <MembershipChangesView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} policy={policy} list={list} filter={filter} selected={selectedId} selectedLabel={selected?.label ?? null} history={history}
      form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={onRefresh} onFilter={onFilter} onSelect={onSelect} onMore={onMore} onOpen={onOpen} onClose={onClose} onSubmit={onSubmit} onTryAgain={onTryAgain}/>
  </div>;
}
