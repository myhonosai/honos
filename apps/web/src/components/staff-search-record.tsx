'use client';

import React, { useEffect, useState } from 'react';
import { STAFF_SEARCH_KINDS } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResult } from '@hon/contracts';
import { SEARCH_UUID, KIND_LABEL, safeSearchCard, searchApiPath, searchFailure } from './staff-search-http';
import styles from './staff-search.module.css';

export function StaffSearchRecord({ organizationId, schoolId, kind, entityId }: { organizationId: string; schoolId: string; kind: string; entityId: string }): React.ReactElement {
  const [result, setResult] = useState<StaffSearchResult | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setResult(null); setError('');
    async function read() {
      try {
        if (!SEARCH_UUID.test(entityId) || !STAFF_SEARCH_KINDS.includes(kind as StaffSearchKind)) throw new Error('This search route is invalid.');
        const path = `${searchApiPath(organizationId, schoolId)}/results/${kind}/${entityId.toLowerCase()}`;
        const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal, referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(searchFailure(response.status));
        const payload = await response.json() as { data?: { result?: unknown } };
        const card = safeSearchCard(payload.data?.result, organizationId, schoolId);
        if (card.kind !== kind || card.entityId !== entityId.toLowerCase()) throw new Error('This search record is unavailable.');
        if (!abort.signal.aborted) setResult(card);
      } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : searchFailure(503)); }
    }
    void read(); return () => abort.abort();
  }, [organizationId, schoolId, kind, entityId]);
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/search">Back to staff search</a><a href="/staff/dashboard">School dashboard</a><a href="/auth/login">Sign in</a></nav>
    <header><p className={styles.eyebrow}>STAFF / SCOPED RECORD</p><h1>One record.<br />One school.</h1><p>Access is checked again when this page opens. This is a redacted search record, not an expanded profile or action surface.</p></header>
    <section aria-live="polite" aria-busy={!result && !error}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : result ? <article className={styles.card}><p className={styles.eyebrow}>{KIND_LABEL[result.kind]}</p><h2>{result.title}</h2><p>{result.subtitle}</p></article> : <p>Verifying staff access and reading this record…</p>}
    </section>
    <aside className={styles.notice}>Search only finds and navigates. Private details, documents, billing and actions require their own independently authorized operational surfaces. No change is made here.</aside>
  </main>;
}
