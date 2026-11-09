'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChampionsDisplayMode } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ChampionsError, championsSchoolApi, keepForRetry, utcMonth, type ChampionsSchoolApi, type LeaderboardPick, type Owned } from './http';
import { ChampionsSchoolView, type BoardPeriod, type ChampionsAction, type ChampionsOutcome, type ChampionsRead, type CopyState } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it (the server returns the first receipt). */
type Pending = Readonly<{ key: string; action: ChampionsAction; schoolId: string; mode: ChampionsDisplayMode | null }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const LOADING = { state: 'LOADING' } as const;
const systemNow = () => Date.now();
const readState = (error: unknown): ChampionsRead<never> => {
  const kind = error instanceof ChampionsError ? error.kind : 'UNKNOWN';
  return { state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' };
};

/**
 * Champions Club for the school the shell verified. Blur, a hidden tab, page hide, a school change or a session end hide the
 * page at once, retire every read and drop any kept command; reads start again only after the shell re-verifies the school.
 * Every command answer is followed by fresh reads. Nothing here pays, credits or messages anyone.
 */
export function ChampionsSchool({ api = championsSchoolApi, now = systemNow }: { api?: ChampionsSchoolApi; now?: () => number }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const schoolId = shell.phase === 'READY' ? shell.selection?.schoolId ?? null : null;
  const [summary, setSummary] = useState<ChampionsRead<Awaited<ReturnType<ChampionsSchoolApi['summary']>>>>(LOADING);
  const [statistics, setStatistics] = useState<ChampionsRead<Awaited<ReturnType<ChampionsSchoolApi['statistics']>>>>(LOADING);
  const [rewards, setRewards] = useState<ChampionsRead<Awaited<ReturnType<ChampionsSchoolApi['rewards']>>>>(LOADING);
  const [contests, setContests] = useState<ChampionsRead<Awaited<ReturnType<ChampionsSchoolApi['contests']>>>>(LOADING);
  const [board, setBoard] = useState<ChampionsRead<Awaited<ReturnType<ChampionsSchoolApi['leaderboard']>>>>(LOADING);
  const [pick, setPick] = useState<LeaderboardPick>({ period: 'ALL_TIME' });
  const [outcome, setOutcome] = useState<ChampionsOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [copy, setCopy] = useState<CopyState>('IDLE');
  const [refresh, setRefresh] = useState(0);
  const privacy = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setCopy('IDLE'); setPick({ period: 'ALL_TIME' });
    setSummary(LOADING); setStatistics(LOADING); setRewards(LOADING); setContests(LOADING); setBoard(LOADING);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  /** One read: retired by its effect's cleanup, a privacy event or unmount; only an owned read may end the session or set state. */
  const run = useCallback(<V,>(set: (read: ChampionsRead<V>) => void, load: ((signal: AbortSignal, owned: Owned) => Promise<V>) | null) => {
    set(LOADING);
    if (!load) return undefined;
    let live = true; const shown = privacy.current;
    const owned = () => live && mounted.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    load(signal, owned).then((value) => { if (owned()) set({ state: 'READY', value }); }, (error) => { if (owned() && !abort.signal.aborted) set(readState(error)); });
    return () => { live = false; abort.abort(); };
  }, []);

  useEffect(() => run(setSummary, schoolId ? (s, o) => api.summary(schoolId, s, o) : null), [run, api, schoolId, refresh]);
  useEffect(() => run(setStatistics, schoolId ? (s, o) => api.statistics(schoolId, s, o) : null), [run, api, schoolId, refresh]);
  useEffect(() => run(setRewards, schoolId ? (s, o) => api.rewards(schoolId, s, o) : null), [run, api, schoolId, refresh]);
  useEffect(() => run(setContests, schoolId ? (s, o) => api.contests(schoolId, s, o) : null), [run, api, schoolId, refresh]);
  useEffect(() => run(setBoard, schoolId ? (s, o) => api.leaderboard(schoolId, pick, s, o) : null), [run, api, schoolId, pick, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: NonNullable<ChampionsOutcome>, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      if (request.action === 'code') {
        const receipt = await api.issueCode(request.schoolId, request.key, signal, owned);
        next = { kind: 'DONE', action: 'code', created: receipt.created, replayed: receipt.replayed };
      } else {
        const receipt = await api.setDisplay(request.schoolId, request.mode ?? 'ANONYMOUS', request.key, signal, owned);
        next = { kind: 'DONE', action: 'display', mode: receipt.displayMode, replayed: receipt.replayed };
      }
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof ChampionsError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((action: ChampionsAction, mode: ChampionsDisplayMode | null) => {
    if (lock !== 'NONE' || pending.current || sending.current || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, schoolId, mode };
    void send();
  }, [lock, schoolId, send]);

  const code = summary.state === 'READY' ? summary.value.referralCode?.code ?? null : null;
  const onCopy = useCallback(() => {
    if (!code) return;
    const shown = privacy.current;
    const clip = globalThis.navigator?.clipboard;
    if (!clip) { setCopy('FAILED'); return; }
    clip.writeText(code).then(() => { if (shown === privacy.current && mounted.current) setCopy('COPIED'); }, () => { if (shown === privacy.current && mounted.current) setCopy('FAILED'); });
  }, [code]);
  const onPeriod = useCallback((period: BoardPeriod) => { setPick(period === 'MONTH' ? { period: 'MONTH', month: utcMonth(now()) } : { period: 'ALL_TIME' }); }, [now]);
  const onRefresh = useCallback(() => { setCopy('IDLE'); setRefresh((n) => n + 1); }, []);
  const onStop = useCallback(() => {
    if (lock !== 'KEPT' || sending.current) return;
    pending.current = null; setLock('NONE'); setOutcome(null); setRefresh((n) => n + 1);
  }, [lock]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <ChampionsSchoolView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} summary={summary} statistics={statistics} rewards={rewards} contests={contests} board={board} period={pick.period}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} copy={copy}
      onRefresh={onRefresh} onIssueCode={() => start('code', null)} onCopy={onCopy} onPeriod={onPeriod} onDisplay={(mode) => start('display', mode)}
      onTryAgain={() => { void send(); }} onStop={onStop}/>
  </div>;
}
