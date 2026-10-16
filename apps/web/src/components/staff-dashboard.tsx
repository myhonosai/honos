'use client';

import React, { useState, type FormEvent } from 'react';
import type { OperationalSnapshot } from '@hon/contracts';
import { loadStaffDashboard, StaffDashboardAccessError } from './staff-dashboard-http';
import styles from './staff-dashboard.module.css';

type VerifiedSelection = Pick<OperationalSnapshot, 'organizationId' | 'schoolId' | 'generatedAt' | 'from' | 'to'>;

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

export function StaffDashboard(): React.ReactElement {
  const [organizationId, setOrganizationId] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [selection, setSelection] = useState<VerifiedSelection | null>(null);
  const [snapshot, setSnapshot] = useState<OperationalSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function clear() { setSelection(null); setSnapshot(null); setError(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    clear(); setLoading(true);
    try {
      const next = await loadStaffDashboard(organizationId, schoolId);
      setSnapshot(next);
      setSelection({ organizationId: next.organizationId, schoolId: next.schoolId, generatedAt: next.generatedAt, from: next.from, to: next.to });
    } catch (reason) {
      if (reason instanceof StaffDashboardAccessError) { setSelection(null); setSnapshot(null); }
      setError(reason instanceof Error ? reason.message : 'The operations dashboard is unavailable.');
    } finally { setLoading(false); }
  }

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/command-center">School Command Center</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">Follow-ups</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/staff/work">Human work</a><a href="/auth/login">Sign in</a></nav>
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
    {snapshot && <OperationsCards snapshot={snapshot} />}
  </main>;
}
