'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateCreateHumanCrmLeadInput, type CrmIntakeStage, type CreateHumanCrmLeadInput } from '@hon/contracts';
import { CrmLeadCreateAccessError, CrmLeadCreateUncertainError, crmLeadCreatePath, prepareCrmLeadCreate, submitCrmLeadCreate, type CrmLeadCreateResult, type PreparedCrmLeadCreate } from './crm-lead-create-http';
import styles from './staff-availability-workbench.module.css';

function trialHref(organizationId: string, schoolId: string, leadId: string): string {
  return `/staff/crm/trials?${new URLSearchParams({ organizationId, schoolId, leadId }).toString()}`;
}

/** Uses only verified bounded stage choices and the canonical create path. Nothing here is scope authority. */
export function CrmLeadCreatePanel({ organizationId, schoolId, intakeStages, intakeStagesMessage, disabled = false, onStarted, onBusy, onAccessLost }: {
  organizationId: string; schoolId: string; intakeStages: readonly CrmIntakeStage[] | null; intakeStagesMessage: string; disabled?: boolean;
  onStarted: () => void; onBusy: (busy: boolean) => void; onAccessLost: () => void;
}): React.ReactElement {
  const [stageId, setStageId] = useState('');
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCrmLeadCreate | null>(null);
  const [result, setResult] = useState<CrmLeadCreateResult | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);

  const selectedStage = intakeStages?.find((stage) => stage.stageId === stageId);
  function edit(change: () => void): void {
    if (active.current || disabled) return;
    epoch.current++; change(); setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setError('');
  }
  function discard(): void {
    edit(() => { setStageId(''); setGivenName(''); setFamilyName(''); setEmail(''); setPhoneE164(''); });
  }
  async function send(request: PreparedCrmLeadCreate): Promise<void> {
    if (active.current || disabled) return;
    const generation = epoch.current;
    active.current = true; setBusy(true); onBusy(true); onStarted(); setAttempted(true); setRetry(null); setResult(null); setError('');
    try {
      const receipt = await submitCrmLeadCreate(request);
      if (generation === epoch.current) setResult(receipt);
    } catch (caught) {
      if (generation !== epoch.current) return;
      if (caught instanceof CrmLeadCreateAccessError) { discardAfterAccessLoss(); onAccessLost(); return; }
      setError(caught instanceof Error ? caught.message : 'No verified creation receipt.');
      if (caught instanceof CrmLeadCreateUncertainError) setRetry(request);
    } finally {
      active.current = false;
      if (generation === epoch.current) { setBusy(false); onBusy(false); }
    }
  }
  function discardAfterAccessLoss(): void {
    epoch.current++; setStageId(''); setGivenName(''); setFamilyName(''); setEmail(''); setPhoneE164('');
    setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setBusy(false); onBusy(false);
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || disabled || attempted || !confirmed || !selectedStage) return;
    try {
      const input: CreateHumanCrmLeadInput = { pipelineId: selectedStage.pipelineId, pipelineStageId: selectedStage.stageId, primaryContact: {
        givenName: givenName.trim(), familyName: familyName.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(phoneE164.trim() ? { phoneE164: phoneE164.trim() } : {}),
      } };
      // Validate all fields before allocating the one key for this explicit submit.
      validateCreateHumanCrmLeadInput(input); crmLeadCreatePath(organizationId, schoolId);
      void send(prepareCrmLeadCreate(organizationId, schoolId, input, crypto.randomUUID()));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid lead-create draft.'); }
  }
  return <section aria-labelledby="crm-lead-create">
    <h2 id="crm-lead-create">Create CRM lead</h2>
    <p>Choose this verified school&apos;s configured intake stage and enter a minimal primary contact. The server independently verifies the current human, exact school, <code>crm.lead.create</code> permission, CRM entitlement and selected non-terminal stage.</p>
    <p>This creates a canonical CRM lead and primary contact only. It does not resolve duplicates, contact anyone, create a task/reminder, record a trial conclusion, enroll a student/family, create membership/payment, consent or attendance, invoke a provider, AI, Action Engine or automation, or establish conversion/revenue facts.</p>
    {!intakeStages && <p role="status">{intakeStagesMessage}</p>}
    {intakeStages && intakeStages.length === 0 && <p role="status">No configured non-terminal CRM intake stage is available for this verified school. A lead cannot be created here until an authorized pipeline manager configures one.</p>}
    {intakeStages && intakeStages.length > 0 && <form onSubmit={submit}><fieldset disabled={busy || disabled}>
      <div className={styles.row}>
        <label>Intake stage<select required autoComplete="off" value={stageId} onChange={e => edit(() => setStageId(e.target.value))}><option value="">Choose a configured intake stage…</option>{intakeStages.map((stage) => <option key={stage.stageId} value={stage.stageId}>{stage.stageName} — {stage.pipelineName}</option>)}</select></label>
        <label>Primary contact given name<input required autoComplete="off" maxLength={120} value={givenName} onChange={e => edit(() => setGivenName(e.target.value))} /></label>
        <label>Primary contact family name<input required autoComplete="off" maxLength={120} value={familyName} onChange={e => edit(() => setFamilyName(e.target.value))} /></label>
        <label>Optional primary contact email<input type="email" autoComplete="off" maxLength={320} value={email} onChange={e => edit(() => setEmail(e.target.value))} /></label>
        <label>Optional primary contact phone (E.164)<input type="tel" autoComplete="off" maxLength={16} value={phoneE164} onChange={e => edit(() => setPhoneE164(e.target.value))} /></label>
      </div>
      <label><input type="checkbox" checked={confirmed} disabled={attempted || !selectedStage} onChange={e => setConfirmed(e.target.checked)} />I explicitly confirm this current-school CRM-only intake draft. This is not duplicate resolution, outreach or enrollment.</label>
      <div className={styles.actions}><button disabled={!confirmed || attempted || !selectedStage}>Confirm create CRM lead</button><button type="button" onClick={discard}>Discard draft / start new lead</button></div>
    </fieldset></form>}
    {busy && <p role="status">Submitting the exact human CRM lead-create command…</p>}
    {error && <p role="alert">{error}</p>}
    {retry && <><p>Only the exact in-memory body/key is retained. Editing or discarding removes this retry; the earlier uncertain command may still have created a lead. Verify through an explicit list load before starting a different command.</p><button disabled={busy || disabled} type="button" onClick={() => void send(retry)}>Retry exact retained lead-create request</button></>}
    {result && <section aria-label="CRM lead creation receipt"><h3>Returned CRM creation receipt</h3><p>A new CRM lead was returned at creation version {result.lead.version} on {result.lead.createdAt}. This receipt does not assert a later lead state, duplicate outcome, contact action, trial result, enrollment, payment, conversion or revenue fact.</p><p>The selected intake stage was returned by the canonical command. No contact details or technical identifiers are shown here.</p><a href={trialHref(organizationId, schoolId, result.lead.id)}>Prepare trial appointment with this untrusted lead selection</a></section>}
    {attempted && <p>The list has not been rewritten or refreshed. Explicitly use Load CRM leads to authorize a fresh list before preparing a separate row/version-bound close. Creation receipts never offer close.</p>}
    <p>Drafts and retries are memory-only and discarded on scope changes, explicit list reload, access loss, navigation, a changed session on server render, or leaving this page&apos;s active view.</p>
  </section>;
}
