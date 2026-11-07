'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CreativeGenerationInput, CreativeGenerationReceipt, CreativeStudioGenerationList } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { AccountStatusError, readSchoolCreativeWallet } from '../account-status/http';
import { CreativeGenerationError, createCreativeGeneration, listCreativeGenerations } from './generation-http';
import { studioWallet, type CreateOutcome, type GenerationsState, type StudioState, type StudioWallet } from './model';
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

/** A create whose outcome is not known yet: the exact request and key, kept in memory only so a retry can never double up. */
type Pending = Readonly<{ schoolId: string; key: string; input: CreativeGenerationInput }>;
const newKey = () => globalThis.crypto.randomUUID();

export function outcomeFromReceipt(receipt: CreativeGenerationReceipt): CreateOutcome {
  switch (receipt.generation.status) {
    case 'SUCCEEDED': case 'RESOLVED_CHARGED': return { kind: 'DONE' };
    case 'UNDER_REVIEW': return { kind: 'HELD' };
    case 'FAILED': case 'RESOLVED_NOT_CHARGED': return { kind: 'FAILED' };
    case 'GENERATING': return { kind: 'UNKNOWN' };
  }
}
export function outcomeFromError(error: unknown): CreateOutcome {
  if (!(error instanceof CreativeGenerationError)) return { kind: 'UNKNOWN' };
  switch (error.kind) {
    case 'REFUSED': return { kind: 'REFUSED', code: error.code };
    case 'DENIED': case 'NOT_CONNECTED': case 'INVALID': return { kind: error.kind };
    default: return { kind: 'UNKNOWN' };
  }
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
    if (pending.current && pending.current.schoolId !== scope.schoolId.toLowerCase()) pending.current = null;
    // A request from before a conceal is still unconfirmed: say so, without showing what it was.
    if (pending.current && !sending.current) setOutcome(prior => prior ?? { kind: 'HIDDEN_PENDING' });
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
    setOutcome({ kind: 'SENDING' });
    let next: CreateOutcome;
    try {
      const receipt = await api.create({ organizationId: selection.organizationId, schoolId: request.schoolId }, request.input, request.key, AbortSignal.timeout(180000));
      next = outcomeFromReceipt(receipt);
    } catch (error) { next = outcomeFromError(error); }
    finally { sending.current = false; }
    // Only a known outcome releases the request; an unknown one keeps the same key for "Check again".
    if (next?.kind !== 'UNKNOWN' && pending.current?.key === request.key) pending.current = null;
    if (shown !== generation.current) return; // concealed meanwhile: the result is not shown
    setOutcome(next);
    if (next?.kind === 'DONE' || next?.kind === 'HELD' || next?.kind === 'FAILED') setRefresh(value => value + 1);
  }, [api, selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = useCallback((input: CreativeGenerationInput) => {
    if (pending.current || sending.current || !selection) return;
    pending.current = { schoolId: selection.schoolId.toLowerCase(), key: newKey(), input };
    void send();
  }, [send, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const onCheckAgain = useCallback(() => { void send(); }, [send]);
  const onRefresh = useCallback(() => setRefresh(value => value + 1), []);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <CreativeStudioView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={selection !== null} studio={studio} onRefresh={onRefresh} generations={generations} outcome={outcome} onCreate={onCreate} onCheckAgain={onCheckAgain}/>
  </div>;
}
