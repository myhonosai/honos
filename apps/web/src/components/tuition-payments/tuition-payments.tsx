'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { validateRecordTuitionPaymentInput, validateVoidTuitionPaymentInput, type InvoicePayments, type ReceivablesFilter, type TuitionPaymentMethod } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { toMinor } from '../membership-changes/http';
import { TuitionError, keepForRetry, tuitionApi, type TuitionApi, type TuitionErrorKind, type TuitionScope } from './http';
import { TuitionPaymentsView, type DetailState, type ReceivablesState, type TuitionAction, type TuitionFields, type TuitionForm, type TuitionOutcome } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: TuitionAction; scope: TuitionScope; targetId: string; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
/** Failures the person can fix in the open form; every other answer closes it and reads again. */
const FIXABLE: readonly TuitionErrorKind[] = ['INVALID', 'CURRENCY', 'EXCEEDS', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof TuitionError ? error.kind : 'UNKNOWN';

/** The request body for an action, from the form and the last verified invoice read; it throws when the details are not acceptable. */
export function tuitionBody(action: TuitionAction, fields: TuitionFields, read: InvoicePayments): unknown {
  const invoice = read.invoice;
  if (action === 'void') return validateVoidTuitionPaymentInput({ expectedInvoiceVersion: invoice.version, reason: (fields.reason ?? '').trim() });
  const amountMinor = toMinor(fields.amount ?? '', invoice.currency), receivedOn = (fields.receivedOn ?? '').trim();
  // The server checks the school-local date again; this only stops an obvious future date before anything is sent.
  if (amountMinor === null || amountMinor > invoice.balanceMinor || !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || receivedOn > read.localToday) throw new TuitionError('INVALID');
  const reference = (fields.reference ?? '').trim(), note = (fields.note ?? '').trim();
  return validateRecordTuitionPaymentInput({ expectedInvoiceVersion: invoice.version, amountMinor, currency: invoice.currency, receivedOn,
    method: (fields.method ?? '') as TuitionPaymentMethod, ...(reference ? { reference } : {}), ...(note ? { note } : {}) });
}

/**
 * Tuition balances (B-TUI-1, 0240). Staff see the verified school's unpaid issued invoices (all or overdue), open one to see its
 * recorded payments, record a payment received outside HON, or void one recorded by mistake. Blur, a hidden tab, page hide, a
 * school change or a session end hide the page at once, retire every read and drop any kept command. Every command answer is
 * followed by fresh reads: the server, not this tab, says what changed. Nothing here charges, refunds or moves money.
 */
export function TuitionPayments({ api = tuitionApi }: { api?: TuitionApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ReceivablesState>({ state: 'LOADING' });
  const [detail, setDetail] = useState<DetailState>({ state: 'IDLE' });
  const [filter, setFilter] = useState<ReceivablesFilter>('OPEN');
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<TuitionForm>(null);
  const [outcome, setOutcome] = useState<TuitionOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef({ list: 0, detail: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), moreAbort = useRef<AbortController | null>(null);
  const retire = () => { gen.current.list++; gen.current.detail++; moreAbort.current?.abort(); moreAbort.current = null; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setForm(null); setOutcome(null);
    setList({ state: 'LOADING' }); setDetail({ state: 'IDLE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing chosen at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setFilter('OPEN'); setSelected(null); setForm(null); setOutcome(null); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++gen.current.list, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.receivables({ organizationId: orgId, schoolId }, filter, null, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', read, items: read.items, nextAfter: read.nextAfter, more: 'IDLE' }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = readKind(error);
        setList({ state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, filter, refresh]);

  useEffect(() => {
    const current = ++gen.current.detail, shown = privacy.current;
    if (!orgId || !schoolId || !selected) { setDetail({ state: 'IDLE' }); return; }
    setDetail({ state: 'LOADING' });
    const owned = () => mounted.current && current === gen.current.detail && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.payments({ organizationId: orgId, schoolId }, selected, signal, owned).then(
      (read) => { if (owned()) setDetail({ state: 'READY', read }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = readKind(error);
        setDetail({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, selected, refresh]);

  const onMore = useCallback(() => {
    if (list.state !== 'READY' || !list.nextAfter || list.more === 'LOADING' || !orgId || !schoolId) return;
    const prior = list, current = gen.current.list, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current && moreAbort.current === abort;
    setList({ ...prior, more: 'LOADING' });
    api.receivables({ organizationId: orgId, schoolId }, prior.read.filter, prior.nextAfter, signal, owned).then(
      (read) => {
        if (!owned()) return;
        moreAbort.current = null;
        // The next page carries fresh totals; the rows only ever grow by id, so a repeat means the list moved: read again.
        const seen = new Set(prior.items.map((i) => i.invoiceId));
        if (read.items.some((i) => seen.has(i.invoiceId))) { setRefresh((n) => n + 1); return; }
        setList({ state: 'READY', read, items: [...prior.items, ...read.items], nextAfter: read.nextAfter, more: 'IDLE' });
      },
      () => { if (owned() && !abort.signal.aborted) { moreAbort.current = null; setList({ ...prior, more: 'FAILED' }); } });
  }, [api, list, orgId, schoolId]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: TuitionOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      // Each body was built by tuitionBody and is validated again by the API module before it is sent.
      if (request.action === 'record') await api.record(request.scope, request.targetId, request.body as never, request.key, signal, owned);
      else await api.voidPayment(request.scope, request.targetId, request.body as never, request.key, signal, owned);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof TuitionError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE' || !FIXABLE.includes(next.kind as TuitionErrorKind)) setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const read = detail.state === 'READY' && detail.read.invoice.invoiceId === selected ? detail.read : null;
  const onSubmit = useCallback((action: TuitionAction, fields: TuitionFields) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || !read || !read.canRecord) return;
    const targetId = action === 'record' ? read.invoice.invoiceId : form?.kind === 'void' ? form.paymentId : null;
    if (!targetId) return;
    let body: unknown;
    try { body = tuitionBody(action, fields, read); }
    catch { setOutcome({ kind: 'INVALID', action }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, targetId, body };
    void send();
  }, [lock, orgId, schoolId, read, form, send]);

  const onFilter = useCallback((next: ReceivablesFilter) => { if (lock === 'NONE') { setFilter(next); setForm(null); } }, [lock]);
  const onSelect = useCallback((id: string | null) => { if (lock === 'NONE') { setSelected(id); setForm(null); setOutcome(null); } }, [lock]);
  const onOpen = useCallback((next: TuitionForm) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }, [lock]);
  const onClose = useCallback(() => { if (lock === 'NONE') setForm(null); }, [lock]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <TuitionPaymentsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} filter={filter} selected={selected} detail={detail} form={form} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={onRefresh} onFilter={onFilter} onSelect={onSelect} onMore={onMore} onOpen={onOpen} onClose={onClose} onSubmit={onSubmit} onTryAgain={onTryAgain}/>
  </div>;
}
