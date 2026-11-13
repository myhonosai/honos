'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingAnswers, OnboardingSaveInput, OnboardingSkippableStep } from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { OnboardingError, keepForRetry, onboardingApi, type OnboardingApi, type OnboardingScope } from './http';
import { EMPTY_ANSWERS, answersOf, saveInputFor, skipInputFor } from './plan';
import { SchoolOnboardingView, type ModeState, type ReadState, type SaveOutcome } from './view';

/** A save whose outcome is not known: the exact answers and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; scope: OnboardingScope; input: OnboardingSaveInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * HON welcome (0323): the welcome questions, the view and language choice, and the setup checklist the server computes from
 * the school's real records. Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire
 * every read and drop the draft and any kept save. Every save is followed by a fresh read: the server says what changed.
 */
export function SchoolOnboarding({ api = onboardingApi }: { api?: OnboardingApi }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [read, setRead] = useState<ReadState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<OnboardingAnswers>(EMPTY_ANSWERS);
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [modeState, setModeState] = useState<ModeState>('IDLE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), dirty = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null; dirty.current = false;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setDraft(EMPTY_ANSWERS); setEditing(false); setModeState('IDLE'); setRead({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read({ organizationId: orgId, schoolId }, signal, owned).then(
      (onboarding) => {
        if (!owned()) return;
        setRead({ state: 'READY', onboarding });
        // Unsaved answers stay while the person is still editing; otherwise the form starts from what the server saved.
        if (!dirty.current) setDraft(answersOf(onboarding.profile));
      },
      (error) => { if (owned() && !abort.signal.aborted) setRead({ state: error instanceof OnboardingError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: SaveOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      await api.save(request.scope, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE' };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof OnboardingError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next?.kind === 'DONE' || next?.kind === 'CHANGED' || next?.kind === 'DENIED') { dirty.current = false; setEditing(false); }
    setRefresh((n) => n + 1);
  }, [api]);

  const profile = read.state === 'READY' ? read.onboarding.profile : null;
  const start = useCallback((input: OnboardingSaveInput | null) => {
    if (!input || lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), scope: { organizationId: orgId, schoolId }, input };
    void send();
  }, [lock, orgId, schoolId, send]);

  const onDraft = useCallback((next: OnboardingAnswers) => { if (lock === 'NONE') { dirty.current = true; setDraft(next); setOutcome(null); } }, [lock]);
  const onEdit = useCallback((on: boolean) => {
    if (lock !== 'NONE') return;
    dirty.current = false; setEditing(on); setOutcome(null); setDraft(answersOf(profile));
  }, [lock, profile]);
  const onSave = useCallback(() => start(saveInputFor(draft, profile)), [start, draft, profile]);
  const onSkip = useCallback((key: OnboardingSkippableStep, skip: boolean) => start(skipInputFor(profile, key, skip)), [start, profile]);
  const onMode = useCallback((mode: HonInterfaceTheme) => {
    const shown = privacy.current;
    setModeState('SAVING');
    void shell.onMode(mode, 'ONBOARDING').then((ok) => {
      if (!mounted.current || shown !== privacy.current) return;
      setModeState(ok ? 'SAVED' : 'FAILED');
      if (ok) setRefresh((n) => n + 1);
    });
  }, [shell]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SchoolOnboardingView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} read={read} draft={draft} editing={editing} outcome={outcome}
      locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} mode={shell.mode} modeState={modeState} languageBlocked={locale.blocked}
      onRefresh={() => setRefresh((n) => n + 1)} onDraft={onDraft} onEdit={onEdit} onSave={onSave} onSkip={onSkip} onMode={onMode}
      onLanguage={locale.chooseLanguage} onTryAgain={() => { void send(); }} />
  </div>;
}
