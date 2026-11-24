import React from 'react';
import type { AiTeamReadiness, CreativeGeneration, CurrentSchoolClassSession, HumanWorkQueueItem, MembershipPlanCatalog, OperationalSnapshot, PlannedAbsenceReviewQueueItem,
  SchoolCommandCenterSnapshot, SchoolReports } from '@hon/contracts';
import { HON_AI_TEAM } from '@hon/design-system';
import { aiTeamPortrait, type HonArtStyle } from '../hon-command/roster';
import type { HonDelegateTarget } from '../hon-command/hon-suggestions';
import { agentStatus, CLASS_SESSION_SNAPSHOT_LIMIT, type Panel } from '../home/model';
import { homeText, type HomeKey } from '../home/copy';
import { workspaceText, type WorkspaceKey } from './copy';
import { attendanceOutcomes, campaignCounts, JORDAN_WEEK_LIST_MAX, publishedPlans, recentCreative, recentMonths, weekSessions, type SpecialistKey } from './model';
import styles from '../membership-changes/membership-changes.module.css';

/** Every read a specialist workspace may show. Each specialist loads only its own (SPECIALIST_SOURCES). */
export type WorkspaceSources = Readonly<{
  readiness: Panel<AiTeamReadiness>;
  command: Panel<SchoolCommandCenterSnapshot>;
  work: Panel<readonly HumanWorkQueueItem[]>;
  sessions: Panel<readonly CurrentSchoolClassSession[]>;
  /** null: the absence queue answered for another school the person works at, so nothing is shown for this one. */
  absences: Panel<readonly PlannedAbsenceReviewQueueItem[] | null>;
  operations: Panel<OperationalSnapshot>;
  reports: Panel<SchoolReports>;
  plans: Panel<MembershipPlanCatalog>;
  campaigns: Panel<readonly HonDelegateTarget[]>;
  creative: Panel<readonly CreativeGeneration[]>;
}>;
export type WorkspaceSourceKey = keyof WorkspaceSources;
const LOADING = { state: 'LOADING' } as const;
export const WORKSPACE_LOADING: WorkspaceSources = { readiness: LOADING, command: LOADING, work: LOADING, sessions: LOADING, absences: LOADING, operations: LOADING,
  reports: LOADING, plans: LOADING, campaigns: LOADING, creative: LOADING };
/** The facts each specialist reads (0260 facts, shown from the existing protected reads). Readiness is always loaded. */
export const SPECIALIST_SOURCES: Readonly<Record<SpecialistKey, readonly WorkspaceSourceKey[]>> = {
  alex: ['readiness', 'command', 'work'],
  jordan: ['readiness', 'sessions', 'absences', 'operations'],
  claire: ['readiness', 'reports', 'command'],
  lena: ['readiness', 'plans', 'campaigns', 'creative'],
};

const LINKS: Readonly<Record<SpecialistKey, readonly [WorkspaceKey, string][]>> = {
  alex: [['linkCommandCenter', '/staff/command-center'], ['linkWork', '/staff/work'], ['linkApprovals', '/staff/action-center/approvals']],
  jordan: [['linkCalendar', '/staff/schedule'], ['linkAttendance', '/staff/attendance'], ['linkAbsences', '/staff/attendance/planned-absences']],
  claire: [['linkReports', '/staff/reports'], ['linkRevenuePlanning', '/staff/planning/revenue']],
  lena: [['linkMemberships', '/staff/memberships'], ['linkMarketing', '/staff/marketing'], ['linkCreative', '/staff/creative-studio']],
};
const TITLE: Readonly<Record<SpecialistKey, [WorkspaceKey, WorkspaceKey]>> = {
  alex: ['alexTitle', 'alexLead'], jordan: ['jordanTitle', 'jordanLead'], claire: ['claireTitle', 'claireLead'], lena: ['lenaTitle', 'lenaLead'],
};

export type SpecialistWorkspaceViewProps = Readonly<{
  agent: SpecialistKey; language: string; artStyle: HonArtStyle; now: Date;
  waiting: boolean; concealed: boolean; hasSchool: boolean; sources: WorkspaceSources;
  /** The Ask box (omitted in static previews and when the specialist is not ready). */
  renderAsk?: (() => React.ReactNode) | undefined;
}>;

type T = (key: WorkspaceKey, values?: Readonly<Record<string, string | number>>) => string;
const date = (language: string, iso: string) => new Date(iso).toLocaleDateString(language, { dateStyle: 'medium' });
const dateTime = (language: string, iso: string) => new Date(iso).toLocaleString(language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const money = (language: string, currency: string, minor: number) => new Intl.NumberFormat(language, { style: 'currency', currency }).format(minor / 100);

/** One card whose body is shown only from a verified read; refused or unverifiable reads say so and show nothing else. */
function Card<V>({ title, panel, t, testId, children }: { title: string; panel: Panel<V>; t: T; testId: string; children: (value: V) => React.ReactNode }): React.ReactElement {
  return <article className={styles.card} data-testid={testId} data-state={panel.state}>
    <h2>{title}</h2>
    {panel.state === 'READY' ? children(panel.value)
      : <p className={styles.meta} role="status">{t(panel.state === 'LOADING' ? 'loading' : panel.state === 'DENIED' ? 'denied' : 'unavailable')}</p>}
  </article>;
}
const Rows = ({ rows }: { rows: readonly (readonly [string, string | number])[] }) =>
  <ul className={styles.list}>{rows.map(([label, value]) => <li key={label}><span>{label}: <strong>{value}</strong></span></li>)}</ul>;

function AlexPanels({ s, t, language }: { s: WorkspaceSources; t: T; language: string }) {
  return <>
    <Card title={t('briefingTitle')} panel={s.command} t={t} testId="alex-briefing">{c => <p>{c.dailyBriefing}</p>}</Card>
    <Card title={t('prioritiesTitle')} panel={s.command} t={t} testId="alex-priorities">{c => c.recommendations.length === 0 ? <p className={styles.meta}>{t('prioritiesEmpty')}</p>
      : <ol className={styles.list}>{c.recommendations.map(r => <li key={r.id}><strong><a href={r.route}>{r.title}</a></strong><span className={styles.meta}>{r.why}</span></li>)}</ol>}</Card>
    <Card title={t('countsTitle')} panel={s.command} t={t} testId="alex-counts">{c => <Rows rows={[
      [t('countNewLeads'), c.metrics.newLeads24h.count], [t('countTrials'), c.metrics.upcomingTrials24h.count], [t('countApprovals'), c.metrics.pendingActionApprovals.count],
      [t('countWork'), c.metrics.outstandingWorkItems.count], [t('countTermsEnding'), c.metrics.membershipTermsEnding30d.count], [t('countTesting'), c.metrics.upcomingTestingEvents30d.count]]} />}</Card>
    <Card title={t('workTitle')} panel={s.work} t={t} testId="alex-work">{items => items.length === 0 ? <p className={styles.meta}>{t('workEmpty')}</p>
      : <ul className={styles.list}>{[...items].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)).slice(0, 5)
        .map(i => <li key={i.workItemId}><strong>{i.title}</strong><span className={styles.meta}>{i.dueAt ? t('due', { date: date(language, i.dueAt) }) : t('noDue')}</span></li>)}</ul>}</Card>
  </>;
}

function JordanPanels({ s, t, language, now }: { s: WorkspaceSources; t: T; language: string; now: Date }) {
  return <>
    <Card title={t('weekTitle')} panel={s.sessions} t={t} testId="jordan-week">{all => {
      const week = weekSessions(all, now);
      return <>
        <p className={styles.meta}>{week.length === 0 ? t('weekEmpty') : t('weekCount', { count: week.length })}</p>
        {all.length >= CLASS_SESSION_SNAPSHOT_LIMIT ? <p className={styles.meta}>{t('weekSaturated')}</p> : null}
        <ul className={styles.list}>{week.slice(0, JORDAN_WEEK_LIST_MAX).map(c => <li key={c.sessionId}><strong>{c.name}</strong>
          <span className={styles.meta}>{dateTime(language, c.startsAt)}{c.roomName ? ` · ${c.roomName}` : ''} · {t('capacity', { count: c.capacity })}</span></li>)}</ul>
        {week.length > JORDAN_WEEK_LIST_MAX ? <p className={styles.meta}>{t('weekPartial', { count: JORDAN_WEEK_LIST_MAX })}</p> : null}
      </>;
    }}</Card>
    <Card title={t('absencesTitle')} panel={s.absences} t={t} testId="jordan-absences">{items => items === null ? <p className={styles.meta}>{t('absencesOtherSchool')}</p>
      : items.length === 0 ? <p className={styles.meta}>{t('absencesEmpty')}</p>
      : <><p className={styles.meta}>{t('absencesCount', { count: items.length })}</p>
        <ul className={styles.list}>{items.slice(0, 5).map(a => <li key={a.id}>{t('absenceRange', { from: date(language, a.startsAt), to: date(language, a.endsAt) })}</li>)}</ul></>}</Card>
    <Card title={s.operations.state === 'READY' ? t('attendanceTitle', { days: attendanceOutcomes(s.operations.value).days }) : t('attendanceTitle', { days: 30 })}
      panel={s.operations} t={t} testId="jordan-attendance">{ops => <Rows rows={attendanceOutcomes(ops).rows.map(r => [t(`att${r.key}` as WorkspaceKey), r.value] as const)} />}</Card>
  </>;
}

function ClairePanels({ s, t, language }: { s: WorkspaceSources; t: T; language: string }) {
  return <>
    <Card title={t('monthsTitle')} panel={s.reports} t={t} testId="claire-months">{reports => {
      const months = recentMonths(reports);
      if (months.length === 0) return <p className={styles.meta}>{t('monthsEmpty')}</p>;
      return <>
        <div className={styles.grid}>{months.map(m => <section key={m.month} data-testid="claire-month">
          <h3>{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' })} {m.partial ? t('monthPartial') : ''}</h3>
          <p className={styles.meta}><strong>{t('mAttendance')}</strong></p>
          <Rows rows={[[t('mClassesHeld'), m.attendance.classesHeld], [t('mCheckIns'), m.attendance.checkIns], [t('mAbsences'), m.attendance.absences], [t('mStudentsAttended'), m.attendance.studentsAttended]]} />
          <p className={styles.meta}><strong>{t('mEnrollment')}</strong></p>
          <Rows rows={[[t('mNewLeads'), m.enrollment.newLeads], [t('mLeadsWon'), m.enrollment.leadsWon], [t('mNewMemberships'), m.enrollment.newMemberships]]} />
          <p className={styles.meta}><strong>{t('mRetention')}</strong></p>
          <Rows rows={[[t('mActiveStart'), m.retention.activeAtStart], [t('mActiveEnd'), m.retention.activeAtEnd], [t('mEnded'), m.retention.ended], [t('mRetained'), m.retention.retainedFromStart]]} />
          <p className={styles.meta}><strong>{t('mRevenue')}</strong></p>
          {m.revenue.length === 0 ? <p className={styles.meta}>{t('mNoRevenue')}</p> : m.revenue.map(r => <Rows key={r.currency} rows={[
            [t('mBilled'), money(language, r.currency, r.billedMinor)], [t('mRecorded'), money(language, r.currency, r.recordedPaymentsMinor)], [t('mRefunds'), money(language, r.currency, r.refundsMinor)]]} />)}
        </section>)}</div>
        <p className={styles.meta}>{t('revenueNote')}</p>
      </>;
    }}</Card>
    <Card title={t('invoicesTitle')} panel={s.command} t={t} testId="claire-invoices">{c => <>
      <p>{t('invoicesCount', { count: c.metrics.paidInvoicesCreated30d.count })}</p>
      {c.metrics.paidInvoicesCreated30d.amountsByCurrency.map(a => <p key={a.currency}><strong>{money(language, a.currency, a.totalMinor)}</strong></p>)}
      <p className={styles.meta}>{t('invoicesNote')}</p>
    </>}</Card>
  </>;
}

function LenaPanels({ s, t, language, now }: { s: WorkspaceSources; t: T; language: string; now: Date }) {
  return <>
    <Card title={t('plansTitle')} panel={s.plans} t={t} testId="lena-plans">{catalog => {
      const plans = publishedPlans(catalog.plans);
      return plans.length === 0 ? <p className={styles.meta}>{t('plansEmpty')}</p>
        : <ul className={styles.list}>{plans.map(p => <li key={p.planId}><strong>{p.displayName}</strong>
          <span className={styles.meta}>{money(language, p.currency, p.priceMinor)} {t(`freq${p.billingFrequency}` as WorkspaceKey)} · {p.termKind === 'FIXED_MONTHS' && p.termMonths ? t('planTerm', { months: p.termMonths }) : t('planOpen')}{p.programName ? ` · ${p.programName}` : ''}</span></li>)}</ul>;
    }}</Card>
    <Card title={t('campaignsTitle')} panel={s.campaigns} t={t} testId="lena-campaigns">{targets =>
      <Rows rows={campaignCounts(targets).map(c => [t(`camp${c.status}` as WorkspaceKey), c.count] as const)} />}</Card>
    <Card title={t('creativeTitle')} panel={s.creative} t={t} testId="lena-creative">{generations => {
      const recent = recentCreative(generations, now);
      return recent.total === 0 ? <p className={styles.meta}>{t('creativeEmpty')}</p> : <>
        <p>{t('creativeCount', { count: recent.total })}</p>
        <Rows rows={recent.byStatus.map(r => [t(`cr${r.status}` as WorkspaceKey), r.count] as const)} />
        <p className={styles.meta}>{t('creativeNote')}</p>
      </>;
    }}</Card>
  </>;
}

/** One specialist's workspace. Panels and the Ask box come only from verified reads for the school the shell verified. */
export function SpecialistWorkspaceView(p: SpecialistWorkspaceViewProps): React.ReactElement {
  const t: T = (key, values) => workspaceText(p.language, key, values);
  const member = HON_AI_TEAM.find(m => m.id === p.agent)!;
  const status = agentStatus(p.sources.readiness, p.agent);
  const [title, lead] = TITLE[p.agent];
  const blocked = p.concealed || p.waiting || !p.hasSchool;
  return <section className={styles.page} aria-labelledby="specialist-title" aria-busy={p.waiting} data-testid={`workspace-${p.agent}`} data-hon-native=""
    style={{ '--agent': member.color } as React.CSSProperties}>
    <header className={styles.head}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
        <img src={aiTeamPortrait(p.agent, p.artStyle) ?? member.portrait} alt="" width={72} height={90} style={{ borderRadius: 12, objectFit: 'cover', flex: 'none', border: `2px solid ${member.color}` }} />
        <div style={{ minWidth: 0 }}>
          <h1 id="specialist-title">{t(title)}</h1>
          <p className={styles.intro}>{t(lead)}</p>
          <p className={styles.meta} data-testid="specialist-status">{homeText(p.language, `status${status}` as HomeKey)} · {t('readOnly')}</p>
        </div>
      </div>
      <a className={styles.secondary} href="/staff/ai-team">{t('backToTeam')}</a>
    </header>
    {blocked ? <p className={styles.meta} role="status">{t(p.concealed ? 'concealed' : p.waiting ? 'checkingSchool' : 'noSchool')}</p> : <>
      <article className={styles.card} data-testid="specialist-ask">
        <h2>{t('askTitle', { name: member.name })}</h2>
        <p className={styles.meta}>{t('askLead', { name: member.name })}</p>
        {status === 'READY' && p.renderAsk ? p.renderAsk()
          : <p className={styles.meta} role="status">{t('notReady', { name: member.name, status: homeText(p.language, `status${status}` as HomeKey) })}</p>}
        <p className={styles.meta}><a href={`/staff/hon?ask=${p.agent}`}>{t('continueInHon')}</a></p>
      </article>
      <div className={styles.grid} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' }}>
        {p.agent === 'alex' ? <AlexPanels s={p.sources} t={t} language={p.language} />
          : p.agent === 'jordan' ? <JordanPanels s={p.sources} t={t} language={p.language} now={p.now} />
          : p.agent === 'claire' ? <ClairePanels s={p.sources} t={t} language={p.language} />
          : <LenaPanels s={p.sources} t={t} language={p.language} now={p.now} />}
      </div>
      <nav className={styles.row} aria-label={t('open')}>{LINKS[p.agent].map(([key, href]) => <a key={href} className={styles.secondary} href={href}>{t(key)}</a>)}</nav>
    </>}
  </section>;
}
