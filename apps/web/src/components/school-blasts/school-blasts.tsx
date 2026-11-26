'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CancelSchoolBlastInput, SaveSchoolBlastInput, SchoolBlast, SchoolBlastAudienceGroup, SchoolBlastChannel, SchoolBlastMergeField, SendSchoolBlastInput } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { BlastError, blastApi, keepForRetry, type BlastApi, type BlastScope } from './http';
import { MediaError, mediaApi, videoPageLink, type MediaApi } from '../school-media/http';
import { CheckoutError, checkoutApi, type CheckoutApi } from '../school-checkout/http';
import type { BlastOutcomeKind } from './copy';
import { blastDraftOf, blastInput, blastProblems, checkoutPageLink, insertLink, liveCheckoutLinks, insertMergeTag, insertPicture, insertVideo, newBlastDraft, pictureIdsOf, removePicture, removeVideo, videoIdsOf, scheduleInstant, scheduleOk, type BlastDraft, type BlastField } from './format';
import { SchoolBlastsView, type BlastOutcome, type BlastRead, type ListRead, type CheckoutsRead, type PicturesRead, type PreviewRead, type SendAsk } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: BlastScope } & (
  { kind: 'save'; input: SaveSchoolBlastInput } | { kind: 'send'; input: SendSchoolBlastInput } | { kind: 'cancel'; input: CancelSchoolBlastInput })>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const readState = (error: unknown) => error instanceof BlastError && error.kind === 'DENIED' ? 'DENIED' as const : 'UNAVAILABLE' as const;
const same = (a: BlastDraft | null, b: BlastDraft | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Marketing > Blasts (0621). Staff with marketing.blast.read see the school's blasts; with marketing.blast.send they write a
 * draft, check its audience and send it now or schedule it. The draft stays in memory until saved; a school change or
 * session end drops it. Every command answer is followed by a fresh list read.
 */
export function SchoolBlasts({ api = blastApi, media = mediaApi, checkout = checkoutApi }: { api?: BlastApi; media?: Pick<MediaApi, 'library'>; checkout?: Pick<CheckoutApi, 'pages' | 'links'> }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ListRead>({ state: 'LOADING' });
  const [selected, setSelected] = useState<BlastRead>(null);
  const [draft, setDraft] = useState<BlastDraft | null>(null);
  const [saved, setSaved] = useState<BlastDraft | null>(null);
  const [preview, setPreview] = useState<PreviewRead>(null);
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [ask, setAsk] = useState<SendAsk>(null);
  const [outcome, setOutcome] = useState<BlastOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  // 0653: the school's ready pictures, read once a draft or blast with an email needs them.
  const [pictures, setPictures] = useState<PicturesRead>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 0654: the video picker (email video lines, or a text's plain video link) reads the same library.
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  // BL2: the school's Live checkout pages and their share links, read each time the picker opens.
  const [checkouts, setCheckouts] = useState<CheckoutsRead>(null);
  const [checkoutPickerOpen, setCheckoutPickerOpen] = useState(false);
  const gen = useRef(0), privacy = useRef(0), detail = useRef(0), mounted = useRef(false), lastSchool = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; detail.current++; pending.current = null; }; }, []);

  const forget = useCallback(() => { setDraft(null); setSaved(null); setSelected(null); setPreview(null); setAsk(null); setScheduleLocal(''); setOutcome(null); setPictures(null); setPickerOpen(false); setVideoPickerOpen(false); }, []);
  useEffect(() => onShellPrivacyEvent((event) => {
    concealShellPrivateNow(); gen.current++; privacy.current++; detail.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setList({ state: 'LOADING' }); setPictures(null);
    if (event.type === HON_SESSION_INVALIDATED_EVENT || event.type === HON_SCHOOL_CONTEXT_CHANGED_EVENT) forget();
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), [forget]);

  const school = schoolId ? schoolId.toLowerCase() : null;
  useEffect(() => {
    if (school !== null && lastSchool.current !== null && school !== lastSchool.current) forget();
    if (school !== null) lastSchool.current = school;
  }, [school, forget]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList((l) => l.state === 'READY' ? l : { state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then((blasts) => { if (owned()) setList({ state: 'READY', blasts }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: readState(error) }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const needPictures = (draft?.channel === 'EMAIL') || (!!draft && videoPickerOpen)
    || (selected?.state === 'READY' && (pictureIdsOf(selected.blast.body).length > 0 || videoIdsOf(selected.blast.body).length > 0));
  useEffect(() => {
    if (!needPictures || pictures !== null || !orgId || !schoolId) return;
    const shown = privacy.current, scope = { organizationId: orgId, schoolId };
    const owned = () => mounted.current && shown === privacy.current;
    setPictures({ state: 'LOADING' });
    media.library(scope, AbortSignal.timeout(15000), owned).then((library) => { if (owned()) setPictures({ state: 'READY', assets: library.assets.filter(a => a.state === 'READY') }); },
      (error) => { if (owned()) setPictures({ state: error instanceof MediaError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
  }, [needPictures, pictures, media, orgId, schoolId]);

  useEffect(() => {
    if (!draft || !checkoutPickerOpen || checkouts !== null || !orgId || !schoolId) return;
    const shown = privacy.current, scope = { organizationId: orgId, schoolId }, language = preferences.language;
    const owned = () => mounted.current && shown === privacy.current;
    setCheckouts({ state: 'LOADING' });
    const signal = AbortSignal.timeout(15000);
    Promise.all([checkout.pages(scope, signal, owned), checkout.links(scope, signal, owned)]).then(([read, issued]) => {
      if (!owned()) return;
      setCheckouts({ state: 'READY', pages: liveCheckoutLinks(read, issued, language) });
    }, (error) => { if (owned()) setCheckouts({ state: error instanceof CheckoutError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
  }, [draft, checkoutPickerOpen, checkouts, checkout, orgId, schoolId, preferences.language]);

  /** Shows one blast: a draft opens in the composer, a sent or cancelled one opens read-only. */
  const show = useCallback((blast: SchoolBlast) => {
    setSelected({ state: 'READY', blast }); setPreview(null); setAsk(null); setScheduleLocal('');
    if (blast.status === 'DRAFT') { const d = blastDraftOf(blast); setDraft(d); setSaved(d); } else { setDraft(null); setSaved(null); }
  }, []);
  const load = useCallback((blastId: string) => {
    if (!orgId || !schoolId) return;
    const current = ++detail.current, shown = privacy.current;
    const owned = () => mounted.current && current === detail.current && shown === privacy.current;
    setDraft(null); setSaved(null); setPreview(null); setAsk(null); setSelected({ state: 'LOADING' });
    api.get({ organizationId: orgId, schoolId }, blastId, AbortSignal.timeout(15000), owned).then((b) => { if (owned()) show(b); },
      (error) => { if (owned()) setSelected({ state: readState(error) }); });
  }, [api, orgId, schoolId, show]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SAVING' });
    let next: BlastOutcome, keep = false, blast: SchoolBlast | null = null;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      let done: BlastOutcomeKind;
      if (request.kind === 'save') { blast = await api.save(request.scope, request.input, request.key, signal, owned); done = 'SAVED'; }
      else if (request.kind === 'send') { blast = await api.send(request.scope, request.input, request.key, signal, owned); done = request.input.sendAt ? 'SCHEDULED' : 'SENT'; }
      else { blast = await api.cancel(request.scope, request.input, request.key, signal, owned); done = 'CANCELLED'; }
      next = { kind: done };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof BlastError ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); setAsk(null);
    if (blast) show(blast);
    else if (!keep && (next?.kind === 'CHANGED' || next?.kind === 'NOT_DRAFT' || next?.kind === 'NOT_CANCELLABLE') && 'blastId' in request.input && request.input.blastId) load(request.input.blastId);
    if (!keep) setRefresh((n) => n + 1);
  }, [api, show, load]);

  const queue = useCallback((command: Omit<Pending, 'key' | 'scope'>) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { ...command, key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId } } as Pending;
    void send();
  }, [lock, orgId, schoolId, send]);

  const readyIds = useMemo(() => pictures?.state === 'READY' ? new Set(pictures.assets.filter(a => a.kind === 'IMAGE').map(a => a.assetId)) : undefined, [pictures]);
  const readyVideoIds = useMemo(() => pictures?.state === 'READY'
    ? new Set(pictures.assets.filter(a => a.kind === 'VIDEO' && a.copyState === 'DONE').map(a => a.assetId)) : undefined, [pictures]);
  const problems = useMemo(() => draft ? blastProblems(draft, readyIds, readyVideoIds) : [], [draft, readyIds, readyVideoIds]);
  const dirty = !!draft && (!draft.blastId || !same(draft, saved));
  const edit = useCallback((change: (d: BlastDraft) => BlastDraft) => {
    if (lock !== 'NONE') return;
    setDraft((d) => d ? change(d) : d); setPreview(null); setAsk(null);
  }, [lock]);
  const onEdit = useCallback((field: BlastField, value: string) => edit((d) => ({ ...d, [field]: value })), [edit]);
  const onToggleGroup = useCallback((g: SchoolBlastAudienceGroup) => edit((d) => ({ ...d, groups: d.groups.includes(g) ? d.groups.filter(x => x !== g) : [...d.groups, g] })), [edit]);
  const onInsert = useCallback((target: 'subject' | 'body', field: SchoolBlastMergeField, start: number, end: number) =>
    edit((d) => ({ ...d, [target]: insertMergeTag(d[target], start, end, field).text })), [edit]);
  const onInsertPicture = useCallback((assetId: string, start: number, end: number) => {
    edit((d) => d.channel === 'EMAIL' ? { ...d, body: insertPicture(d.body, start, end, assetId).text } : d); setPickerOpen(false);
  }, [edit]);
  const onRemovePicture = useCallback((assetId: string) => edit((d) => ({ ...d, body: removePicture(d.body, assetId) })), [edit]);
  const onTogglePicker = useCallback(() => {
    if (lock !== 'NONE') return;
    // Opening the picker reads the library again, so pictures uploaded meanwhile appear.
    setPickerOpen((open) => { if (!open) setPictures(null); return !open; });
  }, [lock]);
  const onInsertVideo = useCallback((assetId: string, start: number, end: number) => {
    edit((d) => d.channel === 'EMAIL' ? { ...d, body: insertVideo(d.body, start, end, assetId).text } : d); setVideoPickerOpen(false);
  }, [edit]);
  const onInsertVideoLink = useCallback((linkToken: string, start: number, end: number) => {
    edit((d) => d.channel === 'SMS' ? { ...d, body: insertLink(d.body, start, end, videoPageLink(globalThis.location.origin, linkToken)).text } : d); setVideoPickerOpen(false);
  }, [edit]);
  const onRemoveVideo = useCallback((assetId: string) => edit((d) => ({ ...d, body: removeVideo(d.body, assetId) })), [edit]);
  const onToggleVideoPicker = useCallback(() => {
    if (lock !== 'NONE') return;
    setVideoPickerOpen((open) => { if (!open) setPictures(null); return !open; });
  }, [lock]);
  const onInsertCheckoutLink = useCallback((publicId: string, start: number, end: number) => {
    edit((d) => ({ ...d, body: insertLink(d.body, start, end, checkoutPageLink(globalThis.location.origin, publicId)).text })); setCheckoutPickerOpen(false);
  }, [edit]);
  const onToggleCheckoutPicker = useCallback(() => {
    if (lock !== 'NONE') return;
    // Opening the picker reads the pages again, so a page published meanwhile appears.
    setCheckoutPickerOpen((open) => { if (!open) setCheckouts(null); return !open; });
  }, [lock]);
  const onNew = useCallback((channel: SchoolBlastChannel) => {
    if (lock !== 'NONE') return;
    detail.current++; setSelected(null); setDraft(newBlastDraft(channel)); setSaved(null); setPreview(null); setAsk(null); setScheduleLocal(''); setOutcome(null);
  }, [lock]);
  const onOpen = useCallback((blastId: string) => { if (lock === 'NONE') { setOutcome(null); load(blastId); } }, [lock, load]);
  const onSave = useCallback(() => { if (draft && !problems.length && dirty) queue({ kind: 'save', input: blastInput(draft) }); }, [draft, problems, dirty, queue]);
  const onPreview = useCallback(() => {
    if (!draft?.blastId || dirty || !orgId || !schoolId || lock !== 'NONE') return;
    const current = ++detail.current, shown = privacy.current, blastId = draft.blastId;
    const owned = () => mounted.current && current === detail.current && shown === privacy.current;
    setPreview({ state: 'LOADING' }); setAsk(null);
    api.audience({ organizationId: orgId, schoolId }, blastId, AbortSignal.timeout(15000), owned).then((v) => { if (owned()) setPreview({ state: 'READY', preview: v }); },
      () => { if (owned()) setPreview({ state: 'UNAVAILABLE' }); });
  }, [api, draft, dirty, orgId, schoolId, lock]);
  const instant = scheduleInstant(scheduleLocal);
  const scheduleValid = scheduleOk(instant);
  const onAsk = useCallback((mode: 'NOW' | 'AT') => {
    if (lock !== 'NONE' || preview?.state !== 'READY' || dirty) return;
    if (mode === 'AT' && !scheduleValid) return;
    setAsk({ sendAt: mode === 'AT' ? instant : null, recipients: preview.preview.outcomes.QUEUED });
  }, [lock, preview, dirty, scheduleValid, instant]);
  const onConfirm = useCallback(() => {
    if (!ask || !draft?.blastId || dirty) return;
    if (ask.sendAt && !scheduleOk(ask.sendAt)) { setAsk(null); return; }
    queue({ kind: 'send', input: { blastId: draft.blastId, expectedVersion: draft.version, sendAt: ask.sendAt } });
  }, [ask, draft, dirty, queue]);
  const onCancelBlast = useCallback(() => {
    if (selected?.state !== 'READY' || selected.blast.status !== 'QUEUED') return;
    queue({ kind: 'cancel', input: { blastId: selected.blast.blastId, expectedVersion: selected.blast.version } });
  }, [selected, queue]);
  const onClose = useCallback(() => { if (lock === 'NONE') { detail.current++; setDraft(null); setSaved(null); setSelected(null); setPreview(null); setAsk(null); } }, [lock]);

  return <div key={shell.phase} data-shell-private="">
    <SchoolBlastsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} selected={selected} draft={draft} dirty={dirty} problems={problems} preview={preview}
      scheduleLocal={scheduleLocal} scheduleValid={scheduleValid} ask={ask} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onNew={onNew} onOpen={onOpen} onEdit={onEdit} onToggleGroup={onToggleGroup} onInsert={onInsert} onSave={onSave} onClose={onClose}
      onPreview={onPreview} onScheduleLocal={(v) => { if (lock === 'NONE') { setScheduleLocal(v); setAsk(null); } }} onAsk={onAsk} onConfirm={onConfirm}
      onBack={() => setAsk(null)} onCancelBlast={onCancelBlast} onRefresh={() => { setRefresh((n) => n + 1); if (selected?.state === 'READY' && !dirty) load(selected.blast.blastId); }}
      onTryAgain={() => { void send(); }}
      pictures={pictures} pickerOpen={pickerOpen} onTogglePicker={onTogglePicker} onInsertPicture={onInsertPicture} onRemovePicture={onRemovePicture}
      videoPickerOpen={videoPickerOpen} onToggleVideoPicker={onToggleVideoPicker} onInsertVideo={onInsertVideo} onInsertVideoLink={onInsertVideoLink} onRemoveVideo={onRemoveVideo}
      checkouts={checkouts} checkoutPickerOpen={checkoutPickerOpen} onToggleCheckoutPicker={onToggleCheckoutPicker} onInsertCheckoutLink={onInsertCheckoutLink}/>
  </div>;
}
