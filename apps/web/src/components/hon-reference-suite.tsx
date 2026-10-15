'use client';
import { ParentJourneyUnavailable } from './parent-journey-unavailable';

import React, { useMemo, useState } from 'react';
import {
  HON_AI_TEAM,
  HON_INTERFACE_THEMES,
  HON_REFERENCE_SCREEN_STATES,
  type HonAiTeamId,
  type HonAiTeamMember,
  type HonInterfaceTheme,
} from '@hon/design-system';
import styles from './hon-reference-suite.module.css';

type ReferenceScreen = keyof typeof HON_REFERENCE_SCREEN_STATES;

const schoolNavigation = ['Home', 'AI Team', 'Students', 'Programs', 'Leads', 'Attendance', 'Schedule', 'Billing', 'Messages', 'Documents', 'Reports', 'Community', 'Action Center', 'Settings'];
const hqNavigation = ['Home', 'AI Team', 'AI Providers', 'Schools', 'Onboarding', 'Growth', 'Customer Success', 'Finance', 'Product', 'Support', 'Analytics', 'Settings'];

const schoolMetrics = [
  ['191', 'Active Students', '+3'],
  ['24', 'New Leads', '+6'],
  ['8', 'Trial Classes', '+2'],
  ['$31,850', 'Monthly Revenue', '+12%'],
] as const;

const hqMetrics = [
  ['20', 'Active Schools', '+3'],
  ['$112k', 'MRR', '+18%'],
  ['4', 'New Signups', '+2'],
  ['2', 'Churn Risk', 'Attention'],
  ['$412', 'AI Cost / School', 'Stable'],
] as const;

function ReferenceNotice(): React.ReactElement {
  return <div className={styles.referenceNotice}>Design reference · representative sample state only · no tenant data is read or changed</div>;
}

function Mark({ compact = false }: { compact?: boolean }): React.ReactElement {
  return <div className={`${styles.mark} ${compact ? styles.markCompact : ''}`} aria-label="HON for Martial Arts"><strong>HON</strong><span>For Martial Arts</span></div>;
}

function PresentationThemeSwitcher({ theme, onChange }: { theme: HonInterfaceTheme; onChange: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  return <section className={styles.themeSwitcher} aria-label="HON presentation mode"><span>Presentation</span><div>{HON_INTERFACE_THEMES.map((option) => <button key={option.id} type="button" aria-pressed={theme === option.id} onClick={() => onChange(option.id)}><strong>{option.label}</strong><small>{option.id === 'modern' ? 'Recommended' : option.id === 'big-button' ? 'Touch-first' : 'High density'}</small></button>)}</div><p>Presentation only · the same school scope, permissions, and actions stay in effect.</p></section>;
}

function AgentPortrait({ agent, selected, onSelect, status = 'Ready' }: { agent: HonAiTeamMember; selected?: boolean; onSelect?: () => void; status?: string }): React.ReactElement {
  return <button
    type="button"
    className={`${styles.agentPortrait} ${selected ? styles.agentSelected : ''}`}
    style={{ '--agent-color': agent.color } as React.CSSProperties}
    onClick={onSelect}
    aria-pressed={selected}
  >
    <span className={styles.portraitFrame}><img src={agent.portrait} alt="" /></span>
    <span className={styles.agentName}>{agent.name}</span>
    <span className={styles.agentRole}>{agent.title}</span>
    <span className={styles.agentState}><i />{status}</span>
  </button>;
}

function Sidebar({ mode }: { mode: 'school' | 'hq' }): React.ReactElement {
  const navigation = mode === 'hq' ? hqNavigation : schoolNavigation;
  return <aside className={`${styles.sidebar} ${mode === 'hq' ? styles.hqSidebar : ''}`}>
	<Mark />
	<nav aria-label={mode === 'hq' ? 'HON HQ navigation' : 'HON school navigation'}>
	  {navigation.map((item, index) => <a className={index === 0 ? styles.activeNav : ''} href={mode !== 'hq' && item === 'Community' ? '/community' : mode !== 'hq' && item === 'Action Center' ? '/staff/action-center/approvals' : mode === 'hq' && item === 'AI Providers' ? '/hq/ai-providers' : index === 0 ? '#' : `#${item.toLowerCase().replaceAll(' ', '-')}`} key={item}><span>{String(index + 1).padStart(2, '0')}</span>{item}</a>)}
	</nav>
    <div className={styles.sidebarFooter}><span className={styles.liveDot} />{mode === 'hq' ? 'Separate HQ authorization' : 'School context required for live work'}</div>
  </aside>;
}

function AgentRoster({ active, onActive, hq = false }: { active: HonAiTeamId; onActive: (id: HonAiTeamId) => void; hq?: boolean }): React.ReactElement {
  const team = hq ? [HON_AI_TEAM[2], HON_AI_TEAM[1], HON_AI_TEAM[0], HON_AI_TEAM[5], HON_AI_TEAM[4]] : HON_AI_TEAM;
  return <section className={`${styles.agentRoster} ${hq ? styles.hqRoster : ''}`} aria-label="HON AI team">
    {team.map((agent) => <AgentPortrait agent={agent} key={agent.id} selected={active === agent.id} onSelect={() => onActive(agent.id)} status={active === agent.id ? 'Selected' : agent.id === 'chad' ? 'Working' : 'Ready'} />)}
  </section>;
}

function CommandLane({ agent, hq = false, compact = false }: { agent: HonAiTeamMember; hq?: boolean; compact?: boolean }): React.ReactElement {
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const prompt = hq ? 'Ask about growth, costs, risk, onboarding, or customer health…' : `Ask ${agent.name} about your school…`;
  return <section className={`${styles.commandBlock} ${compact ? styles.commandCompact : ''}`}>
    <div className={styles.commandHeadline}><span className={styles.signalOrb} style={{ '--agent-color': agent.color } as React.CSSProperties} /><div><small>{agent.name.toUpperCase()} · {agent.title.toUpperCase()}</small><strong>{hq ? 'Your AI team is on it.' : `Good morning, Master David.`}</strong></div><span className={styles.voiceState}>Voice + text</span></div>
    <form className={styles.commandForm} onSubmit={(event) => { event.preventDefault(); if (value.trim()) setSubmitted(true); }}>
      <button className={styles.micButton} type="button" onClick={() => setSubmitted(true)} aria-label="Show reference voice state">⌁</button>
      <input value={value} onChange={(event) => { setValue(event.target.value); setSubmitted(false); }} placeholder={prompt} aria-label={prompt} />
      <button className={styles.sendButton} type="submit">Send <span>→</span></button>
    </form>
    {submitted && <p className={styles.commandFeedback}>Reference response: a verified tenant would create a governed work item or proposal here; this preview has not submitted any action.</p>}
  </section>;
}

function MetricOrbit({ hq = false }: { hq?: boolean }): React.ReactElement {
  const metrics = hq ? hqMetrics : schoolMetrics;
  return <section className={`${styles.metricOrbit} ${hq ? styles.hqMetricOrbit : ''}`}>
    {metrics.map(([value, label, delta], index) => <article key={label} className={`${styles.metricCard} ${index === 3 && hq ? styles.metricRisk : ''}`}><small>{label}</small><strong>{value}</strong><span>{delta}</span><i /></article>)}
  </section>;
}

function ApprovalPreview(): React.ReactElement {
  const [reviewed, setReviewed] = useState(false);
  return <article className={styles.approvalPreview}>
    <div><span className={styles.approvalFlag}>WAITING FOR APPROVAL</span><strong>Marcus · Publish spring trial campaign</strong><p>Audience, destination, and budget are bound to the exact proposal.</p></div>
    <button type="button" onClick={() => setReviewed(true)}>{reviewed ? 'Preview reviewed' : 'Review proposal'}</button>
  </article>;
}

function BigButtonComplete({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  return <main className={`${styles.referencePage} ${styles.bigButtonExperience}`}><ReferenceNotice /><PresentationThemeSwitcher theme={theme} onChange={onTheme} /><section className={styles.bigAppShell}>
    <header className={styles.bigAppHeader}><Mark compact /><div className={styles.bigSchoolSwitch}>◉ Ideal Martial Arts⌄</div><span>◔</span><span className={styles.bigAvatar}>MD</span></header>
    <section className={styles.bigGreeting}><div><span>HON COMPLETE · TOUCH-FIRST</span><h1>Good morning,<br />Master David!</h1><p>Your AI team is here to help you grow your school.</p><button type="button">◉ Ask Alex anything… <b>⌁</b></button></div><img src="/ai/alex.webp" alt="" /></section>
    <section className={styles.bigTeamCard}><header><strong>Your AI Team</strong><button type="button">View All ›</button></header>{HON_AI_TEAM.slice(0,4).map((agent, index)=><div key={agent.id}><img src={agent.portrait} alt="" /><span><b>{agent.name}</b><small>{agent.signal} · {index === 1 ? 'Working' : 'Ready'}</small></span><i style={{background: agent.color}} /></div>)}</section>
    <section className={styles.bigActionGrid}>{[['♟','Students','191'],['▣','Classes','24'],['✓','Attendance','Today'],['●','Leads','7'],['✦','Messages','3'],['◈','Programs',''],['$','Billing',''],['▥','Reports',''],['◉','AI Team',''],['⚙','Settings','']].map(([icon,label,value],i)=><button type="button" key={label} className={`${styles.bigAction} ${styles[`bigAction${i}`]}`}><i>{icon}</i><b>{label}</b><small>{value}</small></button>)}</section>
    <section className={styles.bigLower}><article><header><b>Today’s Classes</b><button type="button">View All ›</button></header>{[['3:30 PM','Tiny Tigers (4–6)','12/14'],['4:30 PM','Green Belt','16/16'],['5:30 PM','Black Belt Program','14/16']].map(([time,name,count])=><p key={name}><time>{time}</time><span>{name}</span><b>{count}</b></p>)}</article><article><header><b>Needs Attention <em>5</em></b></header>{['3 new leads to follow up','2 student absences','1 payment overdue','Review 3 class applications'].map((item,i)=><p key={item}><i>{['♨','♟','$','▣'][i]}</i>{item}<b>›</b></p>)}</article></section>
    <nav className={styles.bigBottomNav}><button>⌂<span>Home</span></button><button>◎<span>AI Team</span></button><button>▣<span>Schedule</span></button><button>☷<span>More</span></button></nav>
  </section></main>;
}

function ClassicComplete({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
 const menu=['Dashboard','AI Team','Students','Programs','Classes','Attendance','Schedule','Testing','Leads','Marketing','Messages','Campaigns','Billing','Reports','Documents','Settings'];
 return <main className={`${styles.referencePage} ${styles.classicExperience}`}><ReferenceNotice /><PresentationThemeSwitcher theme={theme} onChange={onTheme} /><section className={styles.classicAppShell}>
   <aside className={styles.classicRail}><Mark compact /><small>MAIN</small>{menu.map((m,i)=><button type="button" key={m} className={i===0?styles.classicActive:''}><i>{['◉','✦','♟','◈','▣','✓','◷','◆','●','↗','◌','✧','$','▥','□','⚙'][i]}</i>{m}</button>)}<footer>◌ Support<br />? Help Center</footer></aside>
   <section className={styles.classicCanvas}><header className={styles.classicTopbar}><div>◉ Ideal Martial Arts⌄</div><label>⌕ Search students, leads, classes…</label><span>◔</span><span>♧</span><b>MD</b></header><div className={styles.classicHeading}><div><h1>Dashboard</h1><p>Overview of your school’s performance and activity.</p></div><button type="button">Oct 1 – Oct 31, 2026⌄</button></div>
   <section className={styles.classicMetrics}>{[['♟','191','Active Students','+3 This Month'],['▣','24','Today’s Classes','+6% This Month'],['◈','7','New Leads','+40%'],['$','$31,850','Monthly Revenue','+12%']].map(([i,v,l,d])=><article key={l}><i>{i}</i><div><strong>{v}</strong><span>{l}</span><small>{d}</small></div></article>)}</section>
   <section className={styles.classicCharts}><article><header><b>Student Growth</b><button>Last 6 Months⌄</button></header><div className={styles.barChart}>{[38,50,47,68,57,82,91].map((h,i)=><i key={i} style={{height:`${h}%`}} />)}</div><footer><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span></footer></article><article><header><b>Program Distribution</b></header><div className={styles.donut}>191</div><ul><li>Tiny Tigers <b>28%</b></li><li>Green Belt <b>32%</b></li><li>Black Belt <b>24%</b></li><li>Leadership <b>10%</b></li></ul></article></section>
   <section className={styles.classicTables}><article><header><b>Recent Leads</b><button>View All ›</button></header>{[['Emily R.','Facebook','New','Oct 14'],['Daniel K.','Referral','Contacted','Oct 14'],['Sophia M.','Google','Trial Booked','Oct 13'],['James L.','Facebook','New','Oct 13']].map(r=><p key={r[0]}><span>{r[0]}</span><small>{r[1]}</small><em>{r[2]}</em><time>{r[3]}</time></p>)}</article><article><header><b>Today’s Schedule</b><button>View All ›</button></header>{[['3:30 PM','Tiny Tigers (4–6)','12/14'],['4:30 PM','Green Belt (Beginner)','16/16'],['5:30 PM','Black Belt Program','14/16'],['6:30 PM','Leadership Club','12/14']].map(r=><p key={r[1]}><time>{r[0]}</time><span>{r[1]}</span><b>{r[2]}</b></p>)}</article></section></section>
 </section></main>;
}

function CompleteReference({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  const [active, setActive] = useState<HonAiTeamId>('alex');
  const agent = useMemo(() => HON_AI_TEAM.find((member) => member.id === active) ?? HON_AI_TEAM[0], [active]);
  if (theme === 'big-button') return <BigButtonComplete theme={theme} onTheme={onTheme} />;
  if (theme === 'classic') return <ClassicComplete theme={theme} onTheme={onTheme} />;
  return <main className={`${styles.referencePage} ${styles.completePage} ${styles[`presentation_${theme}`]}`}>
    <ReferenceNotice />
    <PresentationThemeSwitcher theme={theme} onChange={onTheme} />
    <div className={styles.desktopShell}>
      <Sidebar mode="school" />
      <section className={styles.commandCanvas}>
        <header className={styles.canvasHeader}><div><span className={styles.contextLabel}>HON COMPLETE · SCHOOL OWNER VIEW</span><h1>An AI team that knows<br />what needs attention.</h1></div><div className={styles.schoolSelect}><span>⌂</span><div><strong>Ideal Martial Arts</strong><small>San Gabriel · Design reference</small></div><b>⌄</b></div></header>
        <section className={styles.completeHero}>
          <div className={styles.heroPortrait} style={{ '--hero-image': `url(${agent.portrait})`, '--agent-color': agent.color } as React.CSSProperties}><div className={styles.heroCopy}><span>{agent.name.toUpperCase()} · SELECTED</span><strong>{agent.name} is ready to coordinate your next move.</strong><p>Switch employees, ask one question, and keep every action inside permissions, policy, and approval.</p></div></div>
          <div className={styles.heroContext}><p>Today at a glance</p><strong>Tue, Oct 14</strong><ul><li><b>191</b> Active Students <span>↗ 3</span></li><li><b>24</b> New Leads <span>↗ 6</span></li><li><b>8</b> Trial Classes <span>↗ 2</span></li></ul></div>
        </section>
        <AgentRoster active={active} onActive={setActive} />
        <section className={styles.completeWorkspace}><div className={styles.conversationColumn}><CommandLane agent={agent} /><div className={styles.commandChips}><button type="button">Today’s priorities</button><button type="button">Improve retention</button><button type="button">Review revenue</button><button type="button">Plan a campaign</button></div></div><div className={styles.activityColumn}><header><strong>AI work in motion</strong><button type="button">View all</button></header><ul><li><i className={styles.readyIcon} />Maya · 12 parent messages organized <span>Ready</span></li><li><i className={styles.workingIcon} />Chad · following up with 7 new leads <span>Working</span></li><li><i className={styles.approvalIcon} />Marcus · campaign proposal prepared <span>Review</span></li></ul></div></section>
        <MetricOrbit />
        <ApprovalPreview />
      </section>
    </div>
  </main>;
}

function HqReference({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  const [active, setActive] = useState<HonAiTeamId>('alex');
  const agent = HON_AI_TEAM.find((member) => member.id === active) ?? HON_AI_TEAM[0];
  return <main className={`${styles.referencePage} ${styles.hqPage}`}>
    <ReferenceNotice />
    <PresentationThemeSwitcher theme={theme} onChange={onTheme} />
    <div className={styles.desktopShell}>
      <Sidebar mode="hq" />
      <section className={styles.hqCanvas}>
        <header className={styles.canvasHeader}><div><span className={styles.contextLabel}>HON HQ · PRIVILEGED CONTROL PLANE</span><h1>Operate HON.<br /><em>Never bypass a school.</em></h1></div><div className={styles.hqOwner}>Master David <span>HON HQ Owner</span></div></header>
        <section className={styles.hqHero}><div className={styles.hqGlow} /><div className={styles.hqHeroText}><span>HON HQ / AI COMMAND CENTER</span><h2>Your AI team<br />is on it.</h2><p>Strategic insight. Real governed actions. Scalable growth.</p><CommandLane agent={agent} hq /></div><AgentRoster active={active} onActive={setActive} hq /></section>
        <section className={styles.hqQuestions}>{['What needs my attention?', 'Review onboarding', 'Analyze churn risk', 'Why did AI costs increase?', 'Plan next month’s growth'].map((question, index) => <button key={question} type="button" className={index === 0 ? styles.questionActive : ''}><span>{String(index + 1).padStart(2, '0')}</span>{question}<b>→</b></button>)}</section>
        <MetricOrbit hq />
        <section className={styles.hqLower}><article><span>GROWTH + CUSTOMER SUCCESS</span><h2>Stalled onboarding</h2><p>3 schools have not completed brand configuration. Ask Growth and Customer Success to analyze the evidence and create a reviewed plan.</p><button type="button">Start governed analysis →</button></article><article><span>PLATFORM ECONOMICS</span><h2>AI cost watch</h2><p>Cost increase is isolated to video analysis jobs. Model routing and credit meters remain within policy.</p><div className={styles.sparkline}><i /><i /><i /><i /><i /><i /><i /></div></article></section>
      </section>
    </div>
  </main>;
}

function CoreReference({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  return <main className={`${styles.referencePage} ${styles.corePage}`}>
    <ReferenceNotice />
    <PresentationThemeSwitcher theme={theme} onChange={onTheme} />
    <div className={styles.desktopShell}>
      <Sidebar mode="school" />
      <section className={styles.coreCanvas}>
        <header className={styles.coreHeader}><div><span className={styles.contextLabel}>HON CORE · CONVENTIONAL SCHOOL MANAGEMENT</span><h1>Good morning, Master David.</h1><p>Here’s what’s happening at your school today.</p></div><a className={styles.coreSearch} href="/staff/search">Search this school’s records →</a></header>
        <MetricOrbit />
        <section className={styles.coreContent}><article className={styles.scheduleCard}><header><div><span>Today’s classes</span><strong>Tuesday, Oct 14</strong></div><button type="button">View schedule →</button></header>{[['3:30 PM', 'Tiny Tigers (4–6)', '12 / 14'], ['4:30 PM', 'Green Belt (Beginner)', '16 / 16'], ['5:30 PM', 'Weapons Class', '14 / 16'], ['6:30 PM', 'Leadership Club', '12 / 14']].map(([time, title, attendance]) => <div className={styles.scheduleRow} key={title}><time>{time}</time><strong>{title}</strong><span>{attendance}</span><i>→</i></div>)}</article><article className={styles.eventsCard}><header><div><span>Upcoming events</span><strong>Keep families informed</strong></div><button type="button">View all →</button></header>{[['OCT 20', 'Halloween Party'], ['NOV 04', 'Black Belt Test'], ['NOV 18', 'Picture Day'], ['DEC 12', 'Winter Break']].map(([date, title]) => <div className={styles.eventRow} key={title}><b>{date}</b><span>{title}</span><i>→</i></div>)}</article></section>
        <section className={styles.coreQuickActions}>{[['+', 'Add student'], ['↗', 'Send message'], ['□', 'Take attendance'], ['◈', 'Process payment']].map(([symbol, label]) => <button key={label} type="button"><i>{symbol}</i>{label}</button>)}</section>
      </section>
    </div>
  </main>;
}

function ParentReference({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  const [panel, setPanel] = useState<'home' | 'progress' | 'schedule'>('home');
  return <main className={`${styles.referencePage} ${styles.parentPage} ${styles[`presentation_${theme}`]}`}><ReferenceNotice /><PresentationThemeSwitcher theme={theme} onChange={onTheme} /><section className={styles.parentStage}><header><Mark compact /><div><span>PARENT APP + EIAN</span><h1>Family-safe. Clear. Encouraging.</h1><p>The native Parent App uses its own verified family scope and a conventional experience that remains useful without Eian.</p></div></header><div className={styles.phoneGrid}><article className={styles.phoneFrame}><div className={styles.phoneTop}><b>9:41</b><span>◒ ▴ ▪</span></div><div className={styles.eianHero}><div><p>Hi there!</p><h2>I’m Eian.</h2><span>I can help with schedules, makeups, progress, and more.</span></div><img src="/ai/eian.webp" alt="" /></div><CommandLane compact agent={{ id: 'alex', name: 'Eian', title: 'Family Guide', signal: 'Care', color: '#287eff', portrait: '/ai/eian.webp' }} /><div className={styles.parentShortcuts}>{[['▣', 'My Schedule'], ['◈', 'My Progress'], ['↻', 'Makeup Class'], ['✦', 'Events']].map(([icon, label]) => <button onClick={() => setPanel(label === 'My Progress' ? 'progress' : label === 'My Schedule' ? 'schedule' : 'home')} type="button" key={label}><i>{icon}</i>{label}</button>)}</div><div className={styles.phoneNav}><button className={panel === 'home' ? styles.phoneActive : ''} onClick={() => setPanel('home')}>Home</button><button className={panel === 'schedule' ? styles.phoneActive : ''} onClick={() => setPanel('schedule')}>Schedule</button><button onClick={() => setPanel('home')}>Eian</button><button>Messages</button><button>More</button></div></article><article className={styles.phoneFrame}><div className={styles.phoneTop}><button type="button">←</button><b>{panel === 'progress' ? 'My Progress' : panel === 'schedule' ? 'Class Schedule' : 'Student Journey'}</b><span>●</span></div>{panel === 'schedule' ? <div className={styles.mobileSchedule}><h3>October 2026</h3>{[['3:30 PM', 'Tiny Tigers'], ['4:30 PM', 'Green Belt'], ['5:30 PM', 'All Ages']].map(([time, item]) => <p key={item}><time>{time}</time><span>{item}<small>Ideal Martial Arts</small></span></p>)}<button type="button">Book a makeup class</button></div> : <div className={styles.progressPane}><ParentJourneyUnavailable /></div>}<div className={styles.phoneNav}><button>Home</button><button className={panel === 'schedule' ? styles.phoneActive : ''}>Schedule</button><button className={panel === 'progress' ? styles.phoneActive : ''}>Progress</button><button>Messages</button><button>More</button></div></article></div></section></main>;
}

function MobileCompleteReference({ theme, onTheme }: { theme: HonInterfaceTheme; onTheme: (theme: HonInterfaceTheme) => void }): React.ReactElement {
  const [active, setActive] = useState<HonAiTeamId>('alex');
  const agent = HON_AI_TEAM.find((member) => member.id === active) ?? HON_AI_TEAM[0];
  return <main className={`${styles.referencePage} ${styles.mobilePage} ${styles[`presentation_${theme}`]}`}><ReferenceNotice /><PresentationThemeSwitcher theme={theme} onChange={onTheme} /><section className={styles.mobileStage}><header><Mark compact /><div><span>MOBILE HON COMPLETE</span><h1>Big-button AI command, without losing control.</h1><p>A touch-first presentation mode of the same governed application.</p></div></header><article className={styles.mobileCompletePhone}><div className={styles.phoneTop}><b>9:41</b><strong>HON</strong><span>◒ ▴</span></div><div className={styles.mobileSchool}>⌂ Ideal Martial Arts <b>⌄</b></div><div className={styles.mobileAgents}>{HON_AI_TEAM.slice(0, 4).map((member) => <button key={member.id} className={active === member.id ? styles.mobileAgentActive : ''} style={{ '--agent-color': member.color } as React.CSSProperties} onClick={() => setActive(member.id)} type="button"><img src={member.portrait} alt="" /><span>{member.name}</span></button>)}</div><div className={styles.mobileGreeting}><span>{agent.name.toUpperCase()} · {agent.title.toUpperCase()}</span><h2>What should we work on today?</h2><p>Touch a priority or start a voice/text request.</p></div><CommandLane agent={agent} compact /><div className={styles.mobileActions}>{[['◎', 'Show today’s priorities'], ['◉', 'Check enrollments'], ['▥', 'Review revenue'], ['✦', 'Improve retention']].map(([icon, label]) => <button type="button" key={label}><i>{icon}</i>{label}<span>→</span></button>)}</div><div className={styles.mobileWork}><span>TEAM WORK</span><p><i />Chad is organizing 5 lead follow-ups <b>Working</b></p><p><i />Maya has 2 parent messages ready <b>Ready</b></p></div><div className={styles.phoneNav}><button className={styles.phoneActive}>Home</button><button>School</button><button>AI Team</button><button>Work</button><button>More</button></div></article></section></main>;
}

export function HonReferenceSuite({ screen }: { screen: ReferenceScreen }): React.ReactElement {
  const [theme, setTheme] = useState<HonInterfaceTheme>('modern');
  const props = { theme, onTheme: setTheme };
  if (screen === 'hq') return <HqReference {...props} />;
  if (screen === 'core') return <CoreReference {...props} />;
  if (screen === 'parent') return <ParentReference {...props} />;
  if (screen === 'mobile') return <MobileCompleteReference {...props} />;
  return <CompleteReference {...props} />;
}
