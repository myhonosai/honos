'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckoutGroup, CheckoutLanguage, CheckoutPageStatus, SaveCheckoutPageInput, SaveCheckoutSettingsInput, SchoolCheckoutPages } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CheckoutError, checkoutApi, keepForRetry, type CheckoutApi, type CheckoutScope } from './http';
import { draftFrom, draftProblems, duplicateDraft, editPage, newDraft, saveInputFrom, type PageDraft, type PageEdit } from './draft';
import { SchoolCheckoutView, type CheckoutEditor, type CheckoutListState, type CheckoutOutcome, type EditorTab, type GroupDraft } from './view';

/** A save whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: CheckoutScope } & ({ what: 'PAGE'; input: SaveCheckoutPageInput } | { what: 'SETTINGS'; input: SaveCheckoutSettingsInput })>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/** The grid order with one page moved one place earlier or later; null when it cannot move. */
export function movedOrder(read: SchoolCheckoutPages, pageId: string, by: -1 | 1): string[] | null {
  const ids = read.pages.map((p) => p.pageId), from = ids.indexOf(pageId), to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
  return ids;
}
/** The settings request for edited groups: a new group gets a key from its English name; the current order is kept. */
export function groupsInput(read: SchoolCheckoutPages, groups: readonly GroupDraft[]): SaveCheckoutSettingsInput {
  const taken = new Set<string>();
  const out: CheckoutGroup[] = groups.map((g) => {
    let key = g.key ?? (g.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'g_$1').slice(0, 40) || 'group');
    if (!/^[a-z]/.test(key)) key = `g_${key}`.slice(0, 40);
    for (let n = 2; taken.has(key); n++) key = `${key.replace(/_\d+$/, '')}_${n}`;
    taken.add(key);
    const label: CheckoutGroup['label'] = { en: g.label.replace(/\s+/g, ' ').trim() };
    if (g.ko) label.ko = g.ko; if (g.es) label.es = g.es;
    return { key, label };
  });
  return { expectedVersion: read.settings.version, groups: out, pageOrder: read.pages.map((p) => p.pageId) };
}

/**
 * Checkout pages (checkout CP2 over 0402), laid out like the owner's current CRM: a grid of named pages with group filters,
 * Duplicate, Draft/Live and order, and an editor with Page details, Pricing options and Agreement tabs plus a family
 * preview. Unsaved edits stay in memory only; blur or a hidden tab hides the page but keeps them, while a school change or
 * a session end drops them. Every save answer is followed by a fresh read. Nothing here takes a payment; HON adds no fee.
 */
export function SchoolCheckout({ api = checkoutApi }: { api?: CheckoutApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<CheckoutListState>({ state: 'LOADING' });
  const [filter, setFilter] = useState<string>('ALL');
  const [editor, setEditor] = useState<CheckoutEditor | null>(null);
  const [groups, setGroups] = useState<readonly GroupDraft[] | null>(null);
  const [editLanguage, setEditLanguage] = useState<CheckoutLanguage>('en');
  const [outcome, setOutcome] = useState<CheckoutOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  const forget = useCallback(() => { setEditor(null); setGroups(null); setOutcome(null); }, []);
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
      (read) => { if (owned()) setList({ state: 'READY', read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof CheckoutError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    const status = request.what === 'PAGE' ? request.input.status : null;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', what: request.what, status });
    let next: CheckoutOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      if (request.what === 'PAGE') await api.save(request.scope, request.input, request.key, signal, owned);
      else await api.saveSettings(request.scope, request.input, request.key, signal, owned);
      next = { kind: 'DONE', what: request.what, status };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof CheckoutError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', what: request.what, status };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    // A saved page or group list is closed, even when a privacy event hid the answer: the next read shows what the server now holds.
    if (next.kind === 'DONE' && mounted.current) { if (request.what === 'PAGE') setEditor(null); else setGroups(null); }
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (!keep) setRefresh((n) => n + 1);
  }, [api]);

  const read = list.state === 'READY' ? list.read : null;
  const taken = useMemo(() => read ? read.pages.filter((p) => p.pageId !== editor?.draft.pageId).map((p) => p.slug) : [], [read, editor?.draft.pageId]);
  const groupKeys = useMemo(() => read ? read.settings.groups.map((g) => g.key) : [], [read]);
  const problems = useMemo(() => read && editor ? draftProblems(editor.draft, 'DRAFT', read.plans, taken, groupKeys) : [], [read, editor, taken, groupKeys]);
  const idle = lock === 'NONE' && !pending.current && !sending.current;
  const start = useCallback((request: Omit<Pending, 'key' | 'scope'>) => {
    if (!idle || !orgId || !schoolId) return;
    pending.current = { ...request, key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId } } as Pending;
    void send();
  }, [idle, orgId, schoolId, send]);

  const onSave = useCallback((status: CheckoutPageStatus) => {
    if (!read || !editor) return;
    if (draftProblems(editor.draft, status, read.plans, taken, groupKeys).length > 0) {
      setOutcome({ kind: status === 'PUBLISHED' && editor.draft.options.length === 0 ? 'OPTIONS_REQUIRED' : 'INVALID', what: 'PAGE', status }); return;
    }
    let input: SaveCheckoutPageInput;
    try { input = saveInputFrom(editor.draft, status); } catch { setOutcome({ kind: 'INVALID', what: 'PAGE', status }); return; }
    start({ what: 'PAGE', input });
  }, [read, editor, taken, groupKeys, start]);
  const onQuickStatus = useCallback((pageId: string, status: CheckoutPageStatus) => {
    const page = read?.pages.find((p) => p.pageId === pageId);
    if (!page || editor) return;
    let input: SaveCheckoutPageInput;
    try { input = saveInputFrom(draftFrom(page), status); } catch { setOutcome({ kind: 'INVALID', what: 'PAGE', status }); return; }
    start({ what: 'PAGE', input });
  }, [read, editor, start]);
  const onMove = useCallback((pageId: string, by: -1 | 1) => {
    if (!read || editor) return;
    const order = movedOrder(read, pageId, by);
    if (order) start({ what: 'SETTINGS', input: { expectedVersion: read.settings.version, groups: read.settings.groups, pageOrder: order } });
  }, [read, editor, start]);
  const onSaveGroups = useCallback(() => {
    if (!read || !groups) return;
    start({ what: 'SETTINGS', input: groupsInput(read, groups) });
  }, [read, groups, start]);

  const openEditor = useCallback((draft: PageDraft) => { if (idle && !editor && !groups) { setEditor({ draft, dirty: false, tab: 'DETAILS' }); setOutcome(null); } }, [idle, editor, groups]);
  const onNew = useCallback(() => {
    if (!read) return;
    const group = filter !== 'ALL' && filter !== 'ARCHIVED' && groupKeys.includes(filter) ? filter : (groupKeys.includes('membership') ? 'membership' : groupKeys[0] ?? 'membership');
    openEditor(newDraft(group, read.pages[0]?.content.currency ?? read.plans[0]?.currency ?? 'USD', read.pages.map((p) => p.slug)));
  }, [read, filter, groupKeys, openEditor]);
  const onOpen = useCallback((pageId: string) => { const page = read?.pages.find((p) => p.pageId === pageId); if (page) openEditor(draftFrom(page)); }, [read, openEditor]);
  const onDuplicate = useCallback((pageId: string) => {
    const page = read?.pages.find((p) => p.pageId === pageId);
    if (page && read) openEditor(duplicateDraft(page, read.pages.map((p) => p.slug)));
  }, [read, openEditor]);
  const onEdit = useCallback((edit: PageEdit) => { if (lock === 'NONE') setEditor((e) => e ? { ...e, draft: editPage(e.draft, edit), dirty: true } : e); }, [lock]);
  const onTab = useCallback((tab: EditorTab) => setEditor((e) => e ? { ...e, tab } : e), []);
  const onClose = useCallback(() => { if (lock === 'NONE') { setEditor(null); setOutcome(null); } }, [lock]);
  const onGroupsOpen = useCallback(() => {
    if (read && idle && !editor) setGroups(read.settings.groups.map((g) => ({ key: g.key, label: g.label.en, ko: g.label.ko ?? '', es: g.label.es ?? '' })));
  }, [read, idle, editor]);
  const onGroupsEdit = useCallback((next: readonly GroupDraft[]) => { if (lock === 'NONE') setGroups(next); }, [lock]);
  const onGroupsClose = useCallback(() => { if (lock === 'NONE') setGroups(null); }, [lock]);
  const onRefreshList = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolCheckoutView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} filter={filter} editor={editor} groups={groups} editLanguage={editLanguage} problems={problems}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onFilter={setFilter} onNew={onNew} onOpen={onOpen} onDuplicate={onDuplicate} onQuickStatus={onQuickStatus} onMove={onMove}
      onEdit={onEdit} onTab={onTab} onEditLanguage={setEditLanguage} onSave={onSave} onClose={onClose}
      onGroupsOpen={onGroupsOpen} onGroupsEdit={onGroupsEdit} onGroupsSave={onSaveGroups} onGroupsClose={onGroupsClose}
      onRefreshList={onRefreshList} onTryAgain={onTryAgain}/>
  </div>;
}
