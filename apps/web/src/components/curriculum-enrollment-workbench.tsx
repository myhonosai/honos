'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CurriculumEnrollmentAccessError, CurriculumEnrollmentUncertainError,
  prepareCurriculumEnrollment, submitCurriculumEnrollment, validateCurriculumEnrollmentDraft,
  type CurriculumEnrollmentKnownIds, type CurriculumEnrollmentReceipt, type PreparedCurriculumEnrollment,
} from './curriculum-enrollment-workbench-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: CurriculumEnrollmentKnownIds = { organizationId: '', schoolId: '', curriculumId: '', studentProfileId: '', currentRankId: '' };
const LABELS: Record<keyof CurriculumEnrollmentKnownIds, string> = {
  organizationId: 'Organization UUID', schoolId: 'School UUID', curriculumId: 'Curriculum UUID', studentProfileId: 'Student profile UUID', currentRankId: 'Current rank UUID (optional)',
};

/** One explicit human enrollment command through the existing canonical curriculum service. */
export function CurriculumEnrollmentWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<CurriculumEnrollmentKnownIds>(EMPTY_IDS);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCurriculumEnrollment | null>(null);
  const [receipt, setReceipt] = useState<CurriculumEnrollmentReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const retained = useRef<PreparedCurriculumEnrollment | null>(null);
  const epoch = useRef(0);
  // Cleanup only: this page never sends, loads, retries, or allocates a key automatically.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; retained.current = null; };
  }, []);

  let valid = false;
  try { validateCurriculumEnrollmentDraft(ids); valid = true; } catch { /* local syntax only */ }

  function edit(change: () => void): void {
    if (active.current || !mounted.current) return;
    epoch.current++; retained.current = null; change();
    setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); setError('');
  }
  function discard(): void {
    edit(() => setIds(EMPTY_IDS));
  }
  function clearAccess(): void {
    epoch.current++; retained.current = null;
    setIds(EMPTY_IDS); setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null);
  }
  async function send(command: PreparedCurriculumEnrollment): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current;
    active.current = true; retained.current = null;
    setBusy(true); setAttempted(true); setRetry(null); setReceipt(null); setError('');
    try {
      const returned = await submitCurriculumEnrollment(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumEnrollmentAccessError) clearAccess();
      else if (caught instanceof CurriculumEnrollmentUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified curriculum enrollment receipt.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted || !confirmed || !mounted.current) return;
    try {
      validateCurriculumEnrollmentDraft(ids);
      // The single idempotency UUID is allocated only after a valid explicit confirmation.
      void send(prepareCurriculumEnrollment(ids, crypto.randomUUID()));
    } catch {
      setError('Enter four exact already-known UUIDs and either one exact known rank UUID or a blank rank for unranked. Nothing was submitted.');
    }
  }
  function retryExact(command: PreparedCurriculumEnrollment): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / CONVENTIONAL INSTRUCTOR OPERATIONS</p><h1>Human curriculum enrollment</h1>
      <p>This page starts idle. Enter exact already-known organization, school, curriculum and student-profile UUIDs. Optionally enter one exact already-known current-rank UUID; leaving it blank deliberately submits an unranked record. No directory, list, search or automatic request is available.</p>
    </header>
    <aside><strong>Existing server authority remains the only authority.</strong>
      <p>UUIDs are untrusted selectors, not authority. The existing canonical service independently resolves the current human, current school, <code>curriculum.progress.record</code> permission, active entitlement, tenant RLS, idempotency, audit and inert outbox boundary on every submit and replay.</p>
      <p>This command cannot determine or confer promotion, eligibility, testing, attendance, booking, billing, payment, membership, consent, communication, provider, AI, Action Engine or automation. An optional known rank is placement data only; no rank outcome is claimed.</p>
    </aside>
    <section aria-labelledby="enrollment-command"><h2 id="enrollment-command">Exact-known-ID enrollment command</h2>
      <p>All required IDs must already be known to the staff member. Blank current rank is intentional unranked placement, not a missing lookup and not an implied next action.</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{(Object.keys(LABELS) as (keyof CurriculumEnrollmentKnownIds)[]).map(field =>
          <label key={field}>{LABELS[field]}<input name={field} required={field !== 'currentRankId'} autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}</div>
        <label className={styles.check}><input name="confirmEnrollment" type="checkbox" checked={confirmed} disabled={attempted || !valid} onChange={event => setConfirmed(event.target.checked)} />I explicitly confirm this exact human curriculum enrollment command. A blank current-rank field deliberately represents unranked.</label>
        <div className={styles.actions}><button type="submit" disabled={!valid || !confirmed || attempted}>Submit human curriculum enrollment</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
      {busy && <p role="status">Submitting the exact human curriculum enrollment command…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {retry && <div className={styles.warning}><p>Only this exact path, body and generated UUID key are retained in memory. No automatic retry occurs. Editing or discarding removes the retry; the earlier uncertain command may still have recorded an enrollment. Seek staff review before submitting a different command.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged enrollment command</button></div>}
      {!receipt && !busy && <p className={styles.empty}>No verified ACTIVE enrollment receipt is shown.</p>}
    </section>
    {receipt && <section aria-label="Returned enrollment receipt" className={styles.record}>
      <h2>Returned enrollment receipt: ACTIVE</h2>
      <p>{receipt.replayed ? 'Replayed or previously recorded enrollment receipt.' : 'Recorded enrollment receipt.'} This is a command-response snapshot, not a live status or a statement about another workflow.</p>
      <dl><dt>Enrollment UUID</dt><dd>{receipt.enrollment.id}</dd><dt>Curriculum UUID</dt><dd>{receipt.enrollment.curriculumId}</dd>
        <dt>Student profile UUID</dt><dd>{receipt.enrollment.studentProfileId}</dd>
        <dt>Current rank UUID</dt><dd>{receipt.enrollment.currentRankId ?? 'Unranked (returned null)'}</dd><dt>Enrollment version</dt><dd>{receipt.enrollment.version}</dd><dt>Enrolled at</dt><dd>{receipt.enrollment.enrolledAt}</dd></dl>
      <p>ACTIVE is the returned enrollment record status only. It does not establish promotion, eligibility, testing, attendance, booking, billing, payment, membership, consent, communication, provider, AI, Action Engine or automation.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only retries are memory-only. Every edit resets confirmation, receipt and retry; access loss clears all inputs and facts. Remount/reload starts idle. Discarding an uncertain command is not cancellation.</p>
  </main>;
}
