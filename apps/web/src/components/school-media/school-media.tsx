'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { schoolMediaTitleFromFileName, schoolMediaTitleOk, type DeleteSchoolMediaInput, type RenameSchoolMediaInput, type SchoolMediaAsset } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MediaError, isVideoFile, keepForRetry, mediaApi, mediaFileProblem, mediaLink, videoFileProblem, videoPageLink, type MediaApi, type MediaScope, type MediaUpload, type VideoUpload } from './http';
import type { MediaOutcomeKind } from './copy';
import { SchoolMediaView, type LibraryRead, type MediaEditing, type MediaOutcome } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server answers the first result). */
type Pending = Readonly<{ key: string; scope: MediaScope } & (
  { kind: 'upload'; input: MediaUpload } | { kind: 'video'; input: VideoUpload } | { kind: 'rename'; input: RenameSchoolMediaInput } | { kind: 'delete'; input: DeleteSchoolMediaInput })>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const readState = (error: unknown) => error instanceof MediaError && error.kind === 'DENIED' ? 'DENIED' as const : 'UNAVAILABLE' as const;

/**
 * Marketing > Media (0628). Staff with marketing.media.read see the school's pictures and storage use; with
 * marketing.media.manage they upload (one file at a time, in order), rename and delete. Picked files stay in memory only until
 * sent; a school change or session end drops them. Every command answer is followed by a fresh library read.
 */
export function SchoolMedia({ api = mediaApi }: { api?: MediaApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [library, setLibrary] = useState<LibraryRead>({ state: 'LOADING' });
  const [editing, setEditing] = useState<MediaEditing>(null);
  const [outcome, setOutcome] = useState<MediaOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false), waiting = useRef<File[]>([]), nextUpload = useRef<() => void>(() => undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; waiting.current = []; }; }, []);

  const forget = useCallback(() => { setEditing(null); setOutcome(null); waiting.current = []; }, []);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null; waiting.current = [];
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setLibrary({ state: 'LOADING' });
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setLibrary((l) => l.state === 'READY' ? l : { state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.library({ organizationId: orgId, schoolId }, signal, owned).then((value) => { if (owned()) setLibrary({ state: 'READY', library: value }); },
      (error) => { if (owned() && !abort.signal.aborted) setLibrary({ state: readState(error) }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async (): Promise<void> => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome(request.kind === 'video' ? { kind: 'UPLOADING', percent: 0 } : { kind: request.kind === 'upload' ? 'UPLOADING' : 'WORKING' });
    let next: MediaOutcomeKind, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      // A video goes straight to storage and may be large: up to six hours.
      const signal = AbortSignal.timeout(request.kind === 'video' ? 6 * 3600000 : request.kind === 'upload' ? 180000 : 30000);
      if (request.kind === 'upload') { await api.upload(request.scope, request.input, request.key, signal, owned); next = 'UPLOADED'; }
      else if (request.kind === 'video') {
        await api.uploadVideo(request.scope, request.input, request.key, signal, owned, (percent) => { if (owned()) setOutcome({ kind: 'UPLOADING', percent }); });
        next = 'VIDEO_UPLOADED';
      }
      else if (request.kind === 'rename') { await api.rename(request.scope, request.input, request.key, signal, owned); next = 'RENAMED'; }
      else { next = (await api.remove(request.scope, request.input, request.key, signal, owned)).removed ? 'DELETED' : 'DELETED_WAITING'; }
    } catch (error) {
      keep = keepForRetry(error);
      next = error instanceof MediaError ? error.kind : 'UNKNOWN';
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome({ kind: next });
    if (!keep) { setEditing(null); setRefresh((n) => n + 1); }
    // The next picked file goes only after this one is settled; a failure stops the rest.
    if (!keep && ((request.kind === 'upload' && next === 'UPLOADED') || (request.kind === 'video' && next === 'VIDEO_UPLOADED'))) nextUpload.current();
    else waiting.current = [];
  }, [api]);

  const queue = useCallback((command: Omit<Pending, 'key' | 'scope'>, scope: MediaScope) => {
    pending.current = { ...command, key: globalThis.crypto.randomUUID(), scope } as Pending;
    void send();
  }, [send]);
  const scopeNow = useCallback((): MediaScope | null => orgId && schoolId ? { organizationId: orgId, schoolId } : null, [orgId, schoolId]);
  const startNextUpload = useCallback(() => {
    const scope = scopeNow();
    const file = waiting.current.shift();
    if (!file || !scope || pending.current || sending.current) return;
    if (isVideoFile(file)) {
      const video = videoFileProblem(file);
      if ('problem' in video) { waiting.current = []; setOutcome({ kind: video.problem }); return; }
      queue({ kind: 'video', input: { file, title: schoolMediaTitleFromFileName(file.name), mediaType: video.mediaType } }, scope);
      return;
    }
    const problem = mediaFileProblem(file);
    if (problem) { waiting.current = []; setOutcome({ kind: problem }); return; }
    queue({ kind: 'upload', input: { file, title: schoolMediaTitleFromFileName(file.name) } }, scope);
  }, [scopeNow, queue]);
  useEffect(() => { nextUpload.current = startNextUpload; }, [startNextUpload]);

  const onFiles = useCallback((files: readonly File[]) => {
    if (lock !== 'NONE' || pending.current || sending.current) return;
    setEditing(null);
    waiting.current = files.slice(0, 20);
    startNextUpload();
  }, [lock, startNextUpload]);
  const onCopy = useCallback((asset: SchoolMediaAsset) => {
    if (!asset.linkToken) return;
    const origin = globalThis.location?.origin ?? '';
    const link = asset.kind === 'VIDEO' ? videoPageLink(origin, asset.linkToken) : mediaLink(origin, asset.linkToken);
    void globalThis.navigator?.clipboard?.writeText(link).then(() => { if (mounted.current) setOutcome({ kind: 'COPIED' }); }, () => undefined);
  }, []);
  const onRename = useCallback((asset: SchoolMediaAsset) => { if (lock === 'NONE') { setOutcome(null); setEditing({ assetId: asset.assetId, mode: 'RENAME', title: asset.title }); } }, [lock]);
  const onTitle = useCallback((title: string) => setEditing((e) => e?.mode === 'RENAME' ? { ...e, title } : e), []);
  const onSaveTitle = useCallback(() => {
    const scope = scopeNow();
    if (lock !== 'NONE' || editing?.mode !== 'RENAME' || !scope || library.state !== 'READY' || !schoolMediaTitleOk(editing.title)) return;
    const asset = library.library.assets.find(a => a.assetId === editing.assetId);
    if (!asset || asset.title === editing.title) return;
    queue({ kind: 'rename', input: { assetId: asset.assetId, expectedVersion: asset.version, title: editing.title } }, scope);
  }, [lock, editing, scopeNow, library, queue]);
  const onDelete = useCallback((asset: SchoolMediaAsset) => { if (lock === 'NONE') { setOutcome(null); setEditing({ assetId: asset.assetId, mode: 'DELETE' }); } }, [lock]);
  const onConfirmDelete = useCallback(() => {
    const scope = scopeNow();
    if (lock !== 'NONE' || editing?.mode !== 'DELETE' || !scope || library.state !== 'READY') return;
    const asset = library.library.assets.find(a => a.assetId === editing.assetId);
    if (asset) queue({ kind: 'delete', input: { assetId: asset.assetId, expectedVersion: asset.version } }, scope);
  }, [lock, editing, scopeNow, library, queue]);

  return <div key={shell.phase} data-shell-private="">
    <SchoolMediaView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} library={library} editing={editing} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onFiles={onFiles} onCopy={onCopy} onRename={onRename} onTitle={onTitle} onSaveTitle={onSaveTitle} onDelete={onDelete} onConfirmDelete={onConfirmDelete}
      onBack={() => { if (lock === 'NONE') setEditing(null); }} onRefresh={() => setRefresh((n) => n + 1)} onTryAgain={() => { void send(); }}/>
  </div>;
}
