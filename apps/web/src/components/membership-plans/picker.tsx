'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION, membershipPlanFixedTermEnd, validateCrmAdultMembershipDraftFromPlanInput,
  type CrmAdultMembershipDraftFromPlan, type CrmAdultMembershipDraftFromPlanInput, type MembershipPlanListing,
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION, validateCrmGuardianChildMembershipDraftFromPlanInput,
} from '@hon/contracts';
import { familyRequest, sendFamilyRequest, type FamilyRequest } from '../crm-family-http';
import { PlanAccessError, PlanRejectedError, PlanUnknownError, draftFromPlanRequest, readAdultPlanOptions, sendPlanRequest, type PlanRequest, type PlanScope } from './http';
import { MembershipPlanTerms } from './terms';
import styles from './plans.module.css';

type Review = { input: Omit<CrmAdultMembershipDraftFromPlanInput, 'confirmation'>; plan: MembershipPlanListing };
export function AdultMembershipPlanPicker({ scope, studentProfileId, currency, childName, disabled, onBlocking, onStarted, onCreated, onAccessLost, onNeedsRefresh }: {
  scope: PlanScope; studentProfileId: string; currency: string; disabled: boolean; onBlocking(blocked: boolean): void; onStarted(): void;
  childName?: string;
  onCreated(data: CrmAdultMembershipDraftFromPlan, replayed: boolean): void; onAccessLost(): void; onNeedsRefresh(message: string): void;
}): React.ReactElement {
  const [plans, setPlans] = useState<MembershipPlanListing[] | null>(null), [selected, setSelected] = useState(''), [start, setStart] = useState('');
  const [review, setReview] = useState<Review | null>(null), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<PlanRequest | FamilyRequest | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { setPlans(null); setSelected(''); setReview(null); setPending(null); setConfirmed(false); setError(''); setBusy(false); setStart(''); onBlocking(false);
    return () => { epoch.current++; abort.current?.abort(); active.current = false; };
  }, [scope.organizationId, scope.schoolId, studentProfileId, currency]);
  useEffect(() => { if (review || error) heading.current?.focus(); }, [review, error]);
  const plan = plans?.find(p => p.planId === selected);
  function edit(): void { setReview(null); setConfirmed(false); setError(''); }
  async function load(): Promise<void> {
    if (active.current || disabled || pending) return;
    const generation = ++epoch.current, controller = new AbortController(); abort.current = controller;
    active.current = true; setBusy(true); onBlocking(true); setPlans(null); setSelected(''); setReview(null); setConfirmed(false); setError('');
    try { const result = await readAdultPlanOptions(scope, controller.signal); if (generation === epoch.current) setPlans(result.plans); }
    catch (e) { if (generation !== epoch.current) return; if (e instanceof PlanAccessError) onAccessLost(); else setError(e instanceof Error ? e.message : 'Plans are unavailable.'); }
    finally { if (generation === epoch.current) { active.current = false; setBusy(false); onBlocking(false); } }
  }
  function prepareReview(): void {
    if (active.current || disabled || pending || !plan || plan.currency !== currency) return;
    try {
      const selection = { studentProfileId, membershipPlanId: plan.planId, membershipPlanVersion: plan.version, ...(start ? { termStartedAt: new Date(start + 'Z').toISOString() } : {}) };
      const input = childName === undefined ? validateCrmAdultMembershipDraftFromPlanInput({ ...selection, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION })
        : validateCrmGuardianChildMembershipDraftFromPlanInput({ ...selection, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION });
      if (input.termStartedAt && plan.termKind === 'FIXED_MONTHS') membershipPlanFixedTermEnd(input.termStartedAt, plan.termMonths!);
      setReview({ input, plan }); setConfirmed(false); setError('');
    } catch { setError('Review the selected plan and enter a valid optional UTC term start.'); }
  }
  async function send(request: PlanRequest | FamilyRequest): Promise<void> {
    if (active.current || disabled || pending && pending !== request) return;
    const generation = epoch.current, controller = new AbortController(); abort.current = controller;
    active.current = true; setBusy(true); onBlocking(true); onStarted(); setError('');
    let retained = false;
    try {
      const result = 'step' in request ? await sendFamilyRequest(request, controller.signal) : await sendPlanRequest(request, controller.signal); if (generation !== epoch.current) return;
      if ('step' in result ? result.step !== 'childDraft' : result.kind !== 'draft') throw new Error('Unexpected result.');
      if (!('draft' in result)) throw new Error('Unexpected DRAFT result.');
      setPending(null); setReview(null); onCreated(result.draft, result.replayed);
    } catch (e) {
      if (generation !== epoch.current) return;
      if (e instanceof PlanAccessError) onAccessLost();
      else if (e instanceof PlanUnknownError) { retained = true; setPending(request); setError(e.message); }
      else {
        setPending(null); setReview(null); setConfirmed(false); setPlans(null); setSelected('');
        if (e instanceof PlanRejectedError && (['CRM_ADULT_MEMBERSHIP_UNAVAILABLE','MEMBERSHIP_PLAN_CURRENCY_MISMATCH'].includes(e.code)
          || childName !== undefined && !['MEMBERSHIP_PLAN_VERSION_STALE','MEMBERSHIP_PLAN_UNAVAILABLE'].includes(e.code))) {
          onNeedsRefresh(childName === undefined ? 'Membership readiness changed. Close adult setup and use Resume setup to verify the current registration, account and DRAFT state.' : 'Family or child readiness changed. Refresh family setup to verify the current guardian payer and this child’s membership state.');
        } else setError(e instanceof Error ? e.message : 'This DRAFT could not be recorded. Reload and review the plans.');
      }
    } finally { if (generation === epoch.current) { active.current = false; setBusy(false); onBlocking(retained); } }
  }
  function publish(): void {
    if (!review || !confirmed || active.current || disabled || pending) return;
    const key = crypto.randomUUID();
    void send(childName === undefined ? draftFromPlanRequest(scope, { ...review.input, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }, key)
      : familyRequest(scope, 'childDraft', studentProfileId, { ...review.input, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }, key));
  }
  const locked = disabled || busy || pending !== null;
  return <section className={styles.picker} aria-labelledby="adult-plan-picker-title" aria-busy={busy}>
    <h3 id="adult-plan-picker-title" tabIndex={-1} ref={heading}>Choose a published membership plan</h3>
    <p>Choose your school’s student membership terms. Verified billing-account currency: <strong>{currency}</strong>.</p>
    <button type="button" disabled={locked} onClick={() => void load()}>{plans === null ? 'Load available membership plans' : 'Reload available membership plans'}</button>
    {busy && <p role="status">{review || pending ? 'Verifying the reviewed DRAFT request…' : 'Loading current school plans…'}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {plans && !plans.length && <p role="status">{childName === undefined ? 'No available membership plans were returned. Ask your school owner to publish a plan, or use the separately available legacy plan-code option below.' : 'No available membership plans were returned. Ask your school owner to publish a matching plan. Child DRAFTs require a published plan.'}</p>}
    {plans && plans.length > 0 && !review && <fieldset disabled={locked}>
      <label>Available membership plan<select aria-label="Available membership plan" value={selected} onChange={e => { setSelected(e.target.value); edit(); }}><option value="">Choose a plan</option>{plans.map(p => <option key={p.planId} value={p.planId} disabled={p.currency !== currency}>{p.displayName} · v{p.version}{p.currency !== currency ? ` · ${p.currency} does not match ${currency}` : ''}</option>)}</select></label>
      {plans.every(p => p.currency !== currency) && <p role="status">No returned plan matches the verified account currency. Ask your school owner for a matching plan.</p>}
      {plan && <><MembershipPlanTerms plan={plan} programName={plan.programName}/><label>Term starts (UTC, optional)<input type="datetime-local" step={1} value={start} onChange={e => { setStart(e.target.value); edit(); }} /><small>This is a membership term date, not a payment-start instruction. Leaving it blank does not invent a default date.</small></label>
        <button type="button" disabled={plan.currency !== currency} onClick={prepareReview}>Review membership DRAFT</button></>}
    </fieldset>}
    {review && <div className={styles.review}><h4>Review membership DRAFT</h4><MembershipPlanTerms plan={review.plan} programName={review.plan.programName}/>
      <p>Term starts: {review.input.termStartedAt ?? 'Not set'}<br/>Term ends: {review.input.termStartedAt && review.plan.termKind === 'FIXED_MONTHS' ? `${membershipPlanFixedTermEnd(review.input.termStartedAt, review.plan.termMonths!)} (preview; HON verifies the actual end)` : 'Not set'}</p>
      <p>This records a DRAFT from the reviewed plan version. It does not activate membership, sign an agreement, create an invoice or collect payment.</p>
      <label className={styles.check}><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{childName === undefined ? 'I reviewed this plan version and confirm this adult’s membership DRAFT.' : `I reviewed this plan version and confirm the membership DRAFT for ${childName}.`}</label>
      <div className={styles.actions}><button type="button" disabled={locked || !confirmed} onClick={publish}>Create DRAFT from selected plan</button><button type="button" disabled={locked} onClick={edit}>Change selection</button></div>
    </div>}
    {pending && <div className={styles.notice}><p>The action may already have completed. Only the exact saved request can be retried.</p><div className={styles.actions}>
      <button type="button" disabled={busy || disabled} onClick={() => void send(pending)}>Retry exact DRAFT request</button>
      <button type="button" disabled={busy || disabled} onClick={() => { setPending(null); setPlans(null); setSelected(''); setReview(null); setConfirmed(false); onBlocking(false); onNeedsRefresh('Local retry discarded. This does not undo a DRAFT. Verify membership readiness again, or close setup and use Resume setup.'); }}>Discard local DRAFT retry</button></div></div>}
  </section>;
}
