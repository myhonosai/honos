'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID, type CrmGuardianChildPayerDesignationReceipt } from '@hon/contracts';
import {
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION,
  CrmGuardianChildPayerDesignationAccessError,
  CrmGuardianChildPayerDesignationRejectedError,
  CrmGuardianChildPayerDesignationUncertainError,
  loadCrmGuardianChildPayerDesignationPreparation,
  prepareCrmGuardianChildPayerDesignationCommand,
  submitCrmGuardianChildPayerDesignation,
  type CrmGuardianChildPayerDesignationScope,
  type PreparedCrmGuardianChildPayerDesignation,
} from './crm-guardian-child-payer-designation-http';
import styles from './crm-guardian-child-payer-designation-workbench.module.css';

const UUID = CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID;

/** A historical verified designation may hand off one child selector only; the destination stays inert. */
export function crmGuardianChildMembershipDraftHref(receipt: CrmGuardianChildPayerDesignationReceipt | null | undefined, studentProfileId: string): string | undefined {
  if (receipt?.state !== 'PAYER_DESIGNATED' || !UUID.test(studentProfileId)) return undefined;
  return `/staff/billing/crm-guardian-child-membership-drafts?${new URLSearchParams({ studentProfileId: studentProfileId.toLowerCase() }).toString()}`;
}

/** Separate direct-human payer-designation boundary; this component never lists or selects people, families, accounts, or memberships. */
export function CrmGuardianChildPayerDesignationWorkbench({ initialStudentProfileId }: { initialStudentProfileId?: string } = {}): React.ReactElement {
  const initialStudent = typeof initialStudentProfileId === 'string' && UUID.test(initialStudentProfileId) ? initialStudentProfileId.toLowerCase() : '';
  const [organizationId, setOrganizationId] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [studentProfileId, setStudentProfileId] = useState(initialStudent);
  const [scope, setScope] = useState<CrmGuardianChildPayerDesignationScope | null>(null);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof loadCrmGuardianChildPayerDesignationPreparation>> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCrmGuardianChildPayerDesignation | null>(null);
  const [receipt, setReceipt] = useState<{ value: CrmGuardianChildPayerDesignationReceipt; replayed: boolean } | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const active = useRef(false);
  const epoch = useRef(0);
  const retained = useRef<PreparedCrmGuardianChildPayerDesignation | null>(null);

  function clearCommand(): void { retained.current = null; setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); }
  function clearDerived(): void { setScope(null); setReadiness(null); clearCommand(); }
  function invalidate(message = ''): void { epoch.current++; active.current = false; setBusy(false); clearDerived(); setError(message); }
  function edit(setter: (value: string) => void, value: string): void { invalidate(); setter(value); }
  function discard(): void { invalidate(); setOrganizationId(''); setSchoolId(''); setStudentProfileId(''); }
  function failure(caught: unknown): void {
    const message = caught instanceof Error ? caught.message : 'Guardian-child payer designation is unavailable. No payer, account, membership, payment, invoice, schedule, activation, or provider result is assumed.';
    if (caught instanceof CrmGuardianChildPayerDesignationAccessError) { invalidate(message); setOrganizationId(''); setSchoolId(''); setStudentProfileId(''); return; }
    invalidate(message);
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; }; }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stale = () => invalidate('Current guardian-child source state may have changed. Selectors remain unverified; explicitly reload readiness.');
    window.addEventListener('focus', stale); document.addEventListener('visibilitychange', stale);
    return () => { window.removeEventListener('focus', stale); document.removeEventListener('visibilitychange', stale); };
  }, []);

  async function prepare(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (active.current || busy || !UUID.test(organizationId) || !UUID.test(schoolId) || !UUID.test(studentProfileId)) { setError('Enter one exact organization, school, and child student-profile UUID, then explicitly load payer-designation readiness.'); return; }
    const nextScope = { organizationId: organizationId.toLowerCase(), schoolId: schoolId.toLowerCase() };
    const generation = ++epoch.current; active.current = true; clearDerived(); setBusy(true); setError('');
    try {
      const result = await loadCrmGuardianChildPayerDesignationPreparation(nextScope, studentProfileId);
      if (!mounted.current || generation !== epoch.current) return;
      setScope(nextScope); setReadiness(result);
    } catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); }
    finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function send(command: PreparedCrmGuardianChildPayerDesignation): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; retained.current = null; setBusy(true); setAttempted(true); setRetry(null); setReceipt(null); setError('');
    try { const saved = await submitCrmGuardianChildPayerDesignation(command); if (mounted.current && generation === epoch.current) setReceipt({ value: saved.receipt, replayed: saved.replayed }); }
    catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CrmGuardianChildPayerDesignationAccessError || caught instanceof CrmGuardianChildPayerDesignationRejectedError) failure(caught);
      else { if (caught instanceof CrmGuardianChildPayerDesignationUncertainError) { retained.current = command; setRetry(command); } setError(caught instanceof Error ? caught.message : 'No verified payer-designation receipt.'); }
    } finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!scope || !readiness || !confirmed || attempted || busy || active.current) return;
    try { void send(prepareCrmGuardianChildPayerDesignationCommand(scope, { studentProfileId, confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, crypto.randomUUID())); }
    catch { setError('The child selector changed or is invalid. Explicitly reload payer-designation readiness before confirming.'); }
  }
  function retryExact(command: PreparedCrmGuardianChildPayerDesignation): void { if (retained.current === command && !active.current && mounted.current) void send(command); }
  const readyToConfirm = !!scope && !!readiness && !busy && !attempted;
  const draftHref = crmGuardianChildMembershipDraftHref(receipt?.value, studentProfileId);

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/crm/register">CRM registration</a><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>DIRECT HUMAN STAFF · SOURCE-GUARDIAN PAYER DESIGNATION</p><h1>Designate the source guardian as payer</h1><p>Enter one known organization, school, and child student-profile UUID. The query prefill is untrusted text only: it starts no request and establishes no child, guardian, family, payer, account, scope, authority, or receipt fact.</p></header>
    <aside><strong>This is an operational designation only.</strong><p>The server must independently rederive the original registered guardian-child source, family relationship, sole source guardian, current canonical account, and current authority. This page cannot search or select guardians, people, families, accounts, conversions, or memberships.</p><p>It creates no billing account, membership, payment schedule, invoice, charge, payment method, agreement, activation, provider operation, communication, curriculum, AI, Action Engine, or automation work.</p></aside>
    <section aria-labelledby="guardian-child-payer-preparation"><h2 id="guardian-child-payer-preparation">1 / Explicit payer-designation readiness</h2><p>All three selectors are untrusted values. No scope is auto-resolved and no I/O occurs until you explicitly prepare.</p>
      <form onSubmit={(event) => void prepare(event)}><fieldset disabled={busy || !!readiness || !!receipt}><div className={styles.formGrid}><label>Organization UUID<input name="organizationId" required autoComplete="off" spellCheck={false} maxLength={36} value={organizationId} onChange={(event) => edit(setOrganizationId, event.target.value)} /></label><label>School UUID<input name="schoolId" required autoComplete="off" spellCheck={false} maxLength={36} value={schoolId} onChange={(event) => edit(setSchoolId, event.target.value)} /></label><label>Child student-profile UUID<input name="studentProfileId" required autoComplete="off" spellCheck={false} maxLength={36} value={studentProfileId} onChange={(event) => edit(setStudentProfileId, event.target.value)} /></label></div><div className={styles.actions}><button type="submit" disabled={busy || !!readiness || !!receipt || !UUID.test(organizationId) || !UUID.test(schoolId) || !UUID.test(studentProfileId)}>Load payer-designation readiness</button>{(readiness || receipt || organizationId || schoolId || studentProfileId) && <button type="button" onClick={discard}>Discard / start over</button>}</div></fieldset></form>
      {busy && <p role="status">Verifying the current human, school, source guardian-child conversion, family relationship, canonical account, and entitlement…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
    {readiness && scope && <section aria-labelledby="guardian-child-payer-command"><h2 id="guardian-child-payer-command">2 / Explicit direct-human payer designation</h2><p>Verified child: <strong>{readiness.studentDisplayName}</strong>. Verified source guardian: <strong>{readiness.guardianDisplayName}</strong>. Canonical billing currency: <strong>{readiness.currency}</strong>.</p><p>No guardian, family, account, conversion, payer identifier, membership, amount, payment, agreement, or authority value is shown or accepted.</p><form onSubmit={submit}><fieldset disabled={busy || attempted}><label className={styles.check}><input name="confirmGuardianChildPayerDesignation" type="checkbox" checked={confirmed} disabled={!readyToConfirm} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this direct-human guardian-child payer designation only. I understand it is not proof of legal guardianship, consent, identity, payment authorization, or a chargeable agreement.</label><div className={styles.actions}><button type="submit" disabled={!readyToConfirm || !confirmed || attempted}>Designate source guardian as payer</button><button type="button" onClick={discard}>Discard / start over</button></div></fieldset></form>{retry && <div className={styles.warning}><p>The outcome is uncertain. No payer designation is assumed. Only the exact retained path, body, and idempotency key may be retried; nothing retries automatically.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged payer designation</button></div>}</section>}
    {receipt && <section aria-label="Historical payer designation receipt" className={styles.receipt}><h2>Historical payer-designation receipt</h2><p>{receipt.replayed ? 'Replayed historical payer-designation receipt.' : 'Recorded historical payer-designation receipt.'} Verified child: <strong>{receipt.value.studentDisplayName}</strong>. Verified source guardian: <strong>{receipt.value.guardianDisplayName}</strong>. Currency: <strong>{receipt.value.currency}</strong>. State: <strong>PAYER_DESIGNATED</strong>. Recorded at: <strong>{receipt.value.recordedAt}</strong>.</p><p>This receipt does not prove legal guardianship, consent, identity, payment authorization, an agreement, payment outcome, billing schedule, invoice, charge, provider result, membership activation, communication, curriculum, AI, Action Engine, or automation result.</p>{draftHref && <p><a href={draftHref}>Prepare separate source-bound child membership DRAFT</a></p>}<button type="button" onClick={discard}>Discard receipt</button></section>}
    {!readiness && !receipt && !busy && !error && <p className={styles.empty}>No verified guardian-child payer-designation readiness or receipt is shown.</p>}
    <p className={styles.footer}>Readiness, confirmation, receipt, and uncertainty-only retry state are memory-only. Editing a selector, access loss, focus or visibility change, discard, unmount, and reload clear derived state without refetch. This page has no browser persistence, directory, generic membership path, or automatic lifecycle action.</p>
  </main>;
}
