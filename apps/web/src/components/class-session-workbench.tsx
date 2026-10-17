'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CLASS_SESSION_POLICIES, ClassSessionAccessError, ClassSessionUncertainError,
  prepareClassSession, submitClassSession, validateClassSessionDraft,
  type ClassSessionDraft, type ClassSessionKnownIds, type ClassSessionWorkbenchResult, type PreparedClassSession,
} from './class-session-workbench-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: ClassSessionKnownIds = { organizationId: '', schoolId: '', programId: '' };
const EMPTY_DRAFT: ClassSessionDraft = { name: '', roomName: '', startsAt: '', endsAt: '', capacity: '', bookingPolicy: '' };
const ID_LABELS: Record<keyof ClassSessionKnownIds, string> = { organizationId: 'Organization UUID', schoolId: 'School UUID', programId: 'Program UUID' };

/** A deliberately idle, direct-human wrapper around the existing canonical session command. */
export function ClassSessionWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<ClassSessionKnownIds>(EMPTY_IDS);
  const [draft, setDraft] = useState<ClassSessionDraft>(EMPTY_DRAFT);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedClassSession | null>(null);
  const [result, setResult] = useState<ClassSessionWorkbenchResult | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const submitted = useRef(false);
  const retained = useRef<PreparedClassSession | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; }; }, []);

  let valid = false;
  try { validateClassSessionDraft(ids, draft); valid = true; } catch { /* only local syntax is checked */ }
  function edit(change: () => void): void {
    if (active.current || !mounted.current) return;
    epoch.current++; change(); submitted.current = false; retained.current = null;
    setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setError('');
  }
  function discard(): void { edit(() => { setIds(EMPTY_IDS); setDraft(EMPTY_DRAFT); }); }
  function clearAccess(): void {
    epoch.current++; submitted.current = false; retained.current = null;
    setIds(EMPTY_IDS); setDraft(EMPTY_DRAFT); setConfirmed(false); setAttempted(false); setRetry(null); setResult(null);
  }
  async function send(command: PreparedClassSession): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current;
    active.current = true; submitted.current = true; retained.current = null;
    setBusy(true); setAttempted(true); setRetry(null); setResult(null); setError('');
    try {
      const receipt = await submitClassSession(command);
      if (mounted.current && generation === epoch.current) setResult(receipt);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof ClassSessionAccessError) clearAccess();
      else if (caught instanceof ClassSessionUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified class-session receipt.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || submitted.current || !confirmed || !mounted.current) return;
    try {
      validateClassSessionDraft(ids, draft);
      void send(prepareClassSession(ids, draft, crypto.randomUUID()));
    } catch { setError('Enter exact already-known UUIDs, bounded UTC session values, capacity and one permitted policy. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedClassSession): void {
    if (retained.current !== command || active.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / CONVENTIONAL STAFF OPERATIONS</p><h1>Create one class session</h1>
      <p>Record one current-school operational class session through the existing canonical command. This workbench starts blank and idle: it performs no lookup, list, search, directory, calendar request or automatic I/O.</p>
    </header>
    <aside><strong>Current school authority remains server-owned.</strong>
      <p>The organization, school and program UUIDs are untrusted exact selectors. The canonical API scope check, service/RLS boundaries and <code>schedule.session.manage</code> authorization remain authoritative; this page does not establish program validity or permission.</p>
      <p>This is not recurring scheduling, calendar integration, instructor availability or assignment, booking, attendance, roster, capacity guarantee, ClassPass, payment, membership, provider, AI, Action Engine, automation or communication. No external delivery is activated.</p>
    </aside>
    <section aria-labelledby="session-command"><h2 id="session-command">Exact-known-ID class-session command</h2>
      <p>Enter already-known organization, current school and program UUIDs; a bounded session name, optional room name, canonical UTC start/end timestamps, positive bounded capacity and one existing booking policy. These entries never query or discover a record.</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{(Object.keys(ID_LABELS) as (keyof ClassSessionKnownIds)[]).map((field) => <label key={field}>{ID_LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={(event) => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}</div>
        <div className={styles.scopeGrid}>
          <label>Session name (maximum 160 characters)<input name="name" required autoComplete="off" maxLength={160} value={draft.name} onChange={(event) => edit(() => setDraft({ ...draft, name: event.target.value }))} /></label>
          <label>Optional room name (maximum 160 characters)<input name="roomName" autoComplete="off" maxLength={160} value={draft.roomName} onChange={(event) => edit(() => setDraft({ ...draft, roomName: event.target.value }))} /></label>
          <label>UTC start (YYYY-MM-DDTHH:mm:ss.sssZ)<input name="startsAt" required autoComplete="off" spellCheck={false} maxLength={24} placeholder="2026-10-16T12:00:00.000Z" value={draft.startsAt} onChange={(event) => edit(() => setDraft({ ...draft, startsAt: event.target.value }))} /></label>
          <label>UTC end (YYYY-MM-DDTHH:mm:ss.sssZ)<input name="endsAt" required autoComplete="off" spellCheck={false} maxLength={24} placeholder="2026-10-16T13:00:00.000Z" value={draft.endsAt} onChange={(event) => edit(() => setDraft({ ...draft, endsAt: event.target.value }))} /></label>
          <label>Capacity (positive whole number)<input name="capacity" required autoComplete="off" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={10} value={draft.capacity} onChange={(event) => edit(() => setDraft({ ...draft, capacity: event.target.value }))} /></label>
          <label>Existing booking policy<select name="bookingPolicy" required value={draft.bookingPolicy} onChange={(event) => edit(() => setDraft({ ...draft, bookingPolicy: event.target.value }))}><option value="">Choose a booking policy</option>{CLASS_SESSION_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}</select></label>
        </div>
        <p>UTC times are syntax-checked locally only; the canonical command independently validates the program, current scope, entitlement, timestamps and all tenant boundaries. Capacity and policy are recorded facts, not an availability, booking or roster promise.</p>
        <label className={styles.check}><input name="confirmSession" type="checkbox" checked={confirmed} disabled={attempted || !valid} onChange={(event) => setConfirmed(event.target.checked)} />I explicitly confirm this exact one-time class-session creation command only. I am not creating a recurring calendar, instructor assignment, booking, attendance, roster, capacity guarantee or downstream action.</label>
        <div className={styles.actions}><button type="submit" disabled={!valid || !confirmed || attempted}>Create class session</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
    </section>
    {busy && <p role="status">Submitting the exact human class-session command…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!result && !busy && <p className={styles.empty}>No verified class-session receipt is shown.</p>}
    {retry && <div className={styles.warning}><p>Only this exact path, closed body and generated UUID key are retained in memory. No automatic retry occurs. Editing or discarding removes the retry; the earlier uncertain command may already have created a class session. Seek authorized staff review before submitting a different command.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged class-session command</button></div>}
    {result && <section aria-label="Returned class-session receipt" className={styles.record}><h2>Returned class-session receipt</h2>
      <p>{result.replayed ? 'Replayed or previously recorded class-session receipt.' : 'Recorded class-session receipt.'} This is the original command-response snapshot, not a live schedule, capacity, booking, roster or calendar state.</p>
      <dl><dt>Class session UUID</dt><dd>{result.classSession.id}</dd><dt>Program UUID</dt><dd>{result.classSession.programId}</dd><dt>Returned name</dt><dd>{result.classSession.name}</dd>
        {result.classSession.roomName && <><dt>Returned room</dt><dd>{result.classSession.roomName}</dd></>}<dt>UTC start / end</dt><dd>{result.classSession.startsAt} / {result.classSession.endsAt}</dd>
        <dt>Returned capacity / booking policy</dt><dd>{result.classSession.capacity} / {result.classSession.bookingPolicy}</dd><dt>Returned status / version</dt><dd>{result.classSession.status} / {result.classSession.version}</dd><dt>Created at</dt><dd>{result.classSession.createdAt}</dd></dl>
      <p>The returned <code>SCHEDULED</code> record is not a recurring calendar, instructor availability, booking, attendance, roster or capacity guarantee, ClassPass allowance, payment or membership outcome. It does not create provider, AI, Action Engine, automation or communication effects.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only exact retries are memory-only. Every input edit clears confirmation, receipt and retry; access loss clears every input and fact. Reload/remount starts idle. No persistence, polling, list, search or refresh exists.</p>
  </main>;
}
