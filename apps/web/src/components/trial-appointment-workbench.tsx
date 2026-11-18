'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CrmAppointmentSummary, CrmTrialOutcomeStatus } from '@hon/contracts';
import { recordTrialOutcome, scheduleTrial, TrialAppointmentAccessError, type TrialOutcomeInput, type TrialScheduleInput } from './trial-appointment-http';
import { terminalTrialFollowUpHref } from './crm-follow-up-handoff';
import styles from './staff-availability-workbench.module.css';
import { formatInSchool, readSchoolClock, schoolLocalToInstant } from './school-time';
import { ManualSchoolFields, useShellSchoolInto } from './school-shell/page-school';
import { IdFields, LeadPicker } from './school-pickers/pickers';

type Pending = { fingerprint: string; key: string; operation: 'SCHEDULE' | 'OUTCOME'; input: TrialScheduleInput | TrialOutcomeInput };

/** B-CRM-3: school wall time when the server named the school's timezone, otherwise explicit UTC. */
function asInstant(value: string, zone: string | null): string {
  if (!zone) return asUtc(value);
  if (!value) throw new Error('A school date and time are required.');
  const r = schoolLocalToInstant(value, zone);
  if (r.state === 'NONEXISTENT') throw new Error("That time does not exist in the school's timezone because of a daylight-saving change. Choose another time.");
  if (r.state !== 'OK') throw new Error('A valid school date and time is required.');
  return r.instant;
}

function asUtc(value: string): string {
  if (!value) throw new Error('A UTC date and time are required.');
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid UTC date and time is required.');
  return date.toISOString();
}

const STATUS: Record<string, string> = { SCHEDULED: 'Scheduled', COMPLETED: 'Came to the trial', NO_SHOW: 'Did not come', CANCELLED: 'Cancelled' };
function summary(appointment: CrmAppointmentSummary, zone: string | null, leadName: string): React.ReactElement {
  const at = (v: string) => zone ? formatInSchool(v, zone, 'en-US') : v;
  return <dl><dt>Lead</dt><dd>{leadName}</dd><dt>Status</dt><dd>{STATUS[appointment.status] ?? appointment.status}</dd><dt>Time</dt><dd>{at(appointment.startsAt)} to {at(appointment.endsAt)}</dd><dt>Location</dt><dd>{appointment.location ?? 'Not set'}</dd></dl>;
}

export interface TrialAppointmentInitialScope { organizationId?: string | undefined; schoolId?: string | undefined; leadId?: string | undefined }

export function TrialAppointmentWorkbench({ initialScope = {} }: { initialScope?: TrialAppointmentInitialScope }): React.ReactElement {
  const [organizationId, setOrganizationId] = useState(initialScope.organizationId ?? '');
  const [schoolId, setSchoolId] = useState(initialScope.schoolId ?? '');
  const shellSchool = useShellSchoolInto(school => { setOrganizationId(school.organizationId); setSchoolId(school.schoolId); });
  const [leadId, setLeadId] = useState(initialScope.leadId ?? '');
  const [leadName, setLeadName] = useState('');
  const [leadList, setLeadList] = useState<'LOADING' | 'READY' | 'DENIED' | 'UNAVAILABLE'>('LOADING');
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
  const [zone, setZone] = useState<{ key: string; timezone: string } | null>(null);
  const scopeKey = `${organizationId.trim().toLowerCase()}:${schoolId.trim().toLowerCase()}`;
  const schoolZone = zone && zone.key === scopeKey ? zone.timezone : null;
  async function adoptSchoolTime(): Promise<void> {
    const key = scopeKey; setZone(null);
    let read: Awaited<ReturnType<typeof readSchoolClock>> = { state: 'UNAVAILABLE' };
    try { read = await readSchoolClock({ organizationId: organizationId.trim(), schoolId: schoolId.trim() }, AbortSignal.timeout(15000)); } catch { /* invalid scope stays UTC */ }
    if (read.state === 'READY') { setZone({ key, timezone: read.clock.schoolTimezone }); setStartsAt(''); setEndsAt(''); }
    else setError('Your school’s time zone could not be read, so times are in UTC.');
  }
  const pending = useRef<Pending | null>(null);
  // Times are entered in the school's own time zone as soon as the signed-in school is known.
  useEffect(() => { if (shellSchool && organizationId === shellSchool.organizationId && schoolId === shellSchool.schoolId && !schoolZone) void adoptSchoolTime(); }, [shellSchool?.schoolId, organizationId, schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setError(caught instanceof Error ? caught.message : 'That did not save. Try again.');
    } finally { setBusy(false); }
  }
  async function schedule(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    await run(async () => {
      const input: TrialScheduleInput = { startsAt: asInstant(startsAt, schoolZone), endsAt: asInstant(endsAt, schoolZone), ...(location.trim() ? { location: location.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
      const current = remember('SCHEDULE', input);
      setAppointment(null);
      const saved = await scheduleTrial(organizationId, schoolId, leadId, input, current.key);
      setAppointment(saved); setUncertain(false); pending.current = null;
      setNotice('Trial scheduled.');
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
      setNotice(`Trial result saved: ${STATUS[saved.status] ?? saved.status}.`);
    });
  }
  async function retry(): Promise<void> {
    const current = pending.current;
    if (!current) return;
    await run(async () => {
      if (current.operation === 'SCHEDULE') {
        const saved = await scheduleTrial(organizationId, schoolId, leadId, current.input as TrialScheduleInput, current.key);
        setAppointment(saved); setUncertain(false); pending.current = null;
        setNotice('Trial scheduled.');
        return;
      }
      if (!appointment || appointment.status !== 'SCHEDULED') throw new Error('This trial is no longer on the page. Schedule or open it again.');
      const saved = await recordTrialOutcome(organizationId, schoolId, appointment, current.input as TrialOutcomeInput, current.key);
      setAppointment(saved); setUncertain(false); pending.current = null;
      setNotice(`Trial result saved: ${STATUS[saved.status] ?? saved.status}.`);
    });
  }

  const followUpHref = appointment ? terminalTrialFollowUpHref(appointment) : undefined;
  const manualLead = !shellSchool || leadList === 'DENIED' || leadList === 'UNAVAILABLE';
  const leadField = <label>Lead record ID<input required autoComplete="off" value={leadId} onChange={(event) => { setLeadId(event.target.value); setLeadName(''); clearReceipt(); }} /></label>;
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">School dashboard</a><a href="/staff/search">Staff search</a><a href="/staff/crm/leads">CRM leads</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>Leads</p><h1>Trial appointments</h1><p>Schedule a trial class for a lead, then record how it went.</p></header>
    <aside data-plain-note=""><strong>Scheduling a trial records it. It does not message the lead or reserve a place in class.</strong></aside>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && pending.current && <aside><strong>We couldn’t confirm that save.</strong><p>Try it again before changing anything.</p><button type="button" disabled={busy} onClick={() => void retry()}>Try again</button></aside>}
    <section aria-labelledby="trial-schedule-title"><h2 id="trial-schedule-title">Schedule a trial</h2><form onSubmit={(event) => void schedule(event)}><fieldset disabled={busy}><div className={styles.row}><ManualSchoolFields current={schoolId}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clearReceipt(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clearReceipt(); }} /></label></ManualSchoolFields>{shellSchool && <LeadPicker scope={shellSchool} value={leadId} disabled={busy} onState={setLeadList} onPick={(lead) => { setLeadId(lead?.id ?? ''); setLeadName(lead ? `${lead.givenName} ${lead.familyName}` : ''); clearReceipt(); }} />}{manualLead ? leadField : <IdFields manual={false}>{leadField}</IdFields>}</div>{!schoolZone && <p data-testid="trial-time-basis">Times are in UTC. <button type="button" data-testid="use-school-time" disabled={busy} onClick={() => void adoptSchoolTime()}>Use school time</button></p>}<div className={styles.dates}><label>{schoolZone ? `Starts (${schoolZone})` : 'Starts (UTC)'}<input required type="datetime-local" step="1" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); clearReceipt(); }} /></label><label>{schoolZone ? `Ends (${schoolZone})` : 'Ends (UTC)'}<input required type="datetime-local" step="1" value={endsAt} onChange={(event) => { setEndsAt(event.target.value); clearReceipt(); }} /></label></div><label>Location (optional)<input maxLength={160} value={location} onChange={(event) => { setLocation(event.target.value); clearReceipt(); }} /></label><label>Private note (staff only, optional)<textarea maxLength={2000} rows={4} value={notes} onChange={(event) => { setNotes(event.target.value); clearReceipt(); }} /></label><div className={styles.actions}><button>{busy ? 'Saving…' : 'Schedule trial'}</button><button type="button" disabled={busy} onClick={clearReceipt}>Clear</button></div></fieldset></form></section>
    {appointment && <section aria-labelledby="trial-receipt-title"><h2 id="trial-receipt-title">Trial</h2>{summary(appointment, schoolZone, leadName || 'This lead')}{followUpHref && <p><a href={followUpHref}>Add a follow-up</a></p>}{appointment.status === 'SCHEDULED' && <form onSubmit={(event) => void saveOutcome(event)}><fieldset disabled={busy}><h3>How did the trial go?</h3><label>Result<select value={outcome} onChange={(event) => { setOutcome(event.target.value as CrmTrialOutcomeStatus); setOutcomeNotes(''); clearOutcomeRetry(); }}><option value="COMPLETED">Came to the trial</option><option value="NO_SHOW">Did not come</option><option value="CANCELLED">Cancelled</option></select></label><label>Note (staff only, optional)<textarea maxLength={2000} rows={4} value={outcomeNotes} onChange={(event) => { setOutcomeNotes(event.target.value); clearOutcomeRetry(); }} /></label><button>{busy ? 'Saving…' : 'Save result'}</button></fieldset></form>}</section>}
  </main>;
}
