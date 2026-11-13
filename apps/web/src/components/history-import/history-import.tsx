'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HISTORY_IMPORT_MAX_BYTES, HISTORY_IMPORT_MAX_COLUMNS, type HistoryImportKind, type HistoryImportMappingTarget } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { parseCsv, keepColumns } from '../import-columns';
import { csvHeaders } from '../student-import/http';
import { ImportError, csvTooLarge, guessMapping, keepForRetry, historyImportApi, type ImportErrorKind, type ImportScope, type HistoryImportApi } from './http';
import { HistoryImportView, unsavedDecisions, type Choice, type DetailState, type ImportAction, type ImportOutcome, type ListState, type UploadState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: ImportAction; scope: ImportScope; batchId: string | null; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
/** Failures the person can fix where they are; every other answer reads again. */
const FIXABLE: readonly ImportErrorKind[] = ['INVALID', 'RATE', 'UNKNOWN'];
const readKind = (error: unknown) => error instanceof ImportError ? error.kind : 'UNKNOWN';

/**
 * Import classes and attendance history (0333). Staff pick what the file holds, upload a CSV, match its columns, and stage
 * it; the server checks every row (and matches attendance to existing students). Staff then decide each row and import
 * exactly the rows marked to import. Blur, a hidden tab, page hide, a school change or a session
 * end hide the page at once, retire every read and drop any kept command and the file in memory. Every command answer is
 * followed by fresh reads: the server, not this tab, says what changed.
 */
export function HistoryImport({ api = historyImportApi }: { api?: HistoryImportApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [detail, setDetail] = useState<DetailState>({ state: 'IDLE' });
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<HistoryImportKind>('CLASSES');
  const [upload, setUpload] = useState<UploadState>({ phase: 'NONE' });
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [outcome, setOutcome] = useState<ImportOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef({ list: 0, detail: 0, file: 0 }), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  const retire = () => { gen.current.list++; gen.current.detail++; gen.current.file++; };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; retire(); pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); retire(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setUpload({ phase: 'NONE' }); setChoices({});
    setList({ state: 'LOADING' }); setDetail({ state: 'IDLE' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  // Another school starts clean: nothing chosen at one school carries over to the next.
  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) { setSelected(null); setUpload({ phase: 'NONE' }); setChoices({}); setOutcome(null); }
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
    setDetail({ state: 'LOADING' });
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

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: ImportOutcome, keep = false, opened: string | null = null;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(60000), id = request.batchId ?? '';
      if (request.action === 'stage') opened = (await api.stage(request.scope, request.body as never, request.key, signal, owned)).id;
      else if (request.action === 'decide') await api.decide(request.scope, id, request.body as never, request.key, signal, owned);
      else await api.finalize(request.scope, id, request.body as never, request.key, signal, owned);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof ImportError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE') {
      setChoices({});
      if (opened) { setUpload({ phase: 'NONE' }); setSelected(opened); }
    } else if (!FIXABLE.includes(next.kind as ImportErrorKind)) setChoices({});
    setRefresh((n) => n + 1);
  }, [api]);

  const ready = detail.state === 'READY' && detail.detail.batch.id.toLowerCase() === selected?.toLowerCase() ? detail.detail : null;
  const start = useCallback((action: ImportAction, batchId: string | null, body: unknown) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, batchId, body };
    void send();
  }, [lock, orgId, schoolId, send]);

  const onFile = useCallback((file: File | null) => {
    if (lock !== 'NONE' || !file) return;
    setOutcome(null);
    const current = ++gen.current.file, shown = privacy.current;
    if (file.size > HISTORY_IMPORT_MAX_BYTES) { setUpload({ phase: 'FILE_ERROR', problem: 'TOO_LARGE' }); return; }
    file.text().then((text) => {
      if (!mounted.current || current !== gen.current.file || shown !== privacy.current) return;
      if (csvTooLarge(text)) { setUpload({ phase: 'FILE_ERROR', problem: 'TOO_LARGE' }); return; }
      // Exports from other software often have more columns than an import takes; those still load, and only the
      // matched columns are staged (see onStage).
      const rows = parseCsv(text), first = rows?.[0];
      const headers = first && first.length > HISTORY_IMPORT_MAX_COLUMNS && new Set(first).size === first.length && first.every((h) => h.trim() && h.length <= 80) ? first : csvHeaders(text);
      if (!headers) { setUpload({ phase: 'FILE_ERROR', problem: 'UNREADABLE' }); return; }
      setUpload({ phase: 'MAPPING', fileName: file.name.slice(0, 120), csv: text, headers, mapping: guessMapping(kind, headers) });
    }, () => { if (mounted.current && current === gen.current.file) setUpload({ phase: 'FILE_ERROR', problem: 'UNREADABLE' }); });
  }, [lock, kind]);
  const onMap = useCallback((header: string, target: HistoryImportMappingTarget) => {
    setUpload((u) => u.phase === 'MAPPING' && u.headers.includes(header) ? { ...u, mapping: { ...u.mapping, [header]: target } } : u);
  }, []);
  // Another kind re-suggests the mapping for the same file: the fields of one kind never carry over to the other.
  const onKind = useCallback((next: HistoryImportKind) => {
    if (lock !== 'NONE') return;
    setKind(next); setOutcome(null);
    setUpload((u) => u.phase === 'MAPPING' ? { ...u, mapping: guessMapping(next, u.headers) } : u.phase === 'FILE_ERROR' ? { phase: 'NONE' } : u);
  }, [lock]);
  const onCancelUpload = useCallback(() => { if (lock === 'NONE') { gen.current.file++; setUpload({ phase: 'NONE' }); } }, [lock]);
  const onStage = useCallback(() => {
    if (upload.phase !== 'MAPPING') return;
    if (upload.headers.length <= HISTORY_IMPORT_MAX_COLUMNS) { start('stage', null, { kind, csv: upload.csv, mapping: { ...upload.mapping } }); return; }
    const kept = upload.headers.filter((h) => upload.mapping[h] !== 'ignore'), rows = parseCsv(upload.csv);
    if (!rows || kept.length > HISTORY_IMPORT_MAX_COLUMNS) return;
    start('stage', null, { kind, csv: keepColumns(rows, kept), mapping: Object.fromEntries(kept.map((h) => [h, upload.mapping[h]!])) });
  }, [upload, kind, start]);

  const onOpen = useCallback((batchId: string | null) => {
    if (lock !== 'NONE') return;
    setSelected(batchId); setChoices({}); setOutcome(null);
  }, [lock]);
  const onChoice = useCallback((index: number, choice: Choice) => { if (lock === 'NONE') setChoices((c) => ({ ...c, [index]: choice })); }, [lock]);
  const onAll = useCallback((which: 'VALID' | 'SKIP') => {
    if (lock !== 'NONE' || !ready) return;
    setChoices(Object.fromEntries(ready.rows.map((r) => [r.index, which === 'VALID' && r.errors.length === 0 ? 'IMPORT' : 'SKIP'])));
  }, [lock, ready]);
  const onSave = useCallback(() => {
    if (!ready) return;
    const decisions = unsavedDecisions(ready, choices);
    if (decisions.length) start('decide', ready.batch.id, { expectedVersion: ready.batch.version, decisions });
  }, [ready, choices, start]);
  const onFinalize = useCallback(() => {
    if (!ready || ready.batch.status !== 'STAGED' || unsavedDecisions(ready, choices).length) return;
    start('finalize', ready.batch.id, { expectedVersion: ready.batch.version, selectedIndices: ready.rows.filter((r) => r.choice === 'IMPORT').map((r) => r.index) });
  }, [ready, choices, start]);
  const onRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onTryAgain = useCallback(() => { void send(); }, [send]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <HistoryImportView language={preferences.language} kind={kind} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} selected={selected} detail={detail} upload={upload} choices={choices} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={onRefresh} onOpen={onOpen} onKind={onKind} onFile={onFile} onMap={onMap} onCancelUpload={onCancelUpload} onStage={onStage}
      onChoice={onChoice} onAll={onAll} onSave={onSave} onFinalize={onFinalize} onTryAgain={onTryAgain}/>
  </div>;
}
