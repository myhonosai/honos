'use client';
import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { PUBLIC_FORM_CHOICES, type PublicFormResult } from '@hon/contracts';
import { publicReferralApi, type PublicReferralApi, type PublicReferralRead } from './http';
import styles from '../campaign-workbench.module.css';

/**
 * 0604 the friend's page at /refer/<code>. No account; the code names no person. It shows the school, the school's offer
 * for the friend and the school's own lead form. Sending it creates a lead at the school, marked as referred by the family
 * who shared the link. Every "not available" reason gives the same answer.
 */
const EMPTY = { name: '', email: '', mobile: '', interest: '', source: '', website: '' };
const OPTIONAL_LABEL: Record<string, string> = { ageBand: 'Age group', experience: 'Experience', preferredTime: 'Preferred class time' };
export const resultText = (r: PublicFormResult): string => r === 'accepted' ? 'Thanks! The school has your details and will be in touch.'
  : r === 'invalid' ? "This couldn't be sent. Check the fields, or the link may no longer be available."
  : r === 'rate-limited' ? 'Too many tries. Please try again later.' : "We couldn't confirm it was sent. Try again without changing anything.";

export type PublicReferralViewProps = Readonly<{
  read: PublicReferralRead | null; values: Readonly<Record<string, string>>; acknowledged: boolean; busy: boolean; status: string; done: boolean;
  onValues?: (v: Record<string, string>) => void; onAck?: (v: boolean) => void; onSubmit?: () => void;
}>;
export function PublicReferralView(p: PublicReferralViewProps): React.ReactElement {
  const r = p.read;
  const shell = (title: string, body: React.ReactNode) => <main className={styles.page} data-testid="public-referral"><header><p>A FRIEND INVITED YOU</p><h1>{title}</h1></header>{body}</main>;
  if (r === null) return shell('Invitation', <p role="status">Loading…</p>);
  if (r === 'GONE' || r === 'UNAVAILABLE') return shell('Invitation', <p role="status" data-kind={r}>This invitation link isn't available right now.</p>);
  const v = p.values, set = (k: string, x: string) => p.onValues?.({ ...v, [k]: x });
  const submit = (e: FormEvent) => { e.preventDefault(); p.onSubmit?.(); };
  return shell(r.schoolName, <>
    {r.friendOffer && <p data-testid="friend-offer"><strong>{r.friendOffer}</strong></p>}
    <h2>{r.form.title}</h2>{r.form.description && <p style={{ whiteSpace: 'pre-line' }}>{r.form.description}</p>}
    {p.status && <p role="status">{p.status}</p>}
    {!p.done && <form onSubmit={submit}><fieldset disabled={p.busy}>
      <label>Name<input required autoComplete="name" maxLength={120} value={v.name ?? ''} onChange={e => set('name', e.target.value)} /></label>
      <label>Email<input type="email" autoComplete="email" maxLength={254} value={v.email ?? ''} onChange={e => set('email', e.target.value)} /></label>
      <label>Mobile (international + format)<input type="tel" autoComplete="tel" maxLength={16} pattern="\+[1-9][0-9]{6,14}" value={v.mobile ?? ''} onChange={e => set('mobile', e.target.value)} /></label>
      <p>Give at least one email or mobile number. This is an enquiry, not a membership, booking or payment.</p>
      <label>Program interest (optional)<input maxLength={80} value={v.interest ?? ''} onChange={e => set('interest', e.target.value)} /></label>
      {r.form.optionalFields.map(k => <label key={k}>{OPTIONAL_LABEL[k] ?? k}<select value={v[k] ?? ''} onChange={e => { const next = { ...v }; if (e.target.value) next[k] = e.target.value; else delete next[k]; p.onValues?.(next); }}>
        <option value="">Optional</option>{PUBLIC_FORM_CHOICES[k].map(c => <option key={c} value={c}>{c}</option>)}</select></label>)}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px' }}><label>Website<input tabIndex={-1} autoComplete="off" value={v.website ?? ''} onChange={e => set('website', e.target.value)} /></label></div>
      <label><input type="checkbox" required checked={p.acknowledged} onChange={e => p.onAck?.(e.target.checked)} />I understand the school saves this enquiry. This is not consent to marketing messages.</label>
      <button type="submit">{p.busy ? 'Sending…' : 'Send'}</button>
    </fieldset></form>}
  </>);
}

export function PublicReferralPage({ code, api = publicReferralApi }: { code: string; api?: PublicReferralApi }): React.ReactElement {
  const [read, setRead] = useState<PublicReferralRead | null>(null), [values, setValues] = useState<Record<string, string>>(EMPTY), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [done, setDone] = useState(false);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null), gate = useRef(false), active = useRef(code);
  active.current = code;
  useEffect(() => {
    const abort = new AbortController();
    setRead(null); setValues(EMPTY); setAck(false); setStatus(''); setDone(false); retry.current = null;
    api.read(code, abort.signal).then(r => { if (!abort.signal.aborted) setRead(r); }, () => { if (!abort.signal.aborted) setRead('UNAVAILABLE'); });
    return () => abort.abort();
  }, [code, api]);
  async function submit() {
    if (gate.current || !read || typeof read === 'string') return;
    if (!ack) { setStatus('Tick the box to say you understand, then send.'); return; }
    const sent = code;
    const input = { ...values, source: 'Family referral', acknowledged: ack }, fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    gate.current = true; setBusy(true);
    const result = await api.submit(code, input, retry.current.key, new AbortController().signal);
    gate.current = false; setBusy(false);
    if (active.current !== sent) return; // the page moved to another invitation; this answer is not its answer
    setStatus(resultText(result));
    if (result === 'accepted') { setDone(true); retry.current = null; }
  }
  return <PublicReferralView read={read} values={values} acknowledged={ack} busy={busy} status={status} done={done} onValues={setValues} onAck={setAck} onSubmit={() => void submit()} />;
}
