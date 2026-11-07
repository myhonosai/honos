'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CreativeGeneration, CreativeGenerationInput, CreativeGenerationReceipt, CreativeStudioGenerationList } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AccountStatusError, readSchoolCreativeWallet } from '../account-status/http';
import { CreativeGenerationError, createCreativeGeneration, listCreativeGenerations } from './generation-http';
import { studioWallet, type CreateLock, type CreateOutcome, type GenerationsState, type StudioState, type StudioWallet } from './model';
import { CreativeStudioView } from './view';

type Scope = Readonly<{ organizationId: string; schoolId: string }>;
export type CreativeStudioApi = {
  wallet(scope: Scope, signal: AbortSignal): Promise<StudioWallet>;
  generations(scope: Scope, signal: AbortSignal): Promise<CreativeStudioGenerationList>;
  create(scope: Scope, input: CreativeGenerationInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeGenerationReceipt>;
};
/** The wallet and generation reads plus the one closed create command. The server authorizes the exact school for each. */
export const CREATIVE_STUDIO_API: CreativeStudioApi = {
  wallet: async (scope, signal) => studioWallet(await readSchoolCreativeWallet(scope, signal)),
  generations: (scope, signal) => listCreativeGenerations(scope.schoolId, signal),
  create: (scope, input, key, signal) => createCreativeGeneration(scope.schoolId, input, key, signal),
};

/**
 * A create whose outcome is not known yet: the exact request and key, kept in memory only so a retry can never double up.
 * unresolved: an attempt already ended without a known outcome, so a later refusal is about the retry, not the request.
 */
type Pending = Readonly<{ schoolId: string; key: string; input: CreativeGenerationInput; unresolved: boolean }>;
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
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const pending = useRef<Pending | null>(null);
  const sending = useRef(false);
  const loadedSchool = useRef<string | null>(null);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; loadedSchool.current = null;
    setStudio({ state: 'LOADING' }); setGenerations({ state: 'LOADING' }); setOutcome(null);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current;
    const school = selection ? selection.schoolId.toLowerCase() : null;
    // A Refresh of the same school keeps what is shown (and any draft in the form) until the new reads answer.
    if (school === null || school !== loadedSchool.current) { setStudio({ state: 'LOADING' }); setGenerations({ state: 'LOADING' }); }
    loadedSchool.current = school;
    if (!selection) return;
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    if (pending.current && pending.current.schoolId !== scope.schoolId.toLowerCase()) {
      pending.current = null;
      if (!sending.current) setLock('NONE');
    }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.wallet(scope, signal).then(
      wallet => { if (current === generation.current) setStudio({ state: 'READY', wallet }); },
      error => { if (current === generation.current) setStudio({ state: error instanceof AccountStatusError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    api.generations(scope, signal).then(
      list => { if (current === generation.current) setGenerations({ state: 'READY', provider: list.provider, items: list.generations }); },
      error => { if (current === generation.current) setGenerations({ state: error instanceof CreativeGenerationError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, api, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current || !selection || selection.schoolId.toLowerCase() !== request.schoolId) return;
    sending.current = true; const shown = generation.current;
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
    if (shown !== generation.current) return; // concealed meanwhile: the result is not shown
    setOutcome(next);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = useCallback((input: CreativeGenerationInput) => {
    if (pending.current || sending.current || lock !== 'NONE' || !selection) return;
    pending.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input, unresolved: false };
    void send();
  }, [send, lock, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckAgain = useCallback(() => { void send(); }, [send]);
  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);
  // After a conceal the shown outcome is gone, but a locked request still says it is waiting (without what it was).
  const shownOutcome: CreateOutcome = outcome ?? (lock === 'SENDING' ? { kind: 'SENDING' } : lock === 'UNRESOLVED' ? { kind: 'HIDDEN_PENDING' } : null);
  const hidePrompt = useCallback((g: CreativeGeneration) => matchesPending(pending.current, g), [lock]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <CreativeStudioView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} studio={studio} onRefresh={onRefresh} generations={generations} outcome={shownOutcome} locked={lock !== 'NONE'} hidePrompt={hidePrompt} onCreate={onCreate} onCheckAgain={onCheckAgain}/>
  </div>;
}
