'use client';

import React, { useRef, useState, type FormEvent } from 'react';
import type { CrmAppointmentSummary, CrmTrialOutcomeStatus } from '@hon/contracts';
import { recordTrialOutcome, scheduleTrial, TrialAppointmentAccessError, type TrialOutcomeInput, type TrialScheduleInput } from './trial-appointment-http';
import styles from './staff-availability-workbench.module.css';

type Pending = { fingerprint: string; key: string; operation: 'SCHEDULE' | 'OUTCOME'; input: TrialScheduleInput | TrialOutcomeInput };

function asUtc(value: string): string {
  if (!value) throw new Error('A UTC date and time are required.');
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid UTC date and time is required.');
  return date.toISOString();
}

function summary(appointment: CrmAppointmentSummary): React.ReactElement {
  return <dl><dt>Trial appointment</dt><dd><code>{appointment.id}</code> · {appointment.status} · version {appointment.version}</dd><dt>Lead</dt><dd><code>{appointment.crmLeadId}</code></dd><dt>Time</dt><dd>{appointment.startsAt} to {appointment.endsAt}</dd><dt>Location</dt><dd>{appointment.location ?? 'No location recorded'}</dd><dt>Recorded</dt><dd>{appointment.updatedAt}</dd></dl>;
}

export function TrialAppointmentWorkbench(): React.ReactElement {
  const [organizationId, setOrganizationId] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [appointment, setAppointment] = useState<CrmAppointmentSummary | null>(null);
  const [outcome, setOutcome] = useState<CrmTrialOutcomeStatus>('COMPLETED');
  const [outcomeNotes, setOutcomeNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Pending | null>(null);

  function clearReceipt(): void { setAppointment(null); setError(''); setNotice(''); setUncertain(false); pending.current = null; }
  function clearOutcomeRetry(): void { setError(''); setNotice(''); setUncertain(false); pending.current = null; }
  function remember(operation: Pending['operation'], input: TrialScheduleInput | TrialOutcomeInput): Pending {
    const fingerprint = JSON.stringify({ operation, organizationId, schoolId, leadId, appointmentId: appointment?.id ?? null, input });
    if (!pending.current || pending.current.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID(), operation, input: structuredClone(input) };
    return pending.current;
  }
  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (caught) {
      if (caught instanceof TrialAppointmentAccessError) { setAppointment(null); setUncertain(false); pending.current = null; }
      else setUncertain(true);
      setError(caught instanceof Error ? caught.message : 'No verified trial result.');
    } finally { setBusy(false); }
  }
  async function schedule(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    await run(async () => {
      const input: TrialScheduleInput = { startsAt: asUtc(startsAt), endsAt: asUtc(endsAt), ...(location.trim() ? { location: location.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
      const current = remember('SCHEDULE', input);
      setAppointment(null);
      const saved = await scheduleTrial(organizationId, schoolId, leadId, input, current.key);
      setAppointment(saved); setUncertain(false); pending.current = null;
      setNotice('Trial appointment recorded. No calendar invitation, reminder, booking, attendance, enrollment, membership, payment, message, or external delivery was created.');
    });
  }
  async function saveOutcome(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!appointment || appointment.status !== 'SCHEDULED') return;
    await run(async () => {
      const input: TrialOutcomeInput = { status: outcome, expectedVersion: appointment.version, ...(outcomeNotes.trim() ? { outcomeNotes: outcomeNotes.trim() } : {}) };
      const current = remember('OUTCOME', input);
      const saved = await recordTrialOutcome(organizationId, schoolId, appointment, input, current.key);
      setAppointment(saved); setUncertain(false); pending.current = null;
      setNotice(`Trial outcome recorded as ${saved.status}. It does not change lead status, create a booking, attendance, enrollment, membership, payment, communication, or external outcome.`);
    });
  }
  async function retry(): Promise<void> {
    const current = pending.current;
    if (!current) return;
    await run(async () => {
      if (current.operation === 'SCHEDULE') {
        const saved = await scheduleTrial(organizationId, schoolId, leadId, current.input as TrialScheduleInput, current.key);
        setAppointment(saved); setUncertain(false); pending.current = null;
        setNotice('Trial appointment receipt confirmed. No calendar invitation, reminder, booking, attendance, enrollment, membership, payment, message, or external delivery was created.');
        return;
      }
      if (!appointment || appointment.status !== 'SCHEDULED') throw new Error('The exact scheduled trial receipt is no longer available in this page session. No outcome retry is assumed.');
      const saved = await recordTrialOutcome(organizationId, schoolId, appointment, current.input as TrialOutcomeInput, current.key);
      setAppointment(saved); setUncertain(false); pending.current = null;
      setNotice(`Trial outcome receipt confirmed as ${saved.status}. No conversion or downstream effect is implied.`);
    });
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM / TRIAL APPOINTMENTS</p><h1>Schedule and record a trial</h1><p>One direct-human, exact-school CRM appointment at a time. Enter only IDs already known from an authorized staff workflow; the server decides scope and permission.</p></header>
    <aside><strong>Appointment facts only.</strong><p>Scheduling creates one canonical CRM <code>TRIAL</code> appointment. It does not contact a lead, reserve a class seat, check anyone in, change a lead stage, create a student/family/enrollment/membership, accept consent, or make a financial, provider, AI, Action Engine, automation, calendar, or delivery claim.</p></aside>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && pending.current && <aside><strong>Outcome unverified.</strong><p>The exact request is retained in memory only. Do not change inputs before choosing whether to retry it; no automatic retry occurs.</p><button type="button" disabled={busy} onClick={() => void retry()}>Retry exact retained request</button></aside>}
    <section aria-labelledby="trial-schedule-title"><h2 id="trial-schedule-title">Schedule a future trial appointment</h2><p>Trial times are entered as UTC. The existing service requires a future end-after-start appointment within 90 days and current <code>crm.trial.schedule</code> authority.</p><form onSubmit={(event) => void schedule(event)}><fieldset disabled={busy}><div className={styles.row}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clearReceipt(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clearReceipt(); }} /></label><label>Known CRM lead UUID<input required autoComplete="off" value={leadId} onChange={(event) => { setLeadId(event.target.value); clearReceipt(); }} /></label></div><div className={styles.dates}><label>Starts at (UTC)<input required type="datetime-local" step="1" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); clearReceipt(); }} /></label><label>Ends at (UTC)<input required type="datetime-local" step="1" value={endsAt} onChange={(event) => { setEndsAt(event.target.value); clearReceipt(); }} /></label></div><label>Location (optional, internal)<input maxLength={160} value={location} onChange={(event) => { setLocation(event.target.value); clearReceipt(); }} /></label><label>Private scheduling note (optional)<textarea maxLength={2000} rows={4} value={notes} onChange={(event) => { setNotes(event.target.value); clearReceipt(); }} /></label><div className={styles.actions}><button>{busy ? 'Verifying…' : 'Record trial appointment'}</button><button type="button" disabled={busy} onClick={clearReceipt}>Clear current receipt</button></div></fieldset></form></section>
    {appointment && <section aria-labelledby="trial-receipt-title"><h2 id="trial-receipt-title">Current command receipt</h2>{summary(appointment)}<p>This receipt is current only for this page session. Reloading the page clears it; use an established authorized CRM workflow to find a different record. An appointment receipt is not a trial attendance or conversion result.</p>{appointment.status === 'SCHEDULED' && <form onSubmit={(event) => void saveOutcome(event)}><fieldset disabled={busy}><h3>Record a final human trial outcome</h3><p>Only this immediately verified scheduled receipt may be updated here. Current <code>crm.trial.manage</code> authority, appointment type, status, version, tenant scope and direct-human posture are rechecked by the server.</p><label>Outcome<select value={outcome} onChange={(event) => { setOutcome(event.target.value as CrmTrialOutcomeStatus); setOutcomeNotes(''); clearOutcomeRetry(); }}><option value="COMPLETED">Completed</option><option value="NO_SHOW">No show</option><option value="CANCELLED">Cancelled</option></select></label><label>Outcome note (optional, internal)<textarea maxLength={2000} rows={4} value={outcomeNotes} onChange={(event) => { setOutcomeNotes(event.target.value); clearOutcomeRetry(); }} /></label><button>{busy ? 'Verifying…' : 'Record final outcome'}</button></fieldset></form>}</section>}
  </main>;
}
