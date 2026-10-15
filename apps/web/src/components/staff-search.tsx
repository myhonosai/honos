'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { STAFF_SEARCH_KINDS, STAFF_SEARCH_QUERY_MAX } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResult } from '@hon/contracts';
import { KIND_LABEL, safeSearchResults, searchApiPath, searchFailure } from './staff-search-http';
import styles from './staff-search.module.css';

export function StaffSearch(): React.ReactElement {
  const [org, setOrg] = useState(''); const [school, setSchool] = useState(''); const [q, setQ] = useState('');
  const [types, setTypes] = useState<StaffSearchKind[]>([...STAFF_SEARCH_KINDS]);
  const [results, setResults] = useState<StaffSearchResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function clear() { pending.current?.abort(); setResults([]); setState('idle'); setError(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); pending.current?.abort();
    const abort = new AbortController(); pending.current = abort;
    setResults([]); setError('');
    try {
      const path = searchApiPath(org, school);
      if (!q.trim() || Array.from(q).length > STAFF_SEARCH_QUERY_MAX || !types.length) throw new Error('Enter 1–120 characters and select at least one type.');
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
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/documents">Documents</a><a href="/staff/roles">Roles</a><a href="/staff/team/availability">Staff availability</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/auth/login">Sign in</a></nav>
    <header><p className={styles.eyebrow}>STAFF / SINGLE-SCHOOL SEARCH</p><h1>Find the record.<br />Keep your focus.</h1><p>Search student and lead names, class sessions, programs and curricula in one authorized school. Lead email or phone can help find a match; contact details stay out of results.</p></header>
    <aside className={styles.notice}>Conventional, read-only search. Available across Essential, Core and Complete with <code>search.global</code> permission. No notes, billing, documents, internal knowledge or staff directory are searched. This is not HON Command or Parent/Eian search.</aside>
    <form onSubmit={submit} aria-busy={state === 'loading'}>
      <fieldset disabled={state === 'loading'} className={styles.scope}><legend>Current school scope</legend>
        <label>Organization UUID<input required autoComplete="off" value={org} onChange={e => { clear(); setOrg(e.target.value); }} /></label>
        <label>School UUID<input required autoComplete="off" value={school} onChange={e => { clear(); setSchool(e.target.value); }} /></label>
        <small>Use your already-known school identifiers. Entering an ID does not grant access.</small>
      </fieldset>
      <label>Search<input required type="search" maxLength={STAFF_SEARCH_QUERY_MAX} autoComplete="off" value={q} onChange={e => { clear(); setQ(e.target.value); }} placeholder="Name, lead email or phone" aria-describedby="search-help" /></label>
      <small id="search-help">Literal, case-insensitive matching. Up to 20 results, with exact and prefix title matches first. Queries are not saved by this page.</small>
      <fieldset className={styles.types}><legend>Result types</legend>{STAFF_SEARCH_KINDS.map(kind => <label key={kind}><input type="checkbox" checked={types.includes(kind)} onChange={e => { clear(); setTypes(current => e.target.checked ? [...current, kind] : current.filter(value => value !== kind)); }} />{KIND_LABEL[kind]}</label>)}</fieldset>
      <button type="submit" disabled={state === 'loading'}>{state === 'loading' ? 'Searching this school…' : 'Search this school'}</button>
    </form>
    <section className={styles.results} aria-live="polite" aria-busy={state === 'loading'} aria-label="Search results">
      {state === 'idle' && <p>Choose your authorized school and enter a search to find records. Nothing is listed until you search.</p>}
      {state === 'loading' && <p>Checking access and searching…</p>}
      {state === 'error' && <p className={styles.error} role="alert">{error}</p>}
      {state === 'ready' && <><h2>{results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matching records'}</h2>{!results.length && <p>Try another name or a different result type. Search stays within this school.</p>}
        <ul>{results.map(result => <li key={`${result.kind}:${result.entityId}`}><a href={result.route} referrerPolicy="no-referrer"><span className={styles.eyebrow}>{KIND_LABEL[result.kind]}</span><strong>{result.title}</strong><span>{result.subtitle}</span><small>Open scoped record →</small></a></li>)}</ul>
        {results.length === 20 && <p>Showing the first 20 matches. Narrow your search to find a specific record.</p>}</>}
    </section>
  </main>;
}
