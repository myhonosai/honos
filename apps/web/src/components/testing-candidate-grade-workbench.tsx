'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { TESTING_CANDIDATE_GRADE_RESULTS } from '@hon/contracts';
import { TestingCandidateGradeAccessError, TestingCandidateGradeUncertainError, prepareTestingCandidateGrade, submitTestingCandidateGrade, validateTestingCandidateGradeDraft,
  type TestingCandidateGradeIds, type TestingCandidateGradeReceipt, type PreparedTestingCandidateGrade } from './testing-candidate-grade-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: TestingCandidateGradeIds = { organizationId: '', schoolId: '', candidateId: '' };
const LABELS: Record<keyof TestingCandidateGradeIds, string> = { organizationId: 'Organization UUID', schoolId: 'School UUID', candidateId: 'Testing candidate UUID' };
function versionNumber(value: string): number { return value === value.trim() && /^[1-9]\d*$/.test(value) ? Number(value) : NaN; }

/** One known-ID candidate outcome command only, with no candidate read or downstream handoff. */
export function TestingCandidateGradeWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<TestingCandidateGradeIds>(EMPTY_IDS);
  const [version, setVersion] = useState('');
  const [result, setResult] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<PreparedTestingCandidateGrade | null>(null);
  const [receipt, setReceipt] = useState<TestingCandidateGradeReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const attempted = useRef(false);
  const retained = useRef<PreparedTestingCandidateGrade | null>(null);
  // Cleanup only. Idle Strict Mode cleanup/setup must leave first-render handlers usable.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (active.current) epoch.current++; retained.current = null; }; }, []);
  const renderedEpoch = epoch.current;
  let validDraft = false;
  try { validateTestingCandidateGradeDraft(ids, result, versionNumber(version), note); validDraft = true; } catch { /* local syntax only, never current candidate facts */ }

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
    reset(); setIds(EMPTY_IDS); setVersion(''); setResult('');
  }
  function confirm(checked: boolean): void {
    if (active.current || attempted.current || !mounted.current || renderedEpoch !== epoch.current) return;
    if (checked) { try { validateTestingCandidateGradeDraft(ids, result, versionNumber(version), note); } catch { return; } }
    epoch.current++; setConfirmed(checked);
  }
  async function send(command: PreparedTestingCandidateGrade): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; attempted.current = true; retained.current = null;
    setNote(''); setConfirmed(false); setRetry(null); setReceipt(null); setError(''); setBusy(true);
    try {
      const returned = await submitTestingCandidateGrade(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof TestingCandidateGradeAccessError) { reset(); setIds(EMPTY_IDS); setVersion(''); setResult(''); }
      else if (caught instanceof TestingCandidateGradeUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified candidate outcome receipt. Review before another explicit command.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted.current || !confirmed || !mounted.current || renderedEpoch !== epoch.current) return;
    try {
      validateTestingCandidateGradeDraft(ids, result, versionNumber(version), note);
      void send(prepareTestingCandidateGrade(ids, result, versionNumber(version), note, crypto.randomUUID()));
    } catch { setError('Enter three exact already-known UUIDs, a positive whole expected version, one closed outcome and an optional note of at most 2000 characters. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedTestingCandidateGrade): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>HON / CONVENTIONAL INSTRUCTOR OPERATIONS</p><h1>Human testing candidate outcome</h1>
      <p>This page starts blank and idle. Supply the exact already-known organization, school and candidate UUIDs, current expected candidate version and one explicit outcome. There is no query prefill, automatic load, directory, search, list, event or candidate read, or scorecard action.</p>
    </header>
    <aside><strong>PASSED is neither promotion nor certificate issuance.</strong>
      <p>This command records candidate outcome evidence, canonical audit and inert outbox only. It does not grade a scorecard or score observations; infer readiness or eligibility; create a roster, place or capacity; change promotion, rank or belt; issue a certificate; grant parent or family access; record attendance; change billing or payment; send communication; invoke a provider, AI, Action Engine or automation. No downstream command or outbox consumer is activated.</p>
      <p>UUIDs and entered versions are untrusted selectors, not authority or verified current facts. Current direct HUMAN_USER / HUMAN_UI identity, exact <code>testing.manage</code> school scope, delegation rejection, tenant RLS, locked authority/candidate and version integrity remain server-owned on every submit and replay.</p>
    </aside>
    <section aria-labelledby="candidate-outcome-command"><h2 id="candidate-outcome-command">Record one known-ID candidate outcome</h2>
      <form autoComplete="off" onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{(Object.keys(LABELS) as (keyof TestingCandidateGradeIds)[]).map(field =>
          <label key={field}>{LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}</div>
        <label>Expected candidate version (positive whole number)<input name="expectedVersion" required autoComplete="off" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={16} value={version} onChange={event => edit(() => setVersion(event.target.value))} /></label>
        <label>Candidate outcome<select name="result" required value={result} onChange={event => edit(() => setResult(event.target.value))}><option value="">Choose an explicit outcome</option>{TESTING_CANDIDATE_GRADE_RESULTS.map(outcome => <option key={outcome} value={outcome}>{outcome}</option>)}</select></label>
        <label>Optional private instructor notes (maximum 2000 characters)<textarea name="instructorNotes" autoComplete="off" maxLength={2000} value={note} onChange={event => edit(() => setNote(event.target.value))} /></label>
        <p>The server requires the exact current version for a fresh mutation. Notes replace the candidate note; omitting or leaving them blank clears its prior note. Local validation does not read or verify any candidate.</p>
        <label className={styles.check}><input name="confirmOutcome" type="checkbox" checked={confirmed} disabled={!validDraft || attempted.current} onChange={event => confirm(event.target.checked)} />I explicitly confirm this exact candidate UUID, expected version, outcome and note replacement only, not a scorecard grade, readiness, promotion, rank, belt, certificate or any downstream effect.</label>
        <div className={styles.actions}><button type="submit" disabled={!validDraft || !confirmed || attempted.current}>Record candidate outcome</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
    </section>
    {busy && <p role="status">Submitting the explicit human candidate outcome command…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!receipt && <p className={styles.empty}>No verified candidate outcome receipt is shown.</p>}
    {retry && <div className={styles.warning}><p>Only the exact path, body and generated UUID key are retained in memory for a separate human retry. The earlier uncertain command may already have changed the candidate outcome. Editing, discarding or reloading is not cancellation; obtain separately authorized current candidate/version information before a different command.</p>
      <button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged outcome</button></div>}
    {receipt && <section aria-label="Returned candidate outcome receipt" className={styles.record}><h2>{`Returned candidate outcome: ${receipt.candidate.result}`}</h2>
      <p>{receipt.replayed ? 'Replayed or previously recorded candidate outcome receipt.' : 'Recorded candidate outcome receipt.'} This is the original command-response snapshot, not live candidate status, readiness or eligibility. A replay returns that command’s original version, even if the candidate has since changed.</p>
      <dl><dt>Candidate UUID</dt><dd>{receipt.candidate.id}</dd><dt>Testing event UUID</dt><dd>{receipt.candidate.testingEventId}</dd>
        <dt>Student curriculum enrollment UUID</dt><dd>{receipt.candidate.studentCurriculumEnrollmentId}</dd><dt>Target rank UUID</dt><dd>{receipt.candidate.targetRankId}</dd>
        <dt>Candidate result / version</dt><dd>{receipt.candidate.result} / {receipt.candidate.version}</dd><dt>Created at</dt><dd>{receipt.candidate.createdAt}</dd></dl>
      <p>Only verified canonical candidate facts are displayed. No private note, actor, authority, audit or outbox payload is displayed. PASSED is neither promotion nor certificate. No scorecard or downstream action is exposed.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only exact retries are memory-only. Every ID, version, outcome or note edit clears confirmation, receipt and retry. Each attempt clears the visible note and confirmation; a new command requires an edit or explicit start over. Access loss clears every input and fact. Remount/reload starts idle. No storage, polling or automatic retry exists.</p>
  </main>;
}
