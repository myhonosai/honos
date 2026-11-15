'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { STAFF_SEARCH_KINDS, STAFF_SEARCH_QUERY_MAX } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResult } from '@hon/contracts';
import { useSchoolShell } from './school-shell/context';
import { KIND_LABEL, safeSearchResults, searchApiPath, searchFailure } from './staff-search-http';
import styles from './staff-search.module.css';

/**
 * Staff search for the school the shell verified (owner, 2026-11-14: the school comes from the session, never a
 * typed ID). The shell selection is only a selector: the search API re-authorizes the exact school, and results are
 * checked against it. The view switch lives in the shell header, so this page has none of its own.
 */
export function StaffSearch(): React.ReactElement {
  const { selection, mode } = useSchoolShell();
  const org = selection?.organizationId ?? '', school = selection?.schoolId ?? '';
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<StaffSearchKind[]>([...STAFF_SEARCH_KINDS]);
  const [results, setResults] = useState<StaffSearchResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  // A different school starts a fresh search: nothing from the previous school stays on screen.
  useEffect(() => { clear(); }, [org, school]); // eslint-disable-line react-hooks/exhaustive-deps
  function clear() { pending.current?.abort(); setResults([]); setState('idle'); setError(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); clear();
    const abort = new AbortController(); pending.current = abort;
    try {
      if (!selection) throw new Error('Choose your school at the top of the page first.');
      const path = searchApiPath(org, school);
      if (!q.trim() || Array.from(q).length > STAFF_SEARCH_QUERY_MAX || !types.length) throw new Error('Type something to search for and keep at least one type ticked.');
      const params = new URLSearchParams({ q, types: STAFF_SEARCH_KINDS.filter(kind => types.includes(kind)).join(',') });
      setState('loading');
      const response = await fetch(`${path}?${params}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(searchFailure(response.status));
      const payload = await response.json() as { data?: { search?: unknown } };
      const cards = safeSearchResults(payload.data?.search, org, school);
      if (!abort.signal.aborted) { setResults(cards); setState('ready'); }
    } catch (failure) {
      if (!abort.signal.aborted) { setState('error'); setError(failure instanceof Error ? failure.message : searchFailure(503)); }
    }
  }
  const themeClass = mode === 'big-button' ? styles.bigButton : mode === 'classic' ? styles.classic : styles.modern;
  return <main className={`${styles.page} ${themeClass}`} data-interface-theme={mode}>
    <header><h1>Search</h1><p>Find students, leads, classes, programs and curricula at your school. Search by name, or by a lead’s email or phone. Results never show contact details.</p></header>
    <form onSubmit={submit} aria-busy={state === 'loading'}>
      <label>Search<input required type="search" maxLength={STAFF_SEARCH_QUERY_MAX} autoComplete="off" value={q} disabled={!selection} onChange={e => { clear(); setQ(e.target.value); }} placeholder="Name, lead email or phone" aria-describedby="search-help" /></label>
      <small id="search-help">Up to 20 results, best matches first. Searches are not saved.</small>
      <fieldset className={styles.types}><legend>Look in</legend>{STAFF_SEARCH_KINDS.map(kind => <label key={kind}><input type="checkbox" checked={types.includes(kind)} onChange={e => { clear(); setTypes(current => e.target.checked ? [...current, kind] : current.filter(value => value !== kind)); }} />{KIND_LABEL[kind]}</label>)}</fieldset>
      <button type="submit" disabled={state === 'loading' || !selection}>{state === 'loading' ? 'Searching…' : 'Search'}</button>
    </form>
    <section className={styles.results} aria-live="polite" aria-busy={state === 'loading'} aria-label="Search results">
      {state === 'idle' && <p>{selection ? 'Nothing is listed until you search.' : 'Choose your school at the top of the page to search it.'}</p>}
      {state === 'loading' && <p>Searching…</p>}
      {state === 'error' && <p className={styles.error} role="alert">{error}</p>}
      {state === 'ready' && <><h2>{results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matches'}</h2>{!results.length && <p>Try another name or tick more types.</p>}
        <ul>{results.map(result => <li key={`${result.kind}:${result.entityId}`}><a href={result.route} referrerPolicy="no-referrer"><span className={styles.eyebrow}>{KIND_LABEL[result.kind]}</span><strong>{result.title}</strong><span>{result.subtitle}</span><small>Open →</small></a></li>)}</ul>
        {results.length === 20 && <p>Showing the first 20 matches. Add more of the name to narrow it down.</p>}</>}
    </section>
  </main>;
}
