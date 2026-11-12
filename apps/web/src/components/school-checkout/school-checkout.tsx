'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckoutLanguage, CheckoutPageKind, CheckoutPageStatus, SaveCheckoutPageInput, SchoolCheckoutPages } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CheckoutError, checkoutApi, keepForRetry, type CheckoutApi, type CheckoutScope } from './http';
import { contentFrom, draftFrom, draftProblems, editDraft, type CheckoutDraft, type DraftEdit } from './draft';
import { SchoolCheckoutView, type CheckoutListState, type CheckoutOutcome } from './view';

/** A save whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: CheckoutScope; input: SaveCheckoutPageInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
type Drafts = Readonly<Record<CheckoutPageKind, CheckoutDraft | null>>;
type Dirty = Readonly<Record<CheckoutPageKind, boolean>>;
const NO_DRAFTS: Drafts = { ENROLLMENT: null, TUITION: null }, CLEAN: Dirty = { ENROLLMENT: false, TUITION: false };
const pageOf = (read: SchoolCheckoutPages, kind: CheckoutPageKind) => kind === 'ENROLLMENT' ? read.enrollment : read.tuition;

/** The save request for one page, from the last verified read and the staff draft; it throws when the draft cannot be sent. */
export function saveInput(read: SchoolCheckoutPages, kind: CheckoutPageKind, status: CheckoutPageStatus, draft: CheckoutDraft): SaveCheckoutPageInput {
  if (draftProblems(draft, kind, status === 'PUBLISHED', read.plans).length > 0) throw new CheckoutError(kind === 'ENROLLMENT' && status === 'PUBLISHED' && draft.planIds.length === 0 ? 'PLANS_REQUIRED' : 'INVALID');
  return { kind, expectedVersion: pageOf(read, kind)?.version ?? 0, status, content: contentFrom(draft) };
}

/** Keep a page's unsaved draft across a fresh read; take the server's version where staff have not changed anything. */
export function mergeDrafts(read: SchoolCheckoutPages, drafts: Drafts, dirty: Dirty): Drafts {
  return { ENROLLMENT: dirty.ENROLLMENT && drafts.ENROLLMENT ? drafts.ENROLLMENT : draftFrom(read.enrollment),
    TUITION: dirty.TUITION && drafts.TUITION ? drafts.TUITION : draftFrom(read.tuition) };
}

/**
 * Checkout pages (B-TUI-2 piece 9b over 0269). A school owner chooses what families see on the enrollment checkout and the
 * tuition payment page: plans and their order, add-ons, questions, a waiver, and receipt and thank-you text, in English with
 * optional Korean and Spanish. Unsaved edits stay in memory only; blur or a hidden tab hides the page but keeps them, while
 * a school change or a session end drops them. Every save answer is followed by a fresh read. HON adds no fee.
 */
export function SchoolCheckout({ api = checkoutApi }: { api?: CheckoutApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<CheckoutListState>({ state: 'LOADING' });
  const [kind, setKind] = useState<CheckoutPageKind>('ENROLLMENT');
  const [editLanguage, setEditLanguage] = useState<CheckoutLanguage>('en');
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const [dirty, setDirty] = useState<Dirty>(CLEAN);
  const [outcome, setOutcome] = useState<CheckoutOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), dirtyRef = useRef<Dirty>(CLEAN);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const forget = useCallback(() => { setDrafts(NO_DRAFTS); setDirty(CLEAN); dirtyRef.current = CLEAN; setOutcome(null); }, []);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setList({ state: 'LOADING' });
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.pages({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (!owned()) return; setList({ state: 'READY', read }); setDrafts((d) => mergeDrafts(read, d, dirtyRef.current)); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof CheckoutError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', status: request.input.status });
    let next: CheckoutOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.save(request.scope, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', status: request.input.status };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof CheckoutError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', status: request.input.status };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    // A saved page is clean again, even when a privacy event hid the answer: the next read shows what the server now holds.
    if (next.kind === 'DONE' && mounted.current) { const clean = { ...dirtyRef.current, [request.input.kind]: false }; dirtyRef.current = clean; setDirty(clean); }
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (!keep) setRefresh((n) => n + 1);
  }, [api]);

  const read = list.state === 'READY' ? list.read : null;
  const draft = drafts[kind];
  const problems = useMemo(() => read && draft ? draftProblems(draft, kind, false, read.plans) : [], [read, draft, kind]);
  const onSave = useCallback((status: CheckoutPageStatus) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId || !read || !draft) return;
    let input: SaveCheckoutPageInput;
    try { input = saveInput(read, kind, status, draft); }
    catch (error) { setOutcome({ kind: error instanceof CheckoutError ? error.kind : 'INVALID', status }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, read, draft, kind, send]);
  const onEdit = useCallback((edit: DraftEdit) => {
    if (lock !== 'NONE' || !drafts[kind]) return;
    setDrafts((d) => d[kind] ? { ...d, [kind]: editDraft(d[kind] as CheckoutDraft, edit) } : d);
    const next = { ...dirtyRef.current, [kind]: true }; dirtyRef.current = next; setDirty(next);
  }, [lock, drafts, kind]);
  const onDiscard = useCallback(() => {
    if (lock !== 'NONE' || !read) return;
    const next = { ...dirtyRef.current, [kind]: false }; dirtyRef.current = next; setDirty(next);
    setDrafts((d) => ({ ...d, [kind]: draftFrom(pageOf(read, kind)) })); setOutcome(null);
  }, [lock, read, kind]);
  const onKind = useCallback((next: CheckoutPageKind) => { if (lock === 'NONE' && !dirtyRef.current[kind]) { setKind(next); setOutcome(null); } }, [lock, kind]);
  const onRefreshList = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolCheckoutView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} kind={kind} editLanguage={editLanguage} draft={draft} dirty={dirty[kind]} problems={problems}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onKind={onKind} onEditLanguage={setEditLanguage} onEdit={onEdit} onSave={onSave} onDiscard={onDiscard} onRefreshList={onRefreshList} onTryAgain={onTryAgain}/>
  </div>;
}
