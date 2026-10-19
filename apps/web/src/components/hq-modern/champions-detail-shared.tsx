'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ChampionsRewardKind, ChampionsRewardStatus } from '@hon/contracts';
import { HqChampionsDetailError, type ChampionsDetailFailure } from './champions-school-rewards-http';
import base from './hq-modern.module.css';
import styles from './champions-management.module.css';

export const rewardNames: Record<ChampionsRewardKind, string> = {
  REFERRER_CREDIT: 'Referrer subscription account credit', WELCOME_CREDIT: 'Welcome subscription account credit',
  FREE_MONTHS: 'Free subscription months', PRIZE: 'Physical / experience prize', LIFETIME_MEMBERSHIP: 'Lifetime membership',
};
export const rewardStatuses: Record<ChampionsRewardStatus, string> = {
  ACCRUED: 'Recorded liability · pending approval', APPROVED: 'Approved for future fulfillment',
  REVERSAL_REVIEW: 'Reversal review required', VOIDED: 'Voided reward record',
};
export const utc = (value: string) => `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
export type DetailRead<T> = { key: string; kind: 'loading' } | { key: string; kind: 'idle' }
  | { key: string; kind: 'ready'; data: T; retrievedAt: string }
  | { key: string; kind: 'failed'; failure: ChampionsDetailFailure };

/** The render-time key removes obsolete facts before effects run; cleanup ignores late reads. */
export function useChampionsDetailRead<T>(key: string, loader: ((signal: AbortSignal) => Promise<T>) | null): DetailRead<T> {
  const [state, setState] = useState<DetailRead<T>>({ key: '', kind: 'idle' });
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    if (!loader) { setState({ key, kind: 'idle' }); return () => { current = false; controller.abort(); }; }
    setState({ key, kind: 'loading' });
    loader(controller.signal).then(
      (data) => { if (current) setState({ key, kind: 'ready', data, retrievedAt: new Date().toISOString() }); },
      (error: unknown) => { if (current) setState({ key, kind: 'failed', failure: error instanceof HqChampionsDetailError ? error.kind : 'UNAVAILABLE' }); },
    );
    return () => { current = false; controller.abort(); };
  }, [key, loader]);
  return state.key === key ? state : { key, kind: loader ? 'loading' : 'idle' };
}

export function DetailState<T>({ state }: { state: DetailRead<T> }): React.ReactElement | null {
  if (state.kind === 'idle' || state.kind === 'ready') return null;
  const title = state.kind === 'loading' ? 'Loading authorized records…'
    : state.failure === 'UNAUTHORIZED' ? 'Sign in to view these records'
    : state.failure === 'FORBIDDEN' ? 'HQ access denied'
    : state.failure === 'INVALID_RESPONSE' ? 'Records could not be verified'
    : state.failure === 'INVALID_SELECTION' ? 'Select a verified school or reward status'
    : 'Authorized records unavailable';
  return <section className={base.panel} role="status"><h2>{title}</h2><p>Previous facts are cleared. Independent current HQ authorization and verified service responses are required. Refresh to check again.</p>{state.kind === 'failed' && state.failure === 'UNAUTHORIZED' && <Link href="/auth/login">Sign in to HON</Link>}</section>;
}

export function ChampionsDetailNav(): React.ReactElement {
  return <nav className={base.moduleLinks} aria-label="Champions Club tools"><Link href="/hq/growth/champions-club">Program overview</Link><Link href="/hq/growth/champions-club/schools">School referrals</Link><Link href="/hq/growth/leaderboard">Official leaderboard</Link><Link href="/hq/growth/rewards">Reward management</Link></nav>;
}
export function Retrieved({ at }: { at: string }): React.ReactElement {
  return <p className={styles.note} role="status">Retrieved {utc(at)} · refresh to recheck. Separate reads are not an atomic snapshot.</p>;
}
