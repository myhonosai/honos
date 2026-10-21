'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CRM_LEAD_REGISTRATION_CONFIRMATION, CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION,
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION, CRM_GUARDIAN_CHILD_MAX_CHILDREN,
  type LeadListItem, type CrmGuardianChildEnrollment, type CrmGuardianChildMembershipDraftFromPlan,
} from '@hon/contracts';
import { familyRequest, readFamilyEnrollment, sendFamilyRequest, type FamilyRequest } from './crm-family-http';
import { PlanAccessError, PlanUnknownError, type PlanScope } from './membership-plans/http';
import { AdultMembershipPlanPicker } from './membership-plans/picker';
import { MembershipPlanTerms } from './membership-plans/terms';
import styles from './crm-family-flow.module.css';

const childStatus = { AWAITING_PAYER_DESIGNATION: 'Awaiting guardian payer designation', READY_FOR_DRAFT: 'Ready to choose a plan', CURRENT_DRAFT: 'Current DRAFT verified', CURRENT_DRAFT_BY_OTHER_STAFF: 'Current DRAFT recorded by other staff', NEEDS_STAFF_REVIEW: 'Staff review required' };
type History = { childName: string; draft: CrmGuardianChildMembershipDraftFromPlan };
export function CrmFamilyFlow({ scope, row, initialFamily, onCancel, onBusy, onStarted, onAccessLost, onAdult }: {
  scope: PlanScope; row: LeadListItem; initialFamily: CrmGuardianChildEnrollment; onCancel(): void; onBusy(busy: boolean): void;
  onStarted(): void; onAccessLost(): void; onAdult(): void;
}): React.ReactElement {
  const [family, setFamily] = useState<CrmGuardianChildEnrollment | null>(initialFamily), [selected, setSelected] = useState('');
  const [given, setGiven] = useState(''), [surname, setSurname] = useState(''), [birth, setBirth] = useState(''), [currency, setCurrency] = useState('USD');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [pickerBlocked, setPickerBlocked] = useState(false);
  const [pending, setPending] = useState<FamilyRequest | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const active = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); return () => { epoch.current++; abort.current?.abort(); active.current = false; }; }, [scope.organizationId, scope.schoolId, row.id]);
  const verified = family && 'children' in family ? family : null;
  const child = verified?.children.find(c => c.studentProfileId === selected);
  const locked = busy || pickerBlocked || pending !== null;
  async function fresh(): Promise<void> {
    const generation = epoch.current;
    setFamily(null); setSelected(''); setConfirmed(false);
    const controller = new AbortController(); abort.current = controller;
    const data = await readFamilyEnrollment(scope, row.id, row.primaryPersonId, controller.signal);
    if (generation === epoch.current) setFamily(data);
  }
  async function refresh(): Promise<void> {
    if (active.current || pickerBlocked || pending) return;
    const generation = epoch.current; active.current = true; setBusy(true); onBusy(true); setError(''); setHistory(null);
    try { await fresh(); }
    catch (e) { if (generation !== epoch.current) return; if (e instanceof PlanAccessError) onAccessLost(); else setError(e instanceof Error ? e.message : 'Family setup is unavailable.'); }
    finally { if (generation === epoch.current) { active.current = false; setBusy(false); onBusy(false); } }
  }
  async function run(request: FamilyRequest): Promise<void> {
    if (active.current || pickerBlocked || pending && pending !== request) return;
    const generation = epoch.current; active.current = true; setBusy(true); onBusy(true); onStarted(); setError(''); setMessage(''); setHistory(null);
    let retained = false;
    try {
      const result = await sendFamilyRequest(request);
      if (generation !== epoch.current) return;
      setPending(null); setConfirmed(false); setGiven(''); setSurname(''); setBirth('');
      if (result.step === 'register') {
        if (result.registration.outcome === 'NEEDS_STAFF_REVIEW') { setFamily({ leadId: row.id, workflowState: 'NEEDS_STAFF_REVIEW' }); setMessage('Possible existing records require staff review. Nothing was registered.'); return; }
        if (result.registration.sourceContactPersonId !== row.primaryPersonId.toLowerCase()) throw new PlanUnknownError('Registration identity could not be matched. Retain the exact request for retry.');
        setMessage(result.replayed ? 'Historical family registration receipt replayed. Current progress is checked separately.' : 'Guardian and first child registered as separate identities.');
      } else if (result.step === 'account') setMessage(result.replayed ? 'Historical canonical account receipt replayed.' : result.account.reused ? 'Existing canonical guardian account reused.' : 'Canonical guardian account created. Payer designation still requires confirmation.');
      else if (result.step === 'payer') setMessage(result.replayed ? 'Historical payer designation replayed.' : 'Guardian payer designation recorded. Each child still needs an individual membership DRAFT.');
      else if (result.step === 'child') setMessage(result.child.outcome === 'NEEDS_STAFF_REVIEW' ? 'Possible duplicate identity or twins: no child was created or merged. Authorized staff review is required; no resolution tool is available here.' : result.replayed ? 'Historical child-addition receipt replayed.' : 'Child added as a separate student profile.');
      // A verified command receipt never advances local workflow state. Re-read current authority and records.
      await fresh();
    } catch (e) {
      if (generation !== epoch.current) return;
      if (e instanceof PlanAccessError) { onAccessLost(); return; }
      if (e instanceof PlanUnknownError) { retained = true; setPending(request); }
      else { setPending(null); setFamily(null); setSelected(''); setConfirmed(false); }
      setError(e instanceof Error ? e.message : 'The result could not be verified.');
    } finally { if (generation === epoch.current) { active.current = false; setBusy(false); onBusy(retained); } }
  }
  function submit(event: FormEvent): void {
    event.preventDefault(); if (active.current || locked || !confirmed || !family) return;
    try {
      const fields = { childGivenName: given, childFamilyName: surname, childBirthDate: birth };
      const step = family.workflowState === 'NOT_REGISTERED' ? 'register' : family.workflowState === 'BILLING_ACCOUNT_REQUIRED' ? 'account' : family.workflowState === 'PAYER_DESIGNATION_REQUIRED' ? 'payer' : family.workflowState === 'PAYER_DESIGNATED' ? 'child' : null;
      if (!step || step === 'child' && verified!.children.length >= CRM_GUARDIAN_CHILD_MAX_CHILDREN) return;
      const selection = step === 'account' ? verified!.historicalRegistrationReceipt.sourceContactPersonId : row.id;
      const body = step === 'register' ? { ...fields, registrationPath: 'GUARDIAN_CHILD', confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION }
        : step === 'account' ? { currency } : step === 'payer' ? { confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION } : { ...fields, confirmation: CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION };
      familyRequest(scope, step, selection, body, '00000000-0000-4000-8000-000000000001');
      void run(familyRequest(scope, step, selection, body, crypto.randomUUID()));
    } catch { setError('Review the child’s name, valid date of birth, account currency and explicit confirmation.'); }
  }
  const edit = (): void => { setConfirmed(false); setError(''); };
  return <section className={styles.flow} aria-labelledby="family-flow-title" aria-busy={busy}>
    <header><p>FAMILY ENROLLMENT</p><h2 id="family-flow-title" tabIndex={-1} ref={heading}>Family setup for {row.givenName} {row.familyName}</h2><p>Register family → confirm guardian payer → prepare each child’s membership DRAFT</p>
      <div className={styles.actions}><button type="button" disabled={locked} onClick={() => void refresh()}>Refresh family setup</button><button type="button" disabled={locked} onClick={onCancel}>Close family setup</button></div></header>
    <p>These are school student memberships. A DRAFT is not active and creates no agreement, payment schedule, invoice or payment.</p>
    {busy && <p role="status">Verifying the current authorized family records…</p>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {pending && <div className={styles.notice}><p>An action may already have completed. This in-memory retry preserves its exact input and idempotency key.</p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run(pending)}>Retry exact family request</button><button type="button" disabled={busy} onClick={() => { setPending(null); setFamily(null); setSelected(''); setConfirmed(false); onBusy(false); setError('Local retry discarded. This does not undo any recorded action. Refresh family setup before continuing.'); }}>Discard local retry</button></div></div>}
    {!family && !busy && !pending && <p role="status">Current family progress is unavailable. Refresh family setup before any new action.</p>}
    {family?.workflowState === 'NEEDS_STAFF_REVIEW' && <div className={styles.notice}><h3>Staff review required</h3><p>This family cannot continue safely here. Possible existing identities, twins, changed relationships or an older registration require an authorized review. Existing records are preserved. No merge, relinking or resolution action is available.</p></div>}
    {family?.workflowState === 'ADULT_REGISTRATION' && <div className={styles.notice}><p>This is an adult registration. Continue through the existing adult Resume Setup workflow.</p><button type="button" disabled={locked} onClick={onAdult}>Open adult Resume Setup</button></div>}
    {verified && <><section aria-labelledby="guardian-overview"><h3 id="guardian-overview">Guardian &amp; family</h3><p><strong>{verified.guardian.displayName}</strong> · verified guardian for {verified.children.length} {verified.children.length === 1 ? 'child' : 'children'}</p><p>Guardian and children have separate identities. Historical registration is not evidence of current membership.</p>
      <p>{verified.billingAccount ? `Canonical guardian billing account verified · ${verified.billingAccount.currency}` : 'No canonical guardian billing account is available.'}</p>
      <p>{verified.payerDesignation ? `Guardian payer designation verified · ${verified.payerDesignation.currency}` : 'Payer responsibility has not been designated. Contact information alone does not establish a payer.'}</p></section>
      <section aria-labelledby="family-children-title"><h3 id="family-children-title">Children · {verified.children.length} / {CRM_GUARDIAN_CHILD_MAX_CHILDREN}</h3><div className={styles.children}>{verified.children.map(c => <button type="button" key={c.studentProfileId} disabled={locked} aria-pressed={selected === c.studentProfileId} onClick={() => { setSelected(c.studentProfileId); setHistory(null); setError(''); }}><strong>{c.displayName}</strong><span>{c.origin === 'CRM_REGISTRATION' ? 'First registered child' : 'Additional child'}</span><span>{childStatus[c.workflowState]}</span></button>)}</div></section>
    </>}
    {child && <section className={styles.child} aria-labelledby="selected-child-title"><h3 id="selected-child-title">Membership for {child.displayName}</h3><p role="status">{childStatus[child.workflowState]}</p>
      {child.workflowState === 'NEEDS_STAFF_REVIEW' && <p>This child requires authorized staff review. No replacement membership or automatic identity merge is available.</p>}
      {child.workflowState === 'AWAITING_PAYER_DESIGNATION' && <p>Complete the guardian payer step before choosing this child’s plan.</p>}
      {child.workflowState === 'CURRENT_DRAFT_BY_OTHER_STAFF' && <p>A current DRAFT exists, recorded by another staff member. Receipt, creator, confirmation, editing, transfer and activation controls are unavailable.</p>}
      {child.workflowState === 'CURRENT_DRAFT' && child.currentMembershipDraft && 'receipt' in child.currentMembershipDraft && <><h4>Verified current DRAFT</h4><p>Recorded {child.currentMembershipDraft.receipt.recordedAt}. Original bound plan version; subsequent catalog changes do not replace these terms.</p><MembershipPlanTerms plan={child.currentMembershipDraft.plan}/></>}
      {child.workflowState === 'READY_FOR_DRAFT' && verified?.workflowState === 'PAYER_DESIGNATED' && verified.billingAccount && <AdultMembershipPlanPicker key={child.studentProfileId} scope={scope} studentProfileId={child.studentProfileId} childName={child.displayName} currency={verified.billingAccount.currency} disabled={busy || pending !== null}
        onBlocking={blocked => { setPickerBlocked(blocked); onBusy(blocked); }} onStarted={onStarted} onAccessLost={onAccessLost}
        onNeedsRefresh={reason => { setPickerBlocked(false); setFamily(null); setSelected(''); onBusy(false); setError(reason); }}
        onCreated={(draft, replayed) => { setPickerBlocked(false); onBusy(false); setFamily(null); setSelected(''); setHistory({ childName: child.displayName, draft }); setMessage(replayed ? 'Historical child DRAFT receipt replayed. Refresh family setup to verify current status.' : 'Child membership DRAFT recorded. Refresh family setup to verify its current status.'); }} />}
    </section>}
    {history && <section className={styles.notice}><h3>Historical DRAFT creation receipt for {history.childName}</h3><p>{history.draft.receipt.planCode} · Recorded {history.draft.receipt.recordedAt}. This receipt does not confirm current membership state or activation.</p><MembershipPlanTerms plan={history.draft.plan}/></section>}
    {family && ['NOT_REGISTERED', 'BILLING_ACCOUNT_REQUIRED', 'PAYER_DESIGNATION_REQUIRED', 'PAYER_DESIGNATED'].includes(family.workflowState) && <form onSubmit={submit}><fieldset disabled={locked}>
      {family.workflowState === 'NOT_REGISTERED' && <><h3>1. Register guardian and first child</h3><p>The selected lead’s verified contact, {row.givenName} {row.familyName}, will be registered as guardian. This does not designate a payer.</p></>}
      {family.workflowState === 'BILLING_ACCOUNT_REQUIRED' && <><h3>2. Create or reuse the guardian’s canonical account</h3><p>Only the guardian returned by the authorized family read is used. Another payer cannot be selected.</p><label>Guardian account currency<input required pattern="[A-Z]{3}" maxLength={3} value={currency} onChange={e => { setCurrency(e.target.value.toUpperCase()); edit(); }}/></label></>}
      {family.workflowState === 'PAYER_DESIGNATION_REQUIRED' && <><h3>3. Confirm guardian payer</h3><p>{verified!.guardian.displayName} will be the billing contact for every child in this family, through the verified canonical {verified!.billingAccount!.currency} account.</p></>}
      {family.workflowState === 'PAYER_DESIGNATED' && <><h3>Add another child</h3><p>Up to 10 children total, including the first registered child. Possible duplicates and twins require staff review.</p></>}
      {family.workflowState === 'PAYER_DESIGNATED' && verified!.children.length >= CRM_GUARDIAN_CHILD_MAX_CHILDREN ? <p role="status">The family has the maximum of 10 children. No additional child can be created here.</p> : <>
        {['NOT_REGISTERED', 'PAYER_DESIGNATED'].includes(family.workflowState) && <div className={styles.fields}><label>Child given name<input required maxLength={100} autoComplete="off" value={given} onChange={e => { setGiven(e.target.value); edit(); }}/></label><label>Child family name<input required maxLength={100} autoComplete="off" value={surname} onChange={e => { setSurname(e.target.value); edit(); }}/></label><label>Child date of birth<input type="date" required min="1900-01-01" max={new Date().toISOString().slice(0, 10)} value={birth} onChange={e => { setBirth(e.target.value); edit(); }}/></label></div>}
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{family.workflowState === 'NOT_REGISTERED' ? 'I reviewed this lead as the guardian and confirm registering the separate child shown.' : family.workflowState === 'BILLING_ACCOUNT_REQUIRED' ? 'I confirm creating or reusing this guardian’s canonical account in the currency shown.' : family.workflowState === 'PAYER_DESIGNATION_REQUIRED' ? `I explicitly confirm ${verified!.guardian.displayName} as payer for every child in this family.` : 'I reviewed this additional child’s identity and confirm adding a separate student profile.'}</label>
        <button disabled={!confirmed}>{family.workflowState === 'NOT_REGISTERED' ? 'Register family' : family.workflowState === 'BILLING_ACCOUNT_REQUIRED' ? 'Create or reuse guardian account' : family.workflowState === 'PAYER_DESIGNATION_REQUIRED' ? 'Designate guardian payer' : 'Add child'}</button>
      </>}
    </fieldset></form>}
  </section>;
}
