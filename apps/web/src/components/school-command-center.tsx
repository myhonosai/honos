'use client';

import React, { useEffect, useState, type FormEvent } from 'react';
import type { CommandCenterCountFact, SchoolCommandCenterSnapshot } from '@hon/contracts';
import { CommandCenterAccessError, loadCommandCenter } from './command-center-http';
import styles from './staff-dashboard.module.css';

const HIDDEN_KEY = 'hon.school-command-center.hidden-panels.v2';
const SECTION = {
  BRIEFING: 'section:briefing',
  METRICS: 'section:metrics',
  LIMITS: 'section:limits',
  RECOMMENDATIONS: 'section:recommendations',
} as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}
function localHidden(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  } catch {
    return [];
  }
}
function HideLocally({ id, onHide, label = 'Hide this section locally' }: { id: string; onHide: (id: string) => void; label?: string }): React.ReactElement {
  return <button type="button" onClick={() => onHide(id)}>{label}</button>;
}
function CountCard({ title, detail, metric }: { title: string; detail: string; metric: CommandCenterCountFact }): React.ReactElement {
  if (metric.availability !== 'AVAILABLE') {
    return <article className={styles.unavailable}><span>{metric.availability === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : 'UNAVAILABLE'}</span><strong>{title}</strong><p>{metric.reason}</p></article>;
  }
  return <article className={styles.card}><header><p>VERIFIED COUNT</p><h2>{title}</h2></header><p className={styles.cardIntro}>{detail}</p><dl className={styles.metrics}><div className={styles.metric}><dt>{metric.windowFrom ? `UTC: ${utc(metric.windowFrom)} – ${utc(metric.windowTo!)}` : 'Current count'}</dt><dd>{metric.count.toLocaleString('en-US')}</dd></div></dl></article>;
}
function PaidInvoiceCard({ snapshot }: { snapshot: SchoolCommandCenterSnapshot }): React.ReactElement {
  const metric = snapshot.metrics.paidInvoicesCreated30d;
  return <article className={styles.card}><header><p>INVOICE OPERATIONS</p><h2>Paid invoices created in 30 days</h2></header><p className={styles.cardIntro}>Current <code>PAID</code> invoice state for invoices created in this trailing UTC window. This is not cash revenue, collection, or payment timing.</p><dl className={styles.metrics}><div className={styles.metric}><dt>Invoice count</dt><dd>{metric.count.toLocaleString('en-US')}</dd><small>{utc(metric.windowFrom)} – {utc(metric.windowTo)}</small></div>{metric.amountsByCurrency.map((amount) => <div key={amount.currency} className={styles.metric}><dt>{amount.currency} invoice total (minor units)</dt><dd>{amount.totalMinor.toLocaleString('en-US')}</dd><small>{amount.count.toLocaleString('en-US')} paid invoice {amount.count === 1 ? 'record' : 'records'}</small></div>)}</dl></article>;
}
function SnapshotCards({ snapshot, hidden, onHide }: { snapshot: SchoolCommandCenterSnapshot; hidden: string[]; onHide: (id: string) => void }): React.ReactElement {
  const metric = snapshot.metrics;
  return <>
    {!hidden.includes(SECTION.BRIEFING) && <section className={styles.empty} aria-label="Daily briefing"><strong>{snapshot.dailyBriefing}</strong><p>Deterministic text derived only from the verified count/status facts below. It does not call AI or execute a task.</p><HideLocally id={SECTION.BRIEFING} onHide={onHide} /></section>}
    {!hidden.includes(SECTION.METRICS) && <section aria-label="Available Command Center metrics"><div className={styles.queueSection}><p className={styles.eyebrow}>VERIFIED SCHOOL SIGNALS</p><h2>Available operational facts</h2><p>Counts are bounded to their displayed UTC windows. A school can hide this section locally without changing any domain data.</p><HideLocally id={SECTION.METRICS} onHide={onHide} /></div><div className={styles.cards}>
      <CountCard title="New leads" detail="CRM leads created in the last 24 hours, regardless of current lead status." metric={metric.newLeads24h} />
      <CountCard title="Upcoming trial appointments" detail="Scheduled trial appointments starting in the next 24 hours." metric={metric.upcomingTrials24h} />
      <CountCard title="Upcoming testing events" detail="Draft, open, or closed testing events starting in the next 30 days." metric={metric.upcomingTestingEvents30d} />
      <CountCard title="Action approvals awaiting review" detail="Current awaiting-approval requests whose expiry has not passed." metric={metric.pendingActionApprovals} />
      <CountCard title="Outstanding durable work" detail="Current nonterminal work items; completed and failed items are excluded." metric={metric.outstandingWorkItems} />
      <CountCard title="Membership terms ending" detail="Active or cancellation-pending memberships with a recorded term end in the next 30 days." metric={metric.membershipTermsEnding30d} />
      <PaidInvoiceCard snapshot={snapshot} />
    </div></section>}
    {!hidden.includes(SECTION.LIMITS) && <section className={styles.queueSection} aria-labelledby="unavailable-title"><p className={styles.eyebrow}>HONEST LIMITS</p><h2 id="unavailable-title">Not calculated without an approved source</h2><p>Unavailable is not zero. These categories have no safe deterministic projection in this slice.</p><HideLocally id={SECTION.LIMITS} onHide={onHide} /><div className={styles.queueGrid}><CountCard title="Unanswered inquiries" detail="" metric={metric.unansweredInquiries} /><CountCard title="Attendance decline" detail="" metric={metric.attendanceDecline} /><CountCard title="Trial conversion" detail="" metric={metric.trialConversion} /><CountCard title="Revenue" detail="" metric={metric.revenue} /></div></section>}
  </>;
}

export function SchoolCommandCenter(): React.ReactElement {
  const [organizationId, setOrganizationId] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [snapshot, setSnapshot] = useState<SchoolCommandCenterSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => { setHidden(localHidden()); }, []);
  function clear() { setSnapshot(null); setError(''); }
  function persist(next: string[]) {
    const unique = [...new Set(next)];
    setHidden(unique);
    try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(unique)); } catch { /* Current view remains configurable without storage. */ }
  }
  function hide(id: string) { persist([...hidden, id]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    clear(); setLoading(true);
    try { setSnapshot(await loadCommandCenter(organizationId, schoolId)); }
    catch (reason) {
      if (reason instanceof CommandCenterAccessError) setSnapshot(null);
      setError(reason instanceof Error ? reason.message : 'The Command Center is unavailable.');
    } finally { setLoading(false); }
  }
  const visibleRecommendations = snapshot?.recommendations.filter((card) => !hidden.includes(`recommendation:${card.id}`)) ?? [];
  const hiddenCount = hidden.length;

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Operations dashboard</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">Follow-ups</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/staff/work">Human work</a><a href="/auth/login">Sign in</a></nav>
    <header className={styles.header}><p className={styles.eyebrow}>STAFF / SCHOOL COMMAND CENTER</p><h1>School Command Center</h1><p>An optional, conventional, read-only school view that extends the staff dashboard. It uses deterministic operational data only—no AI, Action Engine execution, provider call, or mutation.</p></header>
    <aside className={styles.notice}><strong>Human navigation only.</strong><p>Known IDs select one school; they never grant access. The server verifies a direct human, exact <code>reporting.view</code>, selected school, and active Essential/Core/Complete entitlement. Every recommendation opens an existing workflow and never performs an action.</p></aside>
    <section className={styles.scopeSection} aria-labelledby="command-center-scope"><div><h2 id="command-center-scope">Verified current school</h2><p>Enter already-known staff-context IDs. No snapshot is requested until you select a school.</p></div><form onSubmit={submit} aria-busy={loading}><fieldset disabled={loading}><label>Organization UUID<input required autoComplete="off" spellCheck={false} value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" spellCheck={false} value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><button type="submit">{loading ? 'Verifying school…' : 'Load Command Center'}</button></fieldset></form>{!snapshot && !loading && !error && <p className={styles.scopeState} role="status">No verified school is selected. No Command Center data is shown.</p>}{loading && <p className={styles.scopeState} role="status">Verifying access and loading deterministic aggregate facts…</p>}{error && <p className={styles.error} role="alert">{error}</p>}{snapshot && <div className={styles.verified} role="status"><strong>Verified current school</strong><span>Organization <code>{snapshot.organizationId}</code></span><span>School <code>{snapshot.schoolId}</code></span><span>Tier: {snapshot.entitlementTier}</span><span>Generated: {utc(snapshot.generatedAt)} UTC</span></div>}</section>
    {snapshot && <><SnapshotCards snapshot={snapshot} hidden={hidden} onHide={hide} /><section className={styles.queueSection} aria-labelledby="recommendation-title">{!hidden.includes(SECTION.RECOMMENDATIONS) && <><p className={styles.eyebrow}>OPTIONAL HUMAN NAVIGATION</p><h2 id="recommendation-title">Recommended next reviews</h2><p>Cards are ordered by fixed rules over the displayed facts. Hiding a card or section is local to this browser and does not change school data, permissions, tier, or action authority.</p><HideLocally id={SECTION.RECOMMENDATIONS} onHide={hide} /><div className={styles.queueGrid}>{visibleRecommendations.map((card) => <article className={styles.unavailable} key={card.id}><span>OPTIONAL REVIEW</span><strong>{card.title}</strong><p>{card.why}</p><a className={styles.workflowLink} href={card.route}>Open conventional workflow <span aria-hidden="true">→</span></a><HideLocally id={`recommendation:${card.id}`} onHide={hide} label="Hide this card locally" /></article>)}{visibleRecommendations.length === 0 && <p className={styles.scopeState}>{snapshot.recommendations.length ? 'All recommendation cards are hidden locally. Restore them below at any time.' : 'No recommendation threshold is currently met. Available counts remain visible above.'}</p>}</div></>}</section>{hiddenCount > 0 && <section className={styles.notice} aria-live="polite"><strong>{hiddenCount} local {hiddenCount === 1 ? 'preference is' : 'preferences are'} applied.</strong><p>Only this browser hides these Command Center panels or cards. School data and authorizations are unchanged.</p><button type="button" onClick={() => persist([])}>Restore all hidden sections and cards</button></section>}</>}
  </main>;
}
