'use client';
import React, { useEffect, useState } from 'react';
import { verifySchoolVideoPage, type SchoolVideoPage } from '@hon/contracts';
import styles from './public-video.module.css';

type Read = { state: 'LOADING' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; page: SchoolVideoPage };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Reads what the video page shows: the school's name, the title and the copy's size. Only the token is sent. */
export async function readVideoPage(token: string, signal: AbortSignal): Promise<Read> {
  if (!TOKEN.test(token)) return { state: 'GONE' };
  let r: Response;
  try {
    r = await fetch(`/api/v1/public/media/${token}/page`, { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
  } catch { return { state: 'UNAVAILABLE' }; }
  if (r.status === 404 || r.status === 400) return { state: 'GONE' };
  if (r.status !== 200) return { state: 'UNAVAILABLE' };
  try {
    const body = await r.json() as { data?: unknown };
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1) return { state: 'UNAVAILABLE' };
    return { state: 'READY', page: verifySchoolVideoPage(body.data) };
  } catch { return { state: 'UNAVAILABLE' }; }
}

/**
 * The public video page (/v/<token>) a blast links to. It plays HON's 720p copy (/m/<token>) with its poster
 * (/m/<token>/poster); the uploaded original is never reachable. A deleted video, or a school that is not active, shows
 * nothing but a short notice.
 */
export function PublicVideoPage({ token, read = readVideoPage }: { token: string; read?: typeof readVideoPage }): React.ReactElement {
  const [state, setState] = useState<Read>({ state: 'LOADING' });
  useEffect(() => {
    const abort = new AbortController();
    void read(token, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then((value) => { if (!abort.signal.aborted) setState(value); });
    return () => abort.abort();
  }, [token, read]);
  if (state.state === 'LOADING') return <main className={styles.page}><p role="status">Loading…</p></main>;
  if (state.state !== 'READY') return <main className={styles.page}><p role="alert" data-testid="video-gone">
    {state.state === 'GONE' ? 'This video is no longer available.' : 'This video could not be loaded right now. Try again in a moment.'}</p></main>;
  const { page } = state;
  return <main className={styles.page}>
    <p className={styles.school}>{page.schoolName}</p>
    <h1 className={styles.title}>{page.title}</h1>
    <video className={styles.player} controls playsInline preload="metadata" poster={`/m/${token}/poster`} width={page.width} height={page.height} data-testid="video-player">
      <source src={`/m/${token}`} type="video/mp4"/>
    </video>
  </main>;
}
