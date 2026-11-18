'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { faceCodeText, faceText, type FaceKey } from './copy';
import { FaceError, keepFaceForRetry, type FaceErrorKind, type Owned } from './http';

export type FaceOutcome = null | Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string; canRetry: boolean }>;
/** One command: run it with its key; the answer is the line shown when it is saved. */
export type FaceRun = (key: string, signal: AbortSignal, owned: Owned) => Promise<string | Readonly<{ tone: 'ok' | 'blocked'; text: string }>>;

const KIND_KEY: Record<Exclude<FaceErrorKind, 'SESSION'>, FaceKey> = {
  DENIED: 'outDenied', MISSING: 'outMissing', CONFLICT: 'outConflict', INVALID: 'outInvalid', BUSY: 'outBusy', UNKNOWN: 'outUnknown',
};
/** The words for a refusal: the server's own code when HON explains it, else what the kind of answer means. */
export function faceErrorText(language: string, error: unknown): string {
  if (!(error instanceof FaceError)) return faceText(language, 'outUnknown');
  if (error.kind === 'SESSION') return faceText(language, 'outUnknown');
  const known = error.kind === 'UNKNOWN' || error.kind === 'BUSY' ? null : faceCodeText(language, error.code);
  return known ?? faceText(language, KIND_KEY[error.kind]);
}

/**
 * Runs one command at a time. Each has its own idempotency key. An unknown or busy answer keeps that exact command (same
 * key) for Try again; anything definitive drops it. A conflict or a saved answer reloads the read. Leaving the school or
 * the session drops a kept command.
 */
export function useFaceCommands(language: string, reload: () => void) {
  const [outcome, setOutcome] = useState<FaceOutcome>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), pending = useRef<{ key: string; run: FaceRun } | null>(null), sending = useRef(false);
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  const drop = useCallback(() => { pending.current = null; setOutcome(null); setBusy(sending.current); }, []);
  useEffect(() => {
    const events = [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT, 'pagehide'];
    for (const e of events) window.addEventListener(e, drop);
    return () => { for (const e of events) window.removeEventListener(e, drop); };
  }, [drop]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setBusy(true); setOutcome({ tone: 'waiting', text: faceText(language, 'sending'), canRetry: false });
    const owned = () => mounted.current && pending.current?.key === request.key;
    let next: FaceOutcome, keep = false, refresh = false;
    try {
      const answer = await request.run(request.key, AbortSignal.timeout(20000), owned);
      next = typeof answer === 'string' ? { tone: 'ok', text: answer, canRetry: false } : { ...answer, canRetry: false }; refresh = true;
    }
    catch (error) {
      keep = keepFaceForRetry(error);
      refresh = error instanceof FaceError && (error.kind === 'CONFLICT' || error.kind === 'MISSING');
      next = { tone: keep ? 'waiting' : 'blocked', text: faceErrorText(language, error), canRetry: keep };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    else next = null;
    setBusy(pending.current !== null); setOutcome(next);
    if (refresh) reloadRef.current();
  }, [language]);

  const start = useCallback((run: FaceRun) => {
    if (pending.current || sending.current) return false;
    pending.current = { key: globalThis.crypto.randomUUID(), run }; void send(); return true;
  }, [send]);
  const tryAgain = useCallback(() => { void send(); }, [send]);
  const stop = useCallback(() => { if (sending.current) return; pending.current = null; setBusy(false); setOutcome(null); }, []);
  return { outcome, busy, start, tryAgain, stop, clear: () => setOutcome(null) };
}
