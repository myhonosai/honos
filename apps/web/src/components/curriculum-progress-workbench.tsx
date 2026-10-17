'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CurriculumProgressStatus, StaffCurriculumEnrollmentDetails } from '@hon/contracts';
import { CurriculumProgressAccessError, CurriculumProgressUncertainError, HUMAN_PROGRESS_STATUSES, loadCurriculumEnrollment, prepareCurriculumObservation,
  submitCurriculumObservation, validateCurriculumObservationDraft, validateCurriculumProgressIds, type CurriculumProgressKnownIds, type CurriculumObservationReceipt, type PreparedCurriculumObservation } from './curriculum-progress-workbench-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: CurriculumProgressKnownIds = { organizationId: '', schoolId: '', curriculumId: '', enrollmentId: '' };
const LABELS: Record<keyof CurriculumProgressKnownIds, string> = { organizationId: 'Organization UUID', schoolId: 'School UUID', curriculumId: 'Curriculum UUID', enrollmentId: 'Enrollment UUID' };

/** One current enrollment and one appended human observation. No placement or history command. */
export function CurriculumProgressWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<CurriculumProgressKnownIds>(EMPTY_IDS);
  const [snapshot, setSnapshot] = useState<StaffCurriculumEnrollmentDetails | null>(null);
  const [requirementId, setRequirementId] = useState('');
  const [chosenStatus, setChosenStatus] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<PreparedCurriculumObservation | null>(null);
  const [receipt, setReceipt] = useState<CurriculumObservationReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const attempted = useRef(false);
  const retained = useRef<PreparedCurriculumObservation | null>(null);
  const currentSnapshot = useRef<StaffCurriculumEnrollmentDetails | null>(null);
  // Cleanup only: no request, UUID allocation, timer or automatic refresh.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; currentSnapshot.current = null; }; }, []);
  const renderedEpoch = epoch.current;
  let validIds = false; let validDraft = false;
  try { validateCurriculumProgressIds(ids); validIds = true; } catch { /* local syntax only */ }
  try { if (snapshot) { validateCurriculumObservationDraft(ids, snapshot, requirementId, chosenStatus, note); validDraft = true; } } catch { /* no verified draft */ }

  function clearDraft(): void { setRequirementId(''); setChosenStatus(''); setNote(''); setConfirmed(false); }
  function clearSnapshot(): void { currentSnapshot.current = null; setSnapshot(null); }
  function reset(): void {
    epoch.current++; attempted.current = false; retained.current = null; clearSnapshot(); clearDraft(); setRetry(null); setReceipt(null); setError('');
  }
  function edit(change: () => void, scope = false): void {
    if (active.current || !mounted.current) return;
    epoch.current++; retained.current = null;
    if (scope || attempted.current) { clearSnapshot(); clearDraft(); }
    attempted.current = false; setRetry(null); setReceipt(null); setConfirmed(false); setError(''); change();
  }
  function discard(): void { if (active.current || !mounted.current) return; reset(); setIds(EMPTY_IDS); }
  function accessLoss(): void { reset(); setIds(EMPTY_IDS); }
  async function load(): Promise<void> {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    try { validateCurriculumProgressIds(ids); } catch { setError('Enter the four exact already-known UUIDs. Nothing was read.'); return; }
    reset(); const generation = epoch.current; active.current = true; setBusy(true);
    try {
      const returned = await loadCurriculumEnrollment(ids);
      if (mounted.current && generation === epoch.current) { currentSnapshot.current = returned; setSnapshot(returned); }
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumProgressAccessError) accessLoss();
      setError(caught instanceof Error ? caught.message : 'No verified current enrollment.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  async function send(command: PreparedCurriculumObservation): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; attempted.current = true; retained.current = null;
    clearSnapshot(); clearDraft(); setRetry(null); setReceipt(null); setError(''); setBusy(true);
    try {
      const returned = await submitCurriculumObservation(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumProgressAccessError) accessLoss();
      else if (caught instanceof CurriculumProgressUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified observation receipt. Explicitly reload before a new command.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted.current || !confirmed || !mounted.current || renderedEpoch !== epoch.current || !snapshot || currentSnapshot.current !== snapshot) return;
    try {
      validateCurriculumObservationDraft(ids, snapshot, requirementId, chosenStatus, note);
      void send(prepareCurriculumObservation(ids, snapshot, requirementId, chosenStatus as CurriculumProgressStatus, note, crypto.randomUUID()));
    } catch { setError('Choose one returned current-rank requirement, a permitted status and a note of at most 2000 characters. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedCurriculumObservation): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a></nav>
    <header><p>HON / CONVENTIONAL INSTRUCTOR OPERATIONS</p><h1>Human curriculum progress</h1>
      <p>This page starts idle. Enter one exact already-known organization, school, curriculum and enrollment UUID, then explicitly load its current server-returned enrollment and current-rank requirements. No directory, search or automatic request is available.</p>
    </header>
    <aside><strong>MET is a human observation, never an outcome in another workflow.</strong>
      <p>No status here grants promotion, rank, belt, certificate, testing readiness or eligibility, grade, attendance, booking, membership, payment, family or parent access, communication, provider, AI, Action Engine or automation outcome. Even an ATTENDANCE requirement kind is curriculum observation evidence only, not attendance credit.</p>
      <p>UUIDs are untrusted selectors, not authority. Existing tenant RLS, current human identity, exact <code>curriculum.progress.record</code> permission, school entitlement and version rechecks remain server-owned on every read, submit and replay. The inert curriculum outbox event gains no consumer.</p>
    </aside>
    <section aria-labelledby="enrollment-read"><h2 id="enrollment-read">Exact current enrollment read</h2>
      <fieldset disabled={busy}><div className={styles.scopeGrid}>{(Object.keys(LABELS) as (keyof CurriculumProgressKnownIds)[]).map(field =>
        <label key={field}>{LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }), true)} /></label>)}</div>
        <div className={styles.actions}><button type="button" disabled={!validIds} onClick={() => void load()}>Load current enrollment</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset>
      <p>Loading again clears the prior snapshot, draft, confirmation, receipt and retry before the request. Read failures never keep stale facts on screen.</p>
    </section>
    {busy && <p role="status">Verifying the explicit human curriculum request…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!snapshot && <p className={styles.empty}>No verified current enrollment snapshot is shown.</p>}
    {snapshot && <section aria-label="Returned current enrollment" className={styles.record}>
      <h2>Returned current enrollment</h2><p>This is an explicitly loaded snapshot, not live status or testing readiness.</p>
      <dl><dt>Enrollment UUID</dt><dd>{snapshot.enrollment.id}</dd><dt>Curriculum UUID</dt><dd>{snapshot.enrollment.curriculumId}</dd>
        <dt>Student profile UUID</dt><dd>{snapshot.enrollment.studentProfileId}</dd><dt>Current rank UUID</dt><dd>{snapshot.enrollment.currentRankId ?? 'Unranked (returned null)'}</dd>
        <dt>Enrollment status / version</dt><dd>{snapshot.enrollment.status} / {snapshot.enrollment.version}</dd><dt>Enrolled at</dt><dd>{snapshot.enrollment.enrolledAt}</dd></dl>
      <h3>Returned current-rank requirements</h3>
      {snapshot.requirements.length === 0 && <p>No current-rank requirements were returned. No status is inferred and no observation can be submitted.</p>}
      {snapshot.requirements.map(r => <article key={r.id} className={styles.record}>
        <h4>{r.definition.label}</h4><dl><dt>Requirement UUID / code</dt><dd>{r.id} / {r.code}</dd><dt>Kind / required</dt><dd>{r.kind} / {r.required ? 'Required' : 'Optional'}</dd>
          <dt>Requirement version</dt><dd>{r.version}</dd><dt>Latest observation sequence</dt><dd>{r.progressVersion}</dd>
          <dt>Current revision status</dt><dd>{r.status ?? 'Unrecorded for the current revision'}</dd><dt>Recorded at</dt><dd>{r.recordedAt ?? 'Not returned for the current revision'}</dd></dl>
      </article>)}
      {snapshot.enrollment.status !== 'ACTIVE' && <p>This returned enrollment is not ACTIVE. Observation submission is unavailable.</p>}
      {snapshot.enrollment.status === 'ACTIVE' && snapshot.enrollment.currentRankId !== null && snapshot.requirements.length > 0 && <form onSubmit={submit}>
        <fieldset disabled={busy}><legend>Append one human requirement observation</legend>
          <label>Returned requirement<select name="requirementId" required value={requirementId} onChange={event => edit(() => setRequirementId(event.target.value))}>
            <option value="">Choose a returned requirement</option>{snapshot.requirements.map(r => <option key={r.id} value={r.id}>{r.definition.label} ({r.code})</option>)}</select></label>
          <label>Human observation status<select name="observationStatus" required value={chosenStatus} onChange={event => edit(() => setChosenStatus(event.target.value))}>
            <option value="">Choose a human status</option>{HUMAN_PROGRESS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Optional private instructor note (maximum 2000 characters)<textarea name="instructorNote" autoComplete="off" maxLength={2000} value={note} onChange={event => edit(() => setNote(event.target.value))} /></label>
          <p>Expected requirement, enrollment and progress versions come only from this returned snapshot; they are not editable. A null status does not reset a historical observation sequence.</p>
          <label className={styles.check}><input name="confirmObservation" type="checkbox" checked={confirmed} disabled={!validDraft} onChange={event => { if (mounted.current && !active.current && renderedEpoch === epoch.current) setConfirmed(event.target.checked); }} />I explicitly confirm this exact append-only human observation, not promotion or any downstream outcome.</label>
          <button type="submit" disabled={!validDraft || !confirmed}>Record human observation</button>
        </fieldset></form>}
    </section>}
    {retry && <div className={styles.warning}><p>Only this exact path, body and generated UUID key are retained in memory. No automatic retry occurs. The earlier uncertain command may still have recorded an observation; editing, discarding or reloading does not cancel it. Seek staff review before a different command.</p>
      <button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged observation</button></div>}
    {receipt && <section aria-label="Returned observation receipt" className={styles.record}><h2>Returned human observation: {receipt.observation.status}</h2>
      <p>{receipt.replayed ? 'Replayed or previously recorded observation receipt.' : 'Recorded observation receipt.'} This is a command-response snapshot, not a refreshed enrollment or current-status claim.</p>
      <dl><dt>Observation UUID</dt><dd>{receipt.observation.id}</dd><dt>Enrollment UUID</dt><dd>{receipt.observation.enrollmentId}</dd><dt>Requirement UUID</dt><dd>{receipt.observation.requirementId}</dd>
        <dt>Requirement / enrollment versions</dt><dd>{receipt.observation.requirementVersion} / {receipt.observation.enrollmentVersion}</dd><dt>Observation sequence</dt><dd>{receipt.observation.version}</dd><dt>Recorded at</dt><dd>{receipt.observation.recordedAt}</dd></dl>
      <p>MET remains a human observation only. No actor, private note, authority, audit or outbox payload is displayed. Explicitly load again before another observation.</p>
    </section>}
    <p>Inputs, snapshots, receipts and uncertainty-only retries are memory-only. Edits reset confirmation, receipt and retry; scope edits and every command attempt invalidate the read snapshot. Conflict requires an explicit fresh read; access loss clears all inputs and facts. Remount/reload starts idle. Discarding an uncertain command is not cancellation.</p>
    <p>No curriculum, requirement, enrollment or rank-placement authoring; no history editing, testing candidate/event/PROMOTION command or parent command is exposed.</p>
  </main>;
}
