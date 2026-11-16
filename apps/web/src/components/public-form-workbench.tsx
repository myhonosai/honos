'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_OPTIONAL_FIELDS, type CampaignReadSummary, type StaffLeadForm, type PublicFormOptionalField } from '@hon/contracts';
import { formStaffRequest, FormUiError } from './public-form-client';
import { campaignRequest } from './campaign-workbench';
import { addLeadApi, openStageChoices, type StageChoice } from './leads/add-lead-http';
import { IdFields } from './school-pickers/pickers';
import { useShellSchool } from './school-shell/page-school';
import styles from './campaign-workbench.module.css';
export { formStaffRequest } from './public-form-client';
const base = '/api/v1/marketing/forms';
const FIELD_LABEL: Record<PublicFormOptionalField, string> = { ageBand: 'Age group', experience: 'Experience', preferredTime: 'Preferred class time' };
const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Live', DISABLED: 'Turned off' };
/** Plain words for the person; the server's own error text is never shown. */
export function formProblem(error: unknown): string {
  if (error instanceof FormUiError && error.sessionInvalid) return 'Your sign-in has ended. Sign in again.';
  if (error instanceof FormUiError && error.denied) return "You don't have permission to manage lead forms at this school.";
  if (error instanceof Error && error.message.startsWith('Version')) return 'This form changed since you opened it. Refresh and try again.';
  return "We couldn't confirm that. Try again.";
}
/** Selectors only: the server checks the stage and campaign belong to the signed-in school before saving. */
type Lists = { stages: readonly StageChoice[] | null; campaigns: readonly CampaignReadSummary[] | null };
export function PublicFormWorkbench() {
  const [forms, setForms] = useState<StaffLeadForm[]>([]), [selected, setSelected] = useState<StaffLeadForm | null>(null);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [pipelineId, setPipeline] = useState(''), [stageId, setStage] = useState(''), [campaignId, setCampaign] = useState('');
  const [optional, setOptional] = useState<PublicFormOptionalField[]>([]), [busy, setBusy] = useState(false), [current, setCurrent] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const retry = useRef<{ fingerprint: string; key: string; path: string; input: object } | null>(null);
  const gate = useRef(false);
  const school = useShellSchool();
  const [lists, setLists] = useState<Lists>({ stages: null, campaigns: null });
  useEffect(() => { void run(() => refresh()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!school) return;
    const abort = new AbortController();
    let live = true;
    addLeadApi.pipelines(school, abort.signal, () => live).then(items => { if (live) setLists(l => ({ ...l, stages: openStageChoices(items) })); }, () => { if (live) setLists(l => ({ ...l, stages: null })); });
    campaignRequest<CampaignReadSummary[]>('/api/v1/marketing/campaigns').then(items => { if (live && Array.isArray(items)) setLists(l => ({ ...l, campaigns: items.filter(c => c.status === 'ACTIVE') })); }, () => { if (live) setLists(l => ({ ...l, campaigns: null })); });
    return () => { live = false; abort.abort(); };
  }, [school?.organizationId, school?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  function show(f: StaffLeadForm | null) { setSelected(f); setTitle(f?.title ?? ''); setDescription(f?.description ?? ''); setPipeline(f?.pipelineId ?? ''); setStage(f?.pipelineStageId ?? ''); setCampaign(f?.campaignId ?? ''); setOptional(f?.optionalFields ?? []); }
  function invalidate() { setForms([]); show(null); setCurrent(false); }
  async function run(work: () => Promise<void>) {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (e) { invalidate(); if (e instanceof FormUiError && e.denied) retry.current = null; setError(formProblem(e)); }
    finally { gate.current = false; setBusy(false); }
  }
  async function refresh(selectId?: string) {
    invalidate();
    const list = await formStaffRequest(base);
    setForms(list); setCurrent(true); show(selectId ? list.find(f => f.id === selectId) ?? null : null);
  }
  async function mutate(path: string, input: object) {
    const fingerprint = JSON.stringify({ path, input });
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID(), path, input };
    invalidate();
    const receipt = await formStaffRequest(path, input, retry.current.key);
    retry.current = null;
    // Even a successful replay returns a saved historical snapshot, NEVER editable current state.
    // The list is always read fresh after a save; a replayed answer is never shown as the current form.
    setNotice(receipt.replayed ? 'This was already saved. Refreshing the list.' : 'Saved. Refreshing the list.');
    try {
      await refresh(receipt.form.id);
      setNotice('Saved.');
    } catch (e) {
      invalidate();
      setNotice('Saved, but the list could not be refreshed. Refresh before making more changes.');
      if (e instanceof FormUiError && e.denied) throw e;
    }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (!current) return;
    void run(() => mutate(selected ? `${base}/${selected.id}/configuration` : base, { expectedVersion: selected?.version ?? 0, title, description, pipelineId, pipelineStageId: stageId, campaignId: campaignId || null, optionalFields: optional }));
  }
  const stages = lists.stages, campaigns = lists.campaigns;
  const stageValue = pipelineId && stageId ? `${pipelineId}:${stageId}` : '';
  const knownStage = stages?.some(c => `${c.pipelineId}:${c.stageId}` === stageValue) ?? false;
  const knownCampaign = !campaignId || (campaigns?.some(c => c.id === campaignId) ?? false);
  const manual = !school || stages === null;
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/marketing/campaigns">Campaigns</a></nav>
    <header><p>Marketing</p><h1>Lead forms</h1><p>Publish a form for your website. Each new enquiry becomes a lead.</p></header>
    <aside data-plain-note=""><strong>A form enquiry does not give permission to send marketing messages.</strong></aside>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {!current && <p role="status">This list is out of date. Refresh to make changes.</p>}
    {retry.current && <button disabled={busy} onClick={() => { const pending = retry.current; if (pending) void run(() => mutate(pending.path, pending.input)); }}>Try again</button>}
    <section><h2>Your forms</h2><button disabled={busy} onClick={() => void run(() => refresh())}>Refresh</button>
      <p>The count is new leads each form has added.</p>
      <ul>{forms.map(f => <li key={f.id}><button disabled={busy || !current} onClick={() => show(f)}>{f.title} · {STATUS_LABEL[f.status] ?? f.status} · {f.acceptedCount} new leads</button></li>)}</ul>
      <button disabled={busy || !current} onClick={() => show(null)}>New form</button>
    </section>
    <section><h2>{selected ? `${selected.title} (${STATUS_LABEL[selected.status] ?? selected.status})` : 'New form'}</h2><form onSubmit={save}><fieldset disabled={busy || !current || selected?.status === 'PUBLISHED'}>
      <label>Title people see<input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Description people see<input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {stages && <label>New leads start in<select required value={stageValue} onChange={e => { const c = stages.find(x => `${x.pipelineId}:${x.stageId}` === e.target.value); setPipeline(c?.pipelineId ?? ''); setStage(c?.stageId ?? ''); }}>
        <option value="">Choose a stage</option>
        {stageValue && !knownStage && <option value={stageValue}>Current stage (no longer open)</option>}
        {stages.map(c => <option key={`${c.pipelineId}:${c.stageId}`} value={`${c.pipelineId}:${c.stageId}`}>{c.label}</option>)}
      </select></label>}
      {stages?.length === 0 && <p>Your school has no open lead stages yet. Add your first lead on the Leads page to set them up.</p>}
      {campaigns && <label>Campaign (optional)<select value={campaignId} onChange={e => setCampaign(e.target.value)}>
        <option value="">No campaign</option>
        {!knownCampaign && <option value={campaignId}>Current campaign (not active)</option>}
        {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>}
      <IdFields manual={manual}>
        <label>Pipeline record ID<input required={manual} value={pipelineId} onChange={e => setPipeline(e.target.value)} /></label>
        <label>Stage record ID<input required={manual} value={stageId} onChange={e => setStage(e.target.value)} /></label>
        <label>Campaign record ID (optional)<input value={campaignId} onChange={e => setCampaign(e.target.value)} /></label>
      </IdFields>
      <p>A paused campaign stops the form taking enquiries.</p>
      <fieldset><legend>Extra questions</legend>{PUBLIC_FORM_OPTIONAL_FIELDS.map(k => <label key={k}><input type="checkbox" checked={optional.includes(k)} onChange={e => setOptional(e.target.checked ? [...optional,k] : optional.filter(x => x !== k))} />{FIELD_LABEL[k]}</label>)}</fieldset>
      <button type="submit">Save draft</button>
    </fieldset></form>
    {selected && current && <div><button disabled={busy || selected.status === 'PUBLISHED'} onClick={() => void run(() => mutate(`${base}/${selected.id}/publish`, { expectedVersion:selected.version }))}>Publish this form</button><button disabled={busy || selected.status !== 'PUBLISHED'} onClick={() => void run(() => mutate(`${base}/${selected.id}/disable`, { expectedVersion:selected.version }))}>Turn off this form</button>
      {selected.status === 'PUBLISHED' && <a href={`/forms/${selected.publicId}`}>Open published form</a>}</div>}
    </section>
  </main>;
}
