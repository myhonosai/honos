'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PAPER_IMPORT_MAX_PAGES, PAPER_IMPORT_MAX_ROWS, type PaperImportDetail, type PaperImportKind, type PaperImportSummary } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { PaperError, cleanCell, clipCell, keepForRetry, paperImportApi, preparePhoto, type PaperErrorKind, type PaperImportApi, type PaperScope } from './http';
import { PaperImportView, shownDetail, type PageImage, type PaperAction, type PaperDetailState, type PaperDraft, type PaperListState, type PaperOutcome } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string | null; action: PaperAction; scope: PaperScope; setId: string | null; kind: PaperImportKind | null; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
type Result = { ok: true; value: PaperImportSummary | PaperImportDetail } | { ok: false };
const readKind = (error: unknown): PaperErrorKind => error instanceof PaperError ? error.kind : 'UNKNOWN';
/** Failures the person can fix where they are; every other answer reloads the set. */
const FIXABLE: readonly PaperErrorKind[] = ['INVALID', 'RATE', 'UNKNOWN', 'EMPTY', 'IMAGE', 'DUPLICATE'];
const SAMPLE: Readonly<Record<PaperImportKind, string>> = { STUDENT_CARDS: 'student-card', CONTRACTS: 'contract', ATTENDANCE_SHEETS: 'attendance-sheet' };

function draftOf(detail: PaperImportDetail): PaperDraft {
  const width = detail.columns.length;
  const rows = detail.rows.length ? detail.rows : [Array<string>(width).fill('')];
  const unsure = detail.rows.length ? detail.unsure : [Array<boolean>(width).fill(false)];
  return { setId: detail.set.id, version: detail.set.version, rows, unsure, dirty: false };
}

/**
 * Import from photos (0388). Staff photograph student cards, contracts or attendance sheets; HON reads the set once into a
 * table (only the stand-in reader for now); staff check every cell beside the photo, save, and send the table to the
 * existing import review, where nothing is added until each row is decided. Blur, a hidden tab, page hide, a school change
 * or a session end hide the page at once, retire every read, and drop the photos, the table and any kept command held in memory.
 */
export function PaperImport({ api = paperImportApi }: { api?: PaperImportApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<PaperListState>({ state: 'LOADING' });
  const [detail, setDetail] = useState<PaperDetailState>({ state: 'IDLE' });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<PaperDraft | null>(null);
  const [images, setImages] = useState<Record<string, PageImage>>({});
  const [viewing, setViewing] = useState(1);
  const [startKind, setStartKind] = useState<PaperImportKind>('STUDENT_CARDS');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [outcome, setOutcome] = useState<PaperOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [uploading, setUploading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const gen = useRef({ list: 0, detail: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), fetched = useRef(new Set<string>());
  const retire = () => { gen.current.list++; gen.current.detail++; };
  const forget = () => { setDraft(null); setImages({}); fetched.current = new Set(); setViewing(1); setConfirmDelete(false); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setUploading(false); setOutcome(null); forget();
    setList({ state: 'LOADING' }); setDetail({ state: 'IDLE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing opened at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelected(null); setOutcome(null); forget(); }
    if (school !== null) lastSchool.current = school;
  }, [school]);

  useEffect(() => {
    const current = ++gen.current.list, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current.list && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', list: read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: readKind(error) === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  useEffect(() => {
    const current = ++gen.current.detail, shown = privacy.current;
    if (!orgId || !schoolId || !selected) { setDetail({ state: 'IDLE' }); return; }
    setDetail((d) => d.state === 'READY' && d.detail.set.id.toLowerCase() === selected.toLowerCase() ? d : { state: 'LOADING' });
    const owned = () => mounted.current && current === gen.current.detail && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    api.detail({ organizationId: orgId, schoolId }, selected, signal, owned).then(
      (read) => { if (owned()) setDetail({ state: 'READY', detail: read }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = readKind(error);
        setDetail({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, selected, refresh]);

  const ready = shownDetail({ detail, selected });

  // The table follows the server, except unsaved edits to the same version stay until they are saved or the set changes.
  useEffect(() => {
    if (!ready || ready.set.status !== 'READ') { if (ready) setDraft(null); return; }
    setDraft((d) => d && d.dirty && d.setId.toLowerCase() === ready.set.id.toLowerCase() && d.version === ready.set.version ? d : draftOf(ready));
  }, [ready]);

  // Each photo is fetched once per set while the page is shown, by its checksum, and only kept in memory.
  useEffect(() => {
    if (!ready || !orgId || !schoolId || ready.set.status === 'DELETED') return;
    const shown = privacy.current, setId = ready.set.id;
    for (const pg of ready.pages) {
      const tag = `${setId}:${pg.checksum}`;
      if (fetched.current.has(tag)) continue;
      fetched.current.add(tag);
      setImages((m) => ({ ...m, [tag]: { state: 'LOADING' } }));
      const owned = () => mounted.current && shown === privacy.current;
      api.page({ organizationId: orgId, schoolId }, setId, pg.pageNo, AbortSignal.timeout(20000), owned).then(
        (page) => { if (owned()) setImages((m) => ({ ...m, [tag]: { state: 'READY', src: `data:${page.mediaType};base64,${page.data}` } })); },
        () => { fetched.current.delete(tag); if (owned()) setImages((m) => ({ ...m, [tag]: { state: 'UNAVAILABLE' } })); });
    }
    if (ready.pages.length && viewing > ready.pages.length) setViewing(ready.pages.length);
  }, [api, ready, orgId, schoolId, viewing]);

  const send = useCallback(async (): Promise<Result> => {
    const request = pending.current;
    if (!request || sending.current) return { ok: false };
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: PaperOutcome, keep = false, result: Result = { ok: false };
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current === request;
      const signal = AbortSignal.timeout(request.action === 'read' ? 120000 : 60000), id = request.setId ?? '', key = request.key ?? '';
      const body = request.body as never;
      const value = request.action === 'create' ? await api.create(request.scope, request.kind!, key, signal, owned)
        : request.action === 'page' ? await api.addPage(request.scope, id, body, key, signal, owned)
        : request.action === 'read' ? await api.read(request.scope, id, (body as { expectedVersion: number }).expectedVersion, signal, owned)
        : request.action === 'save' ? await api.save(request.scope, id, request.kind!, body, key, signal, owned)
        : request.action === 'send' ? await api.send(request.scope, id, (body as { expectedVersion: number }).expectedVersion, key, signal, owned)
        : await api.remove(request.scope, id, key, signal, owned);
      next = { kind: 'DONE', action: request.action }; result = { ok: true, value };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof PaperError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current === request) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return { ok: false };
    setOutcome(next);
    if (result.ok) {
      const value = result.value;
      if (request.action === 'create' && 'id' in value) { forget(); setSelected(value.id); }
      if (request.action === 'read' && 'set' in value) setDetail({ state: 'READY', detail: value });
      if (request.action === 'save' && 'version' in value) {
        const saved = request.body as { rows: string[][]; unsure: boolean[][] };
        setDetail((d) => d.state === 'READY' && d.detail.set.id.toLowerCase() === value.id.toLowerCase() && value.version > d.detail.set.version
          ? { state: 'READY', detail: { ...d.detail, set: value, rows: saved.rows, unsure: saved.unsure } } : d);
        setDraft(null);
      }
      if (request.action === 'remove') { setConfirmDelete(false); setDraft(null); setImages({}); }
    } else if (!FIXABLE.includes(next.kind as PaperErrorKind)) setDraft(null);
    setRefresh((n) => n + 1);
    return result;
  }, [api]);

  const start = useCallback((action: PaperAction, setId: string | null, kind: PaperImportKind | null, body: unknown): Promise<Result> => {
    if (pending.current || sending.current || !orgId || !schoolId) return Promise.resolve({ ok: false });
    pending.current = { key: action === 'read' ? null : globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, setId, kind, body };
    return send();
  }, [orgId, schoolId, send]);
  const idle = lock === 'NONE' && !uploading;

  const upload = useCallback(async (blobs: readonly Blob[]) => {
    if (!idle || !ready || ready.set.status !== 'OPEN' || blobs.length === 0) return;
    const shown = privacy.current, set = ready.set, room = PAPER_IMPORT_MAX_PAGES - ready.pages.length;
    setUploading(true); setOutcome(null);
    try {
      let version = set.version;
      for (const blob of blobs.slice(0, Math.max(0, room))) {
        const photo = await preparePhoto(blob);
        if (shown !== privacy.current || !mounted.current) return;
        if (!photo.ok) { setOutcome({ kind: photo.problem === 'TOO_BIG' ? 'TOO_BIG' : 'IMAGE', action: 'page' }); return; }
        const result = await start('page', set.id, null, { expectedVersion: version, mediaType: photo.mediaType, data: photo.data });
        if (!result.ok || !('version' in result.value)) return;
        version = result.value.version;
      }
      if (blobs.length > room) setOutcome({ kind: 'FULL', action: 'page' });
    } finally { if (mounted.current) setUploading(false); }
  }, [idle, ready, start]);

  const onFiles = useCallback((files: readonly File[]) => { void upload(files); }, [upload]);
  const onSample = useCallback(() => {
    if (!idle || !ready) return;
    const shown = privacy.current;
    fetch(`/paper-import-samples/${SAMPLE[ready.set.kind]}.png`, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then((r) => r.ok ? r.blob() : Promise.reject(new Error('sample')))
      .then((blob) => { if (shown === privacy.current && mounted.current) void upload([blob.type ? blob : new Blob([blob], { type: 'image/png' })]); },
        () => { if (shown === privacy.current && mounted.current) setOutcome({ kind: 'UNKNOWN', action: 'page' }); });
  }, [idle, ready, upload]);

  const onOpen = useCallback((setId: string | null) => {
    if (!idle) return;
    forget(); setOutcome(null); setSelected(setId);
  }, [idle]);
  const onStart = useCallback(() => { if (idle) void start('create', null, startKind, { kind: startKind }); }, [idle, start, startKind]);
  const onRead = useCallback(() => { if (idle && ready?.set.status === 'OPEN') void start('read', ready.set.id, null, { expectedVersion: ready.set.version }); }, [idle, ready, start]);
  const onCell = useCallback((row: number, column: number, value: string) => {
    if (!idle) return;
    setDraft((d) => {
      if (!d || !d.rows[row] || column < 0 || column >= d.rows[row]!.length) return d;
      const rows = d.rows.map((r, i) => i === row ? r.map((c, j) => j === column ? clipCell(value) : c) : r);
      const unsure = d.unsure.map((u, i) => i === row ? u.map((x, j) => j === column ? false : x) : u);
      return { ...d, rows, unsure, dirty: true };
    });
  }, [idle]);
  const onAddRow = useCallback(() => {
    if (!idle || !ready) return;
    const width = ready.columns.length;
    setDraft((d) => d && d.rows.length < PAPER_IMPORT_MAX_ROWS ? { ...d, rows: [...d.rows, Array<string>(width).fill('')], unsure: [...d.unsure, Array<boolean>(width).fill(false)], dirty: true } : d);
  }, [idle, ready]);
  const onRemoveRow = useCallback((row: number) => {
    if (!idle) return;
    setDraft((d) => d && d.rows.length > 1 ? { ...d, rows: d.rows.filter((_, i) => i !== row), unsure: d.unsure.filter((_, i) => i !== row), dirty: true } : d);
  }, [idle]);
  const onSave = useCallback(() => {
    if (!idle || !ready || !draft || !draft.dirty || draft.setId.toLowerCase() !== ready.set.id.toLowerCase()) return;
    void start('save', ready.set.id, ready.set.kind, { expectedVersion: draft.version, rows: draft.rows.map((r) => r.map(cleanCell)), unsure: draft.unsure.map((u) => [...u]) });
  }, [idle, ready, draft, start]);
  const onSend = useCallback(() => {
    if (!idle || !ready || ready.set.status !== 'READ' || draft?.dirty) return;
    void start('send', ready.set.id, null, { expectedVersion: ready.set.version });
  }, [idle, ready, draft, start]);
  const onDelete = useCallback((confirmed: boolean | null) => {
    if (!idle || !ready) return;
    if (confirmed === null) { setConfirmDelete(true); return; }
    if (!confirmed) { setConfirmDelete(false); return; }
    void start('remove', ready.set.id, null, {});
  }, [idle, ready, start]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  const byPage: Record<number, PageImage> = {};
  for (const pg of ready?.pages ?? []) { const image = images[`${ready!.set.id}:${pg.checksum}`]; if (image) byPage[pg.pageNo] = image; }

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <PaperImportView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} selected={selected} detail={detail} draft={draft} images={byPage} viewing={viewing} startKind={startKind}
      confirmDelete={confirmDelete} outcome={outcome} locked={!idle} canRetry={lock === 'KEPT' && !uploading}
      onRefresh={onRefresh} onOpen={onOpen} onStartKind={(k) => { if (idle) setStartKind(k); }} onStart={onStart} onFiles={onFiles} onSample={onSample}
      onView={setViewing} onRead={onRead} onCell={onCell} onAddRow={onAddRow} onRemoveRow={onRemoveRow} onSave={onSave} onSend={onSend}
      onDelete={onDelete} onTryAgain={onTryAgain}/>
  </div>;
}
