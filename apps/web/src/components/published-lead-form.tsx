'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_CHOICES, type PublishedLeadForm } from '@hon/contracts';
import { loadPublicLeadForm, sendPublicLeadForm } from './public-form-client';
import styles from './campaign-workbench.module.css';
export { sendPublicLeadForm } from './public-form-client';
/** IC1 (0634) consent wording, version IC1-2026-11-19 (spec docs/architecture/INTAKE_CONTACT_CONSENT.md). */
export const emailConsentWording = (school: string) => `By submitting, you agree that ${school} may email you about your enquiry and classes. You can unsubscribe at any time.`;
export const textConsentWording = (school: string) => `Text me about my enquiry and classes from ${school}. Message and data rates may apply. Message frequency varies. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. (Optional)`;
export function PublishedLeadFormView({ publicId }: { publicId: string }) {
  const [form, setForm] = useState<PublishedLeadForm | null>(null), [state, setState] = useState('Loading form…'), [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string,string>>({ name:'',email:'',mobile:'',interest:'',source:'',website:'' }), [acknowledged, setAck] = useState(false), [textOptIn, setTextOptIn] = useState(false);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const gate = useRef(false), activeId = useRef(publicId);
  activeId.current = publicId;
  useEffect(() => {
    const abort = new AbortController();
    setForm(null); setState('Loading form…'); setValues({ name:'',email:'',mobile:'',interest:'',source:'',website:'' }); setAck(false); setTextOptIn(false); retry.current = null;
    void (async () => {
      try {
        const data = await loadPublicLeadForm(publicId, abort.signal);
        if (!abort.signal.aborted) { setForm(data); setState(''); }
      } catch { if (!abort.signal.aborted) { setForm(null); setState('This form is unavailable.'); } }
    })(); return () => abort.abort();
  },[publicId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (gate.current || !form || form.publicId !== publicId) return;
    // IC1 (0634): the "Text me" tick is the lead's own choice; it is sent only when ticked.
    const input = { ...values, acknowledged, ...(textOptIn ? { textOptIn: true } : {}) }, fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key:crypto.randomUUID() };
    gate.current = true; setBusy(true); const result = await sendPublicLeadForm(publicId,input,retry.current.key); gate.current = false; setBusy(false);
    if (activeId.current !== publicId) return;
    setState(result === 'accepted' ? 'Your enquiry was accepted. The school will be in touch.' : result === 'invalid' ? 'The enquiry could not be accepted. Check the fields or try again when this form is available.' : result === 'rate-limited' ? 'Too many enquiries. Please try later.' : 'Acceptance is not confirmed. Retry unchanged to avoid a duplicate.');
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
      <label><input type="checkbox" checked={acknowledged} onChange={e=>setAck(e.target.checked)} />I understand this enquiry is saved by the school.</label>
      <label><input type="checkbox" name="text-opt-in" checked={textOptIn} onChange={e=>setTextOptIn(e.target.checked)} />{textConsentWording(visible.schoolName)}</label>
      <p>{emailConsentWording(visible.schoolName)}</p>
      <button type="submit">{busy ? 'Submitting…' : 'Submit enquiry'}</button>
    </fieldset></form>}
  </main>;
}
