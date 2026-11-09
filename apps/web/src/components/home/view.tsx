import React, { type ReactNode } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { OperationalSchoolScope } from '../operational-navigation';
import { SCHOOL_SHELL_NAV, schoolShellHref } from '../school-shell/catalog';
import { shellText } from '../school-shell/copy';
import { HON_ART_STYLES, defaultArtStyle, type HonArtStyle } from '../hon-command/roster';
import { ShellIcon } from '../school-shell/icons';
import { homeText, type HomeKey } from './copy';
import { homeAiTeam, homeKpis, leadOutcomes, membershipMix, myTasks, recentLeads, todaySessions, sessionSnapshotSaturated, type AgentCard, type Bar, type HomeSources, type Kpi, type Panel } from './model';
import styles from './home.module.css';

export type SchoolHomeViewProps = Readonly<{
  language: string; mode: HonInterfaceTheme; schoolName: string | null; selection: OperationalSchoolScope | null;
  sources: HomeSources; now: Date; timeZone?: string; waiting?: boolean; concealed?: boolean;
  /** The viewer's AI team art style; defaults to the mode's original pairing. */
  artStyle?: HonArtStyle; onArtStyle?: (style: HonArtStyle) => void;
}>;

const LOCALES: Record<string, string> = { en: 'en-US', ko: 'ko-KR', es: 'es-US' };
const scoped = (href: string, selection: OperationalSchoolScope | null) => schoolShellHref({ href, titleKey: 'routeOverview', scoped: true }, selection);

function greetingKey(now: Date): HomeKey {
  const hour = now.getHours();
  return hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening';
}

/**
 * The school Home. Pure presentation of already verified reads: each panel shows its own
 * loading, denied or unverified state, and nothing is estimated or filled with samples.
 */
export function SchoolHomeView({ language, mode, schoolName, selection, sources, now, timeZone, waiting = false, concealed = false, artStyle, onArtStyle }: SchoolHomeViewProps): React.ReactElement {
  const t = (key: HomeKey, values?: Record<string, string | number>) => homeText(language, key, values);
  const locale = LOCALES[language] ?? 'en-US';
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const time = (value: string) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
  const day = (value: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(new Date(value));

  if (!selection) return <main className={styles.home} data-hon-native data-home="no-school"><p className={styles.empty} role="status">{t(concealed ? 'concealed' : waiting ? 'loading' : 'noSchool')}</p></main>;

  const style = artStyle ?? defaultArtStyle(mode);
  const team = homeAiTeam(sources.readiness, style);
  const kpis = homeKpis(sources);
  const half = Math.ceil(team.length / 2);
  const today = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(now);
  const quick: readonly [string, HomeKey][] = [[scoped('/staff/crm/leads', selection), 'quickLeads'], ['/staff/schedule/sessions', 'quickClasses'],
    ['/staff/action-center/approvals', 'quickApprovals'], ['/staff/work', 'quickTasks'], [scoped('/staff/operations', selection), 'quickReport']];

  return <main className={styles.home} data-hon-native data-home="ready" data-mode={mode} data-art={style}>
    <section className={styles.hero} aria-labelledby="home-greeting">
      <header className={styles.heroHead}>
        <h1 id="home-greeting" className={styles.greeting}>{t(greetingKey(now))}, <span>{schoolName ?? t('yourSchool')}</span></h1>
        <p className={styles.lead}>{t('heroLead')}</p>
        <p className={styles.today}><time dateTime={now.toISOString()}>{today}</time></p>
      </header>
      <div className={styles.stage}>
        <ul className={styles.agents} aria-label={t('teamTitle')}>{team.slice(0, half).map(agent => <Agent key={agent.id} agent={agent} t={t} />)}</ul>
        <article className={styles.honCore} aria-labelledby="home-hon">
          <img className={styles.orb} src="/ai/hon-core.webp" alt="" width={168} height={168} />
          <h2 id="home-hon">{t('honTitle')}</h2>
          <p className={styles.honRole}>{t('honCore')}</p>
          <p className={styles.honStatus} data-status="pending">{t('honStatus')}</p>
          <a className={styles.primary} href="/staff/hon"><ShellIcon name="hon" /><span>{t('askHon')}</span></a>
        </article>
        <ul className={styles.agents} aria-label={t('teamTitle')}>{team.slice(half).map(agent => <Agent key={agent.id} agent={agent} t={t} />)}</ul>
      </div>
      <footer className={styles.teamFoot}>
        <p>{t('teamLead')}</p>
        <div className={styles.artStyle} role="group" aria-label={t('artStyle')}>
          <span aria-hidden="true">{t('artStyle')}</span>
          {HON_ART_STYLES.map(value => <button type="button" key={value} aria-pressed={style === value} disabled={!onArtStyle} onClick={() => onArtStyle?.(value)}>{t(`art${value}` as HomeKey)}</button>)}
        </div>
      </footer>
    </section>

    <nav className={styles.help} aria-labelledby="home-help">
      <a className={styles.helpAsk} href="/staff/hon"><span className={styles.helpMic} aria-hidden="true"><ShellIcon name="hon" /></span><strong id="home-help">{t('helpTitle')}</strong></a>
      <ul aria-label={t('quickTitle')}>{quick.map(([href, key]) => <li key={key}><a href={href}>{t(key)}</a></li>)}</ul>
    </nav>

    {mode === 'big-button' && <section className={styles.areas} aria-labelledby="home-areas">
      <header className={styles.sectionHead}><h2 id="home-areas">{t('areasTitle')}</h2><p>{t('areasLead')}</p></header>
      <ul>{SCHOOL_SHELL_NAV.filter(item => item.key !== 'home').map(item => <li key={item.key} data-area={item.key}>
        <a href={schoolShellHref(item.routes[0]!, selection)}><span className={styles.areaIcon} aria-hidden="true"><ShellIcon name={item.key} size={30} /></span>
          <strong>{shellText(language, item.titleKey)}</strong><small>{item.routes.slice(0, 2).map(route => shellText(language, route.titleKey)).join(' · ')}</small></a>
      </li>)}</ul>
    </section>}

    <section aria-labelledby="home-kpis">
      <h2 id="home-kpis" className={styles.visuallyHidden}>{t('kpiTitle')}</h2>
      <ul className={styles.kpis}>{kpis.map(kpi => <KpiTile key={kpi.key} kpi={kpi} t={t} number={number} />)}</ul>
    </section>

    <div className={styles.grid}>
      <Card title={t('leadsTitle')} lead={t('leadsLead')} panel={sources.operations} t={t} footer={<a href={scoped('/staff/crm/leads', selection)}>{t('recentOpen')} →</a>}>
        {snapshot => <Bars bars={leadOutcomes(snapshot)} t={t} number={number} />}
      </Card>
      <Card title={t('membersTitle')} lead={t('membersLead')} panel={sources.operations} t={t} footer={<a href="/staff/memberships">{t('kpiActiveMemberships')} →</a>}>
        {snapshot => <Bars bars={membershipMix(snapshot)} t={t} number={number} />}
      </Card>
      <Card title={t('scheduleTitle')} panel={sources.sessions} t={t} footer={<a href="/staff/schedule/sessions">{t('scheduleOpen')} →</a>}>
        {sessions => { const today = todaySessions(sessions, now), partial = sessionSnapshotSaturated(sessions);
          return <>{today.length ? <ol className={styles.list}>{today.map(session => <li key={session.sessionId}>
            <time dateTime={session.startsAt}>{time(session.startsAt)}</time>
            <span><strong>{session.name}</strong><small>{[session.roomName, t('capacity', { count: number(session.capacity) })].filter(Boolean).join(' · ')}</small></span>
          </li>)}</ol> : !partial ? <p className={styles.empty}>{t('scheduleEmpty')}</p> : null}
          {partial && <p className={styles.empty} data-schedule="partial">{t('schedulePartial')}</p>}</>; }}
      </Card>
      <Card title={t('recentTitle')} panel={sources.leads} t={t} footer={<a href={scoped('/staff/crm/leads', selection)}>{t('recentOpen')} →</a>}>
        {leads => { const recent = recentLeads(leads); return recent.length ? <ol className={styles.list}>{recent.map(lead => <li key={lead.id}>
          <time dateTime={lead.createdAt}>{day(lead.createdAt)}</time>
          <span><strong>{lead.givenName} {lead.familyName}</strong>{lead.nextFollowUpAt && <small>{t('followUp')} {day(lead.nextFollowUpAt)}</small>}</span>
        </li>)}</ol> : <p className={styles.empty}>{t('recentEmpty')}</p>; }}
      </Card>
      <Card title={t('tasksTitle')} panel={sources.work} t={t} footer={<a href="/staff/work">{t('tasksOpen')} →</a>}>
        {items => { const tasks = myTasks(items); return tasks.length ? <ol className={styles.list}>{tasks.map(task => <li key={task.workItemId} data-priority={task.priority}>
          <span className={styles.priority}>{t(`priority${task.priority}` as HomeKey)}</span>
          <span><strong>{task.title}</strong><small>{task.dueAt ? `${t('due')} ${day(task.dueAt)}` : t('noDue')}</small></span>
        </li>)}</ol> : <p className={styles.empty}>{t('tasksEmpty')}</p>; }}
      </Card>
      <article className={styles.card} data-card="pending">
        <header><h3>{t('pendingTitle')}</h3><p>{t('pendingLead')}</p></header>
        <ul className={styles.pending}>{(['pendingFunnel', 'pendingMarketing', 'pendingTrend'] as const).map(key => <li key={key}><span>{t(key)}</span><em>{t('notConnected')}</em></li>)}</ul>
      </article>
    </div>

    <p className={styles.more}><a href={scoped('/staff/operations', selection)}>{t('operationsReport')} →</a></p>
  </main>;
}

function Agent({ agent, t }: { agent: AgentCard; t: (key: HomeKey) => string }): React.ReactElement {
  const live = agent.href !== null && agent.status !== 'NOT_AVAILABLE';
  return <li className={styles.agent} data-agent={agent.id} data-status={agent.status} style={{ '--agent': agent.color } as React.CSSProperties}>
    <span className={styles.portrait}><img src={agent.portrait} alt="" width={280} height={350} loading="lazy" /></span>
    <span className={styles.agentText}>
      <strong>{agent.name}</strong>
      <span className={styles.agentTitle}>{t(agent.title)}</span>
      <span className={styles.agentStatus}><i aria-hidden="true" />{t(`status${agent.status}` as HomeKey)}</span>
    </span>
    {live && <a className={styles.agentLink} href={agent.href!} aria-label={`${t('openWorkspace')}: ${agent.name}`}>{t('openWorkspace')}</a>}
  </li>;
}

function KpiTile({ kpi, t, number }: { kpi: Kpi; t: (key: HomeKey, values?: Record<string, string | number>) => string; number: (value: number) => string }): React.ReactElement {
  return <li className={styles.kpi} data-kpi={kpi.key} data-state={kpi.state} data-tone={kpi.tone}>
    <span className={styles.kpiLabel}>{t(kpi.label)}</span>
    <strong className={styles.kpiValue}>{kpi.state === 'VALUE' ? number(kpi.value) : kpi.state === 'NOT_CONNECTED' ? t('notConnected') : kpi.state === 'LOADING' ? '…' : '—'}</strong>
    <small>{kpi.state === 'VALUE' ? t(kpi.detail, { days: kpi.days ?? '' }) : kpi.state === 'NOT_CONNECTED' ? t(kpi.detail) : t(kpi.detail)}</small>
  </li>;
}

function Bars({ bars, t, number }: { bars: Bar[]; t: (key: HomeKey) => string; number: (value: number) => string }): React.ReactElement {
  const max = Math.max(1, ...bars.map(bar => bar.value));
  return <dl className={styles.bars}>{bars.map(bar => <div key={bar.key} data-bar={bar.key}>
    <dt>{t(bar.label)}</dt><dd><span className={styles.track}><span style={{ width: `${Math.round(bar.value / max * 100)}%` }} /></span><b>{number(bar.value)}</b></dd>
  </div>)}</dl>;
}

function Card<T>({ title, lead, panel, t, footer, children }: { title: string; lead?: string; panel: Panel<T>; t: (key: HomeKey) => string; footer?: ReactNode; children: (value: T) => ReactNode }): React.ReactElement {
  return <article className={styles.card} data-panel={panel.state}>
    <header><h3>{title}</h3>{lead && <p>{lead}</p>}</header>
    {panel.state === 'READY' ? children(panel.value)
      : <p className={styles.empty} role={panel.state === 'LOADING' ? 'status' : undefined}>{t(panel.state === 'LOADING' ? 'loading' : panel.state === 'DENIED' ? 'panelDenied' : 'panelUnavailable')}</p>}
    {footer && <footer>{footer}</footer>}
  </article>;
}
