'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CreativeAvatar, CreativeAvatarInput, CreativeAvatarReceipt, CreativeAvatarVideo, CreativeAvatarVideoInput, CreativeAvatarVideoReceipt, CreativeAvatarVideoRecords, CreativeGeneration, CreativeGenerationInput, CreativeGenerationReceipt, CreativeStudioAvatarList,
  CreativeStudioGenerationList, CreativeWebsiteDraft, CreativeWebsiteDraftInput, CreativeWebsiteDraftList, CreativeWebsiteDraftReceipt } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AccountStatusError, readSchoolCreativeWallet } from '../account-status/http';
import { CreativeGenerationError, createCreativeAvatar, createCreativeAvatarVideo, createCreativeGeneration, createCreativeWebsiteDraft, listCreativeAvatarVideos, listCreativeAvatars,
  listCreativeGenerations, listCreativeWebsiteDrafts, readCreativeWebsiteDraft } from './generation-http';
import { studioWallet, type AvatarsState, type OpenDraft, type VideosState, type WebsitesState, type CreateLock, type CreateOutcome, type GenerationsState, type StudioState, type StudioWallet } from './model';
import { CreativeStudioView } from './view';

type Scope = Readonly<{ organizationId: string; schoolId: string }>;
export type CreativeStudioApi = {
  wallet(scope: Scope, signal: AbortSignal): Promise<StudioWallet>;
  generations(scope: Scope, signal: AbortSignal): Promise<CreativeStudioGenerationList>;
  create(scope: Scope, input: CreativeGenerationInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeGenerationReceipt>;
  /** A1 (0276) avatars: optional so older test doubles keep working; without them the Avatars card says it is unavailable. */
  avatars?(scope: Scope, signal: AbortSignal): Promise<CreativeStudioAvatarList>;
  createAvatar?(scope: Scope, input: CreativeAvatarInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarReceipt>;
  /** A2 (0277) talking avatar videos: optional for the same reason. */
  videos?(scope: Scope, signal: AbortSignal): Promise<CreativeAvatarVideoRecords>;
  createVideo?(scope: Scope, input: CreativeAvatarVideoInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarVideoReceipt>;
  /** WB1 (0344) website drafts: optional for the same reason. */
  websites?(scope: Scope, signal: AbortSignal): Promise<CreativeWebsiteDraftList>;
  readWebsite?(scope: Scope, draftId: string, signal: AbortSignal): Promise<CreativeWebsiteDraft>;
  createWebsite?(scope: Scope, input: CreativeWebsiteDraftInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeWebsiteDraftReceipt>;
};
/** The wallet and generation reads plus the one closed create command. The server authorizes the exact school for each. */
export const CREATIVE_STUDIO_API: CreativeStudioApi = {
  wallet: async (scope, signal) => studioWallet(await readSchoolCreativeWallet(scope, signal)),
  generations: (scope, signal) => listCreativeGenerations(scope.schoolId, signal),
  create: (scope, input, key, signal) => createCreativeGeneration(scope.schoolId, input, key, signal),
  avatars: (scope, signal) => listCreativeAvatars(scope.schoolId, signal),
  createAvatar: (scope, input, key, signal) => createCreativeAvatar(scope.schoolId, input, key, signal),
  videos: (scope, signal) => listCreativeAvatarVideos(scope.schoolId, signal),
  createVideo: (scope, input, key, signal) => createCreativeAvatarVideo(scope.schoolId, input, key, signal),
  websites: (scope, signal) => listCreativeWebsiteDrafts(scope.schoolId, signal),
  readWebsite: (scope, draftId, signal) => readCreativeWebsiteDraft(scope.schoolId, draftId, signal),
  createWebsite: (scope, input, key, signal) => createCreativeWebsiteDraft(scope.schoolId, input, key, signal),
};

/**
 * A create whose outcome is not known yet: the exact request and key, kept in memory only so a retry can never double up.
 * unresolved: an attempt already ended without a known outcome, so a later refusal is about the retry, not the request.
 */
type Pending = Readonly<{ schoolId: string; key: string; input: CreativeGenerationInput; unresolved: boolean }>;
type PendingAvatar = Readonly<{ schoolId: string; key: string; input: CreativeAvatarInput; unresolved: boolean }>;
type PendingVideo = Readonly<{ schoolId: string; key: string; input: CreativeAvatarVideoInput; unresolved: boolean }>;
type PendingWebsite = Readonly<{ schoolId: string; key: string; input: CreativeWebsiteDraftInput; unresolved: boolean }>;
const newKey = () => globalThis.crypto.randomUUID();

export function outcomeFromReceipt(receipt: CreativeGenerationReceipt): CreateOutcome {
  switch (receipt.generation.status) {
    case 'SUCCEEDED': case 'RESOLVED_CHARGED': return { kind: 'DONE' };
    case 'UNDER_REVIEW': return { kind: 'HELD' };
    case 'FAILED': case 'RESOLVED_NOT_CHARGED': return { kind: 'FAILED' };
    case 'GENERATING': return { kind: 'UNKNOWN' };
  }
}
/**
 * What a failed attempt means. release: the request is known not to have been accepted, so its key may be dropped.
 * A 403 never proves that (access can end after the server accepted the request), and once an attempt was unknown a
 * refusal of the retry says nothing about the first send: both keep the request and its key, and claim no outcome.
 */
export function outcomeFromAttempt(error: unknown, unresolved: boolean): Readonly<{ outcome: CreateOutcome; release: boolean }> {
  if (!(error instanceof CreativeGenerationError)) return { outcome: { kind: 'UNKNOWN' }, release: false };
  switch (error.kind) {
    case 'DENIED': return { outcome: { kind: 'RETRY_BLOCKED', cause: 'DENIED', code: error.code }, release: false };
    case 'REFUSED': case 'NOT_CONNECTED': case 'INVALID':
      if (unresolved) return { outcome: { kind: 'RETRY_BLOCKED', cause: error.kind, code: error.code }, release: false };
      return { outcome: error.kind === 'REFUSED' ? { kind: 'REFUSED', code: error.code } : { kind: error.kind }, release: true };
    default: return { outcome: { kind: 'UNKNOWN' }, release: false };
  }
}

/** An avatar receipt as a create outcome: the avatar's status follows its creation generation. */
export function outcomeFromAvatarReceipt(receipt: CreativeAvatarReceipt): CreateOutcome {
  return outcomeFromReceipt({ generation: receipt.avatar.generation, balance: receipt.balance, replayed: receipt.replayed });
}
/** Avatars (and their creation generations) that may be this tab's unconfirmed avatar request: no text is shown for them. */
export function matchesPendingAvatar(request: Readonly<{ input: CreativeAvatarInput }> | null, a: Readonly<{ name: string; style: string; description: string }>): boolean {
  return !!request && a.name === request.input.name && a.style === request.input.style && a.description === request.input.description;
}
export function matchesPendingAvatarGeneration(request: Readonly<{ input: CreativeAvatarInput }> | null, g: CreativeGeneration): boolean {
  return !!request && g.operationCode === 'avatar.create' && g.prompt === request.input.description;
}

/** An avatar video receipt as a create outcome: the video's status follows its generation. */
export function outcomeFromVideoReceipt(receipt: CreativeAvatarVideoReceipt): CreateOutcome {
  return outcomeFromReceipt({ generation: receipt.video.generation, balance: receipt.balance, replayed: receipt.replayed });
}
/** Videos (and their generations) that may be this tab's unconfirmed video request: their script is not shown. */
export function matchesPendingVideo(request: Readonly<{ input: CreativeAvatarVideoInput }> | null, v: Readonly<{ avatarId: string; script: string; seconds: number; format: string }>): boolean {
  return !!request && v.avatarId === request.input.avatarId.toLowerCase() && v.script === request.input.script && v.seconds === request.input.seconds && v.format === request.input.format;
}
export function matchesPendingVideoGeneration(request: Readonly<{ input: CreativeAvatarVideoInput }> | null, g: CreativeGeneration): boolean {
  return !!request && g.operationCode === 'avatar.video' && g.prompt === request.input.script && g.units === request.input.seconds && g.format === request.input.format;
}

/** A website draft receipt as a create outcome. */
export function outcomeFromWebsiteReceipt(receipt: CreativeWebsiteDraftReceipt): CreateOutcome {
  switch (receipt.draft.status) {
    case 'SUCCEEDED': case 'RESOLVED_CHARGED': return { kind: 'DONE' };
    case 'UNDER_REVIEW': return { kind: 'HELD' };
    case 'FAILED': case 'RESOLVED_NOT_CHARGED': return { kind: 'FAILED' };
    case 'GENERATING': return { kind: 'UNKNOWN' };
  }
}
/** Drafts that may be this tab's unconfirmed website request: their brief and pages are not shown. */
export function matchesPendingWebsite(request: Readonly<{ input: CreativeWebsiteDraftInput }> | null, d: Readonly<{ operationCode: string; pages: readonly string[]; brief: string }>): boolean {
  return !!request && d.operationCode === request.input.operationCode && d.brief === request.input.brief && d.pages.join(',') === request.input.pages.join(',');
}

/** Rows that may be this tab's unconfirmed request: the list shows their status and credits, never their text. */
export function matchesPending(request: Readonly<{ input: CreativeGenerationInput }> | null, g: CreativeGeneration): boolean {
  return !!request && g.operationCode === request.input.operationCode && g.units === request.input.units
    && g.format === request.input.format && g.prompt === request.input.prompt;
}

/**
 * Creative Studio for the school the shell verified. Blur, a hidden tab, page hide, a school change or a session end
 * hide the page at once and retire every pending read; reads start again only after the shell re-verifies. A create
 * whose outcome is unknown keeps its exact request and key in memory so "Check again" replays it, never a new request.
 */
export function CreativeStudio({ api = CREATIVE_STUDIO_API }: { api?: CreativeStudioApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [studio, setStudio] = useState<StudioState>({ state: 'LOADING' });
  const [generations, setGenerations] = useState<GenerationsState>({ state: 'LOADING' });
  const [outcome, setOutcome] = useState<CreateOutcome>(null);
  // Survives a conceal: the form stays locked while a request is sending or unconfirmed, whatever is on screen.
  const [lock, setLock] = useState<CreateLock>('NONE');
  const [avatars, setAvatars] = useState<AvatarsState>({ state: 'LOADING' });
  const [avatarOutcome, setAvatarOutcome] = useState<CreateOutcome>(null);
  const [avatarLock, setAvatarLock] = useState<CreateLock>('NONE');
  const pendingAvatar = useRef<PendingAvatar | null>(null);
  const sendingAvatar = useRef(false);
  const [videos, setVideos] = useState<VideosState>({ state: 'LOADING' });
  const [videoOutcome, setVideoOutcome] = useState<CreateOutcome>(null);
  const [videoLock, setVideoLock] = useState<CreateLock>('NONE');
  const pendingVideo = useRef<PendingVideo | null>(null);
  const sendingVideo = useRef(false);
  const [websites, setWebsites] = useState<WebsitesState>({ state: 'LOADING' });
  const [websiteOutcome, setWebsiteOutcome] = useState<CreateOutcome>(null);
  const [websiteLock, setWebsiteLock] = useState<CreateLock>('NONE');
  const pendingWebsite = useRef<PendingWebsite | null>(null);
  const sendingWebsite = useRef(false);
  const [openDraft, setOpenDraft] = useState<OpenDraft>(null);
  const openRead = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  // Advances only when the page is concealed (blur, hidden tab, school change, session end), never on a read Refresh,
  // so a create answer is shown unless private display was retired while it was in flight.
  const privacy = useRef(0);
  const pending = useRef<Pending | null>(null);
  const sending = useRef(false);
  const loadedSchool = useRef<string | null>(null);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; privacy.current++; loadedSchool.current = null;
    setStudio({ state: 'LOADING' }); setGenerations({ state: 'LOADING' }); setOutcome(null); setAvatars({ state: 'LOADING' }); setAvatarOutcome(null);
    setVideos({ state: 'LOADING' }); setVideoOutcome(null); setWebsites({ state: 'LOADING' }); setWebsiteOutcome(null); openRead.current++; setOpenDraft(null);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current;
    const school = selection ? selection.schoolId.toLowerCase() : null;
    // A Refresh of the same school keeps what is shown (and any draft in the form) until the new reads answer.
    if (school === null || school !== loadedSchool.current) { setStudio({ state: 'LOADING' }); setGenerations({ state: 'LOADING' }); setAvatars({ state: 'LOADING' }); setVideos({ state: 'LOADING' }); setWebsites({ state: 'LOADING' }); openRead.current++; setOpenDraft(null); }
    loadedSchool.current = school;
    if (!selection) return;
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    if (pending.current && pending.current.schoolId !== scope.schoolId.toLowerCase()) {
      pending.current = null;
      if (!sending.current) setLock('NONE');
    }
    if (pendingAvatar.current && pendingAvatar.current.schoolId !== scope.schoolId.toLowerCase()) {
      pendingAvatar.current = null;
      if (!sendingAvatar.current) setAvatarLock('NONE');
    }
    if (pendingVideo.current && pendingVideo.current.schoolId !== scope.schoolId.toLowerCase()) {
      pendingVideo.current = null;
      if (!sendingVideo.current) setVideoLock('NONE');
    }
    if (pendingWebsite.current && pendingWebsite.current.schoolId !== scope.schoolId.toLowerCase()) {
      pendingWebsite.current = null;
      if (!sendingWebsite.current) setWebsiteLock('NONE');
    }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.wallet(scope, signal).then(
      wallet => { if (current === generation.current) setStudio({ state: 'READY', wallet }); },
      error => { if (current === generation.current) setStudio({ state: error instanceof AccountStatusError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    api.generations(scope, signal).then(
      list => { if (current === generation.current) setGenerations({ state: 'READY', provider: list.provider, items: list.generations }); },
      error => { if (current === generation.current) setGenerations({ state: error instanceof CreativeGenerationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    if (api.avatars) api.avatars(scope, signal).then(
      list => { if (current === generation.current) setAvatars({ state: 'READY', provider: list.provider, items: list.avatars }); },
      error => { if (current === generation.current) setAvatars({ state: error instanceof CreativeGenerationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    else setAvatars({ state: 'UNAVAILABLE' });
    if (api.videos) api.videos(scope, signal).then(
      list => { if (current === generation.current) setVideos({ state: 'READY', items: list.videos }); },
      error => { if (current === generation.current) setVideos({ state: error instanceof CreativeGenerationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    else setVideos({ state: 'UNAVAILABLE' });
    if (api.websites) api.websites(scope, signal).then(
      list => { if (current === generation.current) setWebsites({ state: 'READY', provider: list.provider, items: list.drafts }); },
      error => { if (current === generation.current) setWebsites({ state: error instanceof CreativeGenerationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    else setWebsites({ state: 'UNAVAILABLE' });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, api, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current || !selection || selection.schoolId.toLowerCase() !== request.schoolId) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: CreateOutcome, release: boolean;
    try {
      const receipt = await api.create({ organizationId: selection.organizationId, schoolId: request.schoolId }, request.input, request.key, AbortSignal.timeout(180000));
      next = outcomeFromReceipt(receipt); release = next?.kind !== 'UNKNOWN';
    } catch (error) { ({ outcome: next, release } = outcomeFromAttempt(error, request.unresolved)); }
    finally { sending.current = false; }
    // Only a known outcome releases the request; anything else keeps the same key for "Check again".
    if (pending.current?.key === request.key) pending.current = release ? null : { ...request, unresolved: true };
    // The lock is state, not display: it is set even when the page was concealed meanwhile.
    setLock(pending.current ? 'UNRESOLVED' : 'NONE');
    if (next?.kind === 'DONE' || next?.kind === 'HELD' || next?.kind === 'FAILED') setRefresh(value => value + 1);
    if (shown !== privacy.current) { // concealed meanwhile: the result is not shown; the lock alone says what is pending
      setOutcome(prior => prior?.kind === 'SENDING' ? null : prior);
      return;
    }
    setOutcome(next);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = useCallback((input: CreativeGenerationInput) => {
    if (pending.current || sending.current || lock !== 'NONE' || !selection) return;
    pending.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input, unresolved: false };
    void send();
  }, [send, lock, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckAgain = useCallback(() => { void send(); }, [send]);

  // A1 avatars: the same rules as a generation. Only a known outcome releases the request; anything else keeps its key.
  const sendAvatar = useCallback(async () => {
    const request = pendingAvatar.current;
    if (!request || sendingAvatar.current || !selection || selection.schoolId.toLowerCase() !== request.schoolId || !api.createAvatar) return;
    sendingAvatar.current = true; const shown = privacy.current;
    setAvatarLock('SENDING'); setAvatarOutcome({ kind: 'SENDING' });
    let next: CreateOutcome, release: boolean;
    try {
      const receipt = await api.createAvatar({ organizationId: selection.organizationId, schoolId: request.schoolId }, request.input, request.key, AbortSignal.timeout(180000));
      next = outcomeFromAvatarReceipt(receipt); release = next?.kind !== 'UNKNOWN';
    } catch (error) { ({ outcome: next, release } = outcomeFromAttempt(error, request.unresolved)); }
    finally { sendingAvatar.current = false; }
    if (pendingAvatar.current?.key === request.key) pendingAvatar.current = release ? null : { ...request, unresolved: true };
    setAvatarLock(pendingAvatar.current ? 'UNRESOLVED' : 'NONE');
    if (next?.kind === 'DONE' || next?.kind === 'HELD' || next?.kind === 'FAILED') setRefresh(value => value + 1);
    if (shown !== privacy.current) { setAvatarOutcome(prior => prior?.kind === 'SENDING' ? null : prior); return; }
    setAvatarOutcome(next);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCreateAvatar = useCallback((input: CreativeAvatarInput) => {
    if (pendingAvatar.current || sendingAvatar.current || avatarLock !== 'NONE' || !selection) return;
    pendingAvatar.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input, unresolved: false };
    void sendAvatar();
  }, [sendAvatar, avatarLock, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckAvatarAgain = useCallback(() => { void sendAvatar(); }, [sendAvatar]);
  const shownAvatarOutcome: CreateOutcome = avatarOutcome ?? (avatarLock === 'SENDING' ? { kind: 'SENDING' } : avatarLock === 'UNRESOLVED' ? { kind: 'HIDDEN_PENDING' } : null);
  const hideAvatarText = useCallback((a: CreativeAvatar) => matchesPendingAvatar(pendingAvatar.current, a), [avatarLock]); // eslint-disable-line react-hooks/exhaustive-deps
  // A2 avatar videos: the same rules again. Only a known outcome releases the request; anything else keeps its key.
  const sendVideo = useCallback(async () => {
    const request = pendingVideo.current;
    if (!request || sendingVideo.current || !selection || selection.schoolId.toLowerCase() !== request.schoolId || !api.createVideo) return;
    sendingVideo.current = true; const shown = privacy.current;
    setVideoLock('SENDING'); setVideoOutcome({ kind: 'SENDING' });
    let next: CreateOutcome, release: boolean;
    try {
      const receipt = await api.createVideo({ organizationId: selection.organizationId, schoolId: request.schoolId }, request.input, request.key, AbortSignal.timeout(300000));
      next = outcomeFromVideoReceipt(receipt); release = next?.kind !== 'UNKNOWN';
    } catch (error) { ({ outcome: next, release } = outcomeFromAttempt(error, request.unresolved)); }
    finally { sendingVideo.current = false; }
    if (pendingVideo.current?.key === request.key) pendingVideo.current = release ? null : { ...request, unresolved: true };
    setVideoLock(pendingVideo.current ? 'UNRESOLVED' : 'NONE');
    if (next?.kind === 'DONE' || next?.kind === 'HELD' || next?.kind === 'FAILED') setRefresh(value => value + 1);
    if (shown !== privacy.current) { setVideoOutcome(prior => prior?.kind === 'SENDING' ? null : prior); return; }
    setVideoOutcome(next);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCreateVideo = useCallback((input: CreativeAvatarVideoInput) => {
    if (pendingVideo.current || sendingVideo.current || videoLock !== 'NONE' || !selection) return;
    pendingVideo.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input, unresolved: false };
    void sendVideo();
  }, [sendVideo, videoLock, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckVideoAgain = useCallback(() => { void sendVideo(); }, [sendVideo]);
  const shownVideoOutcome: CreateOutcome = videoOutcome ?? (videoLock === 'SENDING' ? { kind: 'SENDING' } : videoLock === 'UNRESOLVED' ? { kind: 'HIDDEN_PENDING' } : null);
  const hideVideoText = useCallback((v: CreativeAvatarVideo) => matchesPendingVideo(pendingVideo.current, v), [videoLock]); // eslint-disable-line react-hooks/exhaustive-deps
  // WB1 website drafts: the same rules again. Only a known outcome releases the request; anything else keeps its key.
  const sendWebsite = useCallback(async () => {
    const request = pendingWebsite.current;
    if (!request || sendingWebsite.current || !selection || selection.schoolId.toLowerCase() !== request.schoolId || !api.createWebsite) return;
    sendingWebsite.current = true; const shown = privacy.current;
    setWebsiteLock('SENDING'); setWebsiteOutcome({ kind: 'SENDING' });
    let next: CreateOutcome, release: boolean;
    try {
      const receipt = await api.createWebsite({ organizationId: selection.organizationId, schoolId: request.schoolId }, request.input, request.key, AbortSignal.timeout(300000));
      next = outcomeFromWebsiteReceipt(receipt); release = next?.kind !== 'UNKNOWN';
    } catch (error) { ({ outcome: next, release } = outcomeFromAttempt(error, request.unresolved)); }
    finally { sendingWebsite.current = false; }
    if (pendingWebsite.current?.key === request.key) pendingWebsite.current = release ? null : { ...request, unresolved: true };
    setWebsiteLock(pendingWebsite.current ? 'UNRESOLVED' : 'NONE');
    if (next?.kind === 'DONE' || next?.kind === 'HELD' || next?.kind === 'FAILED') setRefresh(value => value + 1);
    if (shown !== privacy.current) { setWebsiteOutcome(prior => prior?.kind === 'SENDING' ? null : prior); return; }
    setWebsiteOutcome(next);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCreateWebsite = useCallback((input: CreativeWebsiteDraftInput) => {
    if (pendingWebsite.current || sendingWebsite.current || websiteLock !== 'NONE' || !selection) return;
    pendingWebsite.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input, unresolved: false };
    void sendWebsite();
  }, [sendWebsite, websiteLock, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckWebsiteAgain = useCallback(() => { void sendWebsite(); }, [sendWebsite]);
  const shownWebsiteOutcome: CreateOutcome = websiteOutcome ?? (websiteLock === 'SENDING' ? { kind: 'SENDING' } : websiteLock === 'UNRESOLVED' ? { kind: 'HIDDEN_PENDING' } : null);
  const hideWebsiteText = useCallback((d: CreativeWebsiteDraft) => matchesPendingWebsite(pendingWebsite.current, d), [websiteLock]); // eslint-disable-line react-hooks/exhaustive-deps
  // One draft's pages, read on demand. A conceal, school change or a newer open retires the read.
  const onViewWebsite = useCallback((draftId: string) => {
    if (!selection || !api.readWebsite) return;
    const current = ++openRead.current, shown = privacy.current;
    setOpenDraft({ draftId, state: 'LOADING' });
    api.readWebsite({ organizationId: selection.organizationId, schoolId: selection.schoolId }, draftId, AbortSignal.timeout(15000)).then(
      draft => { if (current === openRead.current && shown === privacy.current) setOpenDraft({ draftId, state: 'READY', draft }); },
      () => { if (current === openRead.current && shown === privacy.current) setOpenDraft({ draftId, state: 'FAILED' }); });
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onHideWebsite = useCallback(() => { openRead.current++; setOpenDraft(null); }, []);
  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);
  // After a conceal the shown outcome is gone, but a locked request still says it is waiting (without what it was).
  const shownOutcome: CreateOutcome = outcome ?? (lock === 'SENDING' ? { kind: 'SENDING' } : lock === 'UNRESOLVED' ? { kind: 'HIDDEN_PENDING' } : null);
  const hidePrompt = useCallback((g: CreativeGeneration) => matchesPending(pending.current, g) || matchesPendingAvatarGeneration(pendingAvatar.current, g)
    || matchesPendingVideoGeneration(pendingVideo.current, g), [lock, avatarLock, videoLock]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <CreativeStudioView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} studio={studio} onRefresh={onRefresh} generations={generations} outcome={shownOutcome} locked={lock !== 'NONE'} hidePrompt={hidePrompt} onCreate={onCreate} onCheckAgain={onCheckAgain}
      avatars={avatars} avatarOutcome={shownAvatarOutcome} avatarLocked={avatarLock !== 'NONE'} hideAvatarText={hideAvatarText} onCreateAvatar={onCreateAvatar} onCheckAvatarAgain={onCheckAvatarAgain}
      videos={videos} videoOutcome={shownVideoOutcome} videoLocked={videoLock !== 'NONE'} hideVideoText={hideVideoText} onCreateVideo={onCreateVideo} onCheckVideoAgain={onCheckVideoAgain}
      websites={websites} websiteOutcome={shownWebsiteOutcome} websiteLocked={websiteLock !== 'NONE'} hideWebsiteText={hideWebsiteText} onCreateWebsite={onCreateWebsite}
      onCheckWebsiteAgain={onCheckWebsiteAgain} openDraft={openDraft} onViewWebsite={onViewWebsite} onHideWebsite={onHideWebsite}/>
  </div>;
}
