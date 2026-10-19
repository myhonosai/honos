'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION, type CrmAdultMembershipDraftConfirmation, type CrmAdultMembershipDraftReceipt, type CrmAdultMembershipPreparation } from '@hon/contracts';
import { StaffDashboardAccessError } from './staff-dashboard-http';
import { loadCurrentStaffReportingSchool } from './current-staff-reporting-school-http';
import { loadStaffReportingSchools, type StaffReportingSchoolChoice } from './staff-reporting-schools-http';
import {
  CrmAdultMembershipDraftAccessError,
  CrmAdultMembershipDraftRejectedError,
  CrmAdultMembershipDraftUncertainError,
  loadCrmAdultMembershipDraftConfirmation,
  loadCrmAdultMembershipDraftPreparation,
  prepareCrmAdultMembershipDraftCommand,
  submitCrmAdultMembershipDraft,
  type CrmAdultMembershipDraftScope,
  type PreparedCrmAdultMembershipDraft,
} from './crm-adult-membership-draft-http';
import styles from './crm-adult-membership-draft-workbench.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ScopeState = 'IDLE' | 'SELECTION_REQUIRED' | 'READY';
type Intent = 'READINESS' | 'CONFIRMATION';

/** The activation target treats this current observation selector as untrusted initial text only. */
export function crmAdultMembershipDraftActivationHref(confirmation: CrmAdultMembershipDraftConfirmation | null | undefined): string | undefined {
  const membershipId = confirmation?.state === 'RECORDED_DRAFT' ? confirmation.receipt.membershipId : undefined;
  if (!membershipId || !UUID.test(membershipId)) return undefined;
  return `/staff/billing/memberships?${new URLSearchParams({ membershipId: membershipId.toLowerCase() }).toString()}`;
}

/** Separate direct-human preparation/current-confirmation/DRAFT boundaries; never generic membership I/O. */
export function CrmAdultMembershipDraftWorkbench({ initialStudentProfileId }: { initialStudentProfileId?: string } = {}): React.ReactElement {
  const initialStudent = typeof initialStudentProfileId === 'string' && UUID.test(initialStudentProfileId) ? initialStudentProfileId.toLowerCase() : '';
  const [studentProfileId, setStudentProfileId] = useState(initialStudent);
  const [scope, setScope] = useState<CrmAdultMembershipDraftScope | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>('IDLE');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [choices, setChoices] = useState<StaffReportingSchoolChoice[]>([]);
  const [choiceId, setChoiceId] = useState('');
  const [readiness, setReadiness] = useState<CrmAdultMembershipPreparation | null>(null);
  const [currentDraft, setCurrentDraft] = useState<CrmAdultMembershipDraftConfirmation | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [termStartedAt, setTermStartedAt] = useState('');
  const [termEndsAt, setTermEndsAt] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCrmAdultMembershipDraft | null>(null);
  const [receipt, setReceipt] = useState<{ value: CrmAdultMembershipDraftReceipt; replayed: boolean } | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const active = useRef(false);
  const epoch = useRef(0);
  const retained = useRef<PreparedCrmAdultMembershipDraft | null>(null);

  function clearCommand(): void {
    retained.current = null;
    setPlanCode(''); setTermStartedAt(''); setTermEndsAt(''); setConfirmed(false);
    setAttempted(false); setRetry(null); setReceipt(null);
  }
  function clearDerived(): void { setReadiness(null); setCurrentDraft(null); clearCommand(); }
  function clearPreparation(clearStudent = false): void {
    setScope(null); setScopeState('IDLE'); setIntent(null); setChoices([]); setChoiceId(''); clearDerived();
    if (clearStudent) setStudentProfileId('');
  }
  function clearAccess(message: string): void { epoch.current++; active.current = false; setBusy(false); clearPreparation(true); setError(message); }
  function discard(): void { epoch.current++; active.current = false; setBusy(false); clearPreparation(true); setError(''); }
  function editStudent(value: string): void { epoch.current++; active.current = false; setBusy(false); clearPreparation(false); setStudentProfileId(value); setError(''); }
  function editCommand(): void { retained.current = null; setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); setError(''); }
  function invalidateCurrentState(): void {
    epoch.current++; active.current = false; setBusy(false); clearPreparation(false);
    setError('Current CRM membership state may have changed. The selector remains unverified; explicitly reload readiness or current DRAFT confirmation.');
  }
  function failure(caught: unknown): void {
    if (caught instanceof CrmAdultMembershipDraftAccessError || (caught instanceof StaffDashboardAccessError && (caught.status === 401 || caught.status === 403))) {
      clearAccess(caught.message); return;
    }
    clearPreparation(false);
    setError(caught instanceof Error ? caught.message : 'Adult CRM membership current confirmation is unavailable. No membership draft, activation, payment, invoice, schedule, or provider result is assumed.');
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; retained.current = null; };
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stale = () => invalidateCurrentState();
    window.addEventListener('focus', stale); document.addEventListener('visibilitychange', stale);
    return () => { window.removeEventListener('focus', stale); document.removeEventListener('visibilitychange', stale); };
  }, []);

  async function requestIntent(nextScope: CrmAdultMembershipDraftScope, nextIntent: Intent, generation: number): Promise<void> {
    const result = nextIntent === 'READINESS'
      ? await loadCrmAdultMembershipDraftPreparation(nextScope, studentProfileId)
      : await loadCrmAdultMembershipDraftConfirmation(nextScope, studentProfileId);
    if (!mounted.current || generation !== epoch.current) return;
    setScope(nextScope); setScopeState('READY'); setIntent(nextIntent); setChoices([]); setChoiceId(''); clearCommand();
    if (nextIntent === 'READINESS') { setCurrentDraft(null); setReadiness(result as CrmAdultMembershipPreparation); }
    else { setReadiness(null); setCurrentDraft(result as CrmAdultMembershipDraftConfirmation); }
  }
  async function begin(nextIntent: Intent): Promise<void> {
    if (active.current || !UUID.test(studentProfileId) || !mounted.current) { setError(`Enter one exact student-profile UUID, then explicitly ${nextIntent === 'READINESS' ? 'load adult CRM membership readiness' : 'confirm the current source-bound DRAFT'}.`); return; }
    const generation = ++epoch.current; active.current = true; clearPreparation(false); setIntent(nextIntent); setBusy(true); setError('');
    try {
      const direct = await loadCurrentStaffReportingSchool();
      if (!mounted.current || generation !== epoch.current) return;
      if (direct.state === 'RESOLVED') { await requestIntent({ organizationId: direct.organizationId, schoolId: direct.schoolId }, nextIntent, generation); return; }
      const options = await loadStaffReportingSchools();
      if (!mounted.current || generation !== epoch.current) return;
      if (options.state !== 'SELECTION_REQUIRED') throw new CrmAdultMembershipDraftRejectedError();
      setChoices(options.schools); setScopeState('SELECTION_REQUIRED'); setIntent(nextIntent);
    } catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); }
    finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function selectSchool(event: FormEvent): Promise<void> {
    event.preventDefault();
    const selected = choices.find((item) => item.schoolId === choiceId);
    const nextIntent = intent;
    if (!selected || !nextIntent || active.current) { setError('Choose one server-authorized school before the selected adult CRM action.'); return; }
    const generation = ++epoch.current; active.current = true; setBusy(true); setError(''); clearDerived();
    try { await requestIntent({ organizationId: selected.organizationId, schoolId: selected.schoolId }, nextIntent, generation); }
    catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); }
    finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function send(command: PreparedCrmAdultMembershipDraft): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; retained.current = null;
    setBusy(true); setAttempted(true); setRetry(null); setReceipt(null); setCurrentDraft(null); setError('');
    try {
      const saved = await submitCrmAdultMembershipDraft(command);
      if (mounted.current && generation === epoch.current) setReceipt({ value: saved.receipt, replayed: saved.replayed });
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CrmAdultMembershipDraftAccessError || caught instanceof CrmAdultMembershipDraftRejectedError) { failure(caught); }
      else {
        if (caught instanceof CrmAdultMembershipDraftUncertainError) { retained.current = command; setRetry(command); }
        setError(caught instanceof Error ? caught.message : 'No verified membership draft receipt.');
      }
    } finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!scope || !readiness || currentDraft || !confirmed || attempted || busy || active.current) return;
    try {
      const value = { studentProfileId, planCode, ...(termStartedAt ? { termStartedAt } : {}), ...(termEndsAt ? { termEndsAt } : {}), confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION } as const;
      void send(prepareCrmAdultMembershipDraftCommand(scope, value, crypto.randomUUID()));
    } catch { setError('Use a bounded plan code and canonical UTC-millisecond terms, then explicitly reload readiness if the selector changed.'); }
  }
  function retryExact(command: PreparedCrmAdultMembershipDraft): void { if (retained.current === command && !active.current && mounted.current) void send(command); }

  const readyToConfirm = !!scope && !!readiness && !currentDraft && !busy && !attempted && planCode.trim() === planCode && planCode.length > 0 && planCode.length <= 80;
  const activationHref = crmAdultMembershipDraftActivationHref(currentDraft);
  const actionLabel = intent === 'CONFIRMATION' ? 'current source-bound DRAFT confirmation' : 'adult CRM membership readiness';
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/crm/register">CRM registration</a><a href="/staff/billing/accounts">Billing account review</a><a href="/staff/billing/memberships">Membership activation</a><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>DIRECT HUMAN STAFF · CRM MEMBERSHIP PREPARATION</p><h1>Create or confirm an adult CRM membership draft</h1><p>Load readiness to make one explicit DRAFT-only membership record, or separately confirm an existing source-bound DRAFT after reload. The URL selector is untrusted form text, and no request happens until a staff member chooses an action.</p></header>
    <aside><strong>Current confirmation is a narrow observation, not activation or payment authority.</strong><p>The server independently derives the exact registered adult, active student, sole existing canonical billing relationship, immutable source, and current membership state under the current school. This page cannot search people, accounts, memberships, families, conversions, leads, or trials.</p><p>It creates no billing account, schedule, invoice, payment method, charge, provider operation, agreement, discount, communication, curriculum enrollment, activation, AI work, Action Engine request, or automation.</p></aside>
    <section aria-labelledby="adult-crm-membership-preparation"><h2 id="adult-crm-membership-preparation">1 / Explicit adult CRM action</h2><p>Enter one already-known student-profile UUID or use the inert adult CRM registration handoff. No scope, student fact, account, source, or membership state is loaded automatically.</p>
      <form onSubmit={(event) => { event.preventDefault(); void begin('READINESS'); }}><fieldset disabled={busy || scopeState === 'SELECTION_REQUIRED' || !!readiness || !!currentDraft}><label>Student profile UUID<input name="studentProfileId" required autoComplete="off" spellCheck={false} maxLength={36} value={studentProfileId} onChange={(event) => editStudent(event.target.value)} /></label><div className={styles.actions}><button type="submit" disabled={busy || scopeState === 'SELECTION_REQUIRED' || !!readiness || !!currentDraft || !UUID.test(studentProfileId)}>Load adult CRM membership readiness</button><button type="button" disabled={busy || scopeState === 'SELECTION_REQUIRED' || !!currentDraft || !UUID.test(studentProfileId)} onClick={() => void begin('CONFIRMATION')}>Confirm current source-bound DRAFT</button>{(readiness || currentDraft || scopeState !== 'IDLE' || studentProfileId || receipt) && <button type="button" onClick={discard}>Discard / start over</button>}</div></fieldset></form>
      {scopeState === 'SELECTION_REQUIRED' && <form onSubmit={(event) => void selectSchool(event)}><label>Authorized school<select required value={choiceId} disabled={busy} onChange={(event) => { setChoiceId(event.target.value); setError(''); }}><option value="">Choose a school…</option>{choices.map((item) => <option key={item.schoolId} value={item.schoolId}>{item.schoolName} — {item.organizationName}</option>)}</select></label><div className={styles.actions}><button disabled={busy || !choiceId}>Load {actionLabel} for this school</button><button type="button" disabled={busy} onClick={discard}>Discard / start over</button></div></form>}
      {busy && <p role="status">Verifying the current human, school, adult CRM source, active student, canonical relationship and entitlement…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
    {currentDraft && <section aria-label="Current source-bound DRAFT confirmation" className={styles.receipt}><h2>Current source-bound DRAFT confirmation</h2><p>Current at this explicit check: <strong>DRAFT only</strong>. Plan code: <strong>{currentDraft.receipt.planCode}</strong>. Originally recorded at: <strong>{currentDraft.receipt.recordedAt}</strong>.</p><dl><dt>Term starts at</dt><dd>{currentDraft.receipt.termStartedAt ?? 'Not recorded'}</dd><dt>Term ends at</dt><dd>{currentDraft.receipt.termEndsAt ?? 'Not recorded'}</dd></dl><p>This is not active and does not establish enrollment, agreement, billing schedule, invoice, payment method, payment outcome, provider result, communication, curriculum, AI, Action Engine, or automation result.</p>{activationHref && <p><a href={activationHref}>Review separate direct-human membership activation</a></p>}<button type="button" onClick={discard}>Discard current confirmation</button></section>}
    {readiness && scope && !currentDraft && <section aria-labelledby="adult-crm-membership-command"><h2 id="adult-crm-membership-command">2 / Explicit human DRAFT command</h2><p>Verified adult: <strong>{readiness.studentDisplayName}</strong>. Existing billing currency: <strong>{readiness.currency}</strong>. No payer, account, conversion, family, membership history, amount, payment, or authorization identifier is shown or accepted.</p><form onSubmit={submit}><fieldset disabled={busy || attempted}><div className={styles.formGrid}><label>Plan code<input name="planCode" required maxLength={80} autoComplete="off" value={planCode} onChange={(event) => { editCommand(); setPlanCode(event.target.value); }} /></label><label>Term starts at (optional UTC milliseconds)<input name="termStartedAt" type="text" inputMode="text" maxLength={24} placeholder="2026-10-18T20:00:00.000Z" value={termStartedAt} onChange={(event) => { editCommand(); setTermStartedAt(event.target.value); }} /></label><label>Term ends at (optional UTC milliseconds)<input name="termEndsAt" type="text" inputMode="text" maxLength={24} placeholder="2027-10-18T20:00:00.000Z" value={termEndsAt} onChange={(event) => { editCommand(); setTermEndsAt(event.target.value); }} /></label></div><label className={styles.check}><input name="confirmAdultCrmMembershipDraft" type="checkbox" checked={confirmed} disabled={!readyToConfirm} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this direct-human adult CRM membership DRAFT only. I understand it does not enroll, activate, bill, invoice, collect payment, send a message, create an agreement, or run provider, AI, Action Engine, or automation work.</label><div className={styles.actions}><button type="submit" disabled={!readyToConfirm || !confirmed || attempted}>Create membership DRAFT only</button><button type="button" onClick={discard}>Discard / start over</button></div></fieldset></form>{retry && <div className={styles.warning}><p>The outcome is uncertain. No membership draft is assumed. Only the exact retained path, body, and idempotency key may be retried; nothing retries automatically.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged membership draft</button></div>}</section>}
    {receipt && <section aria-label="Historical membership draft receipt" className={styles.receipt}><h2>Historical membership DRAFT creation receipt</h2><p>{receipt.replayed ? 'Replayed historical DRAFT receipt.' : 'Recorded historical DRAFT receipt.'} Plan code: <strong>{receipt.value.planCode}</strong>. Recorded at: <strong>{receipt.value.recordedAt}</strong>.</p><dl><dt>Term starts at</dt><dd>{receipt.value.termStartedAt ?? 'Not recorded'}</dd><dt>Term ends at</dt><dd>{receipt.value.termEndsAt ?? 'Not recorded'}</dd></dl><p>This historical receipt does not prove the membership remains DRAFT. It does not state enrollment, agreement, billing schedule, invoice, payment method, payment outcome, provider result, activation, communication, curriculum, AI, Action Engine, or automation result. Explicitly confirm the current source-bound DRAFT before using the separate activation review.</p></section>}
    {!readiness && !currentDraft && !busy && !error && <p className={styles.empty}>No verified adult CRM membership readiness or current DRAFT confirmation is shown.</p>}
    <p className={styles.footer}>Readiness, current confirmation, term values, confirmations, receipts, and uncertainty-only retries are memory-only. Editing the selector, access loss, discard, focus, visibility change, unmount, and reload clear derived state without refetch. This page has no browser persistence, directory, generic membership path, or automatic lifecycle action.</p>
  </main>;
}
