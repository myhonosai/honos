'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateCreateHumanCrmLeadInput, type CreateHumanCrmLeadInput } from '@hon/contracts';
import { CrmLeadCreateAccessError, CrmLeadCreateUncertainError, crmLeadCreatePath, prepareCrmLeadCreate, submitCrmLeadCreate, type CrmLeadCreateResult, type PreparedCrmLeadCreate } from './crm-lead-create-http';
import styles from './staff-availability-workbench.module.css';

/** Uses only the canonical create path. Scope entries and drafts never confer authority. */
export function CrmLeadCreatePanel({ organizationId, schoolId, disabled = false, onStarted, onBusy, onAccessLost }: {
  organizationId: string; schoolId: string; disabled?: boolean;
  onStarted: () => void; onBusy: (busy: boolean) => void; onAccessLost: () => void;
}): React.ReactElement {
  const [pipelineId, setPipelineId] = useState('');
  const [pipelineStageId, setPipelineStageId] = useState('');
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

  function edit(change: () => void): void {
    if (active.current || disabled) return;
    epoch.current++; change(); setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setError('');
  }
  function discard(): void {
    edit(() => { setPipelineId(''); setPipelineStageId(''); setGivenName(''); setFamilyName(''); setEmail(''); setPhoneE164(''); });
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
    epoch.current++; setPipelineId(''); setPipelineStageId(''); setGivenName(''); setFamilyName(''); setEmail(''); setPhoneE164('');
    setConfirmed(false); setAttempted(false); setRetry(null); setResult(null); setBusy(false); onBusy(false);
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || disabled || attempted || !confirmed) return;
    try {
      const input: CreateHumanCrmLeadInput = { pipelineId: pipelineId.trim(), pipelineStageId: pipelineStageId.trim(), primaryContact: {
        givenName: givenName.trim(), familyName: familyName.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(phoneE164.trim() ? { phoneE164: phoneE164.trim() } : {}),
      } };
      // Validate everything before allocating the one key for this explicit submit.
      validateCreateHumanCrmLeadInput(input); crmLeadCreatePath(organizationId, schoolId);
      void send(prepareCrmLeadCreate(organizationId, schoolId, input, crypto.randomUUID()));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid lead-create draft.'); }
  }
  return <section aria-labelledby="crm-lead-create">
    <h2 id="crm-lead-create">Create CRM lead</h2>
    <p>Enter this school’s already-known pipeline and non-terminal stage UUIDs and minimal primary contact. The server independently verifies current <code>crm.lead.create</code> scope, entitlement and stage. No pipeline list, editor, contact directory or duplicate search is provided.</p>
    <p>This creates a canonical CRM lead and primary contact only. It does not resolve duplicates, contact anyone, create a task/reminder, record a trial conclusion, enroll a student/family, create membership/payment, consent or attendance, invoke a provider, AI, Action Engine or automation, or establish conversion/revenue facts.</p>
    <form onSubmit={submit}><fieldset disabled={busy || disabled}>
      <div className={styles.row}>
        <label>Known pipeline UUID<input required autoComplete="off" maxLength={36} value={pipelineId} onChange={e => edit(() => setPipelineId(e.target.value))} /></label>
        <label>Known non-terminal stage UUID<input required autoComplete="off" maxLength={36} value={pipelineStageId} onChange={e => edit(() => setPipelineStageId(e.target.value))} /></label>
        <label>Primary contact given name<input required autoComplete="off" maxLength={120} value={givenName} onChange={e => edit(() => setGivenName(e.target.value))} /></label>
        <label>Primary contact family name<input required autoComplete="off" maxLength={120} value={familyName} onChange={e => edit(() => setFamilyName(e.target.value))} /></label>
        <label>Optional primary contact email<input type="email" autoComplete="off" maxLength={320} value={email} onChange={e => edit(() => setEmail(e.target.value))} /></label>
        <label>Optional primary contact phone (E.164)<input type="tel" autoComplete="off" maxLength={16} value={phoneE164} onChange={e => edit(() => setPhoneE164(e.target.value))} /></label>
      </div>
      <label><input type="checkbox" checked={confirmed} disabled={attempted} onChange={e => setConfirmed(e.target.checked)} />I explicitly confirm this current-school CRM-only intake draft. This is not duplicate resolution, outreach or enrollment.</label>
      <div className={styles.actions}><button disabled={!confirmed || attempted}>Confirm create CRM lead</button><button type="button" onClick={discard}>Discard draft / start new lead</button></div>
    </fieldset></form>
    {busy && <p role="status">Submitting the exact human CRM lead-create command…</p>}
    {error && <p role="alert">{error}</p>}
    {retry && <><p>Only the exact in-memory body/key is retained. Editing or discarding removes this retry; the earlier uncertain command may still have created a lead. Verify through an explicit list load before starting a different command.</p><button disabled={busy || disabled} type="button" onClick={() => void send(retry)}>Retry exact retained lead-create request</button></>}
    {result && <section aria-label="CRM lead creation receipt"><h3>Returned CRM creation receipt</h3><p>Lead <code>{result.lead.id}</code> · returned {result.lead.status} · creation v{result.lead.version} · {result.lead.createdAt} · {result.replayed ? 'replayed creation receipt' : 'recorded creation receipt'}</p><p>Returned stage <code>{result.lead.pipelineStageId}</code> · primary person <code>{result.lead.primaryPersonId}</code>. No contact details or later current lead state are returned by this command.</p></section>}
    {attempted && <p>The list has not been rewritten or refreshed. Explicitly use Load CRM leads to authorize a fresh list before preparing a separate row/version-bound close. Creation receipts never offer close.</p>}
    <p>Drafts and retries are memory-only and discarded on scope changes, explicit list reload, access loss, navigation, a changed session on server render, or leaving this page’s active view.</p>
  </section>;
}
