'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_CHOICES, type PublishedLeadForm } from '@hon/contracts';
import { loadPublicLeadForm, sendPublicLeadForm } from './public-form-client';
import styles from './campaign-workbench.module.css';
export { sendPublicLeadForm } from './public-form-client';
export function PublishedLeadFormView({ publicId }: { publicId: string }) {
  const [form, setForm] = useState<PublishedLeadForm | null>(null), [state, setState] = useState('Loading form…'), [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string,string>>({ name:'',email:'',mobile:'',interest:'',source:'',website:'' }), [acknowledged, setAck] = useState(false);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const gate = useRef(false), activeId = useRef(publicId);
  activeId.current = publicId;
  useEffect(() => {
    const abort = new AbortController();
    setForm(null); setState('Loading form…'); setValues({ name:'',email:'',mobile:'',interest:'',source:'',website:'' }); setAck(false); retry.current = null;
    void (async () => {
      try {
        const data = await loadPublicLeadForm(publicId, abort.signal);
        if (!abort.signal.aborted) { setForm(data); setState(''); }
      } catch { if (!abort.signal.aborted) { setForm(null); setState('This form is unavailable.'); } }
    })(); return () => abort.abort();
  },[publicId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (gate.current || !form || form.publicId !== publicId) return;
    const input = { ...values, acknowledged }, fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key:crypto.randomUUID() };
    gate.current = true; setBusy(true); const result = await sendPublicLeadForm(publicId,input,retry.current.key); gate.current = false; setBusy(false);
    if (activeId.current !== publicId) return;
    setState(result === 'accepted' ? 'Your enquiry was accepted. No message or marketing subscription has been sent or created.' : result === 'invalid' ? 'The enquiry could not be accepted. Check the fields or try again when this form is available.' : result === 'rate-limited' ? 'Too many enquiries. Please try later.' : 'Acceptance is not confirmed. Retry unchanged to avoid a duplicate.');
  }
  const visible = form?.publicId === publicId ? form : null;
  return <main className={styles.page}><header><p>SCHOOL ENQUIRY</p><h1>{visible?.title ?? 'Lead form'}</h1>{visible && <p>{visible.description}</p>}</header>
    {state && <p role="status">{state}</p>}
    {visible && <form onSubmit={submit}><fieldset disabled={busy}>
      <label>Name<input required autoComplete="name" maxLength={120} value={values.name} onChange={e=>setValues({...values,name:e.target.value})} /></label>
      <label>Email<input type="email" autoComplete="email" maxLength={254} value={values.email} onChange={e=>setValues({...values,email:e.target.value})} /></label>
      <label>Mobile (international + format)<input type="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{6,14}" value={values.mobile} onChange={e=>setValues({...values,mobile:e.target.value})} /></label>
      <p>Provide at least one email or mobile number. This is a new enquiry, not a membership, booking or payment.</p>
      {(['interest','source'] as const).map(k=><label key={k}>{k === 'interest' ? 'Program interest (optional)' : 'How did you hear about us? (optional)'}<input maxLength={80} value={values[k]} onChange={e=>setValues({...values,[k]:e.target.value})} /></label>)}
      {visible.optionalFields.map(k=><label key={k}>{k}<select value={values[k] ?? ''} onChange={e=>{ const next={...values}; if(e.target.value) next[k]=e.target.value; else delete next[k]; setValues(next); }}><option value="">Optional</option>{PUBLIC_FORM_CHOICES[k].map(v=><option key={v} value={v}>{v}</option>)}</select></label>)}
      <div aria-hidden="true" style={{position:'absolute',left:'-10000px'}}><label>Website<input tabIndex={-1} autoComplete="off" value={values.website} onChange={e=>setValues({...values,website:e.target.value})} /></label></div>
      <label><input type="checkbox" checked={acknowledged} onChange={e=>setAck(e.target.checked)} />I understand this enquiry is saved by the school. This acknowledgement is not consent to marketing messages.</label>
      <button type="submit">{busy ? 'Submitting…' : 'Submit enquiry'}</button>
    </fieldset></form>}
  </main>;
}
