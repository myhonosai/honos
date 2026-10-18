'use client';

import React, { useEffect, useRef, useState } from 'react';
import { HON_AI_TEAM } from '@hon/design-system';
import type { AttendanceStatus, CommandCenterUnavailable, CrmLeadStatus, InvoiceStatus, MembershipState, PaymentAttemptState } from '@hon/contracts';
import { Icon, type IconName } from './icons';
import { HON_MARK_SOURCE, PORTRAIT_STYLES, portraitSource, type PortraitStyle } from './portraits';
import {
  SAMPLE_FOLLOW_UPS,
  SAMPLE_GENERATED_AT,
  SAMPLE_LEADS,
  SAMPLE_METRICS,
  SAMPLE_OWNER,
  SAMPLE_RECOMMENDATIONS,
  SAMPLE_SCHOOLS,
  SAMPLE_SESSIONS,
  SAMPLE_SNAPSHOT,
  SAMPLE_TIME_ZONE,
} from './sample-data';
import styles from './classic-dashboard.module.css';

// Classic CRM reference dashboard (owner-approved visual proof). Reference-only: it renders
// labeled sample data typed to the real read contracts, calls no API, stores nothing, and its
// links only navigate to existing staff workbenches that independently authorize every read.

const SELF = '/reference/classic-dashboard';

type NavItem = { label: string; href: string; icon: IconName; badge?: number };
const NAVIGATION: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [
    { label: 'Dashboard', href: SELF, icon: 'dashboard' },
    { label: 'Command Center', href: '/staff/command-center', icon: 'command' },
    { label: 'Health score', href: '/staff/health-score', icon: 'reports' },
  ] },
  { group: 'Growth', items: [
    { label: 'Leads', href: '/staff/crm/leads', icon: 'leads' },
    { label: 'Trials', href: '/staff/crm/trials', icon: 'trial' },
    { label: 'Follow-ups', href: '/staff/crm/follow-ups', icon: 'followUp' },
    { label: 'Campaigns', href: '/staff/marketing/campaigns', icon: 'marketing' },
  ] },
  { group: 'School', items: [
    { label: 'Class sessions', href: '/staff/schedule/sessions', icon: 'schedule' },
    { label: 'Attendance', href: '/staff/attendance', icon: 'attendance' },
    { label: 'Testing', href: '/staff/testing/readiness', icon: 'testing' },
  ] },
  { group: 'Billing', items: [
    { label: 'Memberships', href: '/staff/billing/memberships', icon: 'memberships' },
    { label: 'Invoices', href: '/staff/billing/invoices', icon: 'invoices' },
    { label: 'Renewals', href: '/staff/billing/renewals', icon: 'renewals' },
  ] },
  { group: 'AI team', items: [
    { label: 'AI work', href: '/staff/ai-work', icon: 'ai' },
    { label: 'Approvals', href: '/staff/action-center/approvals', icon: 'approvals', badge: SAMPLE_METRICS.pendingActionApprovals.count },
  ] },
  { group: 'Admin', items: [{ label: 'Staff roles', href: '/staff/roles', icon: 'settings' }] },
];

const QUICK_ACTIONS: { label: string; href: string; icon: IconName }[] = [
  { label: 'Add lead', href: '/staff/crm/leads', icon: 'plus' },
  { label: 'Schedule trial', href: '/staff/crm/trials', icon: 'trial' },
  { label: 'Take attendance', href: '/staff/attendance', icon: 'attendance' },
  { label: 'Create invoice', href: '/staff/billing/invoices', icon: 'invoices' },
];

const BOTTOM_NAV_START: { label: string; href: string; icon: IconName }[] = [
  { label: 'Home', href: SELF, icon: 'dashboard' },
  { label: 'Leads', href: '/staff/crm/leads', icon: 'leads' },
];
const BOTTOM_NAV_END: { label: string; href: string; icon: IconName }[] = [
  { label: 'Schedule', href: '/staff/schedule/sessions', icon: 'schedule' },
];

// Existing governed workspaces that match an employee's approved role. Everyone else (including Claire,
// Business Performance Manager) opens the shared AI draft inbox until a dedicated workspace exists.
// The curriculum/teaching assistant is a separate capability and is deliberately not linked as Claire's role.
const AGENT_WORKSPACES: Record<string, { href: string; label: string }> = {
  chad: { href: '/staff/leads/assistant', label: 'follow-up draft workspace' },
  marcus: { href: '/staff/marketing/assistant', label: 'marketing draft workspace' },
};
const DEFAULT_AGENT_WORKSPACE = { href: '/staff/ai-work', label: 'AI draft inbox (dedicated workspace not yet available)' };

const HON_JUMP_LINKS: { label: string; href: string; icon: IconName }[] = [
  { label: "Today's classes", href: '/staff/schedule/sessions', icon: 'schedule' },
  { label: 'Open leads', href: '/staff/crm/leads', icon: 'leads' },
  { label: 'Pending approvals', href: '/staff/action-center/approvals', icon: 'approvals' },
  { label: 'My AI draft work', href: '/staff/ai-work', icon: 'ai' },
];

// ---------- formatting (fixed time zone keeps server and client output identical) ----------
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: SAMPLE_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: SAMPLE_TIME_ZONE, month: 'short', day: 'numeric' });
const longDayFormat = new Intl.DateTimeFormat('en-US', { timeZone: SAMPLE_TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: SAMPLE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const number = new Intl.NumberFormat('en-US');
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
const money = (minor: number, currency: string): string => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
const sum = (values: Record<string, number>): number => Object.values(values).reduce((total, value) => total + value, 0);
const humanize = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

function relative(iso: string): string {
  const minutes = Math.round((Date.parse(SAMPLE_GENERATED_AT) - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

// ---------- derived sample facts (same arithmetic a live read would use) ----------
const today = dayKey.format(new Date(SAMPLE_GENERATED_AT));
const sessionsToday = SAMPLE_SESSIONS.filter((session) => dayKey.format(new Date(session.startsAt)) === today);
const attendanceTotal = sum(SAMPLE_SNAPSHOT.attendance.inRangeByStatus);
const attended = SAMPLE_SNAPSHOT.attendance.inRangeByStatus.PRESENT + SAMPLE_SNAPSHOT.attendance.inRangeByStatus.LATE + SAMPLE_SNAPSHOT.attendance.inRangeByStatus.MAKEUP;
const followUpsDue = SAMPLE_FOLLOW_UPS.filter(({ item }) => item.dueAt !== null && dayKey.format(new Date(item.dueAt)) <= today);
const paid = SAMPLE_METRICS.paidInvoicesCreated30d.amountsByCurrency[0];
const cancelledToday = sessionsToday.filter((session) => session.status === 'CANCELLED').length;
const overdueFollowUps = SAMPLE_FOLLOW_UPS.filter(({ item }) => item.dueAt !== null && Date.parse(item.dueAt) < Date.parse(SAMPLE_GENERATED_AT)).length;
const paymentsNeedingReview = ['FAILED', 'REQUIRES_ACTION', 'UNKNOWN'].reduce((total, state) => total + SAMPLE_SNAPSHOT.paymentAttempts.inRangeByState[state as PaymentAttemptState], 0);
const PHONE_ALERT_LIMIT = 3;

type Tone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'slate' | 'teal';
const LEAD_TONES: Record<CrmLeadStatus, Tone> = { OPEN: 'blue', WON: 'green', LOST: 'slate', ARCHIVED: 'violet' };
const MEMBERSHIP_TONES: Record<MembershipState, Tone> = { ACTIVE: 'green', DRAFT: 'slate', FROZEN: 'blue', CANCELLATION_PENDING: 'amber', CANCELLED: 'red', EXPIRED: 'violet' };
const ATTENDANCE_TONES: Record<AttendanceStatus, Tone> = { PRESENT: 'green', LATE: 'amber', MAKEUP: 'teal', EXCUSED_ABSENCE: 'blue', UNEXCUSED_ABSENCE: 'red' };
const INVOICE_TONES: Record<InvoiceStatus, Tone> = { PAID: 'green', ISSUED: 'blue', DRAFT: 'slate', VOID: 'violet', UNCOLLECTIBLE: 'red' };
const ATTENTION_PAYMENTS: PaymentAttemptState[] = ['FAILED', 'REQUIRES_ACTION', 'UNKNOWN'];

// ---------- small building blocks ----------
function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }): React.ReactElement {
  return <span className={styles.chip} data-tone={tone}>{children}</span>;
}

// On phones a collapsible panel shows only its title and a one-line summary until expanded.
// On larger screens the toggle is hidden and the body is always visible.
function Panel({ title, action, footnote, className, collapsible = false, summary, children }: { title: string; action?: { label: string; href: string }; footnote?: string; className?: string | undefined; collapsible?: boolean; summary?: string; children: React.ReactNode }): React.ReactElement {
  const headingId = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`${styles.panel} ${className ?? ''}`} aria-labelledby={headingId} data-collapsible={collapsible ? 'true' : undefined} data-expanded={collapsible ? String(expanded) : undefined}>
      <header className={styles.panelHeader}>
        <h2 id={headingId}>{title}</h2>
        {collapsible ? (
          <button type="button" className={styles.panelToggle} aria-expanded={expanded} aria-controls={`${headingId}-body`} onClick={() => setExpanded((open) => !open)}>
            <span>{summary}</span>
            <span className={styles.srOnly}>{expanded ? `Hide ${title}` : `Show ${title}`}</span>
            <Icon name="chevronDown" size={16} />
          </button>
        ) : null}
        {action ? <a className={styles.panelLink} href={action.href}>{action.label}<Icon name="arrowRight" size={14} /></a> : null}
      </header>
      <div className={styles.panelBody} id={`${headingId}-body`}>{children}</div>
      {footnote ? <p className={styles.footnote}>{footnote}</p> : null}
    </section>
  );
}

function Breakdown<K extends string>({ label, counts, tones }: { label: string; counts: Record<K, number>; tones: Record<K, Tone> }): React.ReactElement {
  const total = sum(counts);
  const entries = (Object.keys(counts) as K[]).map((key) => [key, counts[key]] as const);
  return (
    <div className={styles.breakdown}>
      <div className={styles.stack} role="img" aria-label={`${label}: ${entries.map(([key, value]) => `${humanize(key)} ${value}`).join(', ')}`}>
        {entries.filter(([, value]) => value > 0).map(([key, value]) => <span key={key} data-tone={tones[key]} style={{ flexGrow: value }} />)}
      </div>
      <ul className={styles.legend}>
        {entries.map(([key, value]) => (
          <li key={key}>
            <span className={styles.dot} data-tone={tones[key]} />
            <span>{humanize(key)}</span>
            <strong>{number.format(value)}</strong>
            <small>{total ? percent.format(value / total) : '—'}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Portrait({ id, name, style }: { id: string; name: string; style: PortraitStyle }): React.ReactElement {
  const source = portraitSource(id, style);
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setFailed(false);
    const element = image.current;
    // A server-rendered image can fail before hydration attaches onError.
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, [source]);
  if (failed || !source) return <span className={styles.portraitFallback} aria-hidden="true">{name.charAt(0)}</span>;
  return <img ref={image} className={styles.portrait} src={source} alt="" onError={() => setFailed(true)} />;
}

function HonMark(): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) return <span className={styles.markFallback} aria-hidden="true">H</span>;
  return <img ref={image} className={styles.mark} src={HON_MARK_SOURCE} alt="" onError={() => setFailed(true)} />;
}

function Unavailable({ title, fact }: { title: string; fact: CommandCenterUnavailable }): React.ReactElement {
  return (
    <div className={styles.unavailable}>
      <span className={styles.unavailableIcon}><Icon name="info" size={16} /></span>
      <div>
        <strong>{title}</strong>
        <Chip tone="slate">{fact.availability === 'INSUFFICIENT_DATA' ? 'Insufficient data' : 'Not available yet'}</Chip>
        <p>{fact.reason}</p>
      </div>
    </div>
  );
}

// ---------- page ----------
export function ClassicDashboard(): React.ReactElement {
  const [navOpen, setNavOpen] = useState(false);
  const [schoolMenuOpen, setSchoolMenuOpen] = useState(false);
  const [schoolIndex, setSchoolIndex] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [portraitStyle, setPortraitStyle] = useState<PortraitStyle>('realistic');
  const [honOpen, setHonOpen] = useState(false);
  const honArea = useRef<HTMLDivElement>(null);
  const schoolMenu = useRef<HTMLDivElement>(null);
  const notifications = useRef<HTMLDivElement>(null);
  const about = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const school = SAMPLE_SCHOOLS[schoolIndex] ?? SAMPLE_SCHOOLS[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (navOpen) menuButton.current?.focus();
      setNavOpen(false); setSchoolMenuOpen(false); setNotificationsOpen(false); setAboutOpen(false); setHonOpen(false);
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!schoolMenu.current?.contains(target)) setSchoolMenuOpen(false);
      if (!notifications.current?.contains(target)) setNotificationsOpen(false);
      if (!about.current?.contains(target)) setAboutOpen(false);
      const honTrigger = target instanceof Element && target.closest('[data-hon-trigger]');
      if (!honArea.current?.contains(target) && !honTrigger) setHonOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [navOpen]);

  const kpis: { label: string; value: string; detail: string; icon: IconName; tone: Tone; href: string }[] = [
    { label: 'Active students', value: number.format(SAMPLE_SNAPSHOT.studentProfiles.total), detail: 'Current student profiles', icon: 'students', tone: 'blue', href: '/staff/search' },
    { label: 'Open leads', value: number.format(SAMPLE_SNAPSHOT.leads.byStatus.OPEN), detail: `${SAMPLE_METRICS.newLeads24h.count} created in the last 24h`, icon: 'leads', tone: 'violet', href: '/staff/crm/leads' },
    { label: 'Trials · next 24h', value: number.format(SAMPLE_METRICS.upcomingTrials24h.count), detail: 'Scheduled trial appointments', icon: 'trial', tone: 'teal', href: '/staff/crm/trials' },
    { label: 'Active memberships', value: number.format(SAMPLE_SNAPSHOT.memberships.byState.ACTIVE), detail: `${SAMPLE_METRICS.membershipTermsEnding30d.count} terms end within 30 days`, icon: 'memberships', tone: 'green', href: '/staff/billing/memberships' },
    { label: 'Attendance · 30 days', value: percent.format(attended / attendanceTotal), detail: `${number.format(attendanceTotal)} attendance records`, icon: 'attendance', tone: 'amber', href: '/staff/attendance' },
    { label: 'Paid invoices · 30 days', value: paid ? money(paid.totalMinor, paid.currency) : '—', detail: `${SAMPLE_METRICS.paidInvoicesCreated30d.count} invoices · not cash revenue`, icon: 'invoices', tone: 'blue', href: '/staff/billing/invoices' },
  ];

  const glance: { label: string; value: number; detail: string; icon: IconName; tone: Tone; href: string }[] = [
    { label: 'Classes today', value: sessionsToday.length, detail: `${cancelledToday} cancelled`, icon: 'schedule', tone: 'blue', href: '/staff/schedule/sessions' },
    { label: 'Trials · next 24h', value: SAMPLE_METRICS.upcomingTrials24h.count, detail: 'Prepare intro lessons', icon: 'trial', tone: 'teal', href: '/staff/crm/trials' },
    { label: 'Follow-ups due', value: followUpsDue.length, detail: `${followUpsDue.filter(({ item }) => item.priority === 'HIGH').length} high priority`, icon: 'followUp', tone: 'violet', href: '/staff/crm/follow-ups' },
    { label: 'Testing events · 30 days', value: SAMPLE_METRICS.upcomingTestingEvents30d.count, detail: 'Draft, open or closed events', icon: 'testing', tone: 'amber', href: '/staff/testing/readiness' },
    { label: 'Pending approvals', value: SAMPLE_METRICS.pendingActionApprovals.count, detail: 'Awaiting a qualified reviewer', icon: 'approvals', tone: 'red', href: '/staff/action-center/approvals' },
  ];

  const sidebar = (
    <>
      <div className={styles.brand}>
        <HonMark />
        <div><strong>HON</strong><span>OS</span></div>
        <button type="button" className={styles.drawerClose} onClick={() => { setNavOpen(false); menuButton.current?.focus(); }} aria-label="Close navigation"><Icon name="close" /></button>
      </div>

      <div className={styles.schoolSelect} ref={schoolMenu}>
        <button type="button" className={styles.schoolButton} aria-haspopup="true" aria-expanded={schoolMenuOpen} aria-controls="school-menu" onClick={() => setSchoolMenuOpen((open) => !open)}>
          <span className={styles.schoolAvatar} aria-hidden="true">ST</span>
          <span className={styles.schoolText}><strong>{school.name}</strong><small>{school.location}</small></span>
          <Icon name="chevronDown" size={16} />
        </button>
        {schoolMenuOpen ? (
          <div className={styles.schoolMenu} id="school-menu" role="group" aria-label="School and location">
            {SAMPLE_SCHOOLS.map((option, index) => (
              <button key={option.id} type="button" aria-pressed={index === schoolIndex} onClick={() => { setSchoolIndex(index); setSchoolMenuOpen(false); }}>
                <Icon name="location" size={15} />
                <span><strong>{option.name}</strong><small>{option.location}</small></span>
              </button>
            ))}
            <p>Reference only. Live switching uses the server-authorized reporting-school list.</p>
          </div>
        ) : null}
      </div>

      <details className={styles.appearance}>
        <summary>
          <Icon name="palette" size={15} />
          <span>Appearance</span>
          <small>Classic · {PORTRAIT_STYLES.find((option) => option.id === portraitStyle)?.label}</small>
          <Icon name="chevronDown" size={14} className={styles.appearanceChevron} />
        </summary>
        <div className={styles.appearanceBody}>
          <p className={styles.appearanceLabel} id="platform-view-label">Platform view</p>
          <div className={styles.segmented} role="group" aria-labelledby="platform-view-label">
            <a href="/complete-mobile">Big-Button</a>
            <a href="/">Modern</a>
            <a href={SELF} aria-current="page">Classic</a>
          </div>
          <p className={styles.appearanceLabel} id="portrait-style-label">AI portraits</p>
          <div className={styles.segmented} role="radiogroup" aria-labelledby="portrait-style-label">
            {PORTRAIT_STYLES.map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={portraitStyle === option.id} onClick={() => setPortraitStyle(option.id)}>{option.label}</button>
            ))}
          </div>
          <p className={styles.appearanceNote}>Presentation only. Never changes data, permissions, or AI authority.</p>
        </div>
      </details>

      <nav className={styles.nav} aria-label="Primary">
        {NAVIGATION.map((section) => (
          <div key={section.group} className={styles.navGroup}>
            <p>{section.group}</p>
            <ul>
              {section.items.map((item) => (
                <li key={item.label}>
                  <a href={item.href} aria-current={item.href === SELF ? 'page' : undefined}>
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                    {item.badge ? <em aria-label={`${item.badge} pending`}>{item.badge}</em> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={styles.sidebarFoot}>
        <div className={styles.tier}><Icon name="ai" size={15} /><span><strong>HON Complete</strong><small>Sample entitlement</small></span></div>
        <div className={styles.user}>
          <span className={styles.userAvatar} aria-hidden="true">DK</span>
          <span><strong>{SAMPLE_OWNER.name}</strong><small>{SAMPLE_OWNER.role}</small></span>
        </div>
      </div>
    </>
  );

  return (
    <div className={styles.root}>
      <a className={styles.skip} href="#dashboard-main">Skip to dashboard</a>
      <p className={styles.banner} role="note"><Icon name="info" size={14} /><span className={styles.bannerLong}>Reference preview · sample data only · not connected to a school · links open the existing protected staff workbenches</span><span className={styles.bannerShort}>Reference preview · sample data · not a live school</span></p>

      <div className={styles.shell}>
        <aside className={styles.sidebar} data-open={navOpen} id="classic-sidebar" aria-label="School navigation">{sidebar}</aside>
        {navOpen ? <button type="button" className={styles.scrim} aria-label="Close navigation" onClick={() => setNavOpen(false)} /> : null}

        <div className={styles.main}>
          <header className={styles.topbar}>
            <button ref={menuButton} type="button" className={styles.menuButton} aria-label="Open navigation" aria-expanded={navOpen} aria-controls="classic-sidebar" onClick={() => setNavOpen(true)}><Icon name="menu" /></button>
            <a className={styles.search} href="/staff/search"><Icon name="search" size={16} /><span>Search students, leads, and classes</span></a>
            <div className={styles.topActions}>
              <span className={styles.today}>{longDayFormat.format(new Date(SAMPLE_GENERATED_AT))}</span>
              <div className={styles.popoverAnchor} ref={notifications}>
                <button type="button" className={styles.iconButton} aria-label={`Notifications, ${SAMPLE_RECOMMENDATIONS.length} items`} aria-expanded={notificationsOpen} aria-controls="notifications-popover" onClick={() => setNotificationsOpen((open) => !open)}>
                  <Icon name="bell" /><span className={styles.badge} aria-hidden="true">{SAMPLE_RECOMMENDATIONS.length}</span>
                </button>
                {notificationsOpen ? (
                  <div className={styles.popover} id="notifications-popover">
                    <p className={styles.popoverTitle}>Needs attention</p>
                    <ul>
                      {SAMPLE_RECOMMENDATIONS.map((item) => (
                        <li key={item.id}><a href={item.route}><strong>{item.title}</strong><span>{item.why}</span></a></li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <div className={styles.popoverAnchor} ref={about}>
                <button type="button" className={styles.iconButton} aria-label="About this preview" aria-expanded={aboutOpen} aria-controls="about-popover" onClick={() => setAboutOpen((open) => !open)}><Icon name="help" /></button>
                {aboutOpen ? (
                  <div className={styles.popover} id="about-popover">
                    <p className={styles.popoverTitle}>About this preview</p>
                    <p className={styles.popoverText}>Values are sample data shaped exactly like the Operations Report, Command Center, class-session, lead and follow-up reads. Revenue, conversion and trends stay unavailable until an authoritative source exists. Links open the real staff workbenches, which verify your session, school and permissions.</p>
                  </div>
                ) : null}
              </div>
              <span className={styles.userAvatar} aria-hidden="true">DK</span>
            </div>
          </header>

          <main className={styles.content} id="dashboard-main" tabIndex={-1}>
            <div className={styles.pageHeader}>
              <div>
                <p className={styles.eyebrow}>{school.name} · {school.location}</p>
                <h1>Dashboard</h1>
                <p className={styles.subtle}>Snapshot {timeFormat.format(new Date(SAMPLE_GENERATED_AT))} · 30-day window ending {dayFormat.format(new Date(SAMPLE_SNAPSHOT.to))}</p>
              </div>
              <div className={styles.quickActions} aria-label="Quick actions">
                {QUICK_ACTIONS.map((action) => <a key={action.label} href={action.href}><Icon name={action.icon} size={16} />{action.label}</a>)}
              </div>
            </div>

            <ul className={styles.kpis} aria-label="Key figures">
              {kpis.map((kpi) => (
                <li key={kpi.label}>
                  <a className={styles.kpi} href={kpi.href}>
                    <span className={styles.kpiIcon} data-tone={kpi.tone}><Icon name={kpi.icon} size={20} /></span>
                    <span className={styles.kpiText}><span>{kpi.label}</span><strong>{kpi.value}</strong><small>{kpi.detail}</small></span>
                  </a>
                </li>
              ))}
            </ul>

            <section className={styles.team} aria-labelledby="team-heading">
              <header className={styles.panelHeader}>
                <h2 id="team-heading">HON AI team <Chip tone="violet">Complete</Chip></h2>
                <span className={styles.teamNote}>Governed · approval required · no work recorded in this sample</span>
                <a className={styles.panelLink} href="/staff/ai-work">AI work<Icon name="arrowRight" size={14} /></a>
              </header>
              <ul className={styles.teamList}>
                {HON_AI_TEAM.map((member) => {
                  const workspace = AGENT_WORKSPACES[member.id] ?? DEFAULT_AGENT_WORKSPACE;
                  return (
                    <li key={member.id}>
                      <a className={styles.agent} href={workspace.href} title={`${member.title} · ${workspace.label}`} aria-label={`${member.name}, ${member.title}. Open ${workspace.label}`}>
                        <Portrait id={member.id} name={member.name} style={portraitStyle} />
                        <span className={styles.agentText}><strong>{member.name}</strong><span>{member.title}</span></span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>

            <div className={styles.grid}>
              <h2 className={styles.moreHeading}>More details</h2>
              <Panel title="Today at a glance" className={`${styles.span4} ${styles.tabletFull} ${styles.phoneGlance}`}>
                <ul className={styles.glance}>
                  {glance.map((row) => (
                    <li key={row.label}>
                      <a href={row.href}>
                        <span className={styles.glanceIcon} data-tone={row.tone}><Icon name={row.icon} size={17} /></span>
                        <span className={styles.glanceText}><strong>{row.value}</strong><span>{row.label}</span><small>{row.detail}</small></span>
                        <Icon name="chevronRight" size={16} className={styles.chevron} />
                      </a>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Today's classes" action={{ label: 'Class sessions', href: '/staff/schedule/sessions' }} footnote="Booked counts and instructors are not part of the current class-session read." className={styles.span8} collapsible summary={`${sessionsToday.length} classes · ${cancelledToday} cancelled`}>
                <table className={styles.table}>
                  <thead><tr><th scope="col">Time</th><th scope="col">Class</th><th scope="col">Room</th><th scope="col">Capacity</th><th scope="col">Booking</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {sessionsToday.map((session) => (
                      <tr key={session.sessionId}>
                        <td data-label="Time" className={styles.mono}>{timeFormat.format(new Date(session.startsAt))}</td>
                        <th scope="row" data-label="Class">{session.name}</th>
                        <td data-label="Room">{session.roomName ?? '—'}</td>
                        <td data-label="Capacity" data-meta="Capacity">{session.capacity}</td>
                        <td data-label="Booking">{humanize(session.bookingPolicy)}</td>
                        <td data-label="Status" className={styles.cellStatus}><Chip tone={session.status === 'CANCELLED' ? 'red' : 'blue'}>{humanize(session.status)}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Lead pipeline" action={{ label: 'Leads', href: '/staff/crm/leads' }} footnote="Won and lost reflect CRM close state only, not enrollment or payment." className={`${styles.span4} ${styles.tabletFull}`} collapsible summary={`${SAMPLE_SNAPSHOT.leads.byStatus.OPEN} open · ${SAMPLE_SNAPSHOT.leads.byStatus.WON} won`}>
                <Breakdown label="Leads by status" counts={SAMPLE_SNAPSHOT.leads.byStatus} tones={LEAD_TONES} />
              </Panel>

              <Panel title="Recent leads" action={{ label: 'All leads', href: '/staff/crm/leads' }} className={styles.span8} collapsible summary={`${SAMPLE_LEADS.length} most recent`}>
                <table className={styles.table}>
                  <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Next follow-up</th></tr></thead>
                  <tbody>
                    {SAMPLE_LEADS.map((lead) => (
                      <tr key={lead.id}>
                        <th scope="row" data-label="Name">{lead.givenName} {lead.familyName}</th>
                        <td data-label="Status" className={styles.cellStatus}><Chip tone={LEAD_TONES[lead.status]}>{humanize(lead.status)}</Chip></td>
                        <td data-label="Created" data-meta="Created">{relative(lead.createdAt)}</td>
                        <td data-label="Next follow-up" data-meta="Follow-up">{lead.nextFollowUpAt ? `${dayFormat.format(new Date(lead.nextFollowUpAt))}, ${timeFormat.format(new Date(lead.nextFollowUpAt))}` : <span className={styles.muted}>Not set</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Memberships" action={{ label: 'Memberships', href: '/staff/billing/memberships' }} className={styles.span4} collapsible summary={`${SAMPLE_SNAPSHOT.memberships.byState.ACTIVE} active`}>
                <Breakdown label="Memberships by state" counts={SAMPLE_SNAPSHOT.memberships.byState} tones={MEMBERSHIP_TONES} />
              </Panel>

              <Panel title="Billing status · 30 days" action={{ label: 'Invoices', href: '/staff/billing/invoices' }} footnote="Unknown payment outcomes are never treated as paid." className={styles.span4} collapsible summary={`${paymentsNeedingReview} payments to review`}>
                <Breakdown label="Invoices by status" counts={SAMPLE_SNAPSHOT.invoices.inRangeByStatus} tones={INVOICE_TONES} />
                <div className={styles.attention}>
                  <p>Payment attempts needing review</p>
                  <ul>
                    {ATTENTION_PAYMENTS.map((state) => (
                      <li key={state}><span>{humanize(state)}</span><strong data-alert={SAMPLE_SNAPSHOT.paymentAttempts.inRangeByState[state] > 0}>{SAMPLE_SNAPSHOT.paymentAttempts.inRangeByState[state]}</strong></li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <Panel title="Attendance · 30 days" action={{ label: 'Attendance', href: '/staff/attendance' }} className={`${styles.span4} ${styles.tabletFull}`} collapsible summary={`${percent.format(attended / attendanceTotal)} attended`}>
                <Breakdown label="Attendance by status" counts={SAMPLE_SNAPSHOT.attendance.inRangeByStatus} tones={ATTENDANCE_TONES} />
              </Panel>

              <Panel title="Needs attention" action={{ label: 'Command Center', href: '/staff/command-center' }} footnote="Deterministic suggestions. Each one only opens a workbench; nothing runs automatically." className={`${styles.span5} ${styles.tabletFull} ${styles.phoneAlerts}`}>
                <ul className={styles.tasks}>
                  {SAMPLE_RECOMMENDATIONS.map((item, index) => (
                    <li key={item.id} data-beyond-phone-limit={index >= PHONE_ALERT_LIMIT ? 'true' : undefined}><a href={item.route}><span><strong>{item.title}</strong><small>{item.why}</small></span><Icon name="chevronRight" size={16} className={styles.chevron} /></a></li>
                  ))}
                </ul>
                {SAMPLE_RECOMMENDATIONS.length > PHONE_ALERT_LIMIT ? <a className={styles.phoneMore} href="/staff/command-center">View all {SAMPLE_RECOMMENDATIONS.length} in Command Center<Icon name="arrowRight" size={14} /></a> : null}
              </Panel>

              <Panel title="Follow-ups" action={{ label: 'Follow-ups', href: '/staff/crm/follow-ups' }} footnote="Due dates are planning metadata, not scheduled reminders. Completing a follow-up sends nothing." className={styles.span7} collapsible summary={`${overdueFollowUps} overdue`}>
                <table className={styles.table}>
                  <thead><tr><th scope="col">Lead</th><th scope="col">Priority</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {SAMPLE_FOLLOW_UPS.map(({ item, leadName }) => {
                      const overdue = item.dueAt !== null && Date.parse(item.dueAt) < Date.parse(SAMPLE_GENERATED_AT);
                      return (
                        <tr key={item.followUpId}>
                          <th scope="row" data-label="Lead">{leadName}</th>
                          <td data-label="Priority" className={styles.cellStatus}><Chip tone={item.priority === 'HIGH' ? 'red' : item.priority === 'NORMAL' ? 'blue' : 'slate'}>{humanize(item.priority)}</Chip></td>
                          <td data-label="Due" data-meta="Due">{item.dueAt ? <span className={overdue ? styles.overdue : undefined}>{dayFormat.format(new Date(item.dueAt))}, {timeFormat.format(new Date(item.dueAt))}{overdue ? ' · overdue' : ''}</span> : <span className={styles.muted}>No due date</span>}</td>
                          <td data-label="Status">{humanize(item.status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Business performance" footnote="These measures stay unavailable until an authoritative source exists. HON never estimates them." className={styles.span12} collapsible summary="4 not available yet">
                <div className={styles.unavailableGrid}>
                  <Unavailable title="Revenue" fact={SAMPLE_METRICS.revenue} />
                  <Unavailable title="Trial conversion" fact={SAMPLE_METRICS.trialConversion} />
                  <Unavailable title="Attendance trend" fact={SAMPLE_METRICS.attendanceDecline} />
                  <Unavailable title="Unanswered inquiries" fact={SAMPLE_METRICS.unansweredInquiries} />
                </div>
              </Panel>
            </div>
          </main>
        </div>
      </div>

      <div className={styles.hon} ref={honArea}>
        {honOpen ? (
          <section className={styles.honPanel} id="hon-panel" aria-labelledby="hon-title">
            <header className={styles.honHeader}>
              <span className={styles.honOrb} aria-hidden="true">HON</span>
              <div>
                <h2 id="hon-title">HON assistant</h2>
                <Chip tone="amber">Preview · not connected</Chip>
              </div>
              <button type="button" className={styles.iconButton} aria-label="Close HON assistant" onClick={() => setHonOpen(false)}><Icon name="close" size={16} /></button>
            </header>
            <p className={styles.honText}>HON is your school&apos;s conversational front door in HON Complete. In this reference preview, chat and voice are not connected: nothing is sent and HON takes no action.</p>
            <p className={styles.honLabel}>Jump to</p>
            <ul className={styles.honLinks}>
              {HON_JUMP_LINKS.map((link) => <li key={link.label}><a href={link.href}><Icon name={link.icon} size={15} />{link.label}<Icon name="chevronRight" size={14} className={styles.chevron} /></a></li>)}
            </ul>
            <div className={styles.honComposer}>
              <label className={styles.srOnly} htmlFor="hon-message">Message HON (not connected in this preview)</label>
              <input id="hon-message" type="text" disabled placeholder="Chat is not connected in this preview" />
              <button type="button" disabled aria-label="Voice is off in this preview"><Icon name="mic" size={16} /></button>
            </div>
            <a className={styles.honWorkspace} href="/staff/voice">Open HON workspace<Icon name="arrowRight" size={14} /></a>
          </section>
        ) : null}
        <button type="button" data-hon-trigger className={styles.honButton} aria-label="Open HON assistant" aria-expanded={honOpen} aria-controls={honOpen ? 'hon-panel' : undefined} onClick={() => setHonOpen((open) => !open)}>HON</button>
      </div>

      <nav className={styles.bottomNav} aria-label="Quick navigation">
        {BOTTOM_NAV_START.map((item) => (
          <a key={item.label} href={item.href} aria-current={item.href === SELF ? 'page' : undefined}><Icon name={item.icon} size={20} /><span>{item.label}</span></a>
        ))}
        <button type="button" data-hon-trigger className={styles.bottomHon} aria-label="Open HON assistant" aria-expanded={honOpen} onClick={() => setHonOpen((open) => !open)}><span className={styles.honOrb} aria-hidden="true">HON</span><span>Ask HON</span></button>
        {BOTTOM_NAV_END.map((item) => (
          <a key={item.label} href={item.href}><Icon name={item.icon} size={20} /><span>{item.label}</span></a>
        ))}
        <button type="button" aria-label="More navigation" aria-expanded={navOpen} aria-controls="classic-sidebar" onClick={() => setNavOpen(true)}><Icon name="more" size={20} /><span>More</span></button>
      </nav>
    </div>
  );
}
