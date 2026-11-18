'use client';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ClassSessionRosterEntry } from '@hon/contracts';
import { MarkError, RosterError, type RosterApi, type RosterMark, type RosterPage, type RosterScope } from './http';
import type { MarkState, RosterState } from './view';

const kindOf = (error: unknown) => error instanceof RosterError ? error.kind : 'UNAVAILABLE';

export type RosterDetail = Readonly<{
  roster: RosterState; marks: Readonly<Record<string, MarkState>>;
  onMore: () => void; onMark: (entry: ClassSessionRosterEntry, status: RosterMark) => void; reload: () => void;
  /** Retires every roster read and forgets unconfirmed mark keys (privacy events, unmount). */
  retire: () => void; clear: () => void;
}>;

/**
 * One class's roster, page by page, with attendance marks (shared by Class rosters and the School Calendar). `privacy` is
 * the page's privacy generation: a read started before a privacy event is never shown after it.
 */
export function useRosterDetail(api: RosterApi, scope: RosterScope | null, selectedId: string | null, privacy: MutableRefObject<number>, mounted: MutableRefObject<boolean>): RosterDetail {
  const [roster, setRoster] = useState<RosterState>({ state: 'NONE' });
  const [rosterRefresh, setRosterRefresh] = useState(0);
  // Per student on the open roster: the last mark's outcome. Retry keys are kept per exact unchanged command, so pressing
  // the same button after an unconfirmed save replays it (the server answers once) instead of recording twice.
  const [marks, setMarks] = useState<Readonly<Record<string, MarkState>>>({});
  const markKeys = useRef(new Map<string, string>());
  const rosterGeneration = useRef(0), moreAbort = useRef<AbortController | null>(null);
  const retire = useCallback(() => { markKeys.current.clear(); rosterGeneration.current++; moreAbort.current?.abort(); moreAbort.current = null; }, []);
  const clear = useCallback(() => setRoster({ state: 'NONE' }), []);

  // Page one of the selected class's roster. A changed roster while paging restarts here with restarted=true.
  const firstPage = useCallback((sessionId: string, restarted: boolean) => {
    if (!scope) return () => {};
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++rosterGeneration.current, shown = privacy.current;
    setRoster({ state: 'LOADING' }); setMarks({});
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && current === rosterGeneration.current && shown === privacy.current;
    api.roster(scope, sessionId, null, signal, owned).then(
      (page) => { if (owned()) setRoster({ state: 'READY', sessionId, entries: page.entries, nextCursor: page.nextCursor, more: 'IDLE', restarted }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = kindOf(error);
        setRoster({ state: kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const restart = useRef<((sessionId: string) => void) | null>(null);
  restart.current = (sessionId) => { firstPage(sessionId, true); };

  useEffect(() => {
    if (!selectedId || !scope) { rosterGeneration.current++; setRoster({ state: 'NONE' }); return; }
    return firstPage(selectedId, false);
  }, [scope?.organizationId, scope?.schoolId, selectedId, rosterRefresh, firstPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMore = useCallback(() => {
    if (roster.state !== 'READY' || !roster.nextCursor || roster.more === 'LOADING' || !scope) return;
    const prior = roster, current = rosterGeneration.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === rosterGeneration.current && shown === privacy.current && moreAbort.current === abort;
    setRoster({ ...prior, more: 'LOADING' });
    const changed = () => { if (prior.restarted) setRoster({ state: 'UNAVAILABLE' }); else restart.current?.(prior.sessionId); };
    api.roster(scope, prior.sessionId, prior.nextCursor, signal, owned).then(
      (page: RosterPage) => {
        if (!owned()) return;
        moreAbort.current = null;
        const seen = new Set(prior.entries.map((e) => e.studentProfileId.toLowerCase()));
        // A student already shown on an earlier page means the roster moved under the cursor: start again.
        if (page.entries.some((e) => seen.has(e.studentProfileId.toLowerCase()))) { changed(); return; }
        setRoster({ ...prior, entries: [...prior.entries, ...page.entries], nextCursor: page.nextCursor, more: 'IDLE' });
      },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        moreAbort.current = null;
        const kind = kindOf(error);
        if (kind === 'CURSOR') { changed(); return; }
        setRoster(kind === 'DENIED' ? { state: 'DENIED' } : { ...prior, more: 'FAILED' });
      });
  }, [api, roster, scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMark = useCallback((entry: ClassSessionRosterEntry, status: RosterMark) => {
    if (roster.state !== 'READY' || !scope) return;
    const student = entry.studentProfileId.toLowerCase(), sessionId = roster.sessionId;
    if (marks[student]?.state === 'SAVING' || entry.attendance?.status === status) return;
    const fingerprint = `${sessionId}:${student}:${status}:${entry.attendance?.version ?? 0}`;
    const key = markKeys.current.get(fingerprint) ?? crypto.randomUUID(); markKeys.current.set(fingerprint, key);
    const current = rosterGeneration.current, shown = privacy.current;
    const owned = () => mounted.current && current === rosterGeneration.current && shown === privacy.current;
    setMarks((m) => ({ ...m, [student]: { state: 'SAVING', status } }));
    api.mark(scope, sessionId, entry, status, key).then(
      (attendance) => {
        if (!owned()) return;
        markKeys.current.delete(fingerprint);
        setRoster((r) => r.state === 'READY' && r.sessionId === sessionId
          ? { ...r, entries: r.entries.map((e) => e.studentProfileId.toLowerCase() === student ? { ...e, attendance } : e) } : r);
        setMarks((m) => ({ ...m, [student]: { state: 'SAVED', status } }));
      },
      (error) => {
        if (!owned()) return;
        const kind = error instanceof MarkError ? error.kind : 'UNKNOWN';
        // A definite refusal frees the key; only an unconfirmed outcome keeps it for the same retry.
        if (kind !== 'UNKNOWN') markKeys.current.delete(fingerprint);
        if (kind === 'CONFLICT') { setRosterRefresh((n) => n + 1); return; }
        setMarks((m) => ({ ...m, [student]: { state: kind, status } }));
      });
  }, [api, roster, marks, scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setRosterRefresh((n) => n + 1), []);
  return { roster, marks, onMore, onMark, reload, retire, clear };
}
