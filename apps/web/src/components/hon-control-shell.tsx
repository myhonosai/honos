'use client';

import { useState } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, HON_INTERFACE_THEMES, honTokens, type HonInterfaceTheme } from '@hon/design-system';
import { InterfaceThemePicker } from './interface-theme-picker';

const navigation = [
  ['Today', 'Your day at a glance'],
  ['CRM', 'Leads, trials, enrollment'],
  ['Students & Families', 'Student records and family relationships'],
  ['Schedule & Attendance', 'Classes, capacity, check-in'],
  ['Billing', 'Memberships, invoices, payments'],
  ['Progress & Testing', 'Curriculum, ranks, instructor judgment'],
  ['Achievements', 'Explicit human student recognition'],
  ['Staff', 'Roles, qualifications, work'],
  ['Work', 'Conventional human work records'],
  ['Growth', 'Marketing, goals, attribution'],
  ['Reports', 'Evidence-backed operations'],
  ['Community', 'Verified human owner discussions'],
  ['Action Center', 'Human approval review queue'],
  ['Voice', 'Complete human handoff and private draft'],
] as const;

const foundation = [
  ['Tenant isolation', 'PostgreSQL RLS migrations and transaction-bound tenant scope contracts are present.', 'VERIFIED'],
  ['Operational spine', 'CRM, Billing, audit, idempotency, and outbox share one command boundary.', 'IN BUILD'],
  ['Action safety', 'Typed tools, authority floors, and approval binding are the only AI execution path.', 'GUARDED'],
] as const;

const workstreams = [
  ['CRM & enrollment', 'Command/query contracts', 'Active'],
  ['Billing & membership', 'Ledger and reconciliation contracts', 'Active'],
  ['Action Engine', 'Authority and approval engine', 'Active'],
  ['Parent App / Eian', 'Family-scope contract definition', 'Queued'],
  ['Curriculum & testing', 'Progression model definition', 'Queued'],
  ['AI Office', 'Durable work and visibility layer', 'Queued'],
] as const;

const aiTeam = [
  ['Alex', 'General Manager', 'Leadership', 'READY', 'A'],
  ['Chad', 'Enrollment Director', 'Growth', 'READY', 'C'],
  ['Maya', 'Student Success Manager', 'Care', 'READY', 'M'],
  ['Marcus', 'Marketing Director', 'Creativity', 'READY', 'M'],
  ['Jordan', 'Operations Manager', 'Stability', 'READY', 'J'],
  ['Claire', 'Business Performance Manager', 'Analytics', 'READY', 'C'],
  ['Lena', 'Creative & Commerce Manager', 'Imagination', 'READY', 'L'],
] as const;

function Rail(): React.ReactElement {
  return (
    <aside className="side-rail" aria-label="HON operational navigation">
      <div className="brand-lockup"><img className="hon-mark" src="/manus-storage/async-images/V2i1yOxmOLQ5wsG9Ltutn8/image-1.webp" alt="" /><div><strong>HON</strong><span>For Martial Arts</span></div></div>
      <div className="context-capsule"><span>ACTIVE CONTEXT</span><strong>Foundation Workspace</strong><small>No organization or school is selected</small></div>
      <nav>{navigation.map(([label, hint], index) => <a className={index === 0 ? 'active' : ''} href={label === 'Achievements' ? '/staff/students/achievements' : label === 'Community' ? '/community' : label === 'Action Center' ? '/staff/action-center/approvals' : label === 'Voice' ? '/staff/voice' : label === 'Work' ? '/staff/work' : `#${label.toLowerCase().replaceAll(' ', '-')}`}  key={label} title={hint}><span className="nav-index">{String(index + 1).padStart(2, '0')}</span>{label}</a>)}</nav>
      <div className="rail-foot"><a className="hq-launch" href="/hq">HON HQ <span>↗</span></a><span className="pulse-dot" />Conventional controls remain available if AI, voice, or a provider is unavailable.</div>
    </aside>
  );
}

function ViewHeader({ theme, onChange }: { theme: HonInterfaceTheme; onChange: (value: HonInterfaceTheme) => void }): React.ReactElement {
  const selected = HON_INTERFACE_THEMES.find((candidate) => candidate.id === theme);
  return (
    <header className="topbar">
      <div><p className="eyebrow">HON / FOUNDATION</p><h1>One operating system.<br />Your preferred way to work.</h1></div>
      <div className="topbar-actions"><span className="tier-chip">PRESENTATION MODE</span><InterfaceThemePicker current={theme} onChange={onChange} /><small className="theme-explainer">{selected?.recommendedFor} · the same scoped data, permissions, and actions in every theme.</small></div>
    </header>
  );
}

function FoundationStatus(): React.ReactElement {
  return <section className="system-note"><div className="system-note-icon">i</div><div><strong>Foundation status: PostgreSQL migrations are current; a non-privileged runtime connection is required.</strong><p>The UI does not fabricate operational records or fall back to a privileged migration connection. An authorized organization and school session activates scoped data only after the RLS-enforced runtime role is configured.</p></div></section>;
}

function BigButtonTheme(): React.ReactElement {
  return (
    <div className="big-button-stage">
      <FoundationStatus />
      <section className="welcome-board panel"><div><p className="eyebrow">BIG-BUTTON / PHONE</p><h2>Clear next steps, built for touch.</h2><p>Large cards, simple choices, and familiar navigation support mobile-first school operations without changing what HON can do.</p></div><div className="module-path"><span>STAFF UI</span><i>→</i><span>HON API</span><i>→</i><span>DOMAIN</span><i>→</i><span>POSTGRESQL</span><small>The same governed system sits beneath every interface theme.</small></div></section>
      <section className="module-grid" aria-label="School operating modules">{navigation.slice(1).map(([label, hint], index) => <article key={label} className="module-card"><span className={`module-symbol symbol-${index % 6}`}>{String(index + 1).padStart(2, '0')}</span><h3>{label}</h3><p>{hint}</p><button type="button" disabled>Awaiting school scope <span>→</span></button></article>)}</section>
    </div>
  );
}

function ModernHonTheme(): React.ReactElement {
  return (
    <div className="modern-stage">
      <FoundationStatus />
      <section className="welcome-board panel"><div><p className="eyebrow">MODERN HON</p><h2>Good operations begin with a clear next step.</h2><p>Visual clarity, useful context, and balanced density for daily martial-arts school operations.</p></div><div className="module-path"><span>STAFF UI</span><i>→</i><span>HON API</span><i>→</i><span>DOMAIN</span><i>→</i><span>POSTGRESQL</span><small>Parent / Eian · Automation · AI Tools all converge here</small></div></section>
      <section className="foundation-section"><div className="section-heading"><div><p className="eyebrow">DEPENDENCY BOUNDARIES</p><h2>Foundation work</h2></div><span>Contracts stabilize first; safe domains then move in parallel.</span></div><div className="foundation-cards">{foundation.map(([title, detail, state]) => <article className="foundation-card" key={title}><div><h3>{title}</h3><span className={`state state-${state.toLowerCase().replaceAll(' ', '-')}`}>{state}</span></div><p>{detail}</p></article>)}</div></section>
      <section className="module-grid" aria-label="School operating modules">{navigation.slice(1).map(([label, hint], index) => <article key={label} className="module-card"><span className={`module-symbol symbol-${index % 6}`}>{String(index + 1).padStart(2, '0')}</span><h3>{label}</h3><p>{hint}</p><button type="button" disabled>Awaiting school scope <span>→</span></button></article>)}</section>
    </div>
  );
}

function ClassicTheme(): React.ReactElement {
  return (
    <div className="dark-stage">
      <section className="dark-hero"><p className="eyebrow">CLASSIC / AGENCY PLATFORM</p><h2>High-density control. Same rules. Zero shortcuts.</h2><p>For experienced staff and power users who want an administrative CRM workspace, every record, entitlement, permission, and approval remains identical to the other HON themes.</p><div className="dark-rails"><span><b>01</b>Tenant scope</span><span><b>02</b>Domain command</span><span><b>03</b>Audit + outbox</span><span><b>04</b>Verified result</span></div></section>
      <section className="dark-workspace"><div className="dark-column"><p className="eyebrow">SYSTEM STATE</p>{foundation.map(([title, detail, state]) => <article className="dark-status" key={title}><span className={`state state-${state.toLowerCase().replaceAll(' ', '-')}`}>{state}</span><h3>{title}</h3><p>{detail}</p></article>)}</div><div className="dark-column central"><p className="eyebrow">NO ACTIVE TENANT DATA</p><div className="empty-radar"><div /><div /><div /><b>Scoped data activates only after authentication, authorization, and RLS tenant context are bound.</b></div></div><div className="dark-column"><p className="eyebrow">SAFE PATHS</p><article className="dark-status"><span className="state state-guarded">RESTRICTED</span><h3>Financial mutations</h3><p>Payments, refunds, credits, concessions, and membership changes wait for the registered policy/approval route.</p></article><article className="dark-status"><span className="state state-verified">READY</span><h3>Conventional use</h3><p>Normal UI never requires an AI employee, a voice provider, or a model response.</p></article></div></section>
      <section className="workstream-section dark-workstreams"><div className="section-heading"><div><p className="eyebrow">DELIVERY MAP</p><h2>Parallel workstreams</h2></div><span>Same work, more information density.</span></div><div className="workstream-list">{workstreams.map(([area, scope, status], index) => <div className="workstream-row" key={area}><span className="nav-index">{String(index + 1).padStart(2, '0')}</span><strong>{area}</strong><span>{scope}</span><em className={status === 'Active' ? 'active-status' : ''}>{status}</em></div>)}</div></section>
    </div>
  );
}

function AiOfficeWorkspace(): React.ReactElement {
  return <section className="ai-stage" aria-label="Complete AI Office workspace"><section className="ai-intro"><div><p className="eyebrow">COMPLETE / AI OFFICE</p><h2>Visible team experience.<br />Governed real work.</h2><p>Alex and the HON team become operators only through registered tools, scoped permissions, durable work items, and the Action Engine. This Complete workspace adopts the selected interface theme; it is not a separate application or theme.</p></div><div className="ai-safety-card"><span>AI STATUS</span><strong>Workspace unavailable until Complete</strong><p>Durable work and voice require a scoped school context plus configured providers.</p></div></section><section className="team-roster" aria-label="HON AI team roster">{aiTeam.map(([name, role, signal, status, initial], index) => <article className={`agent agent-${index}`} key={name}><span className="agent-orb">{initial}</span><div><h3>{name}</h3><p>{role}</p><small>{signal}</small></div><em><i />{status}</em></article>)}</section><section className="ai-console"><div className="alex-panel"><div className="alex-avatar">A</div><div><p className="eyebrow">ALEX / GENERAL MANAGER</p><h2>What should HON help you work on?</h2><p>Choose a conventional module or use a text request after your tenant context is verified. Voice stays optional and always degrades to this same text work surface.</p><div className="suggestion-row"><button type="button" disabled>Show operational priorities</button><button type="button" disabled>Explain a report</button><button type="button" disabled>Review pending approvals</button></div><div className="command-lane"><span>⌘</span><p>Command lane unavailable until a scoped Complete session is established</p><button type="button" disabled>Send</button></div></div></div><aside className="action-guard"><p className="eyebrow">ACTION GUARD</p><ol><li>Registered typed tool</li><li>Permission, tier, policy</li><li>Authority + approval</li><li>Domain verification + audit</li></ol><small>No direct SQL · no raw provider credentials · no self-approved authority</small></aside></section></section>;
}

export function HonControlShell(): React.ReactElement {
  const [theme, setTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const contextStyle = { '--hon-teal': honTokens.color.teal } as React.CSSProperties;
  return <main className={`hon-shell theme-${theme}`} style={contextStyle}><Rail /><section className="work-area"><ViewHeader theme={theme} onChange={setTheme} />{theme === 'big-button' && <BigButtonTheme />}{theme === 'modern' && <ModernHonTheme />}{theme === 'classic' && <ClassicTheme />}<AiOfficeWorkspace /></section></main>;
}
