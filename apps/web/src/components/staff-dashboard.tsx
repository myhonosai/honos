'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OperationalSnapshot, OwnerLaunchFirstClassBookingContext, OwnerLaunchFirstClassBookingContextProjection, OwnerLaunchMembershipDraftConfirmation, OwnerLaunchMembershipDraftConfirmationReceipt, OwnerLaunchProjection, OwnerLaunchSavedStudentConfirmation, OwnerLaunchSavedStudentsProjection } from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { loadOwnerLaunchSavedStudents, loadStaffDashboard, StaffDashboardAccessError } from './staff-dashboard-http';
import { loadOwnerLaunch, loadOwnerLaunchFirstClassBookingContext, loadOwnerLaunchMembershipDraft } from './owner-launch-http';
import { InterfaceThemePicker } from './interface-theme-picker';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from './interface-theme-preference';
import styles from './staff-dashboard.module.css';

type VerifiedSelection = Pick<OperationalSnapshot, 'organizationId' | 'schoolId' | 'generatedAt' | 'from' | 'to'>;
type InterfaceThemeState = 'UNAVAILABLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';
export type StaffDashboardInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

function utc(value: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}
function Metric({ label, value, detail }: { label: string; value: number; detail?: string }): React.ReactElement {
  return <div className={styles.metric}><dt>{label}</dt><dd>{value.toLocaleString('en-US')}</dd>{detail && <small>{detail}</small>}</div>;
}
function WorkflowLink({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return <a className={styles.workflowLink} href={href}>{children}<span aria-hidden="true">→</span></a>;
}
function NoAggregate({ workflow, children }: { workflow: string; children: React.ReactNode }): React.ReactElement {
  return <article className={styles.unavailable}><span>NOT COUNTED HERE</span><p>{children}</p><WorkflowLink href={workflow}>Open the managed workflow</WorkflowLink></article>;
}
type OwnerSavedReceipt = NonNullable<OwnerLaunchProjection['registration']> | NonNullable<OwnerLaunchProjection['guardianChildRegistration']>;
export type VerifiedSavedStudent = { receipt: OwnerSavedReceipt; savedStudent: OwnerLaunchSavedStudentConfirmation };
export type SavedStudentStep = { state: 'RECORDED'; verified: VerifiedSavedStudent } | { state: 'NO_RECORDED' | 'UNAVAILABLE' };
export type BookingStep = { state: 'RECORDED'; confirmation: { displayName: string; context: OwnerLaunchFirstClassBookingContext } } | { state: 'NO_RECORDED' | 'UNAVAILABLE' };
export type MembershipDraftStep = { state: 'RECORDED'; receipt: OwnerLaunchMembershipDraftConfirmationReceipt } | { state: 'NO_RECORDED' | 'UNAVAILABLE' };
export type OwnerWorkflowProgress = { savedStudent: SavedStudentStep; booking: BookingStep | null; membershipDraft: MembershipDraftStep | null };

function ownerReceipt(context: OwnerLaunchProjection): OwnerSavedReceipt | null | undefined {
  if (context.registration && context.guardianChildRegistration) return undefined;
  return context.guardianChildRegistration ?? context.registration;
}

/** A current owner context may enter this card only when its fixed scope is the independently verified report scope. */
export function ownerContextMatchesVerifiedDashboard(context: OwnerLaunchProjection, snapshot: Pick<OperationalSnapshot, 'organizationId' | 'schoolId'>): boolean {
  return context.organizationId === snapshot.organizationId && context.schoolId === snapshot.schoolId;
}

/** Bind the display-name confirmation to both the fixed owner receipt and the verified dashboard school. */
export function savedStudentForVerifiedDashboard(
  context: OwnerLaunchProjection,
  savedStudents: OwnerLaunchSavedStudentsProjection,
  snapshot: Pick<OperationalSnapshot, 'organizationId' | 'schoolId'>,
): VerifiedSavedStudent | 'NO_RECORDED' | null {
  if (!ownerContextMatchesVerifiedDashboard(context, snapshot)
    || savedStudents.organizationId !== snapshot.organizationId
    || savedStudents.schoolId !== snapshot.schoolId) return null;
  const receipt = ownerReceipt(context);
  if (receipt === undefined) return null;
  if (!receipt && savedStudents.state === 'NO_RECORDED_REGISTRATIONS') return 'NO_RECORDED';
  if (!receipt || savedStudents.state !== 'RECORDED_REGISTRATIONS') return null;
  const savedStudent = savedStudents.registrations.find((registration) => registration.registrationId === receipt.registrationId
    && registration.studentProfileId === receipt.studentProfileId);
  return savedStudent ? { receipt, savedStudent } : null;
}

/** Booking is factual only when its receipt/student/class trio is the exact saved owner-launch trio. */
export function bookingForVerifiedDashboard(
  booking: OwnerLaunchFirstClassBookingContextProjection,
  context: OwnerLaunchProjection,
  saved: VerifiedSavedStudent,
): { displayName: string; context: OwnerLaunchFirstClassBookingContext } | null {
  if (booking.state !== 'RECORDED_BOOKING'
    || !context.classSession
    || context.classSession.id !== saved.receipt.classSessionId
    || booking.context.registrationId !== saved.receipt.registrationId
    || booking.context.student.studentProfileId !== saved.receipt.studentProfileId
    || booking.context.classSession.id !== saved.receipt.classSessionId
    || booking.context.classSession.id !== context.classSession.id) return null;
  return { displayName: saved.savedStudent.displayName, context: booking.context };
}

/** A DRAFT has no independent dashboard scope: its immutable receipt must be the already verified saved receipt. */
export function membershipDraftForVerifiedDashboard(
  confirmation: OwnerLaunchMembershipDraftConfirmation,
  saved: VerifiedSavedStudent,
): OwnerLaunchMembershipDraftConfirmationReceipt | null {
  return confirmation.state === 'RECORDED_DRAFT' && confirmation.receipt.registrationId === saved.receipt.registrationId
    ? confirmation.receipt : null;
}

export function OwnerWorkflowProgressCard({ progress }: { progress: OwnerWorkflowProgress }): React.ReactElement {
  const saved = progress.savedStudent;
  const booking = progress.booking;
  const draft = progress.membershipDraft;
  return <section className={styles.workflowProgress} aria-labelledby="owner-workflow-progress-title" aria-describedby="owner-workflow-progress-description">
    <p className={styles.eyebrow}>OWNER LAUNCH / CONFIRMATION ONLY</p><h2 id="owner-workflow-progress-title">Saved-workflow progress</h2>
    <p id="owner-workflow-progress-description" className={styles.progressDescription}>Owner-launch membership confirmation is DRAFT only: saved configuration, NOT active. Confirmation-only view of the current owner&apos;s fixed saved receipts. It does not claim activation, payment, attendance, eligibility, parent access, or communication.</p>
    <dl className={styles.progressSteps}>
      <div><dt>School context</dt><dd><strong>Ready</strong><span>Verified current dashboard report</span></dd></div>
      <div><dt>Saved student</dt><dd>{saved.state === 'RECORDED' ? <><strong>{saved.verified.savedStudent.displayName}</strong><span>Matching saved registration</span></> : <strong>{saved.state === 'NO_RECORDED' ? 'No recorded saved student' : 'Unavailable'}</strong>}</dd></div>
      {booking && <div><dt>First class booking</dt><dd>{booking.state === 'RECORDED' ? <><strong>{booking.confirmation.context.classSession.name}</strong><span>{booking.confirmation.context.booking.status}</span></> : <strong>{booking.state === 'NO_RECORDED' ? 'No recorded first class booking' : 'Unavailable'}</strong>}</dd></div>}
      {draft && <div><dt>Membership DRAFT</dt><dd>{draft.state === 'RECORDED' ? <><strong>DRAFT recorded</strong><span>Matching saved registration</span></> : <strong>{draft.state === 'NO_RECORDED' ? 'No recorded membership DRAFT' : 'Unavailable'}</strong>}</dd></div>}
    </dl>
  </section>;
}
function OperationsCards({ snapshot }: { snapshot: OperationalSnapshot }): React.ReactElement {
  const attendance = snapshot.attendance.inRangeByStatus;
  const classes = snapshot.classSessions.inRange;
  const leads = snapshot.leads.byStatus;
  const memberships = snapshot.memberships.byState;
  const invoices = snapshot.invoices.inRangeByStatus;
  const noRangedActivity = Object.values(classes).every((value) => value === 0) && Object.values(attendance).every((value) => value === 0) && Object.values(invoices).every((value) => value === 0);
  return <>
    {noRangedActivity && <section className={styles.empty} aria-label="No range activity"><strong>No class, attendance, or invoice activity is recorded in this reporting window.</strong><p>Current leads and memberships remain separately displayed; zero is a verified count, not a sample state.</p></section>}
    <section className={styles.cards} aria-label="Verified operational summary">
      <article className={styles.card}>
        <header><p>OPERATIONS REPORT</p><h2>Attendance &amp; classes</h2></header>
        <p className={styles.cardIntro}>Class sessions and attendance outcomes for sessions beginning in the verified window.</p>
        <dl className={styles.metrics}><Metric label="Scheduled" value={classes.scheduled} /><Metric label="Completed" value={classes.completed} /><Metric label="Cancelled" value={classes.cancelled} /><Metric label="Present" value={attendance.PRESENT} /><Metric label="Late" value={attendance.LATE} /><Metric label="Unexcused absence" value={attendance.UNEXCUSED_ABSENCE} /><Metric label="Excused absence" value={attendance.EXCUSED_ABSENCE} /><Metric label="Makeup" value={attendance.MAKEUP} /></dl>
        <WorkflowLink href="/staff/search">Find an exact class or student in staff search</WorkflowLink>
      </article>
      <article className={styles.card}>
        <header><p>CRM STATUS</p><h2>Leads &amp; trials</h2></header>
        <p className={styles.cardIntro}>Lead statuses are current school counts, not conversion history.</p>
        <dl className={styles.metrics}><Metric label="Open leads" value={leads.OPEN} /><Metric label="Won" value={leads.WON} /><Metric label="Lost" value={leads.LOST} /><Metric label="Archived" value={leads.ARCHIVED} /></dl>
        <div className={styles.noData}><strong>Trial count unavailable</strong><p>The operations report has no approved trial aggregate. This dashboard does not query appointment records or infer trial totals.</p></div>
        <WorkflowLink href="/staff/search">Find an exact lead in staff search</WorkflowLink>
        <WorkflowLink href="/staff/crm/leads">Open bounded CRM leads</WorkflowLink>
        <WorkflowLink href="/staff/crm/trials">Open bounded trial appointments</WorkflowLink>
      </article>
      <article className={styles.card}>
        <header><p>MEMBERSHIP VIEW</p><h2>Membership &amp; plan</h2></header>
        <p className={styles.cardIntro}>Current membership states and invoice statuses created during the reporting window. Counts are not revenue or collection totals.</p>
        <dl className={styles.metrics}><Metric label="Student profiles" value={snapshot.studentProfiles.total} detail="Current-school aggregate" /><Metric label="Active memberships" value={memberships.ACTIVE} /><Metric label="Frozen" value={memberships.FROZEN} /><Metric label="Cancellation pending" value={memberships.CANCELLATION_PENDING} /><Metric label="Expired" value={memberships.EXPIRED} /><Metric label="Issued invoices" value={invoices.ISSUED} /><Metric label="Paid invoices" value={invoices.PAID} /><Metric label="Uncollectible invoices" value={invoices.UNCOLLECTIBLE} /></dl>
        <div className={styles.noData}><strong>Revenue-plan summary unavailable</strong><p>Saved plans are intentionally scoped to the dedicated human planning workflow; no target, amount, payment schedule, or payment method is shown here.</p></div>
        <WorkflowLink href="/staff/planning/revenue">Open human revenue planning</WorkflowLink>
        <WorkflowLink href="/staff/billing/renewals">Open membership renewal reviews</WorkflowLink>
      </article>
    </section>
    <section className={styles.queueSection} aria-labelledby="queue-title">
      <div><p className={styles.eyebrow}>HUMAN WORKFLOWS</p><h2 id="queue-title">Queue visibility without record enumeration</h2><p>These managed queues have safe, bounded list endpoints. They do not provide dashboard-wide aggregate counts, so this dashboard does not fetch rows, notes, IDs, or evidence just to make a number.</p></div>
      <div className={styles.queueGrid}>
        <NoAggregate workflow="/staff/launch">Owner launch is a bounded conventional setup flow; this dashboard does not infer school readiness or student counts from private records.</NoAggregate>
        <NoAggregate workflow="/staff/crm/follow-ups">Follow-up counts are unavailable from the approved operations report.</NoAggregate>
        <NoAggregate workflow="/staff/billing/renewals">Renewal-review counts are unavailable from the approved operations report.</NoAggregate>
        <NoAggregate workflow="/staff/action-center/approvals">Approval counts are unavailable from the approved operations report.</NoAggregate>
        <NoAggregate workflow="/staff/work">Human work-item counts are unavailable from the approved operations report.</NoAggregate>
      </div>
    </section>
  </>;
}

function PlatformViewSelector({
  interfaceTheme,
  interfaceThemeState,
  interfaceThemeMessage,
  onChange,
}: {
  interfaceTheme: HonInterfaceTheme;
  interfaceThemeState: InterfaceThemeState;
  interfaceThemeMessage: string;
  onChange: (theme: HonInterfaceTheme) => void;
}): React.ReactElement {
  return <section className={styles.platformView} aria-labelledby="platform-view-heading">
    <div><p className={styles.eyebrow}>PRESENTATION ONLY / VERIFIED SCHOOL</p><h2 id="platform-view-heading">Platform View</h2><p>Big-Button / Phone, Modern HON, and Classic CRM change touch targets and density only. They use the same verified report, owner-confirmation reads, permissions, workflow links, audit/security behavior, and current-school scope.</p></div>
    <InterfaceThemePicker
      current={interfaceTheme}
      onChange={onChange}
      disabled={interfaceThemeState !== 'READY'}
      busy={interfaceThemeState === 'LOADING' || interfaceThemeState === 'SAVING'}
      presentation={interfaceTheme === 'classic' ? 'compact' : 'cards'}
      ariaLabel="Platform View for the verified current school"
    />
    <p className={styles.platformViewStatus} role="status" aria-live="polite">{interfaceThemeMessage}</p>
  </section>;
}

export function StaffDashboard({ initialScope = {} }: { initialScope?: StaffDashboardInitialScope } = {}): React.ReactElement {
  const [organizationId, setOrganizationId] = useState(initialScope.organizationId ?? '');
  const [schoolId, setSchoolId] = useState(initialScope.schoolId ?? '');
  const [selection, setSelection] = useState<VerifiedSelection | null>(null);
  const [snapshot, setSnapshot] = useState<OperationalSnapshot | null>(null);
  const [ownerWorkflowProgress, setOwnerWorkflowProgress] = useState<OwnerWorkflowProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [interfaceTheme, setInterfaceTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [interfaceThemeState, setInterfaceThemeState] = useState<InterfaceThemeState>('UNAVAILABLE');
  const [interfaceThemeMessage, setInterfaceThemeMessage] = useState('Load a verified school dashboard to view or change your personal Platform View preference.');
  const generation = useRef(0);
  const interfaceThemeGeneration = useRef(0);

  function clear() {
    generation.current += 1;
    interfaceThemeGeneration.current += 1;
    setSelection(null); setSnapshot(null); setOwnerWorkflowProgress(null); setError('');
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE');
    setInterfaceThemeMessage('Load a verified school dashboard to view or change your personal Platform View preference.');
  }
  useEffect(() => () => { generation.current += 1; interfaceThemeGeneration.current += 1; }, []);
  useEffect(() => {
    if (!selection) {
      interfaceThemeGeneration.current += 1;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE');
      setInterfaceThemeMessage('Load a verified school dashboard to view or change your personal Platform View preference.');
      return;
    }
    const current = ++interfaceThemeGeneration.current;
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('LOADING');
    setInterfaceThemeMessage('Loading your personal Platform View preference for this verified current school…');
    void loadInterfaceThemePreference(scope).then((preference) => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY');
      setInterfaceThemeMessage(preference.selectedVia === 'DEFAULT'
        ? 'Modern HON is the visual default for this verified current school. Choosing another presentation is optional.'
        : 'Saved for your current user and this verified current school only. It never changes data, permissions, authority, or workflow behavior.');
    }).catch((reason) => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} Modern HON remains a visual default only; no preference was loaded or saved.`);
    });
    return () => { if (current === interfaceThemeGeneration.current) interfaceThemeGeneration.current += 1; };
  }, [selection?.organizationId, selection?.schoolId]);
  async function chooseInterfaceTheme(next: HonInterfaceTheme) {
    if (!selection || interfaceThemeState !== 'READY') return;
    const current = ++interfaceThemeGeneration.current;
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    setInterfaceThemeState('SAVING'); setInterfaceThemeMessage('Saving your personal Platform View preference for this verified current school…');
    try {
      const preference = await saveInterfaceThemePreference(scope, next, crypto.randomUUID(), 'SETTINGS');
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY');
      setInterfaceThemeMessage('Saved for your current user and this verified current school only. It never changes data, permissions, authority, or workflow behavior.');
    } catch (reason) {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} No presentation preference was saved.`);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    clear(); const requestGeneration = generation.current; setLoading(true);
    const current = () => generation.current === requestGeneration;
    try {
      const next = await loadStaffDashboard(organizationId, schoolId);
      if (!current()) return;
      setSnapshot(next);
      setSelection({ organizationId: next.organizationId, schoolId: next.schoolId, generatedAt: next.generatedAt, from: next.from, to: next.to });

      // The owner-specific reads are intentionally unavailable to ordinary staff.
      // Do not expose an owner card unless the fixed owner context agrees with the report.
      let ownerContext: OwnerLaunchProjection;
      try {
        ownerContext = await loadOwnerLaunch();
      } catch { return; }
      if (!current() || !ownerContextMatchesVerifiedDashboard(ownerContext, next)) return;

      let savedStudents: OwnerLaunchSavedStudentsProjection;
      try {
        savedStudents = await loadOwnerLaunchSavedStudents();
      } catch {
        if (current()) setOwnerWorkflowProgress({ savedStudent: { state: 'UNAVAILABLE' }, booking: null, membershipDraft: null });
        return;
      }
      if (!current()) return;
      const saved = savedStudentForVerifiedDashboard(ownerContext, savedStudents, next);
      if (saved === 'NO_RECORDED') {
        setOwnerWorkflowProgress({ savedStudent: { state: 'NO_RECORDED' }, booking: null, membershipDraft: null });
        return;
      }
      if (!saved) {
        setOwnerWorkflowProgress({ savedStudent: { state: 'UNAVAILABLE' }, booking: null, membershipDraft: null });
        return;
      }

      const [bookingResult, draftResult] = await Promise.allSettled([
        loadOwnerLaunchFirstClassBookingContext(),
        loadOwnerLaunchMembershipDraft(),
      ]);
      if (!current()) return;
      const booking: BookingStep = bookingResult.status === 'rejected' ? { state: 'UNAVAILABLE' }
        : bookingResult.value.state === 'NO_RECORDED_BOOKING' ? { state: 'NO_RECORDED' }
          : bookingResult.value.state === 'BOOKING_UNAVAILABLE' ? { state: 'UNAVAILABLE' }
            : (() => {
              const confirmation = bookingForVerifiedDashboard(bookingResult.value, ownerContext, saved);
              return confirmation ? { state: 'RECORDED' as const, confirmation } : { state: 'UNAVAILABLE' as const };
            })();
      const membershipDraft: MembershipDraftStep = draftResult.status === 'rejected' ? { state: 'UNAVAILABLE' }
        : draftResult.value.state === 'NO_RECORDED_DRAFT' ? { state: 'NO_RECORDED' }
          : draftResult.value.state === 'DRAFT_UNAVAILABLE' ? { state: 'UNAVAILABLE' }
            : (() => {
              const receipt = membershipDraftForVerifiedDashboard(draftResult.value, saved);
              return receipt ? { state: 'RECORDED' as const, receipt } : { state: 'UNAVAILABLE' as const };
            })();
      setOwnerWorkflowProgress({ savedStudent: { state: 'RECORDED', verified: saved }, booking, membershipDraft });
    } catch (reason) {
      if (!current()) return;
      if (reason instanceof StaffDashboardAccessError) { setSelection(null); setSnapshot(null); }
      setError(reason instanceof Error ? reason.message : 'The operations dashboard is unavailable.');
    } finally { if (current()) setLoading(false); }
  }

  const themeClass = interfaceTheme === 'big-button' ? styles.bigButton : interfaceTheme === 'classic' ? styles.classic : styles.modern;
  return <main className={`${styles.page} ${themeClass}`} data-interface-theme={interfaceTheme}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/command-center">School Command Center</a><a href="/staff/search">Staff search</a><a href="/staff/crm/leads">CRM leads</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/crm/follow-ups">Follow-ups</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/staff/work">Human work</a><a href="/auth/login">Sign in</a></nav>
    <header className={styles.header}><p className={styles.eyebrow}>STAFF / CONVENTIONAL OPERATIONS</p><h1>School operations dashboard</h1><p>One verified school at a time. Read-only operational counts, with no contact data, notes, payment methods, private evidence, automated execution, or external activity.</p></header>
    <aside className={styles.notice}><strong>Read-only operational view.</strong><p>The server derives the signed-in human and verifies reporting access for the selected school. IDs below select a school; they never grant access. Where an approved aggregate is absent, this dashboard says so rather than deriving one from private records.</p></aside>
    <section className={styles.scopeSection} aria-labelledby="scope-heading">
      <div><h2 id="scope-heading">Current verified school</h2><p>Enter already-known staff-context IDs. Loading validates the exact organization, school, active human session, and <code>reporting.view</code> authority through the existing school operations report.</p></div>
      <form onSubmit={submit} aria-busy={loading}>
        <fieldset disabled={loading}><label>Organization UUID<input required autoComplete="off" spellCheck={false} value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" spellCheck={false} value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><button type="submit">{loading ? 'Verifying school…' : 'Load verified dashboard'}</button></fieldset>
      </form>
      {!selection && !loading && !error && <p className={styles.scopeState} role="status">No verified school is selected. No operational data is shown.</p>}
      {loading && <p className={styles.scopeState} role="status">Checking current school access and loading the aggregate-only operations report…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {selection && <div className={styles.verified} role="status"><strong>Verified current school</strong><span>Organization <code>{selection.organizationId}</code></span><span>School <code>{selection.schoolId}</code></span><span>Window: {utc(selection.from)} – {utc(selection.to)} UTC</span><span>Generated: {utc(selection.generatedAt)} UTC</span></div>}
    </section>
    {snapshot && selection && <PlatformViewSelector interfaceTheme={interfaceTheme} interfaceThemeState={interfaceThemeState} interfaceThemeMessage={interfaceThemeMessage} onChange={(theme) => void chooseInterfaceTheme(theme)} />}
    {snapshot && <OperationsCards snapshot={snapshot} />}
    {snapshot && ownerWorkflowProgress && <OwnerWorkflowProgressCard progress={ownerWorkflowProgress} />}
  </main>;
}
