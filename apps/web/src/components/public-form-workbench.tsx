'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_OPTIONAL_FIELDS, type StaffLeadForm, type PublicFormOptionalField } from '@hon/contracts';
import { formStaffRequest, FormUiError } from './public-form-client';
import styles from './campaign-workbench.module.css';
export { formStaffRequest } from './public-form-client';
const base = '/api/v1/marketing/forms';
export function PublicFormWorkbench() {
  const [forms, setForms] = useState<StaffLeadForm[]>([]), [selected, setSelected] = useState<StaffLeadForm | null>(null);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [pipelineId, setPipeline] = useState(''), [stageId, setStage] = useState(''), [campaignId, setCampaign] = useState('');
  const [optional, setOptional] = useState<PublicFormOptionalField[]>([]), [busy, setBusy] = useState(false), [current, setCurrent] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const retry = useRef<{ fingerprint: string; key: string; path: string; input: object } | null>(null);
  const gate = useRef(false);
  function show(f: StaffLeadForm | null) { setSelected(f); setTitle(f?.title ?? ''); setDescription(f?.description ?? ''); setPipeline(f?.pipelineId ?? ''); setStage(f?.pipelineStageId ?? ''); setCampaign(f?.campaignId ?? ''); setOptional(f?.optionalFields ?? []); }
  function invalidate() { setForms([]); show(null); setCurrent(false); }
  async function run(work: () => Promise<void>) {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (e) { invalidate(); if (e instanceof FormUiError && e.denied) retry.current = null; setError(e instanceof Error ? e.message : 'Unavailable. No success confirmed.'); }
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
    setNotice(receipt.replayed ? 'Unchanged command replay confirmed. Saved response is historical; refreshing current authority.' : 'Human command recorded. Refreshing current authority.');
    try {
      await refresh(receipt.form.id);
      setNotice('Current authorized form list refreshed. No downstream execution occurred.');
    } catch (e) {
      invalidate();
      setNotice('Command receipt confirmed, but current state is unavailable. Reload authorized forms before further changes.');
      if (e instanceof FormUiError && e.denied) throw e;
    }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (!current) return;
    void run(() => mutate(selected ? `${base}/${selected.id}/configuration` : base, { expectedVersion: selected?.version ?? 0, title, description, pipelineId, pipelineStageId: stageId, campaignId: campaignId || null, optionalFields: optional }));
  }
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/marketing/campaigns">Campaign plans</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN SCHOOL MARKETING / PUBLIC INTAKE</p><h1>Published lead forms</h1><p>Essential, Core and Complete. Your verified session determines one exact authorized school.</p></header>
    <aside><strong>Intake only, not messaging permission.</strong> Each valid new enquiry creates a new CRM lead; exact bounded retries are deduplicated. Never merges a matching contact, opts in to communication, sends a message, spends, invokes AI or executes payments/actions. Disable before changing a published form. Only vetted optional choices are available; this is not a website builder.</aside>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {!current && <p role="status">No current form state is verified. Mutation controls are disabled until a fresh authorized read succeeds.</p>}
    {retry.current && <button disabled={busy} onClick={() => { const pending = retry.current; if (pending) void run(() => mutate(pending.path, pending.input)); }}>Retry unchanged command</button>}
    <section><h2>Authorized forms and safe counts</h2><button disabled={busy} onClick={() => void run(() => refresh())}>Load authorized school forms</button>
      <p>Exact marketing.form.read is required. Counts are accepted new leads, not raw receipts, messages or conversions. A replay receipt is historical, not current state.</p>
      <ul>{forms.map(f => <li key={f.id}><button disabled={busy || !current} onClick={() => show(f)}>{f.title} · {f.status} · v{f.version} · {f.acceptedCount} accepted leads</button></li>)}</ul>
      <button disabled={busy || !current} onClick={() => show(null)}>New form draft</button>
    </section>
    <section><h2>{selected ? `${selected.status} / v${selected.version}` : 'Configure a draft'}</h2><form onSubmit={save}><fieldset disabled={busy || !current || selected?.status === 'PUBLISHED'}>
      <label>Public title<input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Public description<input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label>Private CRM pipeline ID<input required value={pipelineId} onChange={e => setPipeline(e.target.value)} /></label>
      <label>Private non-terminal stage ID<input required value={stageId} onChange={e => setStage(e.target.value)} /></label>
      <label>Explicit active school campaign ID (optional)<input value={campaignId} onChange={e => setCampaign(e.target.value)} /></label>
      <p>Use existing school pipeline/stage identifiers. Attaching a campaign also requires marketing.campaign.attribute. Paused/inactive campaigns stop intake.</p>
      {PUBLIC_FORM_OPTIONAL_FIELDS.map(k => <label key={k}><input type="checkbox" checked={optional.includes(k)} onChange={e => setOptional(e.target.checked ? [...optional,k] : optional.filter(x => x !== k))} />{k} (vetted choices)</label>)}
      <button type="submit">Save draft configuration</button>
    </fieldset></form>
    {selected && current && <div><button disabled={busy || selected.status === 'PUBLISHED'} onClick={() => void run(() => mutate(`${base}/${selected.id}/publish`, { expectedVersion:selected.version }))}>Publish this form</button><button disabled={busy || selected.status !== 'PUBLISHED'} onClick={() => void run(() => mutate(`${base}/${selected.id}/disable`, { expectedVersion:selected.version }))}>Disable public intake</button>
      <p>Publish and disable require their own exact permissions. Link remains opaque; public access is denied when disabled.</p>{selected.status === 'PUBLISHED' && <a href={`/forms/${selected.publicId}`}>Open published form</a>}</div>}
    </section>
  </main>;
}
