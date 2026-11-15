'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { applyWebsiteEdit, buildWebsiteFromTemplate, suggestWebsiteSlug, type SchoolWebsite, type WebsiteDocument, type WebsiteEdit } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { WebsiteError, keepForRetry, loadWebsiteChoices, websiteApi, type WebsiteApi, type WebsiteChoices, type WebsiteCommand, type WebsiteScope } from './http';
import { WebsiteView, type Device, type Outcome, type ReadState, type StartForm } from './view';

/** A command whose outcome is not known: the exact input and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; command: WebsiteCommand; scope: WebsiteScope; input: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const NO_CHOICES: WebsiteChoices = { forms: [], bookings: [] };

/**
 * WB4 owner workspace for the school website (0361). The draft is edited in memory with the closed edit operations and
 * saved with the revision it was loaded at; publish, rollback and unpublish act on the saved draft only. Blur, a hidden
 * tab, a school change or a session end hide the page and drop unsaved edits and any kept command. Every command answer
 * is followed by a fresh read.
 */
export function SchoolWebsiteWorkspace({ api = websiteApi, choices: loadChoices = loadWebsiteChoices }: { api?: WebsiteApi; choices?: typeof loadWebsiteChoices }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null, schoolName = shell.schoolName ?? '';
  const [read, setRead] = useState<ReadState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<WebsiteDocument | null>(null), [name, setName] = useState('');
  const [start, setStart] = useState<StartForm>({ name: '', slug: '', template: 'MODERN_CLEAN' });
  const [choices, setChoices] = useState<WebsiteChoices>(NO_CHOICES);
  const [tab, setTab] = useState<'edit' | 'history'>('edit'), [device, setDevice] = useState<Device>('desktop');
  const [pageSlug, setPage] = useState('home'), [sectionId, setSection] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | 'unpublish' | number>(null), [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<Outcome>(null), [lock, setLock] = useState<Lock>('NONE'), [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  const showSite = useCallback((site: SchoolWebsite | null) => {
    setRead({ state: 'READY', website: site }); setDraft(site ? site.draft : null); setName(site?.name ?? '');
  }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setDraft(null); setConfirming(null); setRead({ state: 'LOADING' }); setChoices(NO_CHOICES);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read({ organizationId: orgId, schoolId }, signal, owned).then(
      (r) => { if (owned()) showSite(r.website); },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof WebsiteError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    loadChoices({ organizationId: orgId, schoolId }, signal, owned).then((c) => { if (owned()) setChoices(c); }, () => undefined);
    return () => { abort.abort(); };
  }, [api, loadChoices, orgId, schoolId, refresh, showSite]);

  // The start form is prefilled once from the school's name.
  useEffect(() => { if (schoolName) setStart((s) => (s.name ? s : { ...s, name: schoolName.slice(0, 120), slug: suggestWebsiteSlug(schoolName) })); }, [schoolName]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', command: request.command });
    let next: Outcome, keep = false, site: SchoolWebsite | null = null;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      site = await api.command(request.scope, request.command, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', command: request.command };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof WebsiteError ? error.kind : 'UNKNOWN', command: request.command };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); setConfirming(null);
    if (site) { showSite(site); setNote(''); if (request.command === 'rollback') { setTab('edit'); setSection(null); } }
    // A definitive refusal leaves the edits in place to fix; anything else re-reads the server's state.
    else if (next.kind === 'STALE' || next.kind === 'GONE') setRefresh((n) => n + 1);
  }, [api, showSite]);

  const run = useCallback((command: WebsiteCommand, input: unknown) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), command, scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, send]);

  const site = read.state === 'READY' ? read.website : null;
  const dirty = !!site && !!draft && (JSON.stringify(draft) !== JSON.stringify(site.draft) || name !== site.name);
  const edit = useCallback((change: WebsiteEdit) => {
    if (lock !== 'NONE') return;
    if (!draft) return;
    let next: WebsiteDocument;
    try { next = applyWebsiteEdit(draft, change); } catch { setOutcome({ kind: 'EDIT_REFUSED' }); return; }
    setDraft(next); setOutcome(null);
  }, [lock, draft]);

  return <div key={shell.phase} data-shell-private="">
    <WebsiteView language={locale.preferences.language} locale={locale.formattingLocale} mode={shell.mode}
      waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} schoolName={schoolName || name}
      read={read} draft={draft} name={name} dirty={dirty} start={start} choices={choices} tab={tab} device={device} pageSlug={pageSlug} sectionId={sectionId}
      confirming={confirming} note={note} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      origin={typeof window === 'undefined' ? '' : window.location.origin}
      on={{
        refresh: () => setRefresh((n) => n + 1), start: setStart,
        create: () => {
          let document: WebsiteDocument;
          try { document = buildWebsiteFromTemplate(start.template, { schoolName: start.name.trim() || schoolName }); } catch { setOutcome({ kind: 'EDIT_REFUSED' }); return; }
          run('create', { publicSlug: start.slug, name: start.name.trim(), document });
        },
        tab: (next) => { setTab(next); setConfirming(null); }, device: setDevice,
        page: (slug) => { setPage(slug); setSection(null); }, section: setSection, edit,
        name: (next) => { if (lock === 'NONE') setName(next); }, note: setNote,
        save: () => { if (site && draft) run('save', { expectedRevision: site.draftRevision, name: name.trim(), document: draft }); },
        discard: () => { if (site && lock === 'NONE') { setDraft(site.draft); setName(site.name); setOutcome(null); } },
        publish: () => { if (site && !dirty) run('publish', { expectedRevision: site.draftRevision, note: note.trim() }); },
        confirm: (next) => { if (lock === 'NONE') { setConfirming(next); setOutcome(null); } },
        unpublish: () => { if (site) run('unpublish', { expectedRevision: site.draftRevision }); },
        rollback: (version) => { if (site) run('rollback', { expectedRevision: site.draftRevision, version, note: '' }); },
        retry: () => { void send(); },
      }} />
  </div>;
}
