'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { TestingCandidateAccessError, TestingCandidateUncertainError, prepareTestingCandidateRegistration, submitTestingCandidateRegistration, validateTestingCandidateDraft,
  type TestingCandidateKnownIds, type TestingCandidateRegistrationReceipt, type PreparedTestingCandidateRegistration } from './testing-candidate-registration-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: TestingCandidateKnownIds = { organizationId: '', schoolId: '', testingEventId: '', studentCurriculumEnrollmentId: '', targetRankId: '' };
const LABELS: Record<keyof TestingCandidateKnownIds, string> = { organizationId: 'Organization UUID', schoolId: 'School UUID', testingEventId: 'Testing event UUID', studentCurriculumEnrollmentId: 'Student curriculum enrollment UUID', targetRankId: 'Target rank UUID' };

/** One direct-human known-ID command only: no discovery, read or outcome inference. */
export function TestingCandidateRegistrationWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<TestingCandidateKnownIds>(EMPTY_IDS);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<PreparedTestingCandidateRegistration | null>(null);
  const [receipt, setReceipt] = useState<TestingCandidateRegistrationReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const attempted = useRef(false);
  const retained = useRef<PreparedTestingCandidateRegistration | null>(null);
  // Cleanup only: no request, key allocation, polling, timer or automatic work.
  // An idle Strict Mode cleanup/setup replay must not invalidate the first render's handlers.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (active.current) epoch.current++; retained.current = null; }; }, []);
  const renderedEpoch = epoch.current;
  let validDraft = false;
  try { validateTestingCandidateDraft(ids, note); validDraft = true; } catch { /* local syntax only, never eligibility */ }

  function reset(): void {
    epoch.current++; attempted.current = false; retained.current = null;
    setNote(''); setConfirmed(false); setRetry(null); setReceipt(null); setError('');
  }
  function edit(change: () => void): void {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    epoch.current++; attempted.current = false; retained.current = null;
    setRetry(null); setReceipt(null); setConfirmed(false); setError(''); change();
  }
  function discard(): void {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    reset(); setIds(EMPTY_IDS);
  }
  function confirm(checked: boolean): void {
    if (active.current || attempted.current || !mounted.current || renderedEpoch !== epoch.current) return;
    if (checked) { try { validateTestingCandidateDraft(ids, note); } catch { return; } }
    // Also invalidate old confirmed submit handlers when confirmation is revoked.
    epoch.current++; setConfirmed(checked);
  }
  async function send(command: PreparedTestingCandidateRegistration): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; attempted.current = true; retained.current = null;
    setNote(''); setConfirmed(false); setRetry(null); setReceipt(null); setError(''); setBusy(true);
    try {
      const returned = await submitTestingCandidateRegistration(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof TestingCandidateAccessError) { reset(); setIds(EMPTY_IDS); }
      else if (caught instanceof TestingCandidateUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified candidate receipt. Review before another explicit command.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted.current || !confirmed || !mounted.current || renderedEpoch !== epoch.current) return;
    try {
      validateTestingCandidateDraft(ids, note);
      void send(prepareTestingCandidateRegistration(ids, note, crypto.randomUUID()));
    } catch { setError('Enter five exact already-known UUIDs and an optional note of at most 2000 characters. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedTestingCandidateRegistration): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>HON / CONVENTIONAL INSTRUCTOR OPERATIONS</p><h1>Human testing candidate registration</h1>
      <p>This page starts blank and idle. Supply the exact already-known organization, school, testing event, student curriculum enrollment and target rank UUIDs. There is no directory, search, list, automatic request or eligibility selection.</p>
    </header>
    <aside><strong>PENDING is candidate evidence only, not eligibility or testing completion.</strong>
      <p>This command creates only a PENDING candidate, canonical audit and inert outbox evidence. It does not establish testing eligibility or readiness, a roster, place or capacity; score, grade, pass/fail/defer; promotion, rank, belt or certificate; family or parent access; attendance, billing, payment, message, provider, AI, Action Engine, automation or external effect.</p>
      <p>UUIDs are untrusted selectors, not authority. Current direct HUMAN_USER / HUMAN_UI identity, exact <code>testing.manage</code> school scope, tenant RLS, event/enrollment/rank curriculum integrity and unique candidate rechecks remain server-owned on every submit and replay. No outbox consumer is activated.</p>
    </aside>
    <section aria-labelledby="candidate-command"><h2 id="candidate-command">Register one known-ID candidate</h2>
      <form autoComplete="off" onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{(Object.keys(LABELS) as (keyof TestingCandidateKnownIds)[]).map(field =>
          <label key={field}>{LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}</div>
        <label>Optional private instructor notes (maximum 2000 characters)<textarea name="instructorNotes" autoComplete="off" maxLength={2000} value={note} onChange={event => edit(() => setNote(event.target.value))} /></label>
        <p>Local UUID syntax and note bounds do not verify existence, eligibility, readiness or capacity. Only the existing server command can accept these IDs together.</p>
        <label className={styles.check}><input name="confirmRegistration" type="checkbox" checked={confirmed} disabled={!validDraft || attempted.current} onChange={event => confirm(event.target.checked)} />I explicitly confirm this exact PENDING candidate registration only, not eligibility, testing completion or any downstream effect.</label>
        <div className={styles.actions}><button type="submit" disabled={!validDraft || !confirmed || attempted.current}>Register PENDING candidate</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
    </section>
    {busy && <p role="status">Submitting the explicit human candidate command…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!receipt && <p className={styles.empty}>No verified PENDING candidate receipt is shown.</p>}
    {retry && <div className={styles.warning}><p>Only the exact path, body and generated UUID key are retained in memory for a separate human retry. The earlier uncertain command may still have created a candidate. Editing, discarding or reloading is not cancellation; seek separately authorized staff review before a different command.</p>
      <button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged registration</button></div>}
    {receipt && <section aria-label="Returned PENDING candidate receipt" className={styles.record}><h2>Returned candidate: PENDING</h2>
      <p>{receipt.replayed ? 'Replayed or previously recorded candidate receipt.' : 'Recorded candidate receipt.'} This is a command-response snapshot, not live status, eligibility or testing completion.</p>
      <dl><dt>Candidate UUID</dt><dd>{receipt.candidate.id}</dd><dt>Testing event UUID</dt><dd>{receipt.candidate.testingEventId}</dd>
        <dt>Student curriculum enrollment UUID</dt><dd>{receipt.candidate.studentCurriculumEnrollmentId}</dd><dt>Target rank UUID</dt><dd>{receipt.candidate.targetRankId}</dd>
        <dt>Candidate result / version</dt><dd>{receipt.candidate.result} / {receipt.candidate.version}</dd><dt>Created at</dt><dd>{receipt.candidate.createdAt}</dd></dl>
      <p>Only canonical PENDING candidate facts are displayed. No private notes, actor, authority, audit or outbox payload is displayed. No grading, promotion or certificate action is exposed.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only exact retries are memory-only. Edits reset confirmation, receipt and retry. Every command attempt clears the visible note and confirmation; a new command requires an edit or explicit start over. Access loss clears every input and fact. Remount/reload starts idle. No storage, polling or automatic retry exists.</p>
  </main>;
}
