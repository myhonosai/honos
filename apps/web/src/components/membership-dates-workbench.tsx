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
import { requirementText } from './membership-activation-copy';
import { type KnownMembership } from './membership-activation-http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';
import { loadMembershipDateHistory, loadMembershipDateQueue, loadMembershipStatusSummary, previewMembershipDates, prepareMembershipDateRevision,
  reviseMembershipDates, MembershipDatesError, type DateRequest, type DateResult } from './membership-dates-http';
import styles from './membership-dates-workbench.module.css';

type Dates = { startDate: string; endDate: string | null };
type View = 'membership' | 'queue' | 'summary';
const kinds: Record<MembershipDateChangeKind, string> = { INITIAL_CONFIRMATION: 'Confirm dates', CORRECTION: 'Correct dates', EXTENSION: 'Extend', EARLY_END: 'End early' };
const readable = (value: string) => value.replaceAll('_', ' ').toLowerCase();
export function MembershipDatesWorkbench({ sessionSubject }: { sessionSubject?: string }): React.ReactElement {
  const { preferences, date, number } = useLocale();
  const calendar = (value: string | null) => value === null ? 'Open-ended · no last day' : formatLocaleCalendarDate(preferences, value);
  const instant = (value: string | null) => value === null ? 'Not stored' : date(value);
  const [scope, setScope] = useState<KnownMembership>({ organizationId: '', schoolId: '', membershipId: '' });
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
  function editScope(key: keyof KnownMembership, value: string): void {
    if (active.current || retained.current || concealed.current) return;
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
  async function revise(request: DateRequest): Promise<void> {
    if (active.current || concealed.current || retained.current && retained.current !== request) return;
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
    setScope({ organizationId: '', schoolId: '', membershipId: '' }); invalidate(); concealed.current = false; setHidden(false); setError('');
    setNotice('Local recovery deliberately abandoned. This does not cancel or reverse any server action. Verify current membership history before another change.');
  }
  const period = (start: string, end: string | null, zone: string) => <dl><dt>Starts · school-local date</dt><dd>{calendar(start)}</dd><dt>Last valid day · inclusive</dt><dd>{calendar(end)}</dd><dt>School timezone</dt><dd>{zone}</dd></dl>;
  return <main className={styles.page}>
    <nav aria-label="Membership navigation"><a href="/staff/billing/memberships">Activation</a><a href="/staff/crm/leads">CRM enrollment</a><a href="/staff/dashboard">Staff dashboard</a></nav>
    <header><p>DIRECT HUMAN STAFF · MEMBERSHIP DATES</p><h1>Membership dates and history</h1><p>Review one confirmed membership, then explicitly confirm its school-local dates.</p></header>
    <aside><strong>A date revision changes dates only.</strong><p>No payment, refund, credit, invoice, schedule, agreement, consent or entitlement is created or changed. Extending a membership is not a paid renewal. Internal DRAFTs are never published to parents here.</p></aside>
    {hidden ? <section aria-labelledby="dates-shield"><h2 id="dates-shield" ref={shieldHeading} tabIndex={-1}>Membership information hidden</h2>
      <p>Verify your signed session and current school permissions before revealing information. Nothing is resent automatically.</p>
      {busy && <p role="status">The in-flight command is settling safely. Restoration and Discard remain unavailable until settlement.</p>}
      <button type="button" disabled={busy || reading} onClick={() => void restore()}>Verify access and resume</button><a href="/auth/login">Sign in again</a>
      <CrmEnrollmentDiscard disabled={busy || reading} onDiscard={discard} label="Discard local date view" />
    </section> : <div ref={privateView}>
      <section><h2>Verified school and membership</h2><p>Enter known identifiers. Selectors confer no authority. No data or command is loaded from a URL.</p>
        <form onSubmit={event => { event.preventDefault(); void load(); }}><fieldset disabled={locked}>
          <div className={styles.row}>{(['organizationId', 'schoolId', 'membershipId'] as const).map(key => <label key={key}>{key === 'organizationId' ? 'Organization ID' : key === 'schoolId' ? 'School ID' : 'Already-known membership ID'}<input autoComplete="off" maxLength={36} required value={scope[key]} onChange={event => editScope(key, event.target.value)} /></label>)}</div>
          <button type="submit" disabled={reading}>Load membership dates</button>
          <div className={styles.actions}><button type="button" disabled={reading} onClick={() => void auxiliary('queue')}>Review legacy date queue</button><button type="button" disabled={reading} onClick={() => void auxiliary('summary')}>Load status summary</button></div>
        </fieldset></form>
      </section>
      {history && <section><h2>Verified current membership</h2><p>{history.effectiveStatus} · lifecycle {history.state} · membership version {history.version} · observed on {calendar(history.localToday)}</p>
        {history.currentPeriod ? period(history.currentPeriod.startDate, history.currentPeriod.endDate, history.currentPeriod.schoolTimezone) : <p>No confirmed period. Stored legacy instants are unconfirmed hints: start {instant(history.legacyStoredTerm?.termStartedAt ?? null)}; exclusive end instant {instant(history.legacyStoredTerm?.termEndsAt ?? null)}. These are not confirmed calendar dates.</p>}
        {!canRevise && !reading && <p>Date-change controls require a successful server-authorized preview. <button type="button" disabled={locked || history.state !== 'ACTIVE'} onClick={() => void review(history.datesConfirmed ? 'CORRECTION' : 'INITIAL_CONFIRMATION')}>Check date revision access</button></p>}
        {canRevise && <div className={styles.actions}>{(history.datesConfirmed ? ['CORRECTION', 'EXTENSION', 'EARLY_END'] as const : ['INITIAL_CONFIRMATION'] as const).map(value => <button type="button" key={value} disabled={locked || reading} onClick={() => void review(value)}>{kinds[value]}</button>)}</div>}
        <h3>Date history · newest first</h3>{history.versions.length === 0 ? <p>No confirmed date history is available.</p> : <ol>{history.versions.map(v => <li key={v.periodVersion}><strong>Period {v.periodVersion} · {readable(v.changeKind)}</strong>{period(v.startDate, v.endDate, v.schoolTimezone)}<p>{v.actorDisplayName ?? 'Actor name unavailable'} · {instant(v.recordedAt)} · {readable(v.reasonCode)}</p>{v.reasonText && <p>{v.reasonText}</p>}{v.retroactiveDays && <p>Past days added {number(v.retroactiveDays.added)} · removed {number(v.retroactiveDays.removed)}</p>}{v.acknowledgedWarnings.length > 0 && <p>Warnings acknowledged: {v.acknowledgedWarnings.map(readable).join('; ')}</p>}</li>)}</ol>}
      </section>}
      {dates && !saved && <section><h2>{kinds[kind]}</h2><p>Every valid date edit requests a fresh preview and clears previous acknowledgements. A blank last day requests open-ended dates only if the backend permits them.</p>
        <fieldset disabled={locked}><div className={styles.row}><label>Start date<input type="date" value={dates.startDate} onChange={event => changeDates({ ...dates, startDate: event.target.value })} /></label><label>Last valid day (inclusive)<input type="date" value={dates.endDate ?? ''} onChange={event => changeDates({ ...dates, endDate: event.target.value || null })} /></label></div></fieldset>
      </section>}
      {preview && <section><h2>Step 1 · Review date change</h2><dl><dt>Student</dt><dd>{preview.participantDisplayName ?? 'Name unavailable'}</dd><dt>Published plan</dt><dd>{typeof preview.plan?.terms?.displayName === 'string' ? preview.plan.terms.displayName : preview.planCode} · {preview.planCode}{preview.plan ? ` · version ${preview.plan.membershipPlanVersion}` : ''}</dd><dt>Current effective status</dt><dd>{preview.effectiveStatusNow}</dd><dt>If confirmed now</dt><dd>{preview.effectiveStatusIfConfirmedNow ?? 'Unavailable'}</dd><dt>Required permissions</dt><dd>{preview.requiredPermissions.join(', ')}</dd><dt>Past days added / removed</dt><dd>{number(preview.retroactiveDays.added)} / {number(preview.retroactiveDays.removed)}</dd></dl>
        {preview.suggestedDates && <div><h3>Suggested dates · {readable(preview.suggestedDates.endBasis)}</h3>{period(preview.suggestedDates.startDate, preview.suggestedDates.endDate, preview.schoolTimezone)}</div>}
        {preview.proposedDates.startDate && period(preview.proposedDates.startDate, preview.proposedDates.endDate, preview.schoolTimezone)}
        {preview.effectiveStatusIfConfirmedNow === 'SCHEDULED' && <p>This membership would be scheduled to begin {calendar(preview.proposedDates.startDate)}. It is not currently IN_EFFECT.</p>}
        {preview.blocks.length > 0 && <div className={styles.error}><h3>Server blockers</h3><ul>{preview.blocks.map(b => <li key={b.code}>{readable(b.code)} <small>({b.code})</small></li>)}</ul></div>}
        {!preview.canConfirm && preview.blocks.length === 0 && <p role="note">The server does not authorize confirmation. When retroactive permission is required, an appropriately authorized staff member must review this change.</p>}
        <details><summary>Existing financial records · unchanged</summary><p>No financial action is authorized by this preview.</p><ul>{preview.financialFacts.invoices.map(i => <li key={i.invoiceId}>Invoice {i.invoiceId} · {i.status} · due {i.dueDate ? calendar(i.dueDate) : 'not set'}</li>)}{preview.financialFacts.schedules.map(s => <li key={s.scheduleId}>Schedule {s.scheduleId} · {s.status} · {readable(s.frequency)} · next {s.nextChargeDate ? calendar(s.nextChargeDate) : 'not set'} · auto-renew {s.autoRenew ? 'recorded' : 'not recorded'}</li>)}</ul>{!preview.financialFacts.invoices.length && !preview.financialFacts.schedules.length && <p>No financial records were returned.</p>}{(preview.financialFacts.invoicesTruncated || preview.financialFacts.schedulesTruncated) && <p>Financial facts are incomplete. This is not a complete account history.</p>}</details>
        <h3>Requirements not evaluated</h3><ul>{preview.requirementsNotEvaluated.map(value => <li key={value}>{requirementText[value]}</li>)}</ul>
        <form onSubmit={finalReview}><fieldset disabled={locked || reading || summary !== null}>
          <h3>Warnings requiring acknowledgement</h3>{preview.warnings.length === 0 ? <p>No warnings were returned.</p> : preview.warnings.map(w => <label className={styles.check} key={w.code}><input type="checkbox" checked={acknowledged.includes(w.code)} onChange={event => setAcknowledged(old => event.target.checked ? [...old, w.code] : old.filter(code => code !== w.code))} />{readable(w.code)} <small>({w.code})</small>{w.added !== undefined && ` · past days added ${number(w.added)}`}{w.removed !== undefined && ` · removed ${number(w.removed)}`}{w.count !== undefined && ` · records ${number(w.count)}`}{w.days !== undefined && ` · days ${number(w.days)}`}{w.fromDate && ` · from ${calendar(w.fromDate)}`}{w.toDate && ` · to ${calendar(w.toDate)}`}{w.planEndDate && ` · plan last day ${calendar(w.planEndDate)}`}{w.from && ` · from ${w.from}`}{w.to && ` · to ${w.to}`}{w.storedStart && ` · unconfirmed start ${instant(w.storedStart)}`}{w.storedEnd && ` · unconfirmed exclusive end ${instant(w.storedEnd)}`}</label>)}
          {preview.proposedDates.dateSource === 'STAFF_ADJUSTED' && <label>Date adjustment reason (10–500 characters)<textarea required minLength={10} maxLength={500} value={adjustment} onChange={event => setAdjustment(event.target.value)} /></label>}
          <label>Reason category<select required value={reasonCode} onChange={event => setReasonCode(event.target.value)}><option value="">Choose a reason</option>{MEMBERSHIP_DATE_REVISION_REASON_CODES[kind].map(code => <option key={code} value={code}>{readable(code)}</option>)}</select></label>
          <label>Reason for this change (10–500 characters)<textarea required minLength={10} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button type="submit" disabled={!preview.canConfirm || preview.blocks.length > 0 || preview.warnings.some(w => !acknowledged.includes(w.code))}>Review final date confirmation</button>
        </fieldset></form>
      </section>}
      {summary && <section><h2 ref={finalHeading} tabIndex={-1}>Step 2 · Confirm date change</h2>{period(summary.startDate, summary.endDate, preview!.schoolTimezone)}<p>{readable(summary.changeKind)} · {readable(summary.reasonCode)} · {summary.reasonText}</p><p>{summary.dateAdjustmentReason}</p><p>Acknowledged warnings: {summary.acknowledgedWarnings.map(readable).join('; ') || 'None'}</p>
        <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm this exact date change. No payment, invoice, refund, credit, schedule or agreement change is authorized.</label>
        <button type="button" disabled={!confirmed || locked || reading} onClick={() => { if (confirmed && !active.current && !retained.current && !concealed.current) void revise(prepareMembershipDateRevision(scope, summary, crypto.randomUUID())); }}>Confirm membership date change</button>
      </section>}
      {pending && <section><h2>Retained date-change request</h2><p>The outcome may be unknown. The original immutable request and key are retained only in this page’s memory. No automatic retry occurs. Closing or reloading the document destroys this local recovery.</p><button type="button" disabled={busy || reading} onClick={() => void revise(pending)}>Retry exact retained date change</button><CrmEnrollmentDiscard disabled={busy || reading} onDiscard={discard} label="Discard date-change retry" /></section>}
      {saved && <section><h2>Membership date revision receipt</h2><p>{saved.replayed ? 'Verified idempotent replay.' : 'Revision recorded.'} Historical receipt · {instant(saved.receipt.recordedAt)} · membership version {saved.receipt.version}</p>{period(saved.receipt.effectivePeriod.startDate, saved.receipt.effectivePeriod.endDate, saved.receipt.effectivePeriod.schoolTimezone)}<p>Effective status at revision: {saved.receipt.effectiveStatusAtRevision}.</p>{saved.receipt.effectiveStatusAtRevision === 'SCHEDULED' && <p>Membership confirmed — scheduled to begin {calendar(saved.receipt.effectivePeriod.startDate)}.</p>}<p>Past days added {number(saved.receipt.retroactiveDays.added)} · removed {number(saved.receipt.retroactiveDays.removed)}.</p><p>Warnings acknowledged: {saved.receipt.acknowledgedWarnings.map(readable).join('; ') || 'None'}</p>{saved.receipt.followUps.map(f => <p key={f.workItemId}>A billing review reminder was created; no payment, invoice or schedule was changed.</p>)}<p>No financial effects. This receipt does not prove payment, agreement, consent or financial enrollment.</p><button type="button" disabled={reading} onClick={() => void load()}>Refresh verified current dates and history</button></section>}
      {queue && <section><h2>Legacy date confirmation queue</h2><p>Unconfirmed hints only. Review each membership individually; no bulk confirmation is available.</p>{queue.items.length === 0 ? <p>No unconfirmed memberships were returned in this page.</p> : <ul>{queue.items.map(item => <li key={item.membershipId}><strong>{item.participantDisplayName ?? 'Name unavailable'}</strong><p>{item.planCode} · unconfirmed start {instant(item.legacyStoredTerm.termStartedAt)} · unconfirmed exclusive end {instant(item.legacyStoredTerm.termEndsAt)}</p><button type="button" disabled={locked || reading} onClick={() => void load({ ...scope, membershipId: item.membershipId })}>Review individual membership · {item.participantDisplayName ?? item.membershipId}</button></li>)}</ul>}{queue.next && <button type="button" disabled={locked || reading} onClick={() => void auxiliary('queue', queue.next!)}>Next legacy queue page</button>}</section>}
      {report && <section><h2>School membership status summary</h2><p>Backend-calculated totals · {report.schoolTimezone} · school-local today {calendar(report.localToday)} · generated {instant(report.generatedAt)}</p><h3>Lifecycle totals</h3><dl>{Object.entries(report.lifecycle).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><h3>ACTIVE by confirmed effective status</h3><dl>{Object.entries(report.activeByEffectiveStatus).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><h3>UNDATED · unconfirmed stored-term hints</h3><dl>{Object.entries(report.undatedHints).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{number(value)}</dd></React.Fragment>)}</dl><p>Confirmed starts in next 30 school-local days: {number(report.confirmedStartingNext30Days)}. Confirmed ends: {number(report.confirmedEndingNext30Days)}. Window through {calendar(report.windowEndDate)}.</p></section>}
    </div>}
    {reading && <p role="status">Verifying current session and authorized school facts…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
  </main>;
}
