'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { STAFF_SEARCH_KINDS, STAFF_SEARCH_QUERY_MAX } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResult } from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { InterfaceThemePicker } from './interface-theme-picker';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from './interface-theme-preference';
import { KIND_LABEL, safeSearchResults, searchApiPath, searchFailure } from './staff-search-http';
import styles from './staff-search.module.css';

type VerifiedSearchScope = { organizationId: string; schoolId: string };
type InterfaceThemeState = 'UNAVAILABLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function PlatformViewSelector({
  interfaceTheme,
  interfaceThemeState,
  interfaceThemeMessage,
  onChange,
}: {
  interfaceTheme: HonInterfaceTheme;
  interfaceThemeState: InterfaceThemeState;
  interfaceThemeMessage: string;
  onChange: (theme: HonInterfaceTheme) => void;
}): React.ReactElement {
  return <section className={styles.platformView} aria-labelledby="platform-view-heading">
    <div><p className={styles.eyebrow}>PRESENTATION ONLY / VERIFIED SCHOOL</p><h2 id="platform-view-heading">Platform View</h2><p>Big-Button / Phone, Modern HON, and Classic CRM change touch targets and density only. They use the same verified search scope, result types, result cards, permission checks, request semantics, and navigation paths.</p></div>
    <InterfaceThemePicker
      current={interfaceTheme}
      onChange={onChange}
      disabled={interfaceThemeState !== 'READY'}
      busy={interfaceThemeState === 'LOADING' || interfaceThemeState === 'SAVING'}
      presentation={interfaceTheme === 'classic' ? 'compact' : 'cards'}
      ariaLabel="Platform View for the verified current school"
    />
    <p className={styles.platformViewStatus} role="status" aria-live="polite">{interfaceThemeMessage}</p>
  </section>;
}

export function StaffSearch(): React.ReactElement {
  const [org, setOrg] = useState(''); const [school, setSchool] = useState(''); const [q, setQ] = useState('');
  const [types, setTypes] = useState<StaffSearchKind[]>([...STAFF_SEARCH_KINDS]);
  const [results, setResults] = useState<StaffSearchResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const [error, setError] = useState('');
  const [verifiedScope, setVerifiedScope] = useState<VerifiedSearchScope | null>(null);
  const [interfaceTheme, setInterfaceTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [interfaceThemeState, setInterfaceThemeState] = useState<InterfaceThemeState>('UNAVAILABLE');
  const [interfaceThemeMessage, setInterfaceThemeMessage] = useState('Run a verified school search to view or change your personal Platform View preference.');
  const pending = useRef<AbortController | null>(null);
  const interfaceThemeGeneration = useRef(0);
  useEffect(() => () => { pending.current?.abort(); interfaceThemeGeneration.current += 1; }, []);
  useEffect(() => {
    if (!verifiedScope) {
      interfaceThemeGeneration.current += 1;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE');
      setInterfaceThemeMessage('Run a verified school search to view or change your personal Platform View preference.');
      return;
    }
    const current = ++interfaceThemeGeneration.current;
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('LOADING');
    setInterfaceThemeMessage('Loading your personal Platform View preference for this verified current school…');
    void loadInterfaceThemePreference(verifiedScope).then((preference) => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY');
      setInterfaceThemeMessage(preference.selectedVia === 'DEFAULT'
        ? 'Modern HON is the visual default for this verified current school. Choosing another presentation is optional.'
        : 'Saved for your current user and this verified current school only. It never changes search data, permissions, authority, request semantics, or navigation.');
    }).catch((reason) => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} Modern HON remains a visual default only; no preference was loaded or saved.`);
    });
    return () => { if (current === interfaceThemeGeneration.current) interfaceThemeGeneration.current += 1; };
  }, [verifiedScope?.organizationId, verifiedScope?.schoolId]);
  function clear() {
    pending.current?.abort(); interfaceThemeGeneration.current += 1;
    setResults([]); setState('idle'); setError(''); setVerifiedScope(null);
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE');
    setInterfaceThemeMessage('Run a verified school search to view or change your personal Platform View preference.');
  }
  async function chooseInterfaceTheme(next: HonInterfaceTheme) {
    if (!verifiedScope || interfaceThemeState !== 'READY') return;
    const current = ++interfaceThemeGeneration.current;
    setInterfaceThemeState('SAVING'); setInterfaceThemeMessage('Saving your personal Platform View preference for this verified current school…');
    try {
      const preference = await saveInterfaceThemePreference(verifiedScope, next, crypto.randomUUID(), 'SETTINGS');
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY');
      setInterfaceThemeMessage('Saved for your current user and this verified current school only. It never changes search data, permissions, authority, request semantics, or navigation.');
    } catch (reason) {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} No presentation preference was saved.`);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); clear();
    const abort = new AbortController(); pending.current = abort;
    try {
      const path = searchApiPath(org, school);
      if (!q.trim() || Array.from(q).length > STAFF_SEARCH_QUERY_MAX || !types.length) throw new Error('Enter 1–120 characters and select at least one type.');
      const params = new URLSearchParams({ q, types: STAFF_SEARCH_KINDS.filter(kind => types.includes(kind)).join(',') });
      setState('loading');
      const response = await fetch(`${path}?${params}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(searchFailure(response.status));
      const payload = await response.json() as { data?: { search?: unknown } };
      const cards = safeSearchResults(payload.data?.search, org, school);
      if (!abort.signal.aborted) {
        setResults(cards); setState('ready');
        setVerifiedScope({ organizationId: org.toLowerCase(), schoolId: school.toLowerCase() });
      }
    } catch (failure) {
      if (!abort.signal.aborted) { setState('error'); setError(failure instanceof Error ? failure.message : searchFailure(503)); }
    }
  }
  const themeClass = interfaceTheme === 'big-button' ? styles.bigButton : interfaceTheme === 'classic' ? styles.classic : styles.modern;
  return <main className={`${styles.page} ${themeClass}`} data-interface-theme={interfaceTheme}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">School dashboard</a><a href="/staff/documents">Documents</a><a href="/staff/roles">Roles</a><a href="/staff/team/availability">Staff availability</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/auth/login">Sign in</a></nav>
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
    {verifiedScope && <PlatformViewSelector interfaceTheme={interfaceTheme} interfaceThemeState={interfaceThemeState} interfaceThemeMessage={interfaceThemeMessage} onChange={(theme) => void chooseInterfaceTheme(theme)} />}
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
