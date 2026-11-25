'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChadSendError, chadSendApi as defaultApi, sendAtFromLocal, type ChadSendApi, type ChadSendChannel, type ChadSendView } from './chad-draft-send-http';

/**
 * 0647 (P7), owner decision 2026-11-22 "Send automatically once approved": the requester picks how and when the draft goes out.
 * Approval by another staff member (by button or by voice) then queues it with no further click. The school's usual delivery
 * checks still run at send time, so a contact who replies STOP is never sent to.
 */
export const CHAD_SEND_COPY = {
  intro: 'Pick how this message goes out once a teammate approves it. Nothing is sent before then.',
  none: 'Don’t send. Approval only records the decision.',
  noPlan: 'No send is set. Approving only records the decision.',
  readFailed: 'HON could not load the send plan for this draft, so it cannot be approved here yet. Reload to try again.',
  outcome: {
    NO_CONSENT: 'Approved, but not sent: this contact has not agreed to messages on that channel.',
    NO_ADDRESS: 'Approved, but not sent: this contact has no address for that channel.',
    DAILY_CAP: 'Approved, but not sent: this contact already got 3 approved messages in the last 24 hours.',
  },
} as const;
const CHANNEL_LABEL: Record<ChadSendChannel, string> = { SMS: 'Text message', EMAIL: 'Email', NONE: 'Don’t send' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DELIVERY: Record<string, string> = { PENDING: 'Waiting to send', SENT: 'Sent', DELIVERED: 'Delivered', SUPPRESSED: 'Not sent (no consent or address at send time)', FAILED: 'Could not be sent' };

/** What a plan or a send record means, in one line. Pure, so it is tested directly. */
export function chadSendSummary(view: ChadSendView | null): string {
  if (!view) return '';
  const s = view.send;
  if (s) {
    if (s.outcome !== 'QUEUED') return CHAD_SEND_COPY.outcome[s.outcome];
    const how = s.approvalMethod === 'VOICE' ? 'by voice' : 'with the button';
    if (s.cancelled) return `Approved ${how}. The ${CHANNEL_LABEL[s.channel].toLowerCase()} was cancelled before it went out.`;
    const state = s.delivery ? DELIVERY[s.delivery] ?? s.delivery : `Queued for ${when(s.scheduledAt)}`;
    return `Approved ${how} at ${when(s.approvedAt)}. ${CHANNEL_LABEL[s.channel]}: ${state}.`;
  }
  const p = view.plan;
  if (!p || p.channel === 'NONE') return CHAD_SEND_COPY.noPlan;
  return `Once approved, this goes out as ${p.channel === 'EMAIL' ? 'an email' : 'a text message'} ${p.sendAt ? `on ${when(p.sendAt)}` : 'right away'}.`;
}

/** On the approvals screen (readOnly) the reviewer only reads the plan, and onRead tells the screen which plan version was shown
 * (or that it could not be read), so the approval is bound to that version and is blocked while the plan is unknown. */
export function ChadDraftSendPlan({ invocationId, status, mine = true, readOnly = false, onRead, api = defaultApi }: { invocationId: string; status: string; mine?: boolean; readOnly?: boolean;
  onRead?: (view: ChadSendView | null) => void; api?: ChadSendApi }): React.ReactElement | null {
  const [view, setView] = useState<ChadSendView | null>(null);
  const [channel, setChannel] = useState<ChadSendChannel>('NONE');
  const [timing, setTiming] = useState<'NOW' | 'LATER'>('NOW');
  const [local, setLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const report = useRef(onRead); report.current = onRead;
  const key = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let live = true;
    setReadFailed(false); report.current?.(null);
    api.read(invocationId).then((v) => { if (!live) return; setView(v); report.current?.(v); if (v.plan) { setChannel(v.plan.channel); setTiming(v.plan.sendAt ? 'LATER' : 'NOW'); } },
      () => { if (live) { setView(null); setReadFailed(true); report.current?.(null); } });
    return () => { live = false; };
  }, [api, invocationId, status]);
  if (!['AWAITING_APPROVAL', 'APPROVED'].includes(status)) return null;
  const editable = !readOnly && mine && status === 'AWAITING_APPROVAL' && !view?.send;
  const run = async (work: () => Promise<ChadSendView>) => {
    if (busy) return; setBusy(true); setError('');
    try { setView(await work()); } catch (e) { setError(e instanceof ChadSendError ? e.message : 'HON could not confirm this. Refresh to see what was saved.'); }
    finally { setBusy(false); }
  };
  const save = () => run(() => {
    const sendAt = channel === 'NONE' || timing === 'NOW' ? null : sendAtFromLocal(local);
    if (channel !== 'NONE' && timing === 'LATER' && !sendAt) return Promise.reject(new ChadSendError('Pick a day and time.', 400, 'LOCAL'));
    const body = JSON.stringify({ channel, sendAt });
    if (key.current?.body !== body) key.current = { body, key: globalThis.crypto.randomUUID() };
    return api.setPlan(invocationId, { channel, sendAt }, key.current.key);
  });
  const canCancel = !readOnly && !!view?.send && view.send.outcome === 'QUEUED' && !view.send.cancelled && !view.send.delivery;
  return <section aria-labelledby={`send-${invocationId}`} data-chad-send={view?.send?.outcome ?? view?.plan?.channel ?? 'NONE'}>
    <h3 id={`send-${invocationId}`}>Send once approved</h3>
    {readFailed ? <p role="alert" data-chad-send-read-failed>{CHAD_SEND_COPY.readFailed}</p> : <p data-chad-send-summary>{chadSendSummary(view)}</p>}
    {editable ? <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>{CHAD_SEND_COPY.intro}</p>
      <fieldset disabled={busy}><legend>How</legend>
        {(['NONE', 'SMS', 'EMAIL'] as const).map((c) => <label key={c}><input type="radio" name={`chad-channel-${invocationId}`} checked={channel === c} onChange={() => setChannel(c)} data-chad-channel={c} /> {c === 'NONE' ? CHAD_SEND_COPY.none : CHANNEL_LABEL[c]}</label>)}
      </fieldset>
      {channel !== 'NONE' ? <fieldset disabled={busy}><legend>When</legend>
        <label><input type="radio" name={`chad-when-${invocationId}`} checked={timing === 'NOW'} onChange={() => setTiming('NOW')} /> As soon as it is approved</label>
        <label><input type="radio" name={`chad-when-${invocationId}`} checked={timing === 'LATER'} onChange={() => setTiming('LATER')} /> At a set time</label>
        {timing === 'LATER' ? <label>Day and time<input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} data-chad-send-at /></label> : null}
        <p>Quiet hours still apply, and anyone who replied STOP is never sent to.</p>
      </fieldset> : null}
      <button type="submit" disabled={busy} data-chad-send-save>{busy ? 'Saving…' : 'Save'}</button>
    </form> : null}
    {canCancel ? <button type="button" disabled={busy} onClick={() => void run(() => api.cancel(invocationId))} data-chad-send-cancel>Cancel this message</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
