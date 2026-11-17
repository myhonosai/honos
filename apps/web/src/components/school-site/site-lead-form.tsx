'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_CHOICES, type PublishedLeadForm } from '@hon/contracts';
import { loadPublicLeadForm, sendPublicLeadForm } from '../public-form-client';
import { siteSourceNote } from './site-links';
import styles from './school-site.module.css';

const CHOICE_LABELS: Record<string, Record<string, string>> = {
  ageBand: { CHILD: 'Child', TEEN: 'Teen', ADULT: 'Adult' },
  experience: { NEW: 'New to martial arts', SOME: 'Some experience', EXPERIENCED: 'Experienced' },
  preferredTime: { MORNING: 'Mornings', AFTERNOON: 'Afternoons', EVENING: 'Evenings', WEEKEND: 'Weekends' },
};
const FIELD_LABELS: Record<string, string> = { ageBand: 'Who is it for?', experience: 'Experience', preferredTime: 'Best time' };
const EMPTY = { name: '', email: '', mobile: '', interest: '', website: '' };

/**
 * WB3: the school's own published lead form (0075) inside its website. Submissions go to the unchanged public form intake,
 * which creates the CRM lead with the form's campaign attribution; the page's UTM tags travel only as the 80-character
 * source note. In the owner's preview nothing is loaded or sent.
 */
export function SiteLeadForm({ publicFormId, pageSlug, preview }: { publicFormId: string; pageSlug: string; preview: boolean }) {
  const [form, setForm] = useState<PublishedLeadForm | null>(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(EMPTY), [acknowledged, setAck] = useState(false);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null), gate = useRef(false);
  useEffect(() => {
    if (preview || !/^[a-f0-9]{48}$/.test(publicFormId)) return;
    const abort = new AbortController();
    void loadPublicLeadForm(publicFormId, abort.signal).then(data => { if (!abort.signal.aborted) setForm(data); },
      () => { if (!abort.signal.aborted) setStatus('This form is not available right now.'); });
    return () => abort.abort();
  }, [publicFormId, preview]);
  if (preview) return <p className={styles.note} data-preview-form="true">Your published enquiry form appears here on the live site.</p>;
  if (done) return <p role="status" className={styles.thanks}>Thank you. The school has your details and will be in touch.</p>;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (gate.current || !form) return;
    const source = siteSourceNote(typeof window === 'undefined' ? '' : window.location.search, pageSlug);
    const input = { ...values, source, acknowledged }, fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    gate.current = true; setBusy(true);
    const result = await sendPublicLeadForm(publicFormId, input, retry.current.key);
    gate.current = false; setBusy(false);
    if (result === 'accepted') { setDone(true); return; }
    setStatus(result === 'invalid' ? 'Please check your details. Give a name and an email or a mobile number in +1… format.'
      : result === 'rate-limited' ? 'Too many tries. Please try again later.' : 'We could not confirm that was sent. Please press Send again.');
  }
  if (!form) return status ? <p role="status" className={styles.note}>{status}</p> : <p className={styles.note}>Loading the form…</p>;
  return <form className={styles.form} onSubmit={submit}><fieldset disabled={busy}>
    <label>Name<input required autoComplete="name" maxLength={120} value={values.name} onChange={e => setValues({ ...values, name: e.target.value })} /></label>
    <label>Email<input type="email" autoComplete="email" maxLength={254} value={values.email} onChange={e => setValues({ ...values, email: e.target.value })} /></label>
    <label>Mobile<input type="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{6,14}" placeholder="+1…" value={values.mobile} onChange={e => setValues({ ...values, mobile: e.target.value })} /></label>
    <label>What are you interested in? (optional)<input maxLength={80} value={values.interest} onChange={e => setValues({ ...values, interest: e.target.value })} /></label>
    {form.optionalFields.map(k => <label key={k}>{FIELD_LABELS[k] ?? k}<select value={values[k] ?? ''} onChange={e => { const next = { ...values }; if (e.target.value) next[k] = e.target.value; else delete next[k]; setValues(next); }}>
      <option value="">Choose…</option>{PUBLIC_FORM_CHOICES[k].map(c => <option key={c} value={c}>{CHOICE_LABELS[k]?.[c] ?? c}</option>)}</select></label>)}
    <div aria-hidden="true" className={styles.trap}><label>Website<input tabIndex={-1} autoComplete="off" value={values.website} onChange={e => setValues({ ...values, website: e.target.value })} /></label></div>
    <label className={styles.check}><input type="checkbox" checked={acknowledged} onChange={e => setAck(e.target.checked)} />I understand the school will keep these details to reply to me.</label>
    {status && <p role="status" className={styles.note}>{status}</p>}
    <button type="submit" className={styles.button}>{busy ? 'Sending…' : 'Send'}</button>
  </fieldset></form>;
}
