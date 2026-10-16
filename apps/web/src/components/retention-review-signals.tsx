'use client';

import React, { type FormEvent, useState, useRef, useEffect } from 'react';
import type { RetentionReviewSignals, RetentionReviewAcknowledgementEvidence, RetentionReviewAcknowledgement } from '@hon/contracts';
import { loadRetentionReviewSignals, loadRetentionReviewAcknowledgementEvidence, acknowledgeRetentionReviewEvidence, RetentionReviewUiError } from './retention-review-signals-http';
import styles from './billing-renewals-workbench.module.css';

function utc(value: string | null) { return value ? `${value.replace('T', ' ').replace('.000Z', ' UTC')}` : 'Not recorded'; }
function unavailable(value: string | null) { return value ? value.replaceAll('_', ' ').toLowerCase() : 'No limitation recorded.'; }
function Status({ value }: { value: string }) { return <strong>{value.replaceAll('_', ' ')}</strong>; }

/** A conventional staff evidence view. It deliberately never suggests or executes an action. */
export function RetentionReviewSignalsWorkbench() {
  const [schoolId, setSchoolId] = useState('');
  const [membershipId, setMembershipId] = useState('');
  const [signals, setSignals] = useState<RetentionReviewSignals | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [evidence, setEvidence] = useState<RetentionReviewAcknowledgementEvidence | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<RetentionReviewAcknowledgement | null>(null);
  const generation = useRef(0);
  const retryKey = useRef<string | null>(null);
  const clear = () => { generation.current++; setSignals(null); setEvidence(null); setAcknowledgement(null); retryKey.current = null; setError(''); };
  useEffect(() => {
    // Context returning from another tab/window must be verified again. No stale
    // response may repopulate a changed school/session/selector generation.
    const invalidate = () => { clear(); setLoading(false); };
    window.addEventListener('focus', invalidate);
    window.addEventListener('pageshow', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    return () => { generation.current++; window.removeEventListener('focus', invalidate); window.removeEventListener('pageshow', invalidate); document.removeEventListener('visibilitychange', invalidate); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); clear(); setLoading(true);
    const current = generation.current;
    try { const result = await loadRetentionReviewSignals(schoolId.trim(), membershipId.trim()); if (current === generation.current) setSignals(result); }
    catch (failure) { if (current === generation.current) { clear(); setError(failure instanceof RetentionReviewUiError ? failure.message : 'No verified Retention Review Signals result is shown. Check known IDs and retry the read.'); } }
    finally { if (current === generation.current || current + 1 === generation.current) setLoading(false); }
  }
  async function verifyForAcknowledgement() {
    clear(); setLoading(true); const current = generation.current;
    try {
      const result = await loadRetentionReviewAcknowledgementEvidence(schoolId.trim(), membershipId.trim());
      if (current === generation.current) { setSignals(result.signals); setEvidence(result); retryKey.current = crypto.randomUUID(); }
    } catch (failure) { if (current === generation.current) { clear(); setError(failure instanceof RetentionReviewUiError ? failure.message : 'No verified evidence for acknowledgement is shown. Reload the read.'); } }
    finally { if (current === generation.current || current + 1 === generation.current) setLoading(false); }
  }
  async function acknowledge() {
    if (!evidence || !signals || loading || !retryKey.current) return;
    const current = generation.current; setLoading(true); setAcknowledgement(null); setError('');
    try {
      const result = await acknowledgeRetentionReviewEvidence(schoolId.trim(), signals.membershipId, { evidenceVersion: evidence.evidenceVersion, evidenceFingerprint: evidence.evidenceFingerprint, observedAt: signals.observedAt, idempotencyKey: retryKey.current });
      if (current === generation.current) setAcknowledgement(result);
    } catch (failure) { if (current === generation.current) { clear(); setError(failure instanceof RetentionReviewUiError ? failure.message : 'No verified acknowledgement is shown; the result may be unknown. Reload evidence before reviewing again.'); } }
    finally { if (current === generation.current || current + 1 === generation.current) setLoading(false); }
  }
  return <main className={styles.page}>
    <header><p className={styles.eyebrow}>RETENTION REVIEW SIGNALS</p><h1>Retention Review Signals</h1><p>Human-controlled, read-only observed facts for one known membership. This is evidence only: no score, prediction, readiness claim, financial recommendation, or automatic action.</p></header>
    <section className={styles.notice}><strong>Known-ID review only</strong><p>Enter an already-known current-school membership UUID. This page is not a student, family, membership, or staff directory; selectors never grant authority. Big-Button, Modern, and Classic modes only change presentation.</p></section>
    <form onSubmit={submit}><fieldset disabled={loading}><legend>Current school scope</legend><label>School UUID<input required autoComplete="off" spellCheck={false} value={schoolId} onChange={event => { setSchoolId(event.target.value); clear(); }} /></label><label>Known membership UUID<input required autoComplete="off" spellCheck={false} value={membershipId} onChange={event => { setMembershipId(event.target.value); clear(); }} /></label><div className={styles.actions}><button type="submit">{loading ? 'Loading observed facts…' : 'Load Retention Review Signals'}</button></div></fieldset></form>
    {!signals && !loading && !error && <p className={styles.notice} role="status">No verified school and membership are selected. No Retention Review Signals data is shown.</p>}
    {loading && <p className={styles.notice} role="status">Verifying direct human staff access and loading bounded observed facts…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {signals && <><section className={styles.notice} role="status"><strong>Verified evidence-only read</strong><p>Observed at {utc(signals.observedAt)}. Human-only: yes. Read-only: yes. Prediction or automatic action: no.</p><p>Membership <code>{signals.membershipId}</code></p></section>
      <section><h2>Membership term facts</h2><p><Status value={signals.membershipTerm.status} /> · current recorded state: <strong>{signals.membershipTerm.membershipState.replaceAll('_', ' ')}</strong></p><ul><li>Term started: {utc(signals.membershipTerm.termStartedAt)}</li><li>Term ends: {utc(signals.membershipTerm.termEndsAt)}</li><li>Observed term position: {signals.membershipTerm.endingObservation.replaceAll('_', ' ').toLowerCase()}</li></ul>{signals.membershipTerm.reason && <p>Missing data: {unavailable(signals.membershipTerm.reason)}</p>}</section>
      <section><h2>Explicit human renewal review</h2><p><Status value={signals.renewalReview.status} /></p>{signals.renewalReview.status === 'AVAILABLE' ? <ul><li>Latest explicit review state: {signals.renewalReview.latestReviewState}</li><li>Recorded at: {utc(signals.renewalReview.recordedAt)}</li></ul> : <p>Unavailable: {unavailable(signals.renewalReview.reason)}. Missing review records are not treated as failure.</p>}</section>
      <section><h2>Follow-up lifecycle</h2><p><Status value={signals.followUp.status} /> — {unavailable(signals.followUp.reason)}. HON does not infer a membership-to-CRM-follow-up relationship.</p></section>
      <section><h2>Recorded attendance facts</h2><p><Status value={signals.attendance.status} /> · UTC half-open window: {utc(signals.attendance.windowFrom)} through {utc(signals.attendance.windowTo)} (end excluded).</p><ul><li>Recorded facts: {signals.attendance.recordedAttendanceCount}</li><li>Present: {signals.attendance.presentCount}; late: {signals.attendance.lateCount}; makeup: {signals.attendance.makeupCount}</li><li>Excused absence: {signals.attendance.excusedAbsenceCount}; unexcused absence: {signals.attendance.unexcusedAbsenceCount}</li></ul>{signals.attendance.reason && <p>{signals.attendance.status === 'INSUFFICIENT_DATA' ? 'Insufficient data' : 'Unavailable'}: {unavailable(signals.attendance.reason)}. No missing record is treated as a negative attendance fact.</p>}</section>
      <section><h2>Curriculum, testing, and progression observation availability</h2><p><Status value={signals.progression.status} /></p><ul><li>Curriculum enrollments recorded: {signals.progression.curriculumEnrollmentCount}</li><li>Progress observations recorded: {signals.progression.progressObservationCount} ({signals.progression.progressObservationAvailability.replaceAll('_', ' ').toLowerCase()})</li><li>Testing records recorded: {signals.progression.testingRecordCount} ({signals.progression.testingObservationAvailability.replaceAll('_', ' ').toLowerCase()})</li></ul>{signals.progression.reason && <p>Unavailable: {unavailable(signals.progression.reason)}. No availability state establishes readiness, eligibility, grade, or outcome.</p>}</section>
      <section className={styles.notice}><h2>Human evidence acknowledgement</h2><p>This records only that you reviewed the verified projection. It is not an alert, resolution, assignment, follow-up, renewal decision, communication, or retention outcome.</p>
        {!evidence && <button type="button" disabled={loading} onClick={verifyForAcknowledgement}>Verify evidence for acknowledgement</button>}
        {evidence && !acknowledgement && <button type="button" disabled={loading} onClick={acknowledge}>Acknowledge evidence reviewed</button>}
        {acknowledgement && <p role="status"><strong>Evidence reviewed</strong>. No downstream effect.</p>}
      </section>
      <section className={styles.notice}><strong>Limits and non-actions</strong><p>This projection never exposes names, contacts, family or payer information, private notes, invoice/payment/provider details, staff directory data, audit/outbox records, or AI data. It does not create a follow-up, send a message, collect/refund payment, modify a membership/renewal/attendance/curriculum/testing record, invoke automation or the Action Engine, or call an AI/provider.</p></section>
    </>}
  </main>;
}
