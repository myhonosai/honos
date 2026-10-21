'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem, CrmAdultMembershipPreparation, CrmAdultMembershipDraftReceipt, CrmLeadRegistrationResult, CrmLeadRegistrationRecovery, CrmLeadRegistrationRecoveryAccount, MembershipPlanVersionSummary } from '@hon/contracts';
import { adultRequest, sendAdultRequest, AdultAccessError, AdultUncertainError, type AdultAccount, type AdultRequest, type AdultScope } from './crm-adult-flow-http';
import styles from './crm-adult-flow.module.css';
import { AdultMembershipPlanPicker } from './membership-plans/picker';
import { MembershipPlanTerms } from './membership-plans/terms';
import { useLocale } from './localization/provider';
import { sendPlanRequest, PlanAccessError, PlanUnknownError, type PlanRequest } from './membership-plans/http';

type Registered = Extract<CrmLeadRegistrationResult, { outcome: 'REGISTERED' }>;
type Props = AdultScope & { row: LeadListItem; initialRecovery?: CrmLeadRegistrationRecovery; onRecover?(): void; onCancel(): void; onBusy(busy: boolean): void; onStarted(): void; onAccessLost(): void };
export function CrmAdultFlow({ row, organizationId, schoolId, initialRecovery, onRecover, onCancel, onBusy, onStarted, onAccessLost }: Props): React.ReactElement {
  const { date } = useLocale();
  const [pendingPlan, setPendingPlan] = useState<PlanRequest | null>(null);
  const previousRecovery = useRef(initialRecovery);
  const recoveredRegistration = initialRecovery && 'historicalRegistrationReceipt' in initialRecovery ? initialRecovery.historicalRegistrationReceipt : null;
  const recoveredAccount = initialRecovery && 'billingAccount' in initialRecovery ? initialRecovery.billingAccount : null;
  const recoveredDraft = initialRecovery?.workflowState === 'CURRENT_DRAFT' ? initialRecovery.currentMembershipDraft.receipt : null;
  const otherCurrent = initialRecovery?.workflowState === 'CURRENT_DRAFT_BY_OTHER_STAFF';
  const [birthDate, setBirthDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [plan, setPlan] = useState('');
  const [consent, setConsent] = useState(false);
  const [registered, setRegistered] = useState<Registered | null>(recoveredRegistration);
  const [account, setAccount] = useState<AdultAccount | CrmLeadRegistrationRecoveryAccount | null>(recoveredAccount);
  const [prepared, setPrepared] = useState<CrmAdultMembershipPreparation | null>(null);
  const [receipt, setReceipt] = useState<CrmAdultMembershipDraftReceipt | null>(recoveredDraft);
  const [current, setCurrent] = useState(recoveredDraft !== null);
  const [createdFromPlan, setCreatedFromPlan] = useState<MembershipPlanVersionSummary | null>(null);
  const [planBlocking, setPlanBlocking] = useState(false);
  const [pending, setPending] = useState<AdultRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(initialRecovery ? ({
    NOT_REGISTERED: 'No registration is recorded for this lead. Begin only after reviewing the adult registration details.',
    NEEDS_STAFF_REVIEW: 'Staff review required. No later setup step is available.',
    BILLING_ACCOUNT_REQUIRED: 'Historical adult registration recovered. Review the billing-account step before continuing.',
    READY_FOR_DRAFT: 'Canonical billing account verified during recovery. Check DRAFT readiness before creating a membership DRAFT.',
    CURRENT_DRAFT: 'Current DRAFT confirmed by the authorized recovery read.',
    CURRENT_DRAFT_BY_OTHER_STAFF: 'A current DRAFT exists, created by another staff member. This view grants no confirmation, change, ownership-transfer or activation rights.',
  }[initialRecovery.workflowState]) : '');
  const [error, setError] = useState('');
  const [review, setReview] = useState(initialRecovery?.workflowState === 'NEEDS_STAFF_REVIEW');
  const active = useRef(false), generation = useRef(0), heading = useRef<HTMLHeadingElement | null>(null);
  const scope = { organizationId, schoolId };
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => () => { generation.current++; active.current = false; }, [organizationId, schoolId, row.id]);

  // React applies this guarded state adjustment before committing the restored view.
  if (previousRecovery.current !== initialRecovery) {
    previousRecovery.current = initialRecovery;
    setRegistered(recoveredRegistration); setAccount(recoveredAccount); setReceipt(recoveredDraft); setCurrent(recoveredDraft !== null);
    setPrepared(null); setCreatedFromPlan(null); setConsent(false); setBirthDate(''); setPlan(''); setError(''); setReview(initialRecovery?.workflowState === 'NEEDS_STAFF_REVIEW');
    setMessage('Current adult setup reverified. Historical requests are separate from current membership state.');
  }

  function planCreated(data: { receipt: CrmAdultMembershipDraftReceipt; plan: MembershipPlanVersionSummary }, replayed: boolean): void {
    setPendingPlan(null); setReceipt(data.receipt); setCreatedFromPlan(data.plan); setCurrent(false); setPlanBlocking(false); onBusy(false); setConsent(false); setError(''); setMessage(replayed ? 'Historical plan-bound DRAFT creation replayed.' : 'Membership DRAFT recorded from the reviewed plan version. It is not active.');
  }
  async function retryPlan(): Promise<void> {
    if (!pendingPlan || active.current) return;
    const request = pendingPlan, epoch = generation.current; active.current = true; setBusy(true); onBusy(true);
    try {
      const result = await sendPlanRequest(request);
      if (epoch !== generation.current) return;
      if (result.kind !== 'draft') throw new Error('No verified adult DRAFT result.');
      planCreated(result.draft, result.replayed);
    } catch (e) {
      if (epoch !== generation.current) return;
      if (e instanceof PlanAccessError) onAccessLost();
      else { if (!(e instanceof PlanUnknownError)) setPendingPlan(null); setError(e instanceof Error ? e.message : 'Current DRAFT could not be verified.'); }
    } finally { if (epoch === generation.current) { active.current = false; setBusy(false); onBusy(false); } }
  }

  async function run(request: AdultRequest): Promise<void> {
    if (active.current || planBlocking) return;
    active.current = true; const epoch = generation.current; setBusy(true); onBusy(true); setError(''); setMessage(''); setCurrent(false);
    if (request.key) onStarted();
    try {
      const result = await sendAdultRequest(request);
      if (epoch !== generation.current) return;
      if (result.step === 'register') {
        if (result.registration.outcome === 'NEEDS_STAFF_REVIEW') { setReview(true); setMessage('Staff review required. No new registration receipt or later setup step is available.'); }
        else {
          if (result.registration.sourceContactPersonId.toLowerCase() !== row.primaryPersonId.toLowerCase() || result.registration.registrationPath !== 'ADULT' || result.registration.familyId !== null) throw new AdultUncertainError('The returned adult identity does not match this lead. No later step is available; retry the retained request or return to the lead list.');
          setRegistered(result.registration); setMessage(result.replayed ? 'Adult registration receipt replayed.' : 'Adult registration recorded.');
        }
      } else if (result.step === 'account') { setAccount(result.account); setMessage(result.replayed ? 'Account receipt replayed.' : result.account.reused ? 'Existing canonical billing account reused.' : 'Canonical billing account recorded.'); }
      else if (result.step === 'prepare') {
        if (result.preparation.currency !== account?.currency) throw new Error('The account currency changed. Readiness unavailable; return for staff review.');
        setPrepared(result.preparation); setMessage('Adult record and canonical account verified for DRAFT preparation.');
      } else if (result.step === 'draft') { setReceipt(result.receipt); setMessage(result.replayed ? 'Historical DRAFT creation receipt replayed.' : 'Membership DRAFT recorded. It is not active.'); }
      else {
        if (!receipt || JSON.stringify(result.confirmation.receipt) !== JSON.stringify(receipt)) throw new Error('The returned DRAFT differs from this creation receipt. Current confirmation is unavailable.');
        setCurrent(true); setMessage('Current DRAFT confirmed by the authorized backend.');
      }
      setPending(null); setConsent(false);
    } catch (e) {
      if (epoch !== generation.current) return;
      if (e instanceof AdultAccessError) { onAccessLost(); return; }
      if (e instanceof AdultUncertainError) setPending(request);
      else { setPending(null); setConsent(false); if (request.step === 'prepare' || request.step === 'draft') setPrepared(null); }
      setError(e instanceof Error ? e.message : 'This step could not be verified.');
    } finally { if (epoch === generation.current) { active.current = false; setBusy(false); onBusy(false); } }
  }
  function submit(event: FormEvent): void {
    event.preventDefault(); if (active.current || planBlocking || pending || pendingPlan || !consent || review || receipt || otherCurrent) return;
    try {
      // Validate before allocating a command key; each consequential step gets a distinct key.
      const step = !registered ? 'register' : !account ? 'account' : 'draft';
      if (step === 'draft' && !prepared) return;
      const selection = !registered ? row.id : !account ? registered.sourceContactPersonId : registered.studentProfileId;
      const value = !registered ? birthDate : !account ? currency : plan;
      const placeholder = '00000000-0000-4000-8000-000000000001'; adultRequest(scope, step, selection, value, placeholder);
      void run(adultRequest(scope, step, selection, value, crypto.randomUUID()));
    } catch { setError('Review the required date, currency or plan code and confirmation before submitting.'); }
  }
  const locked = busy || pending !== null || pendingPlan !== null;
  return <section className={styles.flow} aria-labelledby="adult-flow-title" aria-busy={busy}>
    <header><p>ADULT CRM SETUP</p><h2 id="adult-flow-title" ref={heading} tabIndex={-1}>Set up {row.givenName} {row.familyName}</h2><p>Register adult → billing account → membership DRAFT</p>
      <button type="button" disabled={busy || planBlocking} onClick={onCancel}>Close adult setup</button>
      {onRecover && <button type="button" disabled={locked || planBlocking} onClick={onRecover}>Refresh saved setup</button>}</header>
    <p>Each step is a separate authorized action. A DRAFT does not activate membership, create a payment schedule or collect payment.</p>
    <ol aria-label="Adult setup progress"><li aria-current={!registered && !review ? 'step' : undefined}>Registration{registered ? ' — recorded' : ''}</li><li aria-current={registered && !account ? 'step' : undefined}>Billing account{account ? ' — verified' : ''}</li><li aria-current={account ? 'step' : undefined}>Membership DRAFT{receipt || otherCurrent ? ' — recorded' : ''}</li></ol>
    {message && <p role="status" className={styles.notice}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {pending && <div className={styles.notice}><p>An action may already have completed. This retry retains its exact data and idempotency key.</p><button type="button" disabled={busy} onClick={() => void run(pending)}>Retry exact request</button></div>}
    {pendingPlan && <div className={styles.notice}><p>A plan-bound DRAFT may already have been created. Its exact request is retained only in memory.</p><button type="button" disabled={busy} onClick={() => void retryPlan()}>Retry exact plan request</button></div>}
    {registered && !otherCurrent && <p>Registration recorded for this adult lead. Historical registration receipt; not proof of current membership. Student reference: <code>{registered.studentProfileId}</code></p>}
    {account && !otherCurrent && <p>{'id' in account ? <>{account.reused === true ? 'Existing account reused' : account.reused === false ? 'Account created' : 'Historical account receipt'} · {account.currency} · <code>{account.id}</code></> : <>Verified canonical account · {account.currency}. No account identifier was returned.</>}</p>}
    {!review && !receipt && !otherCurrent && registered && account && prepared && <AdultMembershipPlanPicker scope={scope} studentProfileId={registered.studentProfileId} currency={prepared.currency} disabled={locked}
      onBlocking={blocked => { setPlanBlocking(blocked); onBusy(blocked); }} onStarted={onStarted} onAccessLost={onAccessLost}
      onNeedsRefresh={reason => { setPrepared(null); setPlanBlocking(false); onBusy(false); setError(reason); }}
      onUncertain={request => { if ('step' in request) return; setPendingPlan(request); setPrepared(null); setPlanBlocking(false); onBusy(false); setError('The adult plan-bound DRAFT outcome is uncertain. Retry only its retained exact request.'); }}
      onCreated={planCreated} />}
    {!review && !receipt && !otherCurrent && <form onSubmit={submit}><fieldset disabled={locked || planBlocking}>
      {!registered ? <><h3>1. Register this adult</h3><label>Date of birth<input type="date" required min="1900-01-01" value={birthDate} onChange={e => { setBirthDate(e.target.value); setConsent(false); setError(''); }} /></label>
        <label className={styles.check}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I reviewed this lead as an adult registering without a guardian.</label><button disabled={!consent || !birthDate}>Register adult</button></>
      : !account ? <><h3>2. Create or reuse this adult’s account</h3><p>The responsible person is the exact adult returned by registration. A matching canonical account is reused; a different currency requires staff review.</p>
        <label>Account currency<input required pattern="[A-Z]{3}" maxLength={3} value={currency} onChange={e => { setCurrency(e.target.value.toUpperCase()); setConsent(false); setError(''); }} /></label>
        <label className={styles.check}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />This adult is responsible for their own billing account in the currency shown.</label><button disabled={!consent || !/^[A-Z]{3}$/.test(currency)}>Create or reuse account</button></>
      : <><h3>3. Prepare membership DRAFT</h3>{!prepared ? <button type="button" onClick={() => void run(adultRequest(scope, 'prepare', registered.studentProfileId, ''))}>Check DRAFT readiness</button>
        : <details><summary>Use legacy free-text plan code</summary><p>{prepared.studentDisplayName} · {prepared.currency} · Ready for DRAFT preparation</p><label>Membership plan code<input required maxLength={80} value={plan} onChange={e => { setPlan(e.target.value); setConsent(false); setError(''); }} /></label><p>This separate legacy option records a plan code without a published catalog-version binding. It does not establish a price or payment terms.</p>
          <label className={styles.check}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I confirm this adult’s membership DRAFT with the plan code shown.</label><button disabled={!consent || !plan.trim()}>Create membership DRAFT</button></details>}</>}
    </fieldset></form>}
    {receipt && createdFromPlan && <div className={styles.receipt}><h3>Created from published plan: {createdFromPlan.displayName}</h3><p>Historical plan-version terms returned with creation; later catalog changes do not replace them.</p><MembershipPlanTerms plan={createdFromPlan}/></div>}
    {receipt && !createdFromPlan && <p>Original published plan terms are unavailable in this receipt or recovery view. A plan code alone does not establish a catalog binding.</p>}
    {receipt && <div className={styles.receipt}><h3>Membership DRAFT creation receipt</h3><p>{receipt.planCode} · DRAFT · Recorded {date(receipt.recordedAt)}</p><p>Historical creation receipt: <code>{receipt.membershipId}</code>. Current state requires a separate check.</p>
      <button type="button" disabled={locked || planBlocking} onClick={() => void run(adultRequest(scope, 'confirm', registered!.studentProfileId, ''))}>Check current DRAFT</button>
      {current && <p role="status">Current DRAFT verified. Membership activation and payments remain outside this workflow.</p>}</div>}
  </section>;
}
