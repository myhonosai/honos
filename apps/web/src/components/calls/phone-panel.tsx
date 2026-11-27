'use client';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OperationalSchoolScope } from '../operational-navigation';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { ShellIcon } from '../school-shell/icons';
import { formatCallDuration, formatCallNumber } from './http';
import { HQ_PHONE_BACKEND, PHONE_REQUEST_EVENT, PhoneController, type PhoneBackend, type PhoneProblem, type PhoneRequest, type PhoneState, type VoiceDeviceFactory } from './phone';
import { hqPhoneCopy, phoneCopy, type PhoneCopy } from './phone-copy';
import styles from './phone-panel.module.css';

const HIDDEN: PhoneState = { kind: 'HIDDEN' };
function problemText(problem: PhoneProblem, copy: PhoneCopy): string {
  if (problem.kind === 'NUMBER') return copy.problemNumber;
  if (problem.kind === 'UNKNOWN') return copy.problemUnknown;
  if (problem.kind === 'MICROPHONE') return copy.problemMicrophone;
  if (problem.kind === 'DROPPED') return copy.problemDropped;
  return copy.refusal[problem.code] ?? copy.problemDropped;
}
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

/**
 * The top-bar phone for the verified school. It asks the calling API for a phone token once per school; a staff member
 * without calling permission never sees it. The incoming-call banner shows over any page. Presentation of the controller only.
 */
export function SchoolPhone({ scope, language, createDevice }: { scope: OperationalSchoolScope; language: string; createDevice?: VoiceDeviceFactory }): React.ReactElement | null {
  return <BrowserPhone target={{ organizationId: scope.organizationId, schoolId: scope.schoolId }} callsHref="/staff/calls" language={language} createDevice={createDevice} />;
}
/** The HQ top-bar phone on the HQ texting number (0694). Hidden for anyone the HQ calling API refuses. */
export function HqPhone({ language, createDevice, backend = HQ_PHONE_BACKEND }: { language: string; createDevice?: VoiceDeviceFactory; backend?: PhoneBackend }): React.ReactElement | null {
  return <BrowserPhone target={backend} callsHref="/hq/communications/calls" language={language} createDevice={createDevice} hq />;
}

function BrowserPhone({ target, callsHref, language, createDevice, hq = false }: { target: { organizationId: string; schoolId: string } | PhoneBackend; callsHref: string;
  language: string; createDevice?: VoiceDeviceFactory | undefined; hq?: boolean }): React.ReactElement | null {
  const copy = hq ? hqPhoneCopy(language) : phoneCopy(language);
  const [controller] = useState(() => new PhoneController(target, createDevice));
  const state = useSyncExternalStore(listener => controller.subscribe(listener), () => controller.snapshot(), () => HIDDEN);
  const [open, setOpen] = useState(false), [number, setNumber] = useState(''), [person, setPerson] = useState<PhoneRequest | null>(null);
  const [keypad, setKeypad] = useState(false), [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { void controller.start(); return () => controller.stop(); }, [controller]);
  useEffect(() => onShellPrivacyEvent(() => { controller.stop(); setOpen(false); setNumber(''); setPerson(null); }), [controller]);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<PhoneRequest>).detail;
      if (!detail) return;
      setNumber(formatCallNumber(detail.toE164)); setPerson(detail); setOpen(true);
      setTimeout(() => input.current?.focus(), 0);
    };
    window.addEventListener(PHONE_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(PHONE_REQUEST_EVENT, onRequest);
  }, []);
  useEffect(() => {
    if (state.kind !== 'ACTIVE') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.kind]);

  if (state.kind === 'HIDDEN') return null;
  const who = (remote: string) => (person && formatCallNumber(person.toE164) === formatCallNumber(remote) && person.name) || (remote ? formatCallNumber(remote) : copy.unknownCaller);
  function dial(event: React.FormEvent) {
    event.preventDefault();
    const request = person && formatCallNumber(person.toE164) === number.trim() ? person : null;
    void controller.dial(number, request?.personId);
  }
  const busyCall = state.kind === 'DIALING' || state.kind === 'ACTIVE';
  return <>
    <button type="button" className={styles.button} aria-expanded={open} aria-controls="hon-phone" data-phone-state={state.kind}
      aria-label={open ? copy.close : copy.open} title={copy.open} onClick={() => setOpen(!open)}>
      <ShellIcon name="calls" /><span>{busyCall ? (state.kind === 'ACTIVE' ? formatCallDuration(Math.max(0, Math.floor((now - state.since) / 1000))) : '…') : copy.open}</span>
    </button>
    {state.kind === 'INCOMING' && <div className={styles.banner} role="alertdialog" aria-label={copy.incoming(who(state.remote))} data-phone-incoming="">
      <strong>{copy.incoming(who(state.remote))}</strong>
      <button type="button" className={styles.answer} onClick={() => { controller.accept(); setOpen(true); }}>{copy.answer}</button>
      <button type="button" className={styles.decline} onClick={() => controller.decline()}>{copy.decline}</button>
    </div>}
    {open && <section id="hon-phone" className={styles.panel} aria-label={copy.title}>
      <header><strong>{copy.title}</strong><button type="button" aria-label={copy.close} onClick={() => setOpen(false)}>×</button></header>
      <div aria-live="polite">
        {state.kind === 'LOADING' && <p role="status">{copy.loading}</p>}
        {state.kind === 'UNAVAILABLE' && <p role="status">{copy.unavailable[state.reason]} <a href={callsHref}>{copy.callsPage}</a></p>}
        {state.kind === 'READY' && state.problem && <p role="alert" className={styles.problem}>{problemText(state.problem, copy)}</p>}
        {state.kind === 'DIALING' && <p role="status">{copy.calling(who(state.remote))}</p>}
        {state.kind === 'ACTIVE' && <p role="status">{copy.onCall(who(state.remote))} · {formatCallDuration(Math.max(0, Math.floor((now - state.since) / 1000)))}</p>}
        {state.kind === 'ENDED' && <p role="status">{copy.ended(who(state.remote))}</p>}
      </div>
      {(state.kind === 'READY' || state.kind === 'ENDED') && <form onSubmit={dial}>
        <label htmlFor="hon-phone-number">{copy.number}</label>
        <input id="hon-phone-number" ref={input} type="tel" inputMode="tel" autoComplete="off" maxLength={40} value={number}
          aria-describedby="hon-phone-hint" onChange={e => setNumber(e.target.value)} />
        <p id="hon-phone-hint" className={styles.hint}>{copy.numberHint}</p>
        <div className={styles.keys} role="group" aria-label={copy.keypad}>
          {KEYS.map(key => <button key={key} type="button" onClick={() => setNumber(value => (value + key).slice(0, 40))}>{key}</button>)}</div>
        <p className={styles.actions}><button type="submit" className={styles.answer} disabled={!number.trim()}>{copy.call}</button>
          {state.kind === 'ENDED' && <a href={callsHref}>{copy.addNotes}</a>}</p>
        {state.kind === 'READY' && <p className={styles.hint}>{state.incoming ? copy.ringMeOn : copy.ringMeOff}</p>}
      </form>}
      {busyCall && <div className={styles.actions}>
        {state.kind === 'ACTIVE' && <button type="button" aria-pressed={state.muted} onClick={() => controller.toggleMute()}>{state.muted ? copy.unmute : copy.mute}</button>}
        {state.kind === 'ACTIVE' && <button type="button" aria-expanded={keypad} onClick={() => setKeypad(!keypad)}>{copy.keypad}</button>}
        <button type="button" className={styles.decline} onClick={() => controller.hangUp()}>{copy.hangUp}</button>
      </div>}
      {state.kind === 'ACTIVE' && keypad && <div className={styles.keys} role="group" aria-label={copy.keypad}>
        {KEYS.map(key => <button key={key} type="button" onClick={() => controller.digits(key)}>{key}</button>)}</div>}
    </section>}
  </>;
}
