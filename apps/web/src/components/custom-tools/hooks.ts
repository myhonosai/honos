'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepForRetry, ToolError, toolErrorKind, type Owned, type ToolErrorKind } from './http';

export type ReadState<V> = { state: 'LOADING' } | { state: 'READY'; value: V } | { state: 'DENIED' | 'GONE' | 'UNAVAILABLE' | 'SESSION' };

/**
 * One read that a newer read, a change of inputs or unmounting retires: a retired answer never shows, and a retired 401
 * never ends a newer session. `run` returning null means there is nothing to read yet.
 */
export function useRead<V>(run: ((signal: AbortSignal, owned: Owned) => Promise<V>) | null, deps: readonly unknown[], timeoutMs = 20000): [ReadState<V>, () => void] {
  const [state, setState] = useState<ReadState<V>>({ state: 'LOADING' });
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const current = ++gen.current;
    setState({ state: 'LOADING' });
    if (!run) return;
    let live = true;
    const owned = () => live && current === gen.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
    run(signal, owned).then(
      (value) => { if (owned()) setState({ state: 'READY', value }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = toolErrorKind(error);
        setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'SESSION' ? 'SESSION' : 'UNAVAILABLE' });
      });
    return () => { live = false; abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const again = useCallback(() => setTick((n) => n + 1), []);
  return [state, again];
}

export type Outcome<A extends string> = null | Readonly<{ kind: 'SENDING' | 'DONE' | ToolErrorKind; action: A; detail: string | null }>;
type Pending<A extends string> = Readonly<{ key: string; action: A; send: (key: string, signal: AbortSignal, owned: Owned) => Promise<unknown> }>;

/**
 * Browser commands, one at a time. Each starts with a fresh Idempotency-Key; a command whose outcome is not known is
 * kept, in memory only, so "Try again" sends the identical request and key (the server returns the first receipt).
 */
export function useCommands<A extends string>(onDone: (action: A, result: unknown) => void) {
  const [outcome, setOutcome] = useState<Outcome<A>>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const pending = useRef<Pending<A> | null>(null), sending = useRef(false), mounted = useRef(false);
  const done = useRef(onDone); done.current = onDone;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  const fire = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action, detail: null });
    let next: Outcome<A>, keep = false, result: unknown = null;
    try {
      const owned = () => mounted.current && pending.current?.key === request.key;
      result = await request.send(request.key, AbortSignal.timeout(60000), owned);
      next = { kind: 'DONE', action: request.action, detail: null };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: toolErrorKind(error), action: request.action, detail: error instanceof ToolError ? error.detail : null };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    if (!mounted.current) return;
    setLock(pending.current ? 'KEPT' : 'NONE');
    setOutcome(next);
    if (next?.kind === 'DONE') done.current(request.action, result);
    else if (next && next.kind !== 'UNKNOWN') done.current(request.action, null);
  }, []);
  const start = useCallback((action: A, send: Pending<A>['send']) => {
    if (pending.current || sending.current) return false;
    pending.current = { key: globalThis.crypto.randomUUID(), action, send };
    void fire();
    return true;
  }, [fire]);
  const retry = useCallback(() => { void fire(); }, [fire]);
  const clear = useCallback(() => { if (!sending.current && !pending.current) setOutcome(null); }, []);
  return { outcome, locked: lock !== 'NONE', canRetry: lock === 'KEPT', start, retry, clear };
}
