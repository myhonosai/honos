'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateCreateHumanCrmLeadInput, type CreateHumanCrmLeadInput } from '@hon/contracts';
import { CrmLeadCreateAccessError, CrmLeadCreateUncertainError, crmLeadCreatePath, prepareCrmLeadCreate, submitCrmLeadCreate, type CrmLeadCreateResult, type PreparedCrmLeadCreate } from './crm-lead-create-http';
import styles from './staff-availability-workbench.module.css';
import { addLeadApi, openStageChoices, type StageChoice } from './leads/add-lead-http';
import { IdFields } from './school-pickers/pickers';

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
  // The school's open stages by name, read for the school this list already shows; the server re-checks the stage on save.
  const [stages, setStages] = useState<readonly StageChoice[] | null>(null), [stagesFailed, setStagesFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let live = true; setStages(null); setStagesFailed(false);
    addLeadApi.pipelines({ organizationId, schoolId }, controller.signal, () => live)
      .then((items) => { if (!live) return; const choices = openStageChoices(items); setStages(choices); if (choices.length === 1) { setPipelineId(choices[0]!.pipelineId); setPipelineStageId(choices[0]!.stageId); } })
      .catch(() => { if (live) setStagesFailed(true); });
    return () => { live = false; controller.abort(); };
  }, [organizationId, schoolId]);
  const stageKey = pipelineId && pipelineStageId ? `${pipelineId}:${pipelineStageId}` : '';

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
    <h2 id="crm-lead-create">Add a lead</h2>
    <p>Adds the person to your leads list. It does not message them or enroll them.</p>
    <form onSubmit={submit}><fieldset disabled={busy || disabled}>
      <div className={styles.row}>
        {stages && stages.length > 0 && <label>Stage<select required value={stageKey} onChange={e => { const choice = stages.find(c => `${c.pipelineId}:${c.stageId}` === e.target.value); edit(() => { setPipelineId(choice?.pipelineId ?? ''); setPipelineStageId(choice?.stageId ?? ''); }); }}><option value="">Choose a stage</option>{stages.map(c => <option key={`${c.pipelineId}:${c.stageId}`} value={`${c.pipelineId}:${c.stageId}`}>{c.label}</option>)}</select></label>}
        {stages && stages.length === 0 && <p>Your school has no open lead stages yet.</p>}
        {stagesFailed && <p role="status">Stages could not be loaded. Reload the page to try again.</p>}
        <IdFields manual={stagesFailed}><label>Pipeline record ID<input required autoComplete="off" maxLength={36} value={pipelineId} onChange={e => edit(() => setPipelineId(e.target.value))} /></label>
        <label>Stage record ID<input required autoComplete="off" maxLength={36} value={pipelineStageId} onChange={e => edit(() => setPipelineStageId(e.target.value))} /></label></IdFields>
        <label>First name<input required autoComplete="off" maxLength={120} value={givenName} onChange={e => edit(() => setGivenName(e.target.value))} /></label>
        <label>Last name<input required autoComplete="off" maxLength={120} value={familyName} onChange={e => edit(() => setFamilyName(e.target.value))} /></label>
        <label>Email (optional)<input type="email" autoComplete="off" maxLength={320} value={email} onChange={e => edit(() => setEmail(e.target.value))} /></label>
        <label>Phone (optional, like +15551234567)<input type="tel" autoComplete="off" maxLength={16} value={phoneE164} onChange={e => edit(() => setPhoneE164(e.target.value))} /></label>
      </div>
      <label><input type="checkbox" checked={confirmed} disabled={attempted} onChange={e => setConfirmed(e.target.checked)} />These details are correct.</label>
      <div className={styles.actions}><button disabled={!confirmed || attempted}>Add lead</button><button type="button" onClick={discard}>Clear</button></div>
    </fieldset></form>
    {busy && <p role="status">Saving…</p>}
    {error && <p role="alert">{error}</p>}
    {retry && <><p>We couldn’t confirm that save. Try it again before changing anything.</p><button disabled={busy || disabled} type="button" onClick={() => void send(retry)}>Try again</button></>}
    {result && <section aria-label="Lead added"><p role="status">{result.replayed ? 'This lead was already added.' : 'Lead added.'} Refresh the list to see it.</p></section>}
  </section>;
}
