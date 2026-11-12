'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  SIGNUP_CONFIRMATION, TRIAL_CONFIRMATION, validateHonOsTrial, validateSignupInput, validateSignupRegistration, validateSignupStatus, validateTrialStatus,
  type HonOsTrial, type SignupStatus, type TrialStatus,
} from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT, reportConfirmedSessionInvalidation } from '../session-invalidation';
import { StartError, startRequest, type StartCommand } from './http';
import styles from './workbench.module.css';

/**
 * Public self-serve start (0241 sign-up + 0246 free trial): a signed-in owner creates their own school, then starts the
 * free trial HQ published. Both programs are CLOSED until David opens them; this page then only says so. Every decision
 * (eligibility, campaign, length, AI credit) is the server's; the page sends only the owner's own words and confirmations.
 */
const COPY: Record<string, string> = {
  SIGNUP_CLOSED: 'Self-serve sign-up is not open yet. Nothing was created.',
  SIGNUP_ALREADY_REGISTERED: 'This account already created a school. Check again to continue.',
  SIGNUP_TERMS_CHANGED: 'The sign-up terms changed. Check again to review the current terms.',
  SIGNUP_REVIEW_REQUIRED: 'This email is already used by another HON account. Contact HON support; nothing was created.',
  SIGNUP_OWNER_NOT_ELIGIBLE: 'This account already has HON access, so it cannot create a new school here.',
  SIGNUP_KEY_REUSED: 'That request changed after it was sent. Start again.',
  SIGNUP_BUSY: 'HON is busy. Nothing was submitted; try again in a moment.',
  TRIAL_CLOSED: 'Free trials are not open yet. Nothing was started.',
  TRIAL_ALREADY_USED: 'This school already used its free trial.',
  TRIAL_CAMPAIGN_UNAVAILABLE: 'That free trial is no longer offered. Check again.',
  TRIAL_CAMPAIGN_FULL: 'That free trial is full. Check again later.',
  TRIAL_NOT_ELIGIBLE: 'This school already has access, so a free trial cannot start.',
  TRIAL_KEY_REUSED: 'That request changed after it was sent. Start again.',
  TRIAL_BUSY: 'HON is busy. Nothing was submitted; try again in a moment.',
  ACCOUNT_FORBIDDEN: 'This account cannot do that.',
  ACCOUNT_INPUT_INVALID: 'Check the details and try again.',
  ACCOUNT_RATE_LIMITED: 'Please wait up to a minute, then retry. This attempt was not submitted.',
  ACCOUNT_CHANGED_RESTART_REQUIRED: 'You are signed in as a different account now. Reload this page to start again.',
  SIGN_IN_REQUIRED: 'Sign in to continue.',
};
const say = (e: unknown) => e instanceof StartError ? COPY[e.code] ?? 'HON could not complete that right now. Try again.' : 'HON could not complete that right now. Try again.';
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
type Pending = StartCommand & Readonly<{ kind: 'signup' | 'trial'; identity: string }>;

function TrialSummary({ trial }: { trial: HonOsTrial }) {
  return <div className={styles.notice} data-start-trial>
    <p><strong>{trial.status === 'TRIAL_ACTIVE' ? 'Your free trial is on.' : trial.status === 'TRIAL_ENDED' ? 'Your free trial has ended.' : 'Your free trial was replaced by other access.'}</strong></p>
    <p>{trial.durationDays} days, from {day(trial.startsAt)} until {day(trial.endsAt)}. No charge, and no payment method is needed. Nothing renews automatically.</p>
    <p>{trial.aiCredits ? `AI team: ${trial.aiCredits.used} of ${trial.aiCredits.credits} trial credits used, up to ${trial.aiCredits.dailyCap} a day, until ${day(trial.aiCredits.expiresAt)}. Creative Studio images and video are not included.` : 'This trial does not include the AI team.'}</p>
  </div>;
}

export function HonOsStart({ sessionSubject }: { sessionSubject: string }) {
  const [phase, setPhase] = useState<'idle' | 'ready'>('idle'), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [signup, setSignup] = useState<SignupStatus | null>(null), [trial, setTrial] = useState<TrialStatus | null>(null);
  const [ownerName, setOwnerName] = useState(''), [schoolName, setSchoolName] = useState(''), [legalName, setLegalName] = useState(''), [timezone, setTimezone] = useState(browserZone);
  const [termsAccepted, setTermsAccepted] = useState(false), [trialConfirmed, setTrialConfirmed] = useState(false), [retry, setRetry] = useState(false);
  const life = useRef({ mounted: false, busy: false, epoch: 0, identity: '' }), pending = useRef<Pending | null>(null), read = useRef<AbortController | null>(null);

  useEffect(() => {
    life.current.mounted = true;
    // A signed-out or replaced session hides everything this page loaded; nothing on it is secret beyond the owner's own school.
    const invalidated = () => { life.current.epoch++; read.current?.abort(); pending.current = null; setRetry(false); setPhase('idle'); setSignup(null); setTrial(null); setMessage(COPY.SIGN_IN_REQUIRED!); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated);
    return () => { life.current.mounted = false; life.current.epoch++; read.current?.abort(); pending.current = null; window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); };
  }, []);

  async function refresh(after?: string) {
    const s = life.current; if (s.busy) return;
    const epoch = ++s.epoch, c = new AbortController(); read.current?.abort(); read.current = c; s.busy = true; setBusy(true); setMessage('Checking your account…');
    try {
      const me = await fetch('/api/identity/me', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: c.signal });
      if (me.status === 401) reportConfirmedSessionInvalidation();
      if (!me.ok) throw new StartError(me.status, 'SIGN_IN_REQUIRED');
      const identity = (await me.json() as { data?: { externalSubject?: unknown } }).data?.externalSubject;
      if (typeof identity !== 'string') throw new StartError(401, 'SIGN_IN_REQUIRED');
      // The page was rendered for one signed session; a different account must reload, and never inherits a pending request.
      if (identity !== sessionSubject || (s.identity && s.identity !== identity)) { pending.current = null; setRetry(false); throw new StartError(403, 'ACCOUNT_CHANGED_RESTART_REQUIRED'); }
      const status = validateSignupStatus(await startRequest('account/sign-up', c.signal));
      const trialStatus = status.registration ? validateTrialStatus(await startRequest('account/trial', c.signal)) : null;
      if (!s.mounted || s.epoch !== epoch) return;
      s.identity = identity; setSignup(status); setTrial(trialStatus); setPhase('ready'); setMessage(after ?? 'Account checked.');
    } catch (e) {
      if (s.mounted && s.epoch === epoch) { setPhase('idle'); setSignup(null); setTrial(null); setMessage(say(e)); }
    } finally { s.busy = false; if (s.mounted) setBusy(false); }
  }

  async function execute(command: Pending) {
    const s = life.current; if (s.busy || command.identity !== s.identity) return;
    pending.current = command; s.busy = true; setBusy(true); setRetry(true); setMessage('Sending… keep this page open.');
    // A consequential request is never aborted by focus or reads; an unknown outcome keeps the exact body and key for an explicit retry.
    let done = '';
    try {
      const result = await startRequest(command.path, new AbortController().signal, command);
      if (!s.mounted) return;
      if (command.kind === 'signup') { validateSignupRegistration(result); done = 'Your school account is created. It has no access yet; start your free trial below.'; }
      else { validateHonOsTrial(result); done = 'Your free trial has started. Continue to Founder Setup to set up your school.'; }
      pending.current = null; setRetry(false); setTermsAccepted(false); setTrialConfirmed(false);
    } catch (e) {
      if (!s.mounted) return;
      // A known refusal speaks for itself; a lost response or an unexplained server error (5xx) may already have committed.
      const known = e instanceof StartError && (e.status < 500 || COPY[e.code] !== undefined);
      setMessage(known ? say(e) : 'The outcome is unknown. Retry the exact request when ready; it cannot create a second school or trial.');
      // A closed 4xx refusal (other than throttling) is final for this request; anything else may have committed.
      if (e instanceof StartError && e.status >= 400 && e.status < 500 && e.status !== 429) { pending.current = null; setRetry(false); }
    } finally { s.busy = false; if (s.mounted) setBusy(false); }
    if (done && s.mounted) await refresh(done);
  }
  const send = (kind: Pending['kind'], path: Pending['path'], body: Record<string, unknown>) => {
    if (pending.current || life.current.busy) return;
    void execute(Object.freeze({ kind, path, body: Object.freeze({ ...body }), key: crypto.randomUUID(), identity: life.current.identity }));
  };

  const terms = signup?.terms ?? null, registration = signup?.registration ?? null;
  const form = { ownerName: ownerName.trim(), schoolName: schoolName.trim(), legalName: legalName.trim(), timezone: timezone.trim(), termsVersionId: terms?.termsVersionId ?? '', confirmation: SIGNUP_CONFIRMATION };
  let formValid = false; try { validateSignupInput(form); formValid = true; } catch { formValid = false; }

  return <section className={styles.page} aria-label="Start your school on HON OS">
    <h1>Start your school on HON OS</h1>
    <p>Create your school account, then start a free trial. There is no charge and no payment method is needed.</p>
    <p role="status" aria-live="polite" aria-atomic="true" data-start-status>{message || 'Check your account to begin.'}</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>{phase === 'ready' ? 'Check again' : 'Check my account'}</button>
    <a href="/auth/login">Sign in with a different account</a>
    {retry && <aside><p>Your last request may not have reached HON. Retrying sends exactly the same request, so it cannot create a second school or trial.</p>
      <button type="button" disabled={busy} onClick={() => pending.current && void execute(pending.current)}>Retry exact request</button></aside>}
    {phase === 'ready' && signup && <fieldset disabled={busy || retry}>
      <h2>1. Your school account</h2>
      {registration ? <p className={styles.notice} data-start-registered>School account created for <strong>{registration.schoolName}</strong> on {day(registration.registeredAt)}.</p>
        : signup.signupStatus === 'CLOSED' ? <p className={styles.notice} data-start-closed>Self-serve sign-up is not open yet. Nothing has been created.</p>
        : signup.eligibility === 'VERIFIED_SIGN_IN_REQUIRED' ? <p className={styles.notice}>Sign in with an account whose email address is verified to create a school.</p>
        : signup.eligibility === 'HAS_OTHER_ACCESS' ? <p className={styles.notice}>This account already has HON access. <a href="/auth/continue">Open my workspace</a></p>
        : !terms ? <p className={styles.notice}>Sign-up terms are not available. Check again later.</p>
        : <>
          <label>Your name<input value={ownerName} maxLength={120} autoComplete="name" onChange={e => setOwnerName(e.target.value)} /></label>
          <label>School name<input value={schoolName} maxLength={120} autoComplete="organization" onChange={e => setSchoolName(e.target.value)} /></label>
          <label>Legal business name<input value={legalName} maxLength={120} onChange={e => setLegalName(e.target.value)} /></label>
          <label>School time zone<input value={timezone} maxLength={64} placeholder="America/New_York" onChange={e => setTimezone(e.target.value)} /></label>
          <label><input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} />I agree to {terms.title} (version {terms.version}, a test-only draft) and confirm I own or run this school.</label>
          <button type="button" disabled={!formValid || !termsAccepted} onClick={() => send('signup', 'account/sign-up', form)}>Create my school account</button>
        </>}
      {registration && trial && <>
        <h2>2. Your free trial</h2>
        {trial.trial ? <><TrialSummary trial={trial.trial} />{trial.trial.status === 'TRIAL_ACTIVE' && <a href="/staff/founder-setup">Continue to Founder Setup →</a>}</>
          : trial.trialStatus === 'CLOSED' ? <p className={styles.notice} data-start-trial-closed>Free trials are not open yet. Your school account is saved; come back when HON opens them.</p>
          : !trial.available ? <p className={styles.notice}>No free trial is available right now. Check again later.</p>
          : <div data-start-offer>
            <p><strong>{trial.available.name}</strong>: {trial.available.durationDays} days. No charge, no payment method, nothing renews automatically.</p>
            <p>{trial.available.aiCredits ? `Includes the AI team with ${trial.available.aiCredits.credits} trial credits (up to ${trial.available.aiCredits.dailyCap} a day) for the first ${trial.available.aiCredits.expiryDays} days. Creative Studio images and video are not included.` : 'This trial does not include the AI team.'}</p>
            <label><input type="checkbox" checked={trialConfirmed} onChange={e => setTrialConfirmed(e.target.checked)} />Start my {trial.available.durationDays}-day free trial now.</label>
            <button type="button" disabled={!trialConfirmed} onClick={() => send('trial', 'account/trial', { schoolId: registration.schoolId, campaignId: trial.available!.campaignId, confirmation: TRIAL_CONFIRMATION })}>Start free trial</button>
          </div>}
      </>}
    </fieldset>}
  </section>;
}
