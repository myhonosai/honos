'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PROMOTION_DECISION_STATUSES } from '@hon/contracts';
import { PromotionDecisionAccessError, PromotionDecisionUncertainError, preparePromotionDecision, submitPromotionDecision, validatePromotionDecisionDraft,
  type PromotionDecisionIds, type PromotionDecisionReceipt, type PreparedPromotionDecision } from './promotion-decision-http';
import styles from './attendance-workbench.module.css';

const EMPTY_IDS: PromotionDecisionIds = { organizationId: '', schoolId: '', candidateId: '' };
const LABELS: Record<keyof PromotionDecisionIds, string> = { organizationId: 'Organization UUID', schoolId: 'School UUID', candidateId: 'Testing candidate UUID' };
function versionNumber(value: string): number { return value === value.trim() && /^[1-9]\d*$/.test(value) ? Number(value) : NaN; }

/** One final, known-ID human instructor command; it never discovers or assesses a candidate. */
export function PromotionDecisionWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<PromotionDecisionIds>(EMPTY_IDS);
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState('');
  const [rationale, setRationale] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<PreparedPromotionDecision | null>(null);
  const [receipt, setReceipt] = useState<PromotionDecisionReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const attempted = useRef(false);
  const retained = useRef<PreparedPromotionDecision | null>(null);
  // Cleanup only. Idle Strict Mode cleanup/setup must leave first-render handlers usable.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (active.current) epoch.current++; retained.current = null; }; }, []);
  const renderedEpoch = epoch.current;
  let validDraft = false;
  try { validatePromotionDecisionDraft(ids, versionNumber(version), status, rationale); validDraft = true; } catch { /* local syntax only; the API owns current facts and authority */ }

  function reset(): void {
    epoch.current++; attempted.current = false; retained.current = null;
    setRationale(''); setConfirmed(false); setRetry(null); setReceipt(null); setError('');
  }
  function edit(change: () => void): void {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    epoch.current++; attempted.current = false; retained.current = null;
    setRetry(null); setReceipt(null); setConfirmed(false); setError(''); change();
  }
  function discard(): void {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    reset(); setIds(EMPTY_IDS); setVersion(''); setStatus('');
  }
  function confirm(checked: boolean): void {
    if (active.current || attempted.current || !mounted.current || renderedEpoch !== epoch.current) return;
    if (checked) { try { validatePromotionDecisionDraft(ids, versionNumber(version), status, rationale); } catch { return; } }
    epoch.current++; setConfirmed(checked);
  }
  async function send(command: PreparedPromotionDecision): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; attempted.current = true; retained.current = null;
    setRationale(''); setConfirmed(false); setRetry(null); setReceipt(null); setError(''); setBusy(true);
    try {
      const returned = await submitPromotionDecision(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof PromotionDecisionAccessError) { reset(); setIds(EMPTY_IDS); setVersion(''); setStatus(''); }
      else if (caught instanceof PromotionDecisionUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'No verified promotion-decision receipt. Review before another explicit command.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted.current || !confirmed || !mounted.current || renderedEpoch !== epoch.current) return;
    try {
      validatePromotionDecisionDraft(ids, versionNumber(version), status, rationale);
      void send(preparePromotionDecision(ids, versionNumber(version), status, rationale, crypto.randomUUID()));
    } catch { setError('Enter three exact already-known UUIDs, a positive whole expected candidate version, one final status and a required rationale of at most 2000 characters. Nothing was submitted.'); }
  }
  function retryExact(command: PreparedPromotionDecision): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>HON / FINAL HUMAN INSTRUCTOR DECISION</p><h1>Final promotion decision</h1>
      <p>This page starts blank and idle. Supply the exact already-known organization, school and testing-candidate UUIDs, current expected candidate version, one final status and a required rationale. There is no query prefill, automatic load, directory, search, list, candidate/rank read, staff/family directory, scorecard action or readiness calculation.</p>
    </header>
    <aside><strong>PROMOTED is a final human instructor decision, never an AI or scorecard action.</strong>
      <p>This page submits only the existing canonical promotion-decision command. The API independently validates the terminal candidate, current enrollment, target rank and promotion prerequisites. Only after that server validation may its existing canonical <code>PROMOTED</code> decision perform the canonical rank change. Entered IDs and version are untrusted selectors, not authority or verified current facts.</p>
      <p>No external certificate, parent notice, attendance record, billing/payment change, message, provider, AI, Action Engine, automation or effect consumer is created, activated or invoked. No certificate issuance, parent/family access, notification or downstream command occurs here.</p>
    </aside>
    <section aria-labelledby="promotion-decision-command"><h2 id="promotion-decision-command">Record one final known-ID promotion decision</h2>
      <form autoComplete="off" onSubmit={submit}><fieldset disabled={busy}>
        <div className={styles.scopeGrid}>{(Object.keys(LABELS) as (keyof PromotionDecisionIds)[]).map(field =>
          <label key={field}>{LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }))} /></label>)}</div>
        <label>Expected candidate version (positive whole number)<input name="expectedVersion" required autoComplete="off" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={16} value={version} onChange={event => edit(() => setVersion(event.target.value))} /></label>
        <label>Final promotion decision<select name="status" required value={status} onChange={event => edit(() => setStatus(event.target.value))}><option value="">Choose a final human decision</option>{PROMOTION_DECISION_STATUSES.map(decision => <option key={decision} value={decision}>{decision}</option>)}</select></label>
        <label>Required private instructor rationale (maximum 2000 characters)<textarea name="rationale" required autoComplete="off" maxLength={2000} value={rationale} onChange={event => edit(() => setRationale(event.target.value))} /></label>
        <p>Local validation checks only command syntax. The server owns candidate finality, current enrollment, target rank, prerequisites, direct-human authorization, tenant scope, idempotency and whether a <code>PROMOTED</code> decision can change rank.</p>
        <label className={styles.check}><input name="confirmPromotionDecision" type="checkbox" checked={confirmed} disabled={!validDraft || attempted.current} onChange={event => confirm(event.target.checked)} />I explicitly confirm this exact candidate UUID, expected version, final decision and rationale as my final human instructor decision. This is not a certificate, notice, attendance, billing/payment, message, provider, AI, Action Engine or automation instruction.</label>
        <div className={styles.actions}><button type="submit" disabled={!validDraft || !confirmed || attempted.current}>Record final promotion decision</button><button type="button" onClick={discard}>Discard inputs / start over</button></div>
      </fieldset></form>
    </section>
    {busy && <p role="status">Submitting the explicit final human promotion decision…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!receipt && <p className={styles.empty}>No verified promotion-decision receipt is shown.</p>}
    {retry && <div className={styles.warning}><p>Only the exact path, body and generated UUID key are retained in memory for a separate human retry. The earlier uncertain command may already have recorded a final decision and, for <code>PROMOTED</code>, changed rank through the canonical server logic. Editing, discarding or reloading is not cancellation; obtain separately authorized current candidate/version information before any different command.</p>
      <button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged promotion decision</button></div>}
    {receipt && <section aria-label="Returned promotion decision receipt" className={styles.record}><h2>{`Returned final decision: ${receipt.decision.status}`}</h2>
      <p>{receipt.replayed ? 'Replayed or previously recorded final-decision receipt.' : 'Recorded final-decision receipt.'} This is the original command-response snapshot, not live candidate status, readiness, eligibility or a certificate/notification claim.</p>
      <dl><dt>Promotion decision UUID</dt><dd>{receipt.decision.id}</dd><dt>Testing candidate UUID</dt><dd>{receipt.decision.testingCandidateId}</dd>
        <dt>Student curriculum enrollment UUID</dt><dd>{receipt.decision.studentCurriculumEnrollmentId}</dd>{receipt.decision.priorRankId && <><dt>Prior rank UUID</dt><dd>{receipt.decision.priorRankId}</dd></>}<dt>Target rank UUID</dt><dd>{receipt.decision.targetRankId}</dd><dt>Decision / version</dt><dd>{receipt.decision.status} / {receipt.decision.version}</dd><dt>Decided at</dt><dd>{receipt.decision.decidedAt}</dd><dt>Created at</dt><dd>{receipt.decision.createdAt}</dd></dl>
      <p>Only verified canonical decision facts are displayed. The submitted rationale is matched but not displayed. No instructor/actor, authority, audit or outbox data is displayed, and no downstream action is exposed.</p>
    </section>}
    <p>Inputs, receipts and uncertainty-only exact retries are memory-only. Every ID, version, decision or rationale edit clears confirmation, receipt and retry. Each attempt clears the visible rationale and confirmation; a new command requires an edit or explicit start over. Access loss clears every input and fact. Remount/reload starts idle. No storage, polling or automatic retry exists.</p>
  </main>;
}
