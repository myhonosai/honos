'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CommsError, type Owned } from './http';

export { useConcealment } from '../hq-support/model';

/** What the last command attempt means. Only DONE saved something; UNKNOWN may have. */
export type CommsOutcome<R> = null
  | { kind: 'SENDING' } | { kind: 'DONE'; receipt: R } | { kind: 'UNKNOWN' } | { kind: 'CHANGED' } | { kind: 'REFUSED'; code: string | null }
  | { kind: 'KEY_REUSED' } | { kind: 'DENIED' } | { kind: 'INVALID' } | { kind: 'GONE' } | { kind: 'LOCAL_INVALID' };
export type Run<R> = (key: string, signal: AbortSignal, owned: Owned) => Promise<R>;

/** Map a command failure to what it means for the person. Anything not definitive is UNKNOWN, and the request is kept. */
export function commsOutcomeFor<R>(error: unknown): { outcome: CommsOutcome<R>; keep: boolean } {
  const kind = error instanceof CommsError ? error.kind : 'UNKNOWN';
  switch (kind) {
    case 'CHANGED': return { outcome: { kind: 'CHANGED' }, keep: false };
    case 'REFUSED': return { outcome: { kind: 'REFUSED', code: (error as CommsError).code }, keep: false };
    case 'KEY_REUSED': return { outcome: { kind: 'KEY_REUSED' }, keep: false };
    case 'DENIED': return { outcome: { kind: 'DENIED' }, keep: false };
    case 'INVALID': return { outcome: { kind: 'INVALID' }, keep: false };
    case 'GONE': return { outcome: { kind: 'GONE' }, keep: false };
    case 'SESSION': return { outcome: null, keep: false };
    default: return { outcome: { kind: 'UNKNOWN' }, keep: true };
  }
}

const newKey = () => globalThis.crypto.randomUUID();

/**
 * One command at a time. A command whose outcome is unknown is kept in memory (exact body and key) so Try again replays
 * it; the database answers a replay with the saved result and never sends twice. Concealing or unmounting drops it.
 */
export function useCommsCommand<R>(privacy: React.MutableRefObject<number>, after: (outcome: CommsOutcome<R>) => void) {
  const [outcome, setOutcome] = useState<CommsOutcome<R>>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const pending = useRef<{ key: string; run: Run<R> } | null>(null), sending = useRef(false), mounted = useRef(false), afterRef = useRef(after);
  afterRef.current = after;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: CommsOutcome<R>, keep: boolean;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const receipt = await request.run(request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', receipt }; keep = false;
    } catch (error) { ({ outcome: next, keep } = commsOutcomeFor<R>(error)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    if (!mounted.current) return;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current) { setOutcome(null); return; }
    setOutcome(next); afterRef.current(next);
  }, [privacy]);

  const start = useCallback((run: Run<R>): boolean => {
    if (pending.current || sending.current) return false;
    pending.current = { key: newKey(), run }; void send(); return true;
  }, [send]);
  const tryAgain = useCallback(() => { void send(); }, [send]);
  const drop = useCallback(() => { pending.current = null; setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE'); }, []);
  const local = useCallback(() => { if (!pending.current && !sending.current) setOutcome({ kind: 'LOCAL_INVALID' }); }, []);
  return { outcome, locked: lock !== 'NONE', canRetry: lock === 'KEPT', start, tryAgain, drop, local };
}
