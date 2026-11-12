'use client';
import React, { useEffect, useRef, useState } from 'react';
import {
  SIGNUP_CONFIRMATION, TRIAL_CONFIRMATION, validateHonOsTrial, validateSignupInput, validateSignupRegistration, validateSignupStatus, validateTrialStatus,
  type HonOsTrial, type SignupStatus, type TrialStatus,
} from '@hon/contracts';
import { HON_SESSION_INVALIDATED_EVENT, reportConfirmedSessionInvalidation } from '../session-invalidation';
import { StartError, startRequest, type StartCommand } from './http';
import { START_COPY, instant, type StartCopy } from './copy';
import { useLocale } from '../localization/provider';
import styles from './workbench.module.css';

/**
 * Public self-serve start (0241 sign-up + 0246 free trial): a signed-in owner creates their own school, then starts the
 * free trial HQ published. Both programs are CLOSED until David opens them; this page then only says so. Every decision
 * (eligibility, campaign, length, AI credit) is the server's; the page sends only the owner's own words and confirmations.
 */
type Message = Readonly<{ say: (c: StartCopy) => string }>;
const line = (pick: (c: StartCopy) => string): Message => ({ say: pick });
const fromError = (e: unknown): Message => line(c => e instanceof StartError ? c.codes[e.code] ?? c.fallback : c.fallback);
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
type Pending = StartCommand & Readonly<{ kind: 'signup' | 'trial'; identity: string }>;

function TrialSummary({ trial, c, at }: { trial: HonOsTrial; c: StartCopy; at: (iso: string) => string }) {
  return <div className={styles.notice} data-start-trial>
    <p><strong>{trial.status === 'TRIAL_ACTIVE' ? c.trialActive : trial.status === 'TRIAL_ENDED' ? c.trialEnded : c.trialReplaced}</strong></p>
    <p>{c.trialDates(trial.durationDays, at(trial.startsAt), at(trial.endsAt))}</p>
    <p>{trial.aiCredits ? c.aiUsage(trial.aiCredits.used, trial.aiCredits.credits, trial.aiCredits.dailyCap, at(trial.aiCredits.expiresAt)) : c.noAi}</p>
  </div>;
}

export function HonOsStart({ sessionSubject }: { sessionSubject: string }) {
  const { preferences, formattingLocale } = useLocale(), c = START_COPY[preferences.language] ?? START_COPY.en;
  const [phase, setPhase] = useState<'idle' | 'ready'>('idle'), [busy, setBusy] = useState(false), [message, setMessage] = useState<Message | null>(null);
  const [signup, setSignup] = useState<SignupStatus | null>(null), [trial, setTrial] = useState<TrialStatus | null>(null);
  const [ownerName, setOwnerName] = useState(''), [schoolName, setSchoolName] = useState(''), [legalName, setLegalName] = useState(''), [timezone, setTimezone] = useState(browserZone);
  const [termsAccepted, setTermsAccepted] = useState(false), [trialConfirmed, setTrialConfirmed] = useState(false), [retry, setRetry] = useState(false);
  const life = useRef({ mounted: false, busy: false, epoch: 0, identity: '' }), pending = useRef<Pending | null>(null), read = useRef<AbortController | null>(null);

  useEffect(() => {
    life.current.mounted = true;
    // A signed-out or replaced session hides everything this page loaded; nothing on it is secret beyond the owner's own school.
    const invalidated = () => { life.current.epoch++; read.current?.abort(); pending.current = null; setRetry(false); setPhase('idle'); setSignup(null); setTrial(null); setMessage(line(x => x.codes.SIGN_IN_REQUIRED!)); };
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated);
    return () => { life.current.mounted = false; life.current.epoch++; read.current?.abort(); pending.current = null; window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); };
  }, []);

  async function refresh(after?: Message) {
    const s = life.current; if (s.busy) return;
    const epoch = ++s.epoch, c = new AbortController(); read.current?.abort(); read.current = c; s.busy = true; setBusy(true); setMessage(line(x => x.checking));
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
      s.identity = identity; setSignup(status); setTrial(trialStatus); setPhase('ready'); setMessage(after ?? line(x => x.checked));
    } catch (e) {
      if (s.mounted && s.epoch === epoch) { setPhase('idle'); setSignup(null); setTrial(null); setMessage(fromError(e)); }
    } finally { s.busy = false; if (s.mounted) setBusy(false); }
  }

  async function execute(command: Pending) {
    const s = life.current; if (s.busy || command.identity !== s.identity) return;
    pending.current = command; s.busy = true; setBusy(true); setRetry(true); setMessage(line(x => x.sending));
    // A consequential request is never aborted by focus or reads; an unknown outcome keeps the exact body and key for an explicit retry.
    let done: Message | null = null;
    try {
      const result = await startRequest(command.path, new AbortController().signal, command);
      if (!s.mounted) return;
      if (command.kind === 'signup') { validateSignupRegistration(result); done = line(x => x.created); }
      else { validateHonOsTrial(result); done = line(x => x.trialStarted); }
      pending.current = null; setRetry(false); setTermsAccepted(false); setTrialConfirmed(false);
    } catch (e) {
      if (!s.mounted) return;
      // A known refusal speaks for itself; a lost response or an unexplained server error (5xx) may already have committed.
      const known = e instanceof StartError && (e.status < 500 || START_COPY.en.codes[e.code] !== undefined);
      setMessage(known ? fromError(e) : line(x => x.unknownOutcome));
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

  // School-facing instants are shown in the school's own time zone, with the zone named.
  const at = (iso: string) => instant(iso, formattingLocale, registration?.timezone);
  const draft = terms?.status === 'TEST_ONLY_DRAFT';

  return <section className={styles.page} aria-label={c.title}>
    <h1>{c.title}</h1>
    <p>{c.intro}</p>
    <p role="status" aria-live="polite" aria-atomic="true" data-start-status>{message ? message.say(c) : c.begin}</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>{phase === 'ready' ? c.checkAgain : c.checkFirst}</button>
    <a href="/auth/login">{c.otherAccount}</a>
    {retry && <aside><p>{c.retryNote}</p>
      <button type="button" disabled={busy} onClick={() => pending.current && void execute(pending.current)}>{c.retryButton}</button></aside>}
    {phase === 'ready' && signup && <fieldset disabled={busy || retry}>
      <h2>{c.step1}</h2>
      {registration ? <p className={styles.notice} data-start-registered>{c.registered(registration.schoolName, at(registration.registeredAt))}</p>
        : signup.signupStatus === 'CLOSED' ? <p className={styles.notice} data-start-closed>{c.signupClosed}</p>
        : signup.eligibility === 'VERIFIED_SIGN_IN_REQUIRED' ? <p className={styles.notice}>{c.verifiedRequired}</p>
        : signup.eligibility === 'HAS_OTHER_ACCESS' ? <p className={styles.notice}>{c.hasOtherAccess} <a href="/auth/continue">{c.openWorkspace}</a></p>
        : !terms ? <p className={styles.notice}>{c.termsUnavailable}</p>
        : <>
          <label>{c.ownerName}<input value={ownerName} maxLength={120} autoComplete="name" onChange={e => setOwnerName(e.target.value)} /></label>
          <label>{c.schoolName}<input value={schoolName} maxLength={120} autoComplete="organization" onChange={e => setSchoolName(e.target.value)} /></label>
          <label>{c.legalName}<input value={legalName} maxLength={120} onChange={e => setLegalName(e.target.value)} /></label>
          <label>{c.timezone}<input value={timezone} maxLength={64} placeholder="America/New_York" onChange={e => setTimezone(e.target.value)} /></label>
          {/* Placeholder: the legal sign-up terms wording is David's decision and is not written yet. */}
          {draft && <p className={styles.notice} data-start-legal-pending>{c.legalTermsPending}</p>}
          <label><input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} />{c.agree(terms.title, terms.version, draft)}</label>
          <button type="button" disabled={!formValid || !termsAccepted} onClick={() => send('signup', 'account/sign-up', form)}>{c.createButton}</button>
        </>}
      {registration && trial && <>
        <h2>{c.step2}</h2>
        {trial.trial ? <><TrialSummary trial={trial.trial} c={c} at={at} />{trial.trial.status === 'TRIAL_ACTIVE' && <a href="/staff/founder-setup">{c.founderSetup}</a>}</>
          : trial.trialStatus === 'CLOSED' ? <p className={styles.notice} data-start-trial-closed>{c.trialClosed}</p>
          : !trial.available ? <p className={styles.notice}>{c.noOffer}</p>
          : <div data-start-offer>
            <p><strong>{c.offer(trial.available.name, trial.available.durationDays)}</strong></p>
            <p>{trial.available.aiCredits ? c.offerAi(trial.available.aiCredits.credits, trial.available.aiCredits.dailyCap, trial.available.aiCredits.expiryDays) : c.noAi}</p>
            {/* Placeholder: the legal free-trial terms wording is David's decision and is not written yet. */}
            <p className={styles.notice} data-start-trial-terms-pending>{c.trialTermsPending}</p>
            <label><input type="checkbox" checked={trialConfirmed} onChange={e => setTrialConfirmed(e.target.checked)} />{c.confirmTrial(trial.available.durationDays)}</label>
            <button type="button" disabled={!trialConfirmed} onClick={() => send('trial', 'account/trial', { schoolId: registration.schoolId, campaignId: trial.available!.campaignId, confirmation: TRIAL_CONFIRMATION })}>{c.startTrial}</button>
          </div>}
      </>}
    </fieldset>}
  </section>;
}
