'use client';
import React, { useEffect, useRef, useState } from 'react';
import { MAYA_CHECK_IN_NAME_TOKEN, mayaCheckInMax, type MayaCheckInChannel, type MayaCheckInApproval, type MayaCheckInRecipient, type MayaCheckInView } from '@hon/contracts';
import { MayaCheckInError, mayaCheckInApi as defaultApi, type MayaCheckInApi, type MayaCheckInErrorKind, type MayaCheckInScope } from '../hon-command/maya-check-in-http';
import { browserRecognition, detectHonVoiceSupport, type RecognitionAdapter } from '../hon-command/hon-voice';
import { sendAtFromLocal } from '../chad-draft-send-http';

/**
 * P8 (0649), owner decision 2026-11-22 "Send automatically once approved", with verbal approval allowed. Maya writes a check-in
 * text or email for one at-risk student. Nothing is sent until you approve it here, by the button or by saying "approve" or
 * "send it". Approval queues one message; the school's usual checks (consent, STOP, quiet hours) still run when it goes out.
 */
export const MAYA_CHECK_IN_NOTICE: Readonly<Record<MayaCheckInErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED' | 'NOT_HEARD', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'Check-in drafts need Maya switched on for you, message sending at this school and an active Complete plan. Nothing was sent.',
  NOT_AT_RISK: 'This student is not on the at-risk list now, so Maya did not write a draft.',
  NO_CONSENT: 'This person has not agreed to messages on that channel. Nothing was sent. Pick the other person or channel.',
  NO_ADDRESS: 'This person has no phone number or email for that channel. Nothing was sent.',
  DAILY_CAP: 'This person already got 3 approved AI-drafted messages today. Nothing was sent.',
  NOT_CANCELLABLE: 'This message is already on its way, so it can no longer be cancelled.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'This draft was already approved or dismissed.',
  INVALID: 'That was not accepted as written. Keep the message within its length, with no links. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Maya could not write a draft this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Maya is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Maya’s draft could not be used:',
  NOT_HEARD: 'To approve by voice, say “approve” or “send it”. Nothing was sent.',
};
/** The only words that approve, said on their own while this one draft is on screen. */
export const APPROVAL_PHRASE = /^(approve|approved|approve it|send it|approve and send|yes,? send it)[.!]?$/i;
export const isApprovalPhrase = (heard: string): boolean => APPROVAL_PHRASE.test(heard.replace(/\s+/g, ' ').trim());
const DELIVERY: Record<string, string> = { PENDING: 'waiting to send', SENT: 'sent', DELIVERED: 'delivered', SUPPRESSED: 'not sent (no consent or address at send time)', FAILED: 'could not be sent' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** What happened to an approved draft, in one line. Pure, so it is tested directly. */
export function mayaCheckInSummary(view: MayaCheckInView): string {
  const s = view.send;
  if (!s) return '';
  const how = s.approvalMethod === 'VOICE' ? 'by voice' : 'with the button';
  const what = s.channel === 'EMAIL' ? 'email' : 'text';
  if (s.cancelled) return `Approved ${how}. The ${what} was cancelled before it went out.`;
  return `Approved ${how} at ${when(s.approvedAt)}. The ${what} is ${s.delivery ? DELIVERY[s.delivery] ?? s.delivery.toLowerCase() : `queued for ${when(s.scheduledAt)}`}.`;
}

type Notice = null | { kind: keyof typeof MAYA_CHECK_IN_NOTICE; problems?: readonly string[] };
const newKey = (): string => globalThis.crypto.randomUUID();
const recognitionFor = (): RecognitionAdapter | null => {
  if (typeof window === 'undefined') return null;
  return detectHonVoiceSupport(window as never).recognition ? browserRecognition(window as never) : null;
};

export function MayaCheckIn({ school, membershipId, givenName, api = defaultApi, recognition }: { school: MayaCheckInScope; membershipId: string; givenName: string;
  api?: MayaCheckInApi; recognition?: RecognitionAdapter | null }): React.ReactElement {
  const [channel, setChannel] = useState<MayaCheckInChannel>('SMS');
  const [note, setNote] = useState('');
  const [view, setView] = useState<MayaCheckInView | null>(null);
  const [message, setMessage] = useState('');
  const [subject, setSubject] = useState('');
  const [recipient, setRecipient] = useState<MayaCheckInRecipient>('STUDENT');
  const [timing, setTiming] = useState<'NOW' | 'LATER'>('NOW');
  const [local, setLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [mic, setMic] = useState<RecognitionAdapter | null>(recognition ?? null);
  const askKey = useRef<{ key: string; body: string } | null>(null);
  const approveKey = useRef<{ key: string; body: string; sent: MayaCheckInApproval } | null>(null);
  const stop = useRef<null | (() => void)>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; stop.current?.(); }; }, []);
  useEffect(() => { if (recognition === undefined) setMic(recognitionFor()); }, [recognition]);
  const owned = () => live.current;
  const fail = (error: unknown) => { const kind = error instanceof MayaCheckInError ? error.kind : 'UNKNOWN'; setNotice({ kind }); return kind; };
  const show = (v: MayaCheckInView) => {
    setView(v); setMessage(v.message ?? ''); setSubject(v.subject ?? '');
    setRecipient(v.recipients.find((r) => r.reachable)?.recipient ?? 'STUDENT');
  };

  const ask = async () => {
    if (busy) return;
    const body = { membershipId: membershipId.toLowerCase(), channel, note: note.trim() }, text = JSON.stringify(body);
    const key = askKey.current?.body === text ? askKey.current.key : newKey();
    askKey.current = { key, body: text };
    setBusy(true); setNotice(null);
    try {
      const v = await api.request(school, body, key, AbortSignal.timeout(90000), owned);
      if (!live.current) return;
      askKey.current = null;
      if (v.status === 'RESULT_RECORDED') { show(v); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) { if (live.current && fail(error) !== 'UNKNOWN') askKey.current = null; }
    finally { if (live.current) setBusy(false); }
  };

  const approve = async (method: 'BUTTON' | 'VOICE') => {
    if (!view || view.status !== 'RESULT_RECORDED' || busy) return;
    const sendAt = timing === 'NOW' ? null : sendAtFromLocal(local);
    if (timing === 'LATER' && !sendAt) { setNotice({ kind: 'INVALID' }); return; }
    const approval = { recipient, message: message.trim(), subject: view.brief.channel === 'EMAIL' ? subject.trim() : '', sendAt, approvalMethod: method,
      voiceTurnId: method === 'VOICE' ? newKey() : null };
    // A lost answer keeps its key: only the identical approval may be sent again (a voice retry keeps its turn id).
    const text = JSON.stringify({ ...approval, voiceTurnId: method });
    const prior = approveKey.current?.body === text ? approveKey.current : null;
    const key = prior?.key ?? newKey(), sent = prior?.sent ?? approval;
    approveKey.current = { key, body: text, sent };
    setBusy(true); setNotice(null);
    try {
      const v = await api.approve(school, view.id, view.brief.channel, sent, key, AbortSignal.timeout(30000), owned);
      if (!live.current) return;
      approveKey.current = null; setView(v);
    } catch (error) { if (live.current && fail(error) !== 'UNKNOWN') approveKey.current = null; }
    finally { if (live.current) setBusy(false); }
  };

  const listen = () => {
    if (!mic || busy || listening) return;
    setListening(true); setNotice(null);
    const session = mic.start({ lang: 'en-US', continuous: false, onDevice: false }, {
      onInterim: () => undefined,
      onFinal: (heard) => { if (!live.current) return; if (isApprovalPhrase(heard)) void approve('VOICE'); else setNotice({ kind: 'NOT_HEARD' }); },
      onError: () => { if (live.current) setNotice({ kind: 'NOT_HEARD' }); },
      onEnd: () => { stop.current = null; if (live.current) setListening(false); },
    });
    stop.current = () => session.abort();
  };

  const cancel = async () => {
    if (!view?.send || busy) return;
    setBusy(true); setNotice(null);
    try { const v = await api.cancel(school, view.id, newKey(), AbortSignal.timeout(30000), owned); if (live.current) setView(v); }
    catch (error) { if (live.current) fail(error); }
    finally { if (live.current) setBusy(false); }
  };
  const dismiss = () => {
    if (!view || view.status !== 'RESULT_RECORDED') return;
    const before = view; setView(null);
    api.dismiss(school, before.id, newKey(), AbortSignal.timeout(30000), owned).then(() => undefined, (error) => { if (live.current && fail(error) !== 'GONE') setView(before); });
  };

  const max = view ? mayaCheckInMax(view.brief.channel) : mayaCheckInMax(channel);
  const preview = message.split(MAYA_CHECK_IN_NAME_TOKEN).join(recipient === 'STUDENT' ? givenName : (view?.recipients.find((r) => r.recipient === recipient)?.name.split(' ')[0] || givenName));
  return <div data-maya-check-in={view?.status ?? 'IDLE'}>
    {!view ? <form onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset disabled={busy}><legend>Ask Maya to draft a check-in</legend>
        {(['SMS', 'EMAIL'] as const).map((c) => <label key={c}><input type="radio" name={`maya-check-in-${membershipId}`} checked={channel === c} onChange={() => setChannel(c)} data-maya-check-in-channel={c} /> {c === 'SMS' ? 'Text message' : 'Email'}</label>)}
        <label>Anything Maya should know (optional)<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: they mentioned a knee injury" /></label>
      </fieldset>
      <button type="submit" disabled={busy} data-maya-check-in-ask>{busy ? 'Maya is writing…' : 'Draft a check-in with Maya'}</button>
      <p>Maya sees only this student’s attendance numbers, never their name or contact details. Nothing is sent until you approve it.</p>
    </form> : null}
    {view && view.status === 'RESULT_RECORDED' ? <form onSubmit={(e) => { e.preventDefault(); void approve('BUTTON'); }}>
      <p><strong>Maya’s draft</strong> (written with AI; check it before you approve): {view.summary}</p>
      {view.brief.channel === 'EMAIL' ? <label>Subject<input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} data-maya-check-in-subject /></label> : null}
      <label>{view.brief.channel === 'EMAIL' ? 'Email' : 'Text message'} ({message.trim().length}/{max})<textarea value={message} maxLength={max} rows={view.brief.channel === 'EMAIL' ? 8 : 4} onChange={(e) => setMessage(e.target.value)} data-maya-check-in-message /></label>
      {message.includes(MAYA_CHECK_IN_NAME_TOKEN) ? <p data-maya-check-in-preview>They will see: {preview}</p> : null}
      <fieldset disabled={busy}><legend>Send to</legend>
        {view.recipients.map((r) => <label key={r.recipient}><input type="radio" name={`maya-check-in-to-${view.id}`} checked={recipient === r.recipient} disabled={!r.reachable} onChange={() => setRecipient(r.recipient)} data-maya-check-in-to={r.recipient} />
          {' '}{r.name || (r.recipient === 'STUDENT' ? 'The student' : 'The billing contact')}{r.recipient === 'BILLING_CONTACT' ? ' (billing contact)' : ''}{r.reachable ? '' : ' (no consent or address for this channel)'}</label>)}
      </fieldset>
      <fieldset disabled={busy}><legend>When</legend>
        <label><input type="radio" name={`maya-check-in-when-${view.id}`} checked={timing === 'NOW'} onChange={() => setTiming('NOW')} /> As soon as I approve</label>
        <label><input type="radio" name={`maya-check-in-when-${view.id}`} checked={timing === 'LATER'} onChange={() => setTiming('LATER')} /> At a set time</label>
        {timing === 'LATER' ? <label>Day and time<input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} data-maya-check-in-at /></label> : null}
      </fieldset>
      <p>Quiet hours still apply, and anyone who replied STOP is never sent to.</p>
      <button type="submit" disabled={busy || !view.recipients.some((r) => r.reachable)} data-maya-check-in-approve>{busy ? 'Approving…' : 'Approve and send'}</button>
      {mic ? <button type="button" disabled={busy || listening || !view.recipients.some((r) => r.reachable)} onClick={listen} data-maya-check-in-voice>{listening ? 'Listening… say “approve”' : 'Approve by voice'}</button> : null}
      <button type="button" disabled={busy} onClick={dismiss} data-maya-check-in-dismiss>Dismiss</button>
    </form> : null}
    {view?.send ? <div data-maya-check-in-sent>
      <p>{mayaCheckInSummary(view)}</p>
      {!view.send.cancelled && !view.send.delivery ? <button type="button" disabled={busy} onClick={() => void cancel()} data-maya-check-in-cancel>Cancel this message</button> : null}
    </div> : null}
    {notice ? <div role="alert" data-maya-check-in-notice={notice.kind}>
      <p>{MAYA_CHECK_IN_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
  </div>;
}
