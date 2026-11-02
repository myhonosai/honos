'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MEMBERSHIP_ACTIVATION_CONFIRMATION, MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION, MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION,
  MEMBERSHIP_ACTIVATION_REASON_CODES, MEMBERSHIP_ADULT_VERIFICATION_METHODS, isSchoolLocalDate, validateConfirmMembershipActivationInput,
  type MembershipActivationPreview, type ConfirmMembershipActivationInput, type MembershipActivationContext, type MembershipActivationWarningCode,
} from '@hon/contracts';
import { formatLocaleCalendarDate } from '@hon/design-system';
import {
  activateKnownMembership, previewMembershipActivation, loadMembershipActivationContext, prepareMembershipActivation, MembershipActivationError,
  type KnownMembership, type ActivationRequest, type ActivationResult,
} from './membership-activation-http';
import { verifyEnrollmentSession } from './crm-enrollment-privacy';
import { PlanAccessError } from './membership-plans/http';
import { CrmEnrollmentDiscard } from './crm-enrollment-discard';
import { useLocale } from './localization/provider';
import { activationText, activationWarning, activationBlock, activationRequirement, activationSource, activationReason, type ActivationTextKey, type ActivationVariables } from './membership-activation-catalog';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import styles from './membership-activation-workbench.module.css';

type Dates = { startDate: string; endDate: string | null };
export function MembershipActivationWorkbench({ sessionSubject, initialMembership, onReturn }: { sessionSubject?: string; initialMembership?: KnownMembership; onReturn?(): void }): React.ReactElement {
  const { preferences, date } = useLocale();
  const t = (key: string, vars?: ActivationVariables) => activationText(preferences.language, key as ActivationTextKey, vars);
  const calendar = (value: string | null) => value === null ? t('Open-ended · no last day') : formatLocaleCalendarDate(preferences, value);
  const [presentation, setPresentation] = useState<'modern' | 'classic' | 'big'>('modern');
  const discardCopy = { description: t('An action may already have completed. Discard permanently removes its local retry information; it does not cancel or undo a server action. Retry the exact request to resolve an unknown outcome, or deliberately abandon local recovery and verify saved setup before any new action.'), confirmation: t('I understand and deliberately abandon local recovery.') };
  const [scope, setScope] = useState<KnownMembership>(() => initialMembership ? { ...initialMembership } : { organizationId: '', schoolId: '', membershipId: '' });
  const [preview, setPreview] = useState<MembershipActivationPreview | null>(null), [dates, setDates] = useState<Dates | null>(null);
  const [observed, setObserved] = useState<MembershipActivationContext | null>(null), [saved, setSaved] = useState<ActivationResult | null>(null);
  const [pending, setPending] = useState<ActivationRequest | null>(null), [summary, setSummary] = useState<ConfirmMembershipActivationInput | null>(null);
  const [warnings, setWarnings] = useState<MembershipActivationWarningCode[]>([]), [adjustment, setAdjustment] = useState('');
  const [overrideReason, setOverrideReason] = useState(''), [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [adult, setAdult] = useState(false), [adultMethod, setAdultMethod] = useState<typeof MEMBERSHIP_ADULT_VERIFICATION_METHODS[number]>('ID_CHECKED_IN_PERSON');
  const [reason, setReason] = useState<ConfirmMembershipActivationInput['reasonCode']>('ROUTINE_ENROLLMENT'), [details, setDetails] = useState('');
  const [confirmed, setConfirmed] = useState(false), [reading, setReading] = useState(false), [commandBusy, setCommandBusy] = useState(false);
  const [hidden, setHidden] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const readEpoch = useRef(0), readAbort = useRef<AbortController | null>(null), concealed = useRef(false), sensitive = useRef(false);
  const instance = useRef(0), activeCommand = useRef<ActivationRequest | null>(null), retained = useRef<ActivationRequest | null>(null);
  const finalHeading = useRef<HTMLHeadingElement | null>(null), shieldHeading = useRef<HTMLHeadingElement | null>(null), reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const privateArea = useRef<HTMLDivElement | null>(null), sessionOwner = useRef(sessionSubject), restoreAttempt = useRef(0);
  sensitive.current = !!(scope.organizationId || scope.schoolId || scope.membershipId || preview || saved || pending || reading);
  const locked = commandBusy || pending !== null;
  function resetReview(): void { setSummary(null); setConfirmed(false); setWarnings([]); setOverrideReason(''); setOverrideConfirmed(false); setAdult(false); setDetails(''); setAdjustment(''); }
  function invalidateRead(): void { readEpoch.current++; readAbort.current?.abort(); setReading(false); }
  function conceal(): void {
    if (!sensitive.current) return;
    if (privateArea.current) { privateArea.current.hidden = true; privateArea.current.inert = true; }
    concealed.current = true; setHidden(true); invalidateRead(); setSummary(null); setConfirmed(false); setError(''); setNotice('');
  }
  useEffect(() => {
    const blur = () => conceal(), visibility = () => { if (document.visibilityState !== 'visible') conceal(); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, blur);
    document.addEventListener('visibilitychange', visibility);
    const leave = (event: BeforeUnloadEvent) => { if (activeCommand.current || retained.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    if (sessionOwner.current !== sessionSubject) conceal();
    return () => { instance.current++; readEpoch.current++; readAbort.current?.abort(); activeCommand.current = null; for (const event of events) window.removeEventListener(event, blur); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', leave); };
  }, [sessionSubject]);
  useEffect(() => { if (hidden) shieldHeading.current?.focus(); else if (summary) finalHeading.current?.focus(); }, [hidden, summary]);
  function editScope(key: keyof KnownMembership, value: string): void {
    if (initialMembership || activeCommand.current || retained.current || concealed.current) return;
    invalidateRead(); setPreview(null); setDates(null); setSaved(null); setObserved(null); resetReview(); setError(''); setNotice(''); setScope(old => ({ ...old, [key]: value }));
  }
  async function review(input: Dates | Record<string, never> = {}): Promise<void> {
    if (activeCommand.current || retained.current || concealed.current) return;
    invalidateRead(); const run = readEpoch.current, controller = new AbortController(); readAbort.current = controller;
    setReading(true); setPreview(null); setObserved(null); setSaved(null); resetReview(); setError(''); setNotice('');
    try {
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      const next = await previewMembershipActivation(scope, input, controller.signal);
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      if (run !== readEpoch.current || concealed.current) return;
      setPreview(next); setDates({ startDate: next.proposedDates.startDate ?? '', endDate: next.proposedDates.endDate });
      reviewHeading.current?.focus();
    } catch (e) {
      if (run !== readEpoch.current) return;
      if (e instanceof PlanAccessError || e instanceof MembershipActivationError && [401, 403].includes(e.status)) conceal();
      setError(e instanceof MembershipActivationError ? e.message : 'Session, school access or activation preview could not be verified. Sign in if your session expired, then review again.');
    } finally { if (run === readEpoch.current) setReading(false); }
  }
  function changeDates(next: Dates): void {
    if (locked || concealed.current) return;
    invalidateRead(); setDates(next); setPreview(null); resetReview(); setError('');
    if (isSchoolLocalDate(next.startDate) && (next.endDate === null || isSchoolLocalDate(next.endDate))) void review(next);
    else setError('Enter valid school-local calendar dates to request a fresh preview.');
  }
  function finalReview(event: FormEvent): void {
    event.preventDefault(); if (!preview || reading || locked || concealed.current || !preview.canConfirm || !preview.proposedDates.startDate) return;
    try {
      if (preview.warnings.some(w => !warnings.includes(w.code))) throw new Error();
      if (preview.overridableWarnings.some(code => !preview.availableOverrides.includes(code)) || preview.overridableWarnings.length > 0 && !overrideConfirmed) throw new Error();
      if (preview.warnings.some(w => w.code === 'START_DATE_BACKDATED') && !details.trim()) throw new Error();
      const body = validateConfirmMembershipActivationInput({
        expectedVersion: preview.version, previewDigest: preview.previewDigest, startDate: preview.proposedDates.startDate, endDate: preview.proposedDates.endDate,
        dateSource: preview.proposedDates.dateSource, ...(preview.proposedDates.dateSource === 'STAFF_ADJUSTED' ? { dateAdjustmentReason: adjustment.trim() } : {}),
        acknowledgedWarnings: preview.warnings.map(w => w.code),
        overrides: preview.overridableWarnings.map(code => ({ code, reason: overrideReason.trim(), confirmation: MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION })),
        ...(adult && !preview.birthDateRecorded ? { adultVerification: { method: adultMethod, attestation: MEMBERSHIP_ADULT_VERIFICATION_ATTESTATION } } : {}),
        reasonCode: reason, ...(details.trim() ? { reasonText: details.trim() } : {}), confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION,
      });
      setSummary(body); setConfirmed(false); setError('');
    } catch { setError('Acknowledge every warning and complete the required reasons and confirmations before reviewing the final summary.'); }
  }
  async function activate(request: ActivationRequest): Promise<void> {
    if (activeCommand.current || concealed.current || retained.current && retained.current !== request) return;
    const retry = retained.current === request, life = instance.current, epoch = readEpoch.current; let sent = false;
    activeCommand.current = request; retained.current = request; setPending(request); setCommandBusy(true); setError(''); setNotice(''); setSummary(null); setConfirmed(false);
    try {
      await verifyEnrollmentSession(sessionOwner.current, AbortSignal.timeout(15_000));
      if (instance.current !== life || concealed.current || epoch !== readEpoch.current) return;
      sent = true;
      const result = await activateKnownMembership(request);
      if (instance.current !== life || activeCommand.current !== request) return;
      if (!concealed.current) await verifyEnrollmentSession(sessionOwner.current, AbortSignal.timeout(15_000));
      if (instance.current !== life || activeCommand.current !== request) return;
      retained.current = null; setPending(null); setSaved(result); setPreview(null); setDates(null); setObserved(null);
    } catch (e) {
      if (instance.current !== life || activeCommand.current !== request) return;
      const failure = e instanceof MembershipActivationError ? e : new MembershipActivationError('The outcome is unknown. Retry only the exact retained request.', 0, '', true);
      if (!retry && (!sent || !failure.uncertain && ![401, 403].includes(failure.status))) { retained.current = null; setPending(null); }
      setPreview(null); resetReview();
      if (e instanceof PlanAccessError || [401, 403].includes(failure.status)) conceal();
      setError(!sent && !retry ? 'Session verification failed before dispatch. No activation request was sent.' : failure.message);
    } finally {
      // Command ownership lasts for this component/session instance, NOT a read epoch.
      // Blur invalidates reads but must never prevent settlement behind the shield.
      if (instance.current === life && activeCommand.current === request) {
        if (!sent && !retry) { retained.current = null; setPending(null); }
        activeCommand.current = null; setCommandBusy(false);
      }
    }
  }
  async function restore(): Promise<void> {
    if (activeCommand.current || !concealed.current || reading) return;
    invalidateRead(); const run = readEpoch.current, attempt = ++restoreAttempt.current, life = instance.current, controller = new AbortController(); readAbort.current = controller; setReading(true); setError('');
    try {
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      const context = await loadMembershipActivationContext(retained.current?.scope ?? scope, controller.signal);
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      if (run !== readEpoch.current || !concealed.current || document.visibilityState !== 'visible') return;
      setObserved(context); setPreview(null); setDates(null); resetReview(); concealed.current = false; setHidden(false);
      setNotice('Session and exact-school activation access verified. Review again before a new command; an unknown request can only be retried explicitly.');
    } catch {
      // A real 401 broadcasts concealment and invalidates the read epoch before
      // it throws. Keep its generic refusal visible, but never accept a stale
      // restoration's error in another attempt, instance or revealed view.
      if (instance.current === life && restoreAttempt.current === attempt && concealed.current) setError('Access could not be verified. Information remains hidden. Sign in again if your session expired, or ask your school owner to restore access.');
    }
    finally { if (run === readEpoch.current) setReading(false); }
  }
  function discard(): void {
    if (activeCommand.current) return;
    retained.current = null; setPending(null); setPreview(null); setSaved(null); setDates(null); setObserved(null); resetReview();
    invalidateRead();
    // Abandonment clears recovery, not authorization. A concealed CRM-bound
    // selector must not reappear without a new protected read. Return to an
    // empty CRM instance instead; standalone entry can safely become blank.
    if (initialMembership) { if (onReturn) onReturn(); return; }
    setScope({ organizationId: '', schoolId: '', membershipId: '' }); concealed.current = false; setHidden(false);
    setNotice('Local recovery deliberately abandoned. No server action was canceled or undone. Verify current membership state before any new confirmation.');
  }
  const warningLabel = (w: MembershipActivationPreview['warnings'][number]) => `${activationWarning(preferences.language, w.code)}${w.days ? ` (${w.days} ${t('days')})` : ''}${w.planEndDate ? ` ${t('Plan suggestion: {date}.', { date: calendar(w.planEndDate) })}` : ''}`;
  const dateSummary = (start: string, end: string | null) => <dl><dt>{t("Starts · school-local date")}</dt><dd>{calendar(start)}</dd><dt>{t("Last valid day · inclusive")}</dt><dd>{calendar(end)}</dd></dl>;
  async function observe(): Promise<void> {
    if (activeCommand.current || retained.current || concealed.current || reading) return;
    invalidateRead(); const run = readEpoch.current, controller = new AbortController(); readAbort.current = controller;
    setReading(true); setPreview(null); setDates(null); setObserved(null); resetReview(); setError(''); setNotice('');
    try {
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      const context = await loadMembershipActivationContext(scope, controller.signal);
      await verifyEnrollmentSession(sessionOwner.current, controller.signal);
      if (run !== readEpoch.current || concealed.current) return;
      setObserved(context);
    } catch (e) {
      if (run !== readEpoch.current) return;
      if (e instanceof PlanAccessError || e instanceof MembershipActivationError && [401, 403].includes(e.status)) conceal();
      setError('Current membership state could not be verified. No current activation or effective status is assumed.');
    } finally { if (run === readEpoch.current) setReading(false); }
  }
  return <main className={`${styles.page} ${styles[`mode_${presentation}`]}`} data-membership-activation>
    <label>{t('Presentation')}<select aria-label={t('Presentation')} value={presentation} onChange={event => setPresentation(event.target.value as typeof presentation)}><option value="modern">{t('Modern')}</option><option value="classic">{t('Classic')}</option><option value="big">{t('Big Button')}</option></select></label>
    <div role="status" aria-live="polite" aria-atomic="true" className={`${styles.status} ${notice ? styles.notice : ''}`}>{commandBusy ? t('Activation request in progress') : reading ? t('Verifying current session, school access and membership facts…') : hidden ? t('Membership information hidden') : notice ? t(notice) : ''}</div>
    <nav aria-label={t("Membership navigation")}><a href="/staff/dashboard">{t("Staff dashboard")}</a><a href="/staff/crm/leads">{t("CRM enrollment")}</a></nav>
    {onReturn && <button type="button" disabled={locked || reading} onClick={() => { if (!activeCommand.current && !retained.current && !reading) onReturn(); }}>{t("Return to CRM registration")}</button>}
    <header><p>{t("DIRECT HUMAN STAFF · MEMBERSHIP LIFECYCLE")}</p><h1>{t("Review and confirm membership activation")}</h1><p>{t("1. Review the server preview. 2. Confirm this membership and its exact dates.")}</p></header>
    <aside><strong>{t("Membership confirmation is separate from financial enrollment.")}</strong><p>{t("This does not collect tuition, sign an agreement, record customer consent, authorize recurring payments or complete financial enrollment. No billing schedule is created. Card collection never authorizes recurring billing.")}</p></aside>
    {hidden ? <section aria-labelledby="activation-shield"><h2 id="activation-shield" tabIndex={-1} ref={shieldHeading}>{t("Membership information hidden")}</h2>
      <p>{t("Focus loss immediately conceals sensitive information. Verify your signed session and current exact-school activation access before revealing it. Commands are never resent automatically.")}</p>
      {commandBusy && <p role="status">{t("The in-flight command is settling safely. Verify access and Discard are unavailable until it settles.")}</p>}
      <button type="button" disabled={commandBusy || reading} onClick={() => void restore()}>{t("Verify access and resume")}</button>
      <a href="/auth/login">{t("Sign in again")}</a>
      <CrmEnrollmentDiscard disabled={commandBusy || reading} onDiscard={discard} label={t("Discard local activation view")} copy={discardCopy} />
    </section> : <div ref={privateArea} data-activation-private>
      <section><h2>{t("One already-known membership")}</h2><p>{t(initialMembership ? 'Membership reference selected from CRM; review current facts before confirming.' : 'Enter known IDs. Every read and command independently verifies current school authority. No record is loaded or activated from URL parameters.')}</p>
        <form onSubmit={event => { event.preventDefault(); void review(); }}><fieldset disabled={locked}>
          <div className={styles.row}>{(['organizationId', 'schoolId', 'membershipId'] as const).map(key => <label key={key}>{t(key === 'organizationId' ? 'Organization ID' : key === 'schoolId' ? 'School ID' : 'Already-known membership ID')}<input required maxLength={36} autoComplete="off" readOnly={Boolean(initialMembership)} value={scope[key]} onChange={event => editScope(key, event.target.value)} /></label>)}</div>
          <button type="submit" disabled={reading}>{t("Review activation")}</button>
        </fieldset></form>
      </section>
      {observed && <section><h2>{t("Current membership observation")}</h2><p>{t(observed.state)} · {t('version {version}', { version: observed.version })}. {t('This live observation is separate from any historical confirmation receipt. ACTIVE alone does not prove current effective dates, payment or agreement.')}</p></section>}
      {dates && !saved && <section><h2>{t("Membership dates")}</h2><p>{t("Dates use the school timezone. The end is the last valid membership day. Every valid edit requests a fresh preview and clears all previous acknowledgements.")}</p>
        <fieldset disabled={locked}><div className={styles.row}>
          <label>{t("Start date")}<input type="date" required value={dates.startDate} onChange={event => changeDates({ ...dates, startDate: event.target.value })} /></label>
          <label>{t("Last valid day (inclusive)")}<input type="date" value={dates.endDate ?? ''} onChange={event => changeDates({ ...dates, endDate: event.target.value || null })} /></label>
        </div><p>{t("Leave the last day blank to request an open-ended term. The backend decides whether this plan supports it.")}</p></fieldset>
      </section>}
      {preview && <section aria-labelledby="activation-review"><h2 id="activation-review" tabIndex={-1} ref={reviewHeading}>{t("Step 1 · Review activation")}</h2>
        <dl><dt>{t("Student")}</dt><dd>{preview.participantDisplayName ?? t('Name unavailable')}</dd><dt>{t("Membership plan")}</dt><dd>{typeof preview.plan?.terms?.displayName === 'string' ? preview.plan.terms.displayName : preview.planCode} · {preview.planCode}{preview.plan ? ` · ${t('published version {version}', { version: preview.plan.membershipPlanVersion })}` : ''}</dd>
          <dt>{t("Membership source")}</dt><dd>{activationSource(preferences.language, preview.source)}</dd><dt>{t("Current membership status")}</dt><dd>{t(preview.state)} · {t('version {version}', { version: preview.version })}</dd>
          <dt>{t("School timezone")}</dt><dd>{preview.schoolTimezone} · {t('Today:')} {calendar(preview.localToday)}</dd><dt>{t("Suggested start")}</dt><dd>{calendar(preview.suggestedDates.startDate)} · {t(preview.suggestedDates.startBasis.replaceAll('_', ' '))}</dd><dt>{t("Suggested last day (inclusive)")}</dt><dd>{calendar(preview.suggestedDates.endDate)} · {t(preview.suggestedDates.endBasis.replaceAll('_', ' '))}</dd>
          <dt>{t("Projected effective status if confirmed now")}</dt><dd>{t(preview.effectiveStatusIfConfirmedNow ?? 'Unavailable')}</dd></dl>
        {preview.effectiveStatusIfConfirmedNow === 'SCHEDULED' && <p>{t('Confirmation would schedule this membership to begin {date}. It is not currently IN_EFFECT.', { date: calendar(preview.proposedDates.startDate) })}</p>}
        {preview.blocks.length > 0 && <div className={styles.error}><h3>{t("Activation blockers")}</h3><ul>{preview.blocks.map(b => <li key={b.code}>{activationBlock(preferences.language, b.code)} <small>({b.code})</small></li>)}</ul></div>}
        <form onSubmit={finalReview}><fieldset disabled={locked || reading || summary !== null}>
          <h3>{t("Warnings requiring acknowledgement")}</h3>{preview.warnings.length === 0 ? <p>{t("No warnings were returned.")}</p> : preview.warnings.map(w => <label className={styles.check} key={w.code}><input type="checkbox" checked={warnings.includes(w.code)} onChange={event => { setWarnings(old => event.target.checked ? [...old, w.code] : old.filter(c => c !== w.code)); setConfirmed(false); }} />{warningLabel(w)}</label>)}
          {preview.overridableWarnings.length > 0 && (preview.overridableWarnings.every(code => preview.availableOverrides.includes(code)) ? <div className={styles.override}><h3>{t("Authorized identity-review override")}</h3><p>{t("Review remains unresolved. No identities will be merged, deleted or reassigned. A follow-up work item will be recorded.")}</p>
            <label>{t("Identity override reason (10–500 characters)")}<textarea minLength={10} maxLength={500} required value={overrideReason} onChange={event => setOverrideReason(event.target.value)} /></label>
            <label className={styles.check}><input type="checkbox" checked={overrideConfirmed} onChange={event => setOverrideConfirmed(event.target.checked)} />{t("I separately confirm that this identity review remains unresolved.")}</label></div>
            : <p role="note">{t("Your preview does not authorize an identity override. An appropriately authorized staff member must review; no override control is available.")}</p>)}
          {!preview.birthDateRecorded && <div><p>{t("A birth-date follow-up reminder will be created. No birth date or customer consent is fabricated.")}</p><label className={styles.check}><input type="checkbox" checked={adult} onChange={event => setAdult(event.target.checked)} />{t("Optional: I attest that staff verified this participant is an adult.")}</label>
            {adult && <label>{t("Adult verification method")}<select value={adultMethod} onChange={event => setAdultMethod(event.target.value as typeof adultMethod)}>{MEMBERSHIP_ADULT_VERIFICATION_METHODS.map(method => <option value={method} key={method}>{t(method.replaceAll('_', ' '))}</option>)}</select></label>}</div>}
          {preview.proposedDates.dateSource === 'STAFF_ADJUSTED' && <label>{t("Date adjustment reason")}<textarea required maxLength={500} value={adjustment} onChange={event => setAdjustment(event.target.value)} /></label>}
          <label>{t("Activation reason")}<select value={reason} onChange={event => setReason(event.target.value as typeof reason)}>{MEMBERSHIP_ACTIVATION_REASON_CODES.map(code => <option value={code} key={code}>{activationReason(preferences.language, code)}</option>)}</select></label>
          <label>{t("Activation reason details")}{t(reason === 'OTHER' || preview.warnings.some(w => w.code === 'START_DATE_BACKDATED') ? ' (required)' : ' (optional)')}<textarea maxLength={500} required={reason === 'OTHER' || preview.warnings.some(w => w.code === 'START_DATE_BACKDATED')} value={details} onChange={event => setDetails(event.target.value)} /></label>
          <h3>{t("Requirements not evaluated")}</h3><ul>{preview.requirementsNotEvaluated.map(item => <li key={item}>{activationRequirement(preferences.language, item)}</li>)}</ul>
          <button type="submit" disabled={!preview.canConfirm || preview.warnings.some(w => !warnings.includes(w.code)) || preview.overridableWarnings.some(code => !preview.availableOverrides.includes(code))}>{t("Review final confirmation")}</button>
        </fieldset></form>
      </section>}
      {summary && preview && <section aria-labelledby="activation-final"><h2 id="activation-final" tabIndex={-1} ref={finalHeading}>{t("Step 2 · Confirm activation")}</h2>
        <p>{preview.participantDisplayName ?? t('Name unavailable')} · {preview.planCode} · {activationSource(preferences.language, preview.source)} · {preview.schoolTimezone}</p>{dateSummary(summary.startDate, summary.endDate)}
        <p>{t("Projected effective status:")} <strong>{t(preview.effectiveStatusIfConfirmedNow ?? 'Unavailable')}</strong>. {t('The server will revalidate these exact reviewed facts.')}</p>
        <p>{t("Reason:")} {activationReason(preferences.language, summary.reasonCode)}{summary.reasonText ? ` · ${summary.reasonText}` : ''}</p>{summary.dateAdjustmentReason && <p>{t("Date adjustment:")} {summary.dateAdjustmentReason}</p>}
        <ul>{summary.acknowledgedWarnings.map(code => <li key={code}>{t("Acknowledged:")} {activationWarning(preferences.language, code)}</li>)}{summary.overrides.map(o => <li key={o.code}>{t("Unresolved identity override:")} {o.reason}</li>)}</ul>
        {summary.adultVerification && <p>{t("Optional staff adult attestation:")} {t(summary.adultVerification.method.replaceAll('_', ' '))}. {t('No birth date is recorded.')}</p>}
        <p>{t("No agreement, signature, customer consent, payment or recurring-payment authorization is recorded.")}</p>
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("I confirm this membership and the exact dates above, without recording agreement, consent or payment.")}</label>
        <div className={styles.actions}><button type="button" disabled={!confirmed || locked || reading} onClick={() => { if (!confirmed || activeCommand.current || retained.current || concealed.current) return; try { void activate(prepareMembershipActivation(scope, summary, crypto.randomUUID())); } catch { setError('Confirmation could not be prepared. Review the current preview again.'); } }}>{t("Confirm membership activation")}</button>
          <button type="button" disabled={locked} onClick={() => { setSummary(null); setConfirmed(false); }}>{t("Back to review")}</button></div>
      </section>}
      {pending && <section><h2>{t(commandBusy ? 'Activation request in progress' : 'Activation outcome unknown')}</h2><p>{t("No unverified activation is assumed. The immutable request and original idempotency key remain in memory only. There is no automatic retry.")}</p>
        <button type="button" disabled={commandBusy} onClick={() => void activate(pending)}>{t("Retry exact retained activation")}</button><CrmEnrollmentDiscard disabled={commandBusy} onDiscard={discard} label={t("Discard activation retry")} copy={discardCopy} />
      </section>}
      {saved && <section aria-labelledby="activation-receipt"><h2 id="activation-receipt">{t("Membership confirmation receipt")}</h2>
        <p>{saved.receipt.effectiveStatusAtActivation === 'SCHEDULED' ? t('Membership confirmed — scheduled to begin {date}.', { date: calendar(saved.receipt.effectivePeriod.startDate) }) : t(saved.receipt.effectiveStatusAtActivation === 'ENDED' ? 'Membership confirmed — its recorded effective period has ended.' : 'Membership confirmed — IN_EFFECT at the recorded confirmation time.')}</p>
        <p>{t('Lifecycle ACTIVE · version {version}', { version: saved.receipt.version })}{saved.replayed ? ` · ${t('idempotent replay')}` : ''}. {t('This is historical confirmation evidence; it is not a new current-state read.')}</p>
        {dateSummary(saved.receipt.effectivePeriod.startDate, saved.receipt.effectivePeriod.endDate)}<p>{t("School timezone:")} {saved.receipt.effectivePeriod.schoolTimezone}. {t('Confirmation recorded:')} {date(saved.receipt.recordedAt)}.</p>
        <h3>{t("Warnings acknowledged")}</h3><ul>{saved.receipt.acknowledgedWarnings.map(code => <li key={code}>{activationWarning(preferences.language, code)}</li>)}</ul>
        <h3>{t("Overrides used")}</h3>{saved.receipt.overridesUsed.length === 0 ? <p>{t("None.")}</p> : <p>{t("Identity-review override recorded. The review remains unresolved.")}</p>}
        <h3>{t("Follow-up reminders")}</h3>{saved.receipt.followUps.length === 0 ? <p>{t("No reminders returned.")}</p> : <ul>{saved.receipt.followUps.map(item => <li key={item.workItemId}>{t(item.kind === 'BIRTH_DATE_MISSING' ? 'Record birth date for an activated membership' : 'Resolve outstanding identity review')} · {t('Work item')} {item.workItemId}</li>)}</ul>}
        <h3>{t("Requirements not evaluated")}</h3><ul>{saved.receipt.requirementsNotEvaluated.map(item => <li key={item}>{activationRequirement(preferences.language, item)}</li>)}</ul>
        <p>{t("This is not payment, agreement, consent, recurring authorization or financially complete enrollment evidence.")}</p>
      </section>}
      <section><button type="button" disabled={locked || reading} onClick={() => void observe()}>{t("Check current membership status")}</button>
        <p>{t("Current lifecycle observation; effective status, payment and agreement are not verified by this read.")}</p></section>
      {saved && <section><h2>{t("Continue school operations")}</h2><p>{t("These links do not book a class, record attendance or prove payment.")}</p><a href="/staff/schedule/bookings">{t("Class bookings")}</a><a href="/staff/attendance">{t("Attendance")}</a></section>}
    </div>}
    {reading && <p role="status">{t("Verifying current session, school access and membership facts…")}</p>}
    {error && <p role="alert" className={styles.error}>{t(error)}</p>}
  </main>;
}
