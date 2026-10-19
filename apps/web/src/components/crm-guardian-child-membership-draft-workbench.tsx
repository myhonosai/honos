'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { type CrmGuardianChildMembershipDraftConfirmation, type CrmGuardianChildMembershipDraftReceipt } from '@hon/contracts';
import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION,
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  CrmGuardianChildMembershipDraftAccessError,
  CrmGuardianChildMembershipDraftRejectedError,
  CrmGuardianChildMembershipDraftUncertainError,
  loadCrmGuardianChildMembershipDraftConfirmation,
  loadCrmGuardianChildMembershipDraftPreparation,
  prepareCrmGuardianChildMembershipDraftCommand,
  submitCrmGuardianChildMembershipDraft,
  type CrmGuardianChildMembershipDraftScope,
  type PreparedCrmGuardianChildMembershipDraft,
} from './crm-guardian-child-membership-draft-http';
import styles from './crm-guardian-child-membership-draft-workbench.module.css';

const UUID = CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID;
type Intent = 'READINESS' | 'CONFIRMATION';

/** Only a separately observed current source-bound DRAFT may hand off one membership selector for activation review. */
export function crmGuardianChildMembershipDraftActivationHref(confirmation: CrmGuardianChildMembershipDraftConfirmation | null | undefined): string | undefined {
  const membershipId = confirmation?.state === 'RECORDED_DRAFT' ? confirmation.receipt.membershipId : undefined;
  if (!membershipId || !UUID.test(membershipId)) return undefined;
  return `/staff/billing/memberships?${new URLSearchParams({ membershipId: membershipId.toLowerCase() }).toString()}`;
}

/** Separate direct-human guardian-child preparation/current-confirmation/DRAFT boundaries; never generic membership or billing-account I/O. */
export function CrmGuardianChildMembershipDraftWorkbench({ initialStudentProfileId }: { initialStudentProfileId?: string } = {}): React.ReactElement {
  const initialStudent = typeof initialStudentProfileId === 'string' && UUID.test(initialStudentProfileId) ? initialStudentProfileId.toLowerCase() : '';
  const [organizationId, setOrganizationId] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [studentProfileId, setStudentProfileId] = useState(initialStudent);
  const [scope, setScope] = useState<CrmGuardianChildMembershipDraftScope | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof loadCrmGuardianChildMembershipDraftPreparation>> | null>(null);
  const [currentDraft, setCurrentDraft] = useState<CrmGuardianChildMembershipDraftConfirmation | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [termStartedAt, setTermStartedAt] = useState('');
  const [termEndsAt, setTermEndsAt] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCrmGuardianChildMembershipDraft | null>(null);
  const [receipt, setReceipt] = useState<{ value: CrmGuardianChildMembershipDraftReceipt; replayed: boolean } | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const active = useRef(false);
  const epoch = useRef(0);
  const retained = useRef<PreparedCrmGuardianChildMembershipDraft | null>(null);

  function clearCommand(): void { retained.current = null; setPlanCode(''); setTermStartedAt(''); setTermEndsAt(''); setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); }
  function clearDerived(): void { setScope(null); setIntent(null); setReadiness(null); setCurrentDraft(null); clearCommand(); }
  function invalidate(message = ''): void { epoch.current++; active.current = false; setBusy(false); clearDerived(); setError(message); }
  function edit(setter: (value: string) => void, value: string): void { invalidate(); setter(value); }
  function editCommand(): void { retained.current = null; setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); setError(''); }
  function discard(): void { invalidate(); setOrganizationId(''); setSchoolId(''); setStudentProfileId(''); }
  function failure(caught: unknown): void {
    const message = caught instanceof Error ? caught.message : 'Guardian-child membership DRAFT state is unavailable. No membership, activation, payment, invoice, schedule, or provider result is assumed.';
    invalidate(message);
    if (caught instanceof CrmGuardianChildMembershipDraftAccessError) { setOrganizationId(''); setSchoolId(''); setStudentProfileId(''); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; }; }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stale = () => invalidate('Current guardian-child membership state may have changed. Selectors remain unverified; explicitly reload readiness or current DRAFT confirmation.');
    window.addEventListener('focus', stale); document.addEventListener('visibilitychange', stale);
    return () => { window.removeEventListener('focus', stale); document.removeEventListener('visibilitychange', stale); };
  }, []);

  async function begin(nextIntent: Intent, event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (active.current || busy || !UUID.test(organizationId) || !UUID.test(schoolId) || !UUID.test(studentProfileId)) { setError(`Enter one exact organization, school, and child student-profile UUID, then explicitly ${nextIntent === 'READINESS' ? 'load source-bound DRAFT readiness' : 'confirm the current source-bound DRAFT'}.`); return; }
    const nextScope = { organizationId: organizationId.toLowerCase(), schoolId: schoolId.toLowerCase() };
    const generation = ++epoch.current; active.current = true; clearDerived(); setIntent(nextIntent); setBusy(true); setError('');
    try {
      const result = nextIntent === 'READINESS' ? await loadCrmGuardianChildMembershipDraftPreparation(nextScope, studentProfileId) : await loadCrmGuardianChildMembershipDraftConfirmation(nextScope, studentProfileId);
      if (!mounted.current || generation !== epoch.current) return;
      setScope(nextScope); setIntent(nextIntent); clearCommand();
      if (nextIntent === 'READINESS') { setReadiness(result as Awaited<ReturnType<typeof loadCrmGuardianChildMembershipDraftPreparation>>); setCurrentDraft(null); }
      else { setReadiness(null); setCurrentDraft(result as CrmGuardianChildMembershipDraftConfirmation); }
    } catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); }
    finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function send(command: PreparedCrmGuardianChildMembershipDraft): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; retained.current = null; setBusy(true); setAttempted(true); setRetry(null); setReceipt(null); setCurrentDraft(null); setError('');
    try { const saved = await submitCrmGuardianChildMembershipDraft(command); if (mounted.current && generation === epoch.current) setReceipt({ value: saved.receipt, replayed: saved.replayed }); }
    catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CrmGuardianChildMembershipDraftAccessError || caught instanceof CrmGuardianChildMembershipDraftRejectedError) failure(caught);
      else { if (caught instanceof CrmGuardianChildMembershipDraftUncertainError) { retained.current = command; setRetry(command); } setError(caught instanceof Error ? caught.message : 'No verified guardian-child membership DRAFT receipt.'); }
    } finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!scope || !readiness || currentDraft || !confirmed || attempted || busy || active.current) return;
    try { const value = { studentProfileId, planCode, ...(termStartedAt ? { termStartedAt } : {}), ...(termEndsAt ? { termEndsAt } : {}), confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION } as const; void send(prepareCrmGuardianChildMembershipDraftCommand(scope, value, crypto.randomUUID())); }
    catch { setError('Use a bounded plan code and canonical UTC-millisecond terms, then explicitly reload readiness if a selector changed.'); }
  }
  function retryExact(command: PreparedCrmGuardianChildMembershipDraft): void { if (retained.current === command && !active.current && mounted.current) void send(command); }
  const readyToConfirm = !!scope && !!readiness && !currentDraft && !busy && !attempted && planCode.trim() === planCode && planCode.length > 0 && planCode.length <= 80;
  const activationHref = crmGuardianChildMembershipDraftActivationHref(currentDraft);

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/crm/register">CRM registration</a><a href="/staff/billing/crm-guardian-child-payer-designations">Source-guardian payer designation</a><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>DIRECT HUMAN STAFF · SOURCE-BOUND CHILD MEMBERSHIP PREPARATION</p><h1>Create or confirm a child membership DRAFT</h1><p>Enter one known organization, school, and child student-profile UUID. Load readiness to create one source-bound DRAFT-only membership record, or separately confirm an existing source-bound DRAFT. A URL selector is untrusted form text and cannot fetch, command, prove a relationship, or establish authority.</p></header>
    <aside><strong>Current confirmation is a narrow observation, not activation or payment authority.</strong><p>The server independently rederives the immutable payer designation, original child/guardian/family source, frozen canonical account, exact current membership state, current human, school, and entitlement. This page cannot search guardians, accounts, people, families, conversions, memberships, leads, or trials.</p><p>It creates no billing account, schedule, invoice, payment method, charge, provider operation, agreement, communication, curriculum enrollment, activation, AI, Action Engine, or automation work.</p></aside>
    <section aria-labelledby="guardian-child-membership-preparation"><h2 id="guardian-child-membership-preparation">1 / Explicit source-bound child action</h2><p>All selectors are untrusted values. No scope is auto-resolved and no I/O occurs until a staff member selects an explicit action.</p><form onSubmit={(event) => void begin('READINESS', event)}><fieldset disabled={busy || !!readiness || !!currentDraft}><div className={styles.formGrid}><label>Organization UUID<input name="organizationId" required autoComplete="off" spellCheck={false} maxLength={36} value={organizationId} onChange={(event) => edit(setOrganizationId, event.target.value)} /></label><label>School UUID<input name="schoolId" required autoComplete="off" spellCheck={false} maxLength={36} value={schoolId} onChange={(event) => edit(setSchoolId, event.target.value)} /></label><label>Child student-profile UUID<input name="studentProfileId" required autoComplete="off" spellCheck={false} maxLength={36} value={studentProfileId} onChange={(event) => edit(setStudentProfileId, event.target.value)} /></label></div><div className={styles.actions}><button type="submit" disabled={busy || !!readiness || !!currentDraft || !UUID.test(organizationId) || !UUID.test(schoolId) || !UUID.test(studentProfileId)}>Load child membership DRAFT readiness</button><button type="button" disabled={busy || !!readiness || !UUID.test(organizationId) || !UUID.test(schoolId) || !UUID.test(studentProfileId)} onClick={() => void begin('CONFIRMATION')}>Confirm current source-bound DRAFT</button>{(readiness || currentDraft || organizationId || schoolId || studentProfileId || receipt) && <button type="button" onClick={discard}>Discard / start over</button>}</div></fieldset></form>{busy && <p role="status">Verifying the current human, school, payer designation, child/guardian source, canonical account, and entitlement…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}</section>
    {currentDraft && <section aria-label="Current source-bound child DRAFT confirmation" className={styles.receipt}><h2>Current source-bound child DRAFT confirmation</h2><p>Current at this explicit check: <strong>DRAFT only</strong>. Plan code: <strong>{currentDraft.receipt.planCode}</strong>. Originally recorded at: <strong>{currentDraft.receipt.recordedAt}</strong>.</p><dl><dt>Term starts at</dt><dd>{currentDraft.receipt.termStartedAt ?? 'Not recorded'}</dd><dt>Term ends at</dt><dd>{currentDraft.receipt.termEndsAt ?? 'Not recorded'}</dd></dl><p>This is not active and does not establish enrollment, agreement, billing schedule, invoice, payment method, payment outcome, provider result, communication, curriculum, AI, Action Engine, or automation result.</p>{activationHref && <p><a href={activationHref}>Review separate direct-human membership activation</a></p>}<button type="button" onClick={discard}>Discard current confirmation</button></section>}
    {readiness && scope && !currentDraft && <section aria-labelledby="guardian-child-membership-command"><h2 id="guardian-child-membership-command">2 / Explicit human child DRAFT command</h2><p>Verified child: <strong>{readiness.studentDisplayName}</strong>. Verified source guardian: <strong>{readiness.guardianDisplayName}</strong>. Existing canonical currency: <strong>{readiness.currency}</strong>.</p><p>No payer, account, conversion, family, membership history, amount, payment, agreement, or authority identifier is shown or accepted.</p><form onSubmit={submit}><fieldset disabled={busy || attempted}><div className={styles.formGrid}><label>Plan code<input name="planCode" required maxLength={80} autoComplete="off" value={planCode} onChange={(event) => { editCommand(); setPlanCode(event.target.value); }} /></label><label>Term starts at (optional UTC milliseconds)<input name="termStartedAt" type="text" maxLength={24} placeholder="2026-10-18T20:00:00.000Z" value={termStartedAt} onChange={(event) => { editCommand(); setTermStartedAt(event.target.value); }} /></label><label>Term ends at (optional UTC milliseconds)<input name="termEndsAt" type="text" maxLength={24} placeholder="2027-10-18T20:00:00.000Z" value={termEndsAt} onChange={(event) => { editCommand(); setTermEndsAt(event.target.value); }} /></label></div><label className={styles.check}><input name="confirmGuardianChildMembershipDraft" type="checkbox" checked={confirmed} disabled={!readyToConfirm} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this direct-human source-bound guardian-child membership DRAFT only. I understand it does not enroll, activate, bill, invoice, collect payment, send a message, create an agreement, or run provider, AI, Action Engine, or automation work.</label><div className={styles.actions}><button type="submit" disabled={!readyToConfirm || !confirmed || attempted}>Create child membership DRAFT only</button><button type="button" onClick={discard}>Discard / start over</button></div></fieldset></form>{retry && <div className={styles.warning}><p>The outcome is uncertain. No membership draft is assumed. Only the exact retained path, body, and idempotency key may be retried; nothing retries automatically.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged child membership draft</button></div>}</section>}
    {receipt && <section aria-label="Historical child membership draft receipt" className={styles.receipt}><h2>Historical child membership DRAFT creation receipt</h2><p>{receipt.replayed ? 'Replayed historical DRAFT receipt.' : 'Recorded historical DRAFT receipt.'} Plan code: <strong>{receipt.value.planCode}</strong>. Recorded at: <strong>{receipt.value.recordedAt}</strong>.</p><dl><dt>Term starts at</dt><dd>{receipt.value.termStartedAt ?? 'Not recorded'}</dd><dt>Term ends at</dt><dd>{receipt.value.termEndsAt ?? 'Not recorded'}</dd></dl><p>This historical receipt does not prove the membership remains DRAFT. It does not state enrollment, agreement, billing schedule, invoice, payment method, payment outcome, provider result, activation, communication, curriculum, AI, Action Engine, or automation result. Explicitly confirm the current source-bound DRAFT before using the separate activation review.</p></section>}
    {!readiness && !currentDraft && !busy && !error && <p className={styles.empty}>No verified guardian-child membership readiness or current DRAFT confirmation is shown.</p>}
    <p className={styles.footer}>Readiness, current confirmation, term values, confirmation, receipts, and uncertainty-only retries are memory-only. Editing a selector, access loss, focus or visibility change, discard, unmount, and reload clear derived state without refetch. This page has no browser persistence, directory, generic membership creation path, or automatic lifecycle action.</p>
  </main>;
}
