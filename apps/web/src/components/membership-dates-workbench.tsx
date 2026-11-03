'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MEMBERSHIP_DATE_REVISION_CONFIRMATION, MEMBERSHIP_DATE_REVISION_REASON_CODES, isSchoolLocalDate, validateConfirmMembershipDateRevisionInput,
  type MembershipDateChangeKind, type MembershipDateRevisionPreview, type MembershipDateHistory,
  type MembershipDateConfirmationQueue, type SchoolMembershipStatusSummary, type ConfirmMembershipDateRevisionInput,
} from '@hon/contracts';
import { formatLocaleCalendarDate } from '@hon/design-system';
import { useLocale } from './localization/provider';
import { verifyEnrollmentSession } from './crm-enrollment-privacy';
import { PlanAccessError } from './membership-plans/http';
import { CrmEnrollmentDiscard } from './crm-enrollment-discard';
import { type KnownMembership } from './membership-activation-http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import { loadMembershipDateHistory, loadMembershipDateQueue, loadMembershipStatusSummary, previewMembershipDates, prepareMembershipDateRevision,
  reviseMembershipDates, MembershipDatesError, type DateRequest, type DateResult } from './membership-dates-http';
import { dateText, dateCodeText } from './membership-dates-copy';
import { activationRequirement } from './membership-activation-catalog';
import styles from './membership-dates-workbench.module.css';

type Dates = { startDate: string; endDate: string | null };
type View = 'membership' | 'queue' | 'summary';
const kinds: Record<MembershipDateChangeKind, string> = { INITIAL_CONFIRMATION: 'Confirm dates', CORRECTION: 'Correct dates', EXTENSION: 'Extend', EARLY_END: 'End early' };
export function MembershipDatesWorkbench({ sessionSubject, initialMembership, onReturn, onAbandon }: { sessionSubject?: string; initialMembership?: KnownMembership; onReturn?(): void; onAbandon?(): void }): React.ReactElement {
  const { preferences, date, number } = useLocale();
  const t = (key: string, vars?: Readonly<Record<string, string | number>>) => dateText(preferences?.language, key, vars);
  const readable = (code: string) => dateCodeText(preferences?.language, code);
  const [presentation, setPresentation] = useState<'modern' | 'classic' | 'big'>('modern');
  const discardCopy = { description: t('An action may already have completed. Discard permanently removes its local retry information; it does not cancel or undo a server action. Retry the exact request to resolve an unknown outcome, or deliberately abandon local recovery and verify saved setup before any new action.'), confirmation: t('I understand and deliberately abandon local recovery.') };
  const calendar = (value: string | null) => value === null ? t('Open-ended · no last day') : formatLocaleCalendarDate(preferences, value);
  const instant = (value: string | null) => value === null ? t('Not stored') : date(value);
  const [scope, setScope] = useState<KnownMembership>(() => initialMembership ? { organizationId: initialMembership.organizationId, schoolId: initialMembership.schoolId, membershipId: initialMembership.membershipId } : { organizationId: '', schoolId: '', membershipId: '' });
  const [history, setHistory] = useState<MembershipDateHistory | null>(null), [preview, setPreview] = useState<MembershipDateRevisionPreview | null>(null);
  const [queue, setQueue] = useState<MembershipDateConfirmationQueue | null>(null), [report, setReport] = useState<SchoolMembershipStatusSummary | null>(null);
  const [dates, setDates] = useState<Dates | null>(null), [kind, setKind] = useState<MembershipDateChangeKind>('CORRECTION'), [canRevise, setCanRevise] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string[]>([]), [reasonCode, setReasonCode] = useState(''), [reason, setReason] = useState(''), [adjustment, setAdjustment] = useState('');
  const [summary, setSummary] = useState<ConfirmMembershipDateRevisionInput | null>(null), [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<DateRequest | null>(null), [saved, setSaved] = useState<DateResult | null>(null);
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false), [hidden, setHidden] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const epoch = useRef(0), abort = useRef<AbortController | null>(null), instance = useRef(0), concealed = useRef(false), sensitive = useRef(false);
  const active = useRef<DateRequest | null>(null), retained = useRef<DateRequest | null>(null), lastView = useRef<View>('membership');
  const shieldHeading = useRef<HTMLHeadingElement | null>(null), finalHeading = useRef<HTMLHeadingElement | null>(null);
  const entryHeading = useRef<HTMLHeadingElement | null>(null);
  const privateView = useRef<HTMLDivElement | null>(null);
  const locked = busy || pending !== null;
  sensitive.current = !!(scope.organizationId || scope.schoolId || scope.membershipId || history || preview || queue || report || saved || pending || reading);
  const school = () => ({ organizationId: scope.organizationId, schoolId: scope.schoolId });
  function resetReview(): void { setSummary(null); setConfirmed(false); setAcknowledged([]); setReason(''); setReasonCode(''); setAdjustment(''); }
  function invalidate(): void { epoch.current++; abort.current?.abort(); setReading(false); }
  function conceal(): void {
    if (!sensitive.current) return;
    // React may batch state updates; hide protected content synchronously on lifecycle events.
    if (privateView.current) { privateView.current.hidden = true; privateView.current.inert = true; }
    concealed.current = true; setHidden(true); invalidate(); setSummary(null); setConfirmed(false); setError(''); setNotice('');
  }
  useEffect(() => {
    const blur = () => conceal(), visibility = () => { if (document.visibilityState !== 'visible') conceal(); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, blur);
    document.addEventListener('visibilitychange', visibility);
    return () => { instance.current++; epoch.current++; abort.current?.abort(); active.current = null; for (const event of events) window.removeEventListener(event, blur); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionSubject]);
  useEffect(() => { if (hidden) shieldHeading.current?.focus(); else if (summary) finalHeading.current?.focus(); }, [hidden, summary]);
  useEffect(() => { if (initialMembership) entryHeading.current?.focus(); }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (active.current || retained.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  function editScope(key: keyof KnownMembership, value: string): void {
    if (initialMembership || active.current || retained.current || concealed.current) return;
    invalidate(); setHistory(null); setPreview(null); setQueue(null); setReport(null); setDates(null); setSaved(null); setCanRevise(false); resetReview(); setError(''); setNotice('');
    setScope(old => ({ ...old, [key]: value }));
  }
  function startRead(): { run: number; controller: AbortController } {
    invalidate(); const controller = new AbortController(); abort.current = controller; setReading(true); setError(''); setNotice('');
    return { run: epoch.current, controller };
  }
  function readFailure(e: unknown, run: number): void {
    if (run !== epoch.current) return;
    if (e instanceof PlanAccessError || e instanceof MembershipDatesError && [401, 403].includes(e.status)) conceal();
    setError(e instanceof MembershipDatesError ? e.message : 'The signed session, school permission or response could not be verified. No new action is available; sign in again if needed.');
  }
  async function review(nextKind: MembershipDateChangeKind, selected?: Dates, target = scope): Promise<void> {
    if (active.current || retained.current || concealed.current) return;
    // 0178 only suggests dates for legacy stored terms or fixed-term extensions.
    // CORRECTION/EARLY_END require explicit dates; never invent them or assume every kind has a suggestion.
    const fixedExtension = nextKind === 'EXTENSION' && preview?.plan?.terms?.termKind === 'FIXED_MONTHS';
    const fallback = history?.currentPeriod ? { startDate: history.currentPeriod.startDate, endDate: history.currentPeriod.endDate } : dates?.startDate ? dates : undefined;
    const proposed = selected ?? (fixedExtension ? undefined : fallback);
    if (!proposed && !(nextKind === 'INITIAL_CONFIRMATION' && history?.legacyStoredTerm?.termStartedAt) && !fixedExtension) {
      invalidate(); setKind(nextKind); setDates({ startDate: '', endDate: null }); setPreview(null); resetReview();
      setError('Enter staff-verified dates to request a preview. HON has no suggested dates for this record.'); return;
    }
    const { run, controller } = startRead(); setPreview(null); setCanRevise(false); resetReview(); lastView.current = 'membership';
    try {
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      const data = await previewMembershipDates(target, { changeKind: nextKind, ...(proposed ?? {}) }, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      setPreview(data); setKind(nextKind); setCanRevise(data.state === 'ACTIVE');
      setDates({ startDate: data.proposedDates.startDate ?? '', endDate: data.proposedDates.endDate });
    } catch (e) { readFailure(e, run); }
    finally { if (run === epoch.current) setReading(false); }
  }
  async function load(target = scope): Promise<void> {
    if (active.current || retained.current || concealed.current) return;
    const { run, controller } = startRead(); setHistory(null); setPreview(null); setQueue(null); setReport(null); setDates(null); setSaved(null); setCanRevise(false); resetReview(); lastView.current = 'membership';
    try {
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      const next = await loadMembershipDateHistory(target, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      // A successful preview is the server-backed capability check. Read-only staff can still see authorized history.
      let candidate: MembershipDateRevisionPreview | null = null;
      const nextKind = next.datesConfirmed ? 'CORRECTION' : 'INITIAL_CONFIRMATION';
      if (next.state === 'ACTIVE' && (next.currentPeriod || next.legacyStoredTerm?.termStartedAt)) {
        try { candidate = await previewMembershipDates(target, { changeKind: nextKind, ...(next.currentPeriod ? { startDate: next.currentPeriod.startDate, endDate: next.currentPeriod.endDate } : {}) }, controller.signal); }
        catch (e) { if (!(e instanceof MembershipDatesError && e.status === 403)) throw e; }
      }
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      setScope(target); setHistory(next); setPreview(candidate); setCanRevise(candidate !== null);
      setKind(nextKind);
      if (!candidate && next.state === 'ACTIVE' && !next.currentPeriod) setDates({ startDate: '', endDate: null });
      if (candidate) { setKind(candidate.changeKind); setDates({ startDate: candidate.proposedDates.startDate ?? '', endDate: candidate.proposedDates.endDate }); }
    } catch (e) { readFailure(e, run); }
    finally { if (run === epoch.current) setReading(false); }
  }
  async function auxiliary(view: 'queue' | 'summary', after?: string): Promise<void> {
    if (active.current || retained.current || concealed.current) return;
    const { run, controller } = startRead(); setHistory(null); setPreview(null); setDates(null); setSaved(null); setCanRevise(false); setQueue(null); setReport(null); resetReview(); lastView.current = view;
    try {
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || concealed.current) return;
      if (view === 'queue') { const data = await loadMembershipDateQueue(school(), { ...(after ? { after } : {}), limit: 10 }, controller.signal); await verifyEnrollmentSession(sessionSubject, controller.signal); if (run === epoch.current && !concealed.current) setQueue(data); }
      else { const data = await loadMembershipStatusSummary(school(), controller.signal); await verifyEnrollmentSession(sessionSubject, controller.signal); if (run === epoch.current && !concealed.current) setReport(data); }
    } catch (e) { readFailure(e, run); }
    finally { if (run === epoch.current) setReading(false); }
  }
  function changeDates(next: Dates): void {
    if (locked || concealed.current) return;
    invalidate(); setDates(next); setPreview(null); resetReview(); setError('');
    if (isSchoolLocalDate(next.startDate) && (next.endDate === null || isSchoolLocalDate(next.endDate)) && (next.endDate === null || next.endDate >= next.startDate)) void review(kind, next);
    else setError('Enter valid school-local dates; the inclusive last day cannot precede the start. A fresh preview is required.');
  }
  function finalReview(event: FormEvent): void {
    event.preventDefault(); if (!preview || !preview.canConfirm || preview.blocks.length || !preview.proposedDates.startDate || reading || locked || concealed.current) return;
    try {
      if (preview.warnings.some(w => !acknowledged.includes(w.code))) throw new Error();
      const body = validateConfirmMembershipDateRevisionInput({ expectedVersion: preview.version, expectedPeriodVersion: preview.currentPeriod?.periodVersion ?? null,
        previewDigest: preview.previewDigest, changeKind: preview.changeKind, startDate: preview.proposedDates.startDate, endDate: preview.proposedDates.endDate,
        dateSource: preview.proposedDates.dateSource, ...(preview.proposedDates.dateSource === 'STAFF_ADJUSTED' ? { dateAdjustmentReason: adjustment.trim() } : {}),
        acknowledgedWarnings: preview.warnings.map(w => w.code), reasonCode, reasonText: reason.trim(), confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION });
      setSummary(body); setConfirmed(false); setError('');
    } catch { setError('Acknowledge every warning and provide the applicable reason and required date-adjustment explanation (10–500 characters).'); }
  }
  async function revise(request: DateRequest, retry = false): Promise<void> {
    if (active.current || concealed.current || retry && retained.current !== request || retained.current && retained.current !== request) return;
    const life = instance.current; active.current = request; retained.current = request; setPending(request); setBusy(true); setError(''); setNotice(''); setSummary(null); setConfirmed(false);
    try {
      // Recheck identity on every explicit attempt, including retries; the API independently rechecks school permissions.
      await verifyEnrollmentSession(sessionSubject, AbortSignal.timeout(15_000));
      if (instance.current !== life || active.current !== request) return;
      // Focus loss during identity verification must not start a command behind the shield.
      if (concealed.current) { setNotice('No command was sent. Verify access, then explicitly retry the retained request.'); return; }
      const result = await reviseMembershipDates(request);
      if (instance.current !== life || active.current !== request) return;
      await verifyEnrollmentSession(sessionSubject, AbortSignal.timeout(15_000));
      if (instance.current !== life || active.current !== request) return;
      retained.current = null; setPending(null); setSaved(result); setPreview(null); setDates(null); setHistory(null); setCanRevise(false);
    } catch (e) {
      if (instance.current !== life || active.current !== request) return;
      if (e instanceof PlanAccessError) { conceal(); setError('Session identity could not be verified. The exact request remains in memory; sign in again and verify access.'); }
      else {
        const failure = e instanceof MembershipDatesError ? e : new MembershipDatesError('The result is unknown. Retry only the exact retained request.', 0, '', true);
        if (!failure.uncertain && ![401, 403].includes(failure.status)) { retained.current = null; setPending(null); }
        setPreview(null); setCanRevise(false); resetReview();
        if ([401, 403].includes(failure.status)) conceal();
        setError(failure.message);
      }
    } finally {
      // Instance/command ownership is intentionally independent of read epochs: blur cannot strand a settled command.
      if (instance.current === life && active.current === request) { active.current = null; setBusy(false); }
    }
  }
  async function restore(): Promise<void> {
    if (active.current || !concealed.current || reading) return;
    const { run, controller } = startRead();
    try {
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || !concealed.current) return;
      const target = retained.current?.scope ?? scope;
      let nextHistory: MembershipDateHistory | null = null, nextQueue: MembershipDateConfirmationQueue | null = null, nextReport: SchoolMembershipStatusSummary | null = null;
      if (lastView.current === 'membership') {
        nextHistory = await loadMembershipDateHistory(target, controller.signal);
        if (retained.current) {
          const input = JSON.parse(retained.current.body) as ConfirmMembershipDateRevisionInput;
          await previewMembershipDates(target, { changeKind: input.changeKind, startDate: input.startDate, endDate: input.endDate }, controller.signal);
        }
      } else if (lastView.current === 'queue') nextQueue = await loadMembershipDateQueue(school(), { limit: 10 }, controller.signal);
      else nextReport = await loadMembershipStatusSummary(school(), controller.signal);
      await verifyEnrollmentSession(sessionSubject, controller.signal);
      if (run !== epoch.current || !concealed.current || document.visibilityState !== 'visible') return;
      setHistory(nextHistory); setQueue(nextQueue); setReport(nextReport); setPreview(null); setDates(null); setCanRevise(false); resetReview(); concealed.current = false; setHidden(false);
      setNotice('Session and current exact-school access verified. Historical receipts are separate from current history. Review again before a new change; retry is always explicit.');
    } catch { if (run === epoch.current) setError('Access could not be verified. Information remains hidden. Sign in again or ask the school owner to restore permission.'); }
    finally { if (run === epoch.current) setReading(false); }
  }
  function discard(): void {
    if (active.current) return;
    retained.current = null; setPending(null); setSaved(null); setHistory(null); setPreview(null); setQueue(null); setReport(null); setDates(null); setCanRevise(false); resetReview();
    if (initialMembership && (onAbandon || onReturn)) { invalidate(); (onAbandon ?? onReturn)!(); return; }
    setScope({ organizationId: '', schoolId: '', membershipId: '' }); invalidate(); concealed.current = false; setHidden(false); setError('');
    setNotice('Local recovery deliberately abandoned. This does not cancel or reverse any server action. Verify current membership history before another change.');
  }
  const period = (start: string, end: string | null, zone: string) => <dl><dt>{t("Starts · school-local date")}</dt><dd>{calendar(start)}</dd><dt>{t("Last valid day · inclusive")}</dt><dd>{calendar(end)}</dd><dt>{t("School timezone")}</dt><dd>{zone}</dd></dl>;
  const confirmationEpoch = epoch.current, confirmationLife = instance.current;
  return <main className={`${styles.page} ${styles[`mode_${presentation}`]}`} data-membership-dates>
    <label>{t('Presentation')}<select aria-label={t('Presentation')} value={presentation} onChange={event => setPresentation(event.target.value as typeof presentation)}><option value="modern">{t('Modern')}</option><option value="classic">{t('Classic')}</option><option value="big">{t('Big Button')}</option></select></label>
    <div role="status" aria-live="polite" aria-atomic="true" className={styles.status}>{busy ? t('Date change in progress') : reading ? t('Verifying current session and authorized school facts…') : hidden ? t('Membership information hidden') : notice ? t(notice) : ''}</div>
    {onReturn && <button type="button" disabled={locked || reading || hidden} onClick={() => { if (!active.current && !retained.current && !concealed.current && !reading) onReturn(); }}>{t('Return to activation review')}</button>}
    <nav aria-label={t("Membership navigation")}><a href="/staff/billing/memberships">{t("Activation")}</a><a href="/staff/crm/leads">{t("CRM enrollment")}</a><a href="/staff/dashboard">{t("Staff dashboard")}</a></nav>
    <header><p>{t("DIRECT HUMAN STAFF · MEMBERSHIP DATES")}</p><h1 ref={entryHeading} tabIndex={-1}>{t("Membership dates and history")}</h1><p>{t("Review one confirmed membership, then explicitly confirm its school-local dates.")}</p></header>
    <aside><strong>{t("A date revision changes dates only.")}</strong><p>{t("No payment, refund, credit, invoice, schedule, agreement, consent or entitlement is created or changed. Extending a membership is not a paid renewal. Internal DRAFTs are never published to parents here.")}</p></aside>
    {hidden ? <section aria-labelledby="dates-shield"><h2 id="dates-shield" ref={shieldHeading} tabIndex={-1}>{t("Membership information hidden")}</h2>
      <p>{t("Verify your signed session and current school permissions before revealing information. Nothing is resent automatically.")}</p>
      {busy && <p role="status">{t("The in-flight command is settling safely. Restoration and Discard remain unavailable until settlement.")}</p>}
      <button type="button" disabled={busy || reading} onClick={() => void restore()}>{t("Verify access and resume")}</button><a href="/auth/login">{t("Sign in again")}</a>
      <CrmEnrollmentDiscard disabled={busy || reading} onDiscard={discard} label={t("Discard local date view")} copy={discardCopy} />
    </section> : <div ref={privateView} data-dates-private>
      <section><h2>{t("School and membership reference")}</h2><p>{t(initialMembership ? 'Membership reference selected from an authorized current-state review. Load current history explicitly; this selection grants no authority.' : "Enter known identifiers. Selectors confer no authority. No data or command is loaded from a URL.")}</p>
        <form onSubmit={event => { event.preventDefault(); void load(); }}><fieldset disabled={locked}>
          <div className={styles.row}>{(['organizationId', 'schoolId', 'membershipId'] as const).map(key => <label key={key}>{key === 'organizationId' ? t("Organization ID") : key === 'schoolId' ? t("School ID") : t("Already-known membership ID")}<input autoComplete="off" maxLength={36} required readOnly={Boolean(initialMembership)} value={scope[key]} onChange={event => editScope(key, event.target.value)} /></label>)}</div>
          <button type="submit" disabled={reading}>{t("Load membership dates")}</button>
          <div className={styles.actions}><button type="button" disabled={reading} onClick={() => void auxiliary('queue')}>{t("Review legacy date queue")}</button><button type="button" disabled={reading} onClick={() => void auxiliary('summary')}>{t("Load status summary")}</button></div>
        </fieldset></form>
      </section>
      {history && <section><h2>{t("Verified current membership")}</h2><p>{t(history.effectiveStatus)} {t(" · lifecycle ")}{t(history.state)} {t(" · membership version ")}{history.version} {t(" · observed on ")}{calendar(history.localToday)}</p>
        {history.currentPeriod ? period(history.currentPeriod.startDate, history.currentPeriod.endDate, history.currentPeriod.schoolTimezone) : <p>{t("No confirmed period. Stored legacy instants are unconfirmed hints: start ")}{instant(history.legacyStoredTerm?.termStartedAt ?? null)}{t("; exclusive end instant ")}{instant(history.legacyStoredTerm?.termEndsAt ?? null)}{t(". These are not confirmed calendar dates.")}</p>}
        {!canRevise && !reading && <p>{t("Date-change controls require a successful server-authorized preview. ")}<button type="button" disabled={locked || history.state !== 'ACTIVE'} onClick={() => void review(history.datesConfirmed ? 'CORRECTION' : 'INITIAL_CONFIRMATION')}>{t("Check date revision access")}</button></p>}
        {canRevise && <div className={styles.actions}>{(history.datesConfirmed ? ['CORRECTION', 'EXTENSION', 'EARLY_END'] as const : ['INITIAL_CONFIRMATION'] as const).map(value => <button type="button" key={value} disabled={locked || reading} onClick={() => void review(value)}>{t(kinds[value])}</button>)}</div>}
        <h3>{t("Date history · newest first")}</h3>{history.versions.length === 0 ? <p>{t("No confirmed date history is available.")}</p> : <ol>{history.versions.map(v => <li key={v.periodVersion}><strong>{t("Period ")}{v.periodVersion} · {readable(v.changeKind)}</strong>{period(v.startDate, v.endDate, v.schoolTimezone)}<p>{v.actorDisplayName ?? t("Actor name unavailable")} · {instant(v.recordedAt)} · {readable(v.reasonCode)}</p>{v.reasonText && <p>{v.reasonText}</p>}{v.retroactiveDays && <p>{t("Past days added ")}{number(v.retroactiveDays.added)} {t(" · removed ")}{number(v.retroactiveDays.removed)}</p>}{v.acknowledgedWarnings.length > 0 && <p>{t("Warnings acknowledged: ")}{v.acknowledgedWarnings.map(readable).join('; ')}</p>}</li>)}</ol>}
      </section>}
      {dates && !saved && <section><h2>{t(kinds[kind])}</h2><p>{t("Every valid date edit requests a fresh preview and clears previous acknowledgements. A blank last day requests open-ended dates only if the backend permits them.")}</p>
        <fieldset disabled={locked}><div className={styles.row}><label>{t("Start date")}<input type="date" value={dates.startDate} onChange={event => changeDates({ ...dates, startDate: event.target.value })} /></label><label>{t("Last valid day (inclusive)")}<input type="date" value={dates.endDate ?? ''} onChange={event => changeDates({ ...dates, endDate: event.target.value || null })} /></label></div></fieldset>
      </section>}
      {preview && <section><h2>{t("Step 1 · Review date change")}</h2><dl><dt>{t("Student")}</dt><dd>{preview.participantDisplayName ?? t("Name unavailable")}</dd><dt>{t("Published plan")}</dt><dd>{typeof preview.plan?.terms?.displayName === 'string' ? preview.plan.terms.displayName : preview.planCode} · {preview.planCode}{preview.plan ? ` · ${t('version {value}', { value: number(preview.plan.membershipPlanVersion) })}` : ''}</dd><dt>{t("Current effective status")}</dt><dd>{t(preview.effectiveStatusNow)}</dd><dt>{t("If confirmed now")}</dt><dd>{preview.effectiveStatusIfConfirmedNow ? t(preview.effectiveStatusIfConfirmedNow) : t("Unavailable")}</dd><dt>{t("Required permissions")}</dt><dd>{preview.requiredPermissions.map(code => t(code === 'billing.membership.dates.retroactive' ? 'Retroactive date permission' : 'Date revision permission')).join(', ')}</dd><dt>{t("Past days added / removed")}</dt><dd>{number(preview.retroactiveDays.added)} / {number(preview.retroactiveDays.removed)}</dd></dl>
        {preview.suggestedDates && <div><h3>{t("Suggested dates · ")}{readable(preview.suggestedDates.endBasis)}</h3>{period(preview.suggestedDates.startDate, preview.suggestedDates.endDate, preview.schoolTimezone)}</div>}
        {preview.proposedDates.startDate && period(preview.proposedDates.startDate, preview.proposedDates.endDate, preview.schoolTimezone)}
        {preview.effectiveStatusIfConfirmedNow === 'SCHEDULED' && <p>{t("This membership would be scheduled to begin ")}{calendar(preview.proposedDates.startDate)}{t(". It is not currently IN_EFFECT.")}</p>}
        {preview.blocks.length > 0 && <div className={styles.error}><h3>{t("Server blockers")}</h3><ul>{preview.blocks.map(b => <li key={b.code}>{readable(b.code)} <small>({b.code})</small></li>)}</ul></div>}
        {!preview.canConfirm && preview.blocks.length === 0 && <p role="note">{t("The server does not authorize confirmation. When retroactive permission is required, an appropriately authorized staff member must review this change.")}</p>}
        <details><summary>{t("Existing financial records · unchanged")}</summary><p>{t("No financial action is authorized by this preview.")}</p><ul>{preview.financialFacts.invoices.map(i => <li key={i.invoiceId}>{t("Invoice ")}{i.invoiceId} · {t(i.status)} {t(" · due ")}{i.dueDate ? calendar(i.dueDate) : t("not set")}</li>)}{preview.financialFacts.schedules.map(s => <li key={s.scheduleId}>{t("Schedule ")}{s.scheduleId} · {t(s.status)} · {readable(s.frequency)} {t(" · next ")}{s.nextChargeDate ? calendar(s.nextChargeDate) : t("not set")} {t(" · auto-renew ")}{s.autoRenew ? t("recorded") : t("not recorded")}</li>)}</ul>{!preview.financialFacts.invoices.length && !preview.financialFacts.schedules.length && <p>{t("No financial records were returned.")}</p>}{(preview.financialFacts.invoicesTruncated || preview.financialFacts.schedulesTruncated) && <p>{t("Financial facts are incomplete. This is not a complete account history.")}</p>}</details>
        <h3>{t("Requirements not evaluated")}</h3><ul>{preview.requirementsNotEvaluated.map(value => <li key={value}>{activationRequirement(preferences?.language ?? "en", value)}</li>)}</ul>
        <form onSubmit={finalReview}><fieldset disabled={locked || reading || summary !== null}>
          <h3>{t("Warnings requiring acknowledgement")}</h3>{preview.warnings.length === 0 ? <p>{t("No warnings were returned.")}</p> : preview.warnings.map(w => <label className={styles.check} key={w.code}><input type="checkbox" checked={acknowledged.includes(w.code)} onChange={event => setAcknowledged(old => event.target.checked ? [...old, w.code] : old.filter(code => code !== w.code))} />{readable(w.code)} <small>({w.code})</small>{w.added !== undefined && ` · ${t('past days added {value}', { value: number(w.added) })}`}{w.removed !== undefined && ` · ${t('removed {value}', { value: number(w.removed) })}`}{w.count !== undefined && ` · ${t('records {value}', { value: number(w.count) })}`}{w.days !== undefined && ` · ${t('days {value}', { value: number(w.days) })}`}{w.fromDate && ` · ${t('from {value}', { value: calendar(w.fromDate) })}`}{w.toDate && ` · ${t('to {value}', { value: calendar(w.toDate) })}`}{w.planEndDate && ` · ${t('plan last day {value}', { value: calendar(w.planEndDate) })}`}{w.from && ` · ${t('from {value}', { value: readable(w.from) })}`}{w.to && ` · ${t('to {value}', { value: readable(w.to) })}`}{w.storedStart && ` · ${t('unconfirmed start {value}', { value: instant(w.storedStart) })}`}{w.storedEnd && ` · ${t('unconfirmed exclusive end {value}', { value: instant(w.storedEnd) })}`}</label>)}
          {preview.proposedDates.dateSource === 'STAFF_ADJUSTED' && <label>{t("Date adjustment reason (10–500 characters)")}<textarea required minLength={10} maxLength={500} value={adjustment} onChange={event => setAdjustment(event.target.value)} /></label>}
          <label>{t("Reason category")}<select aria-label={t("Reason category")} required value={reasonCode} onChange={event => setReasonCode(event.target.value)}><option value="">{t("Choose a reason")}</option>{MEMBERSHIP_DATE_REVISION_REASON_CODES[kind].map(code => <option key={code} value={code}>{readable(code)}</option>)}</select></label>
          <label>{t("Reason for this change (10–500 characters)")}<textarea required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button type="submit" disabled={!preview.canConfirm || preview.blocks.length > 0 || preview.warnings.some(w => !acknowledged.includes(w.code))}>{t("Review final date confirmation")}</button>
        </fieldset></form>
      </section>}
      {summary && <section><h2 ref={finalHeading} tabIndex={-1}>{t("Step 2 · Confirm date change")}</h2>{period(summary.startDate, summary.endDate, preview!.schoolTimezone)}<p>{readable(summary.changeKind)} · {readable(summary.reasonCode)} · {summary.reasonText}</p><p>{summary.dateAdjustmentReason}</p><p>{t("Acknowledged warnings: ")}{summary.acknowledgedWarnings.map(readable).join('; ') || t("None")}</p>
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("I confirm this exact date change. No payment, invoice, refund, credit, schedule or agreement change is authorized.")}</label>
        <button type="button" disabled={!confirmed || locked || reading} onClick={() => { if (confirmed && confirmationEpoch === epoch.current && confirmationLife === instance.current && !active.current && !retained.current && !concealed.current) void revise(prepareMembershipDateRevision(scope, summary, crypto.randomUUID())); }}>{t("Confirm membership date change")}</button>
      </section>}
      {pending && <section><h2>{t("Retained date-change request")}</h2><p>{t("The outcome may be unknown. The original immutable request and key are retained only in this page’s memory. No automatic retry occurs. Closing or reloading the document destroys this local recovery.")}</p><button type="button" disabled={busy || reading} onClick={() => void revise(pending, true)}>{t("Retry exact retained date change")}</button><CrmEnrollmentDiscard disabled={busy || reading} onDiscard={discard} label={t("Discard date-change retry")} copy={discardCopy} /></section>}
      {saved && <section><h2>{t("Membership date revision receipt")}</h2><p>{saved.replayed ? t("Verified idempotent replay.") : t("Revision recorded.")} {t(" Historical receipt · ")}{instant(saved.receipt.recordedAt)} {t(" · membership version ")}{saved.receipt.version}</p>{period(saved.receipt.effectivePeriod.startDate, saved.receipt.effectivePeriod.endDate, saved.receipt.effectivePeriod.schoolTimezone)}<p>{t("Effective status at revision: ")}{t(saved.receipt.effectiveStatusAtRevision)}.</p>{saved.receipt.effectiveStatusAtRevision === 'SCHEDULED' && <p>{t("Membership confirmed — scheduled to begin ")}{calendar(saved.receipt.effectivePeriod.startDate)}.</p>}<p>{t("Past days added ")}{number(saved.receipt.retroactiveDays.added)} {t(" · removed ")}{number(saved.receipt.retroactiveDays.removed)}.</p><p>{t("Warnings acknowledged: ")}{saved.receipt.acknowledgedWarnings.map(readable).join('; ') || t("None")}</p>{saved.receipt.followUps.map(f => <p key={f.workItemId}>{t("A billing review reminder was created; no payment, invoice or schedule was changed.")}</p>)}<p>{t("No financial effects. This receipt does not prove payment, agreement, consent or financial enrollment.")}</p><button type="button" disabled={reading} onClick={() => void load()}>{t("Refresh verified current dates and history")}</button></section>}
      {queue && <section><h2>{t("Legacy date confirmation queue")}</h2><p>{t("Unconfirmed hints only. Review each membership individually; no bulk confirmation is available.")}</p>{queue.items.length === 0 ? <p>{t("No unconfirmed memberships were returned in this page.")}</p> : <ul>{queue.items.map(item => <li key={item.membershipId}><strong>{item.participantDisplayName ?? t("Name unavailable")}</strong><p>{item.planCode} {t(" · unconfirmed start ")}{instant(item.legacyStoredTerm.termStartedAt)} {t(" · unconfirmed exclusive end ")}{instant(item.legacyStoredTerm.termEndsAt)}</p><button type="button" disabled={locked || reading} onClick={() => void load({ ...scope, membershipId: item.membershipId })}>{t("Review individual membership · ")}{item.participantDisplayName ?? item.membershipId}</button></li>)}</ul>}{queue.next && <button type="button" disabled={locked || reading} onClick={() => void auxiliary('queue', queue.next!)}>{t("Next legacy queue page")}</button>}</section>}
      {history?.state === 'ACTIVE' && <section><h2>{t('Continue school operations')}</h2><p>{t('These links open separate authorized scheduling and attendance screens. They do not book a class, mark attendance, or prove eligibility or payment.')}</p><div className={styles.actions}><a href="/staff/schedule/bookings">{t('Class bookings')}</a><a href="/staff/attendance">{t('Attendance')}</a></div></section>}
      {report && <section><h2>{t("School membership status summary")}</h2><p>{t("Backend-calculated totals · ")}{report.schoolTimezone} {t(" · school-local today ")}{calendar(report.localToday)} {t(" · generated ")}{instant(report.generatedAt)}</p><h3>{t("Lifecycle totals")}</h3><dl>{Object.entries(report.lifecycle).map(([key, value]) => <React.Fragment key={key}><dt>{readable(key)}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><h3>{t("ACTIVE by confirmed effective status")}</h3><dl>{Object.entries(report.activeByEffectiveStatus).map(([key, value]) => <React.Fragment key={key}><dt>{readable(key)}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><h3>{t("UNDATED · unconfirmed stored-term hints")}</h3><dl>{Object.entries(report.undatedHints).map(([key, value]) => <React.Fragment key={key}><dt>{readable(key)}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><p>{t("Confirmed starts in next 30 school-local days: ")}{number(report.confirmedStartingNext30Days)}{t(". Confirmed ends: ")}{number(report.confirmedEndingNext30Days)}{t(". Window through ")}{calendar(report.windowEndDate)}.</p></section>}
    </div>}
    {error && <p role="alert" className={styles.error}>{t(error)}</p>}
  </main>;
}
