'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChampionsContestReceipt } from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ContestError, type Owned } from './http';

/** What the last command attempt means. Only DONE saved something; UNKNOWN may have. */
export type ContestOutcome = null
  | { kind: 'SENDING' } | { kind: 'DONE'; receipt: ChampionsContestReceipt } | { kind: 'UNKNOWN' } | { kind: 'CHANGED' }
  | { kind: 'REFUSED'; code: string | null } | { kind: 'KEY_REUSED' } | { kind: 'DENIED' } | { kind: 'INVALID' } | { kind: 'GONE' } | { kind: 'LOCAL_INVALID'; form: string };
export type Run = (key: string, signal: AbortSignal, owned: Owned) => Promise<ChampionsContestReceipt>;

/**
 * Leaving the tab (blur, hidden tab, page hide) or a session end hides every contest fact. `privacy` counts those moments so
 * nothing read or sent before one speaks for the view after it. `onConceal` runs first so callers drop drafts and kept commands.
 */
export function useConcealment(onConceal: () => void): { concealed: boolean; privacy: React.MutableRefObject<number>; reveal: () => void } {
  const [concealed, setConcealed] = useState(false);
  const privacy = useRef(0), callback = useRef(onConceal);
  callback.current = onConceal;
  useEffect(() => {
    const conceal = () => { privacy.current++; callback.current(); setConcealed(true); };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);
  const reveal = useCallback(() => setConcealed(false), []);
  return { concealed, privacy, reveal };
}

/** Map a command failure to what it means for the person. Anything not definitive is UNKNOWN, and the request is kept. */
export function contestOutcomeFor(error: unknown): { outcome: ContestOutcome; keep: boolean } {
  const kind = error instanceof ContestError ? error.kind : 'UNKNOWN';
  switch (kind) {
    case 'CHANGED': return { outcome: { kind: 'CHANGED' }, keep: false };
    case 'REFUSED': return { outcome: { kind: 'REFUSED', code: (error as ContestError).code }, keep: false };
    case 'KEY_REUSED': return { outcome: { kind: 'KEY_REUSED' }, keep: false };
    case 'DENIED': return { outcome: { kind: 'DENIED' }, keep: false };
    case 'INVALID': return { outcome: { kind: 'INVALID' }, keep: false };
    case 'GONE': return { outcome: { kind: 'GONE' }, keep: false };
    case 'SESSION': return { outcome: null, keep: false };
    default: return { outcome: { kind: 'UNKNOWN' }, keep: true };
  }
}

const newKey = () => globalThis.crypto.randomUUID();
type Pending = Readonly<{ key: string; run: Run }>;

/**
 * One command at a time. A command whose outcome is unknown is kept in memory (exact body and key) so Try again replays
 * it; the database answers a replay with the saved result and never saves it twice. Concealing or unmounting drops it.
 */
export function useContestCommand(privacy: React.MutableRefObject<number>, after: (outcome: ContestOutcome) => void) {
  const [outcome, setOutcome] = useState<ContestOutcome>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const pending = useRef<Pending | null>(null), sending = useRef(false), mounted = useRef(false), afterRef = useRef(after);
  afterRef.current = after;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: ContestOutcome, keep: boolean;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await request.run(request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', receipt }; keep = false;
    } catch (error) { ({ outcome: next, keep } = contestOutcomeFor(error)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    if (!mounted.current) return;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current) { setOutcome(null); return; }
    setOutcome(next); afterRef.current(next);
  }, [privacy]);

  /** Start a new command. Refused while one is sending or kept for retry. */
  const start = useCallback((run: Run): boolean => {
    if (pending.current || sending.current) return false;
    pending.current = { key: newKey(), run }; void send(); return true;
  }, [send]);
  const tryAgain = useCallback(() => { void send(); }, [send]);
  /** Drop any kept command and outcome (conceal, denial, starting over). A command still sending finishes unseen. */
  const drop = useCallback(() => { pending.current = null; setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE'); }, []);
  const local = useCallback((form: string) => { if (!pending.current && !sending.current) setOutcome({ kind: 'LOCAL_INVALID', form }); }, []);
  return { outcome, locked: lock !== 'NONE', canRetry: lock === 'KEPT', start, tryAgain, drop, local, setOutcome };
}
