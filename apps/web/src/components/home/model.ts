import type { AiTeamReadiness, CurrentSchoolClassSession, HumanWorkQueueItem, LeadListItem, OperationalSnapshot, SchoolCommandCenterSnapshot } from '@hon/contracts';
import { HON_AI_TEAM, type HonInterfaceTheme } from '@hon/design-system';
import { teachingAiPortrait } from '../hon-command/roster';
import type { HomeKey } from './copy';

/** One independently loaded source. DENIED = the API refused this person; UNAVAILABLE = no verified result. */
export type Panel<T> = { state: 'LOADING' } | { state: 'READY'; value: T } | { state: 'DENIED' } | { state: 'UNAVAILABLE' };
export const LOADING: Panel<never> = { state: 'LOADING' };

export type HomeSources = Readonly<{
  command: Panel<SchoolCommandCenterSnapshot>;
  operations: Panel<OperationalSnapshot>;
  readiness: Panel<AiTeamReadiness>;
  leads: Panel<readonly LeadListItem[]>;
  sessions: Panel<readonly CurrentSchoolClassSession[]>;
  work: Panel<readonly HumanWorkQueueItem[]>;
}>;

export const HOME_LOADING: HomeSources = { command: LOADING, operations: LOADING, readiness: LOADING, leads: LOADING, sessions: LOADING, work: LOADING };

// ---------------------------------------------------------------- KPI tiles

export type Kpi = Readonly<{ key: string; label: HomeKey; tone: 'accent' | 'teal' | 'violet' | 'amber' | 'rose' | 'green' }>
  & ({ state: 'VALUE'; value: number; detail: HomeKey; days?: number } | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'NOT_CONNECTED'; detail: HomeKey });

function fromPanel<T>(panel: Panel<T>, read: (value: T) => number, base: Omit<Kpi, 'state' | 'value' | 'detail' | 'days'>, detail: HomeKey, days?: (value: T) => number): Kpi {
  if (panel.state === 'READY') return { ...base, state: 'VALUE', value: read(panel.value), detail, ...(days ? { days: days(panel.value) } : {}) } as Kpi;
  return { ...base, state: panel.state, detail: panel.state === 'DENIED' ? 'kpiDenied' : panel.state === 'LOADING' ? 'loading' : 'kpiUnavailable' } as Kpi;
}

export function reportDays(snapshot: Pick<OperationalSnapshot, 'from' | 'to'>): number {
  return Math.max(1, Math.round((Date.parse(snapshot.to) - Date.parse(snapshot.from)) / 86_400_000));
}

/**
 * Headline numbers, each straight from a verified read. Revenue and attendance rate have
 * no authoritative source yet and are shown as not connected, never estimated.
 */
export function homeKpis(sources: Pick<HomeSources, 'command' | 'operations'>): Kpi[] {
  const { command, operations } = sources;
  return [
    fromPanel(operations, v => v.memberships.byState.ACTIVE, { key: 'activeMemberships', label: 'kpiActiveMemberships', tone: 'accent' }, 'kpiActiveMembershipsDetail'),
    fromPanel(operations, v => v.studentProfiles.total, { key: 'students', label: 'kpiStudents', tone: 'teal' }, 'kpiStudentsDetail'),
    fromPanel(command, v => v.metrics.newLeads24h.count, { key: 'newLeads', label: 'kpiNewLeads', tone: 'violet' }, 'kpiNewLeadsDetail'),
    fromPanel(command, v => v.metrics.upcomingTrials24h.count, { key: 'trials', label: 'kpiTrials', tone: 'green' }, 'kpiTrialsDetail'),
    fromPanel(operations, v => v.attendance.inRangeByStatus.PRESENT + v.attendance.inRangeByStatus.LATE + v.attendance.inRangeByStatus.MAKEUP,
      { key: 'checkIns', label: 'kpiCheckIns', tone: 'amber' }, 'kpiCheckInsDetail', reportDays),
    fromPanel(command, v => v.metrics.pendingActionApprovals.count, { key: 'approvals', label: 'kpiApprovals', tone: 'rose' }, 'kpiApprovalsDetail'),
    { key: 'revenue', label: 'kpiRevenue', tone: 'green', state: 'NOT_CONNECTED', detail: 'kpiRevenueDetail' },
    { key: 'attendanceRate', label: 'kpiAttendanceRate', tone: 'amber', state: 'NOT_CONNECTED', detail: 'kpiAttendanceRateDetail' },
  ];
}

// ---------------------------------------------------------------- distributions

export type Bar = Readonly<{ key: string; label: HomeKey; value: number }>;

export function leadOutcomes(snapshot: OperationalSnapshot): Bar[] {
  const s = snapshot.leads.byStatus;
  return [{ key: 'OPEN', label: 'leadOpen', value: s.OPEN }, { key: 'WON', label: 'leadWon', value: s.WON }, { key: 'LOST', label: 'leadLost', value: s.LOST }];
}

export function membershipMix(snapshot: OperationalSnapshot): Bar[] {
  const s = snapshot.memberships.byState;
  return [{ key: 'ACTIVE', label: 'memberActive', value: s.ACTIVE }, { key: 'FROZEN', label: 'memberFrozen', value: s.FROZEN },
    { key: 'CANCELLATION_PENDING', label: 'memberCancelling', value: s.CANCELLATION_PENDING }, { key: 'DRAFT', label: 'memberDraft', value: s.DRAFT }];
}

// ---------------------------------------------------------------- lists

/** Sessions that start on the viewer's current local day, earliest first. */
export function todaySessions(sessions: readonly CurrentSchoolClassSession[], now: Date): CurrentSchoolClassSession[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return sessions.filter(session => session.status !== 'CANCELLED' && Date.parse(session.startsAt) >= start.getTime() && Date.parse(session.startsAt) < end.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 6);
}

export function recentLeads(leads: readonly LeadListItem[]): LeadListItem[] {
  return [...leads].filter(lead => lead.status === 'OPEN').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5);
}

/** Due soonest first; undated last. */
export function myTasks(items: readonly HumanWorkQueueItem[]): HumanWorkQueueItem[] {
  const due = (item: HumanWorkQueueItem) => item.dueAt ? Date.parse(item.dueAt) : Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => due(a) - due(b)).slice(0, 5);
}

// ---------------------------------------------------------------- AI team

export type AgentStatus = 'READY' | 'PROVIDER_OFF' | 'AI_OFF' | 'BUDGET' | 'NO_ROUTE' | 'NO_PERMISSION' | 'HIDDEN' | 'CHECKING' | 'UNKNOWN' | 'NOT_AVAILABLE';
export type AgentCard = Readonly<{ id: string; name: string; title: HomeKey; portrait: string; color: string; status: AgentStatus; href: string | null }>;

/**
 * The owner roster (2026-11-06): Kai teaches; seven business specialists; Claire is Business
 * Performance only. Status comes from AI team readiness, never from the portrait: an agent with
 * no backend is "not available yet". The backend's teaching key is still `claire`; it is Kai's.
 */
const LIVE: Record<string, { key: 'chad' | 'marcus' | 'claire'; href: string }> = {
  kai: { key: 'claire', href: '/staff/teaching-assistant' },
  chad: { key: 'chad', href: '/staff/leads/assistant' },
  marcus: { key: 'marcus', href: '/staff/marketing/assistant' },
};
const TITLES: Record<string, HomeKey> = { kai: 'agentKai', alex: 'agentAlex', chad: 'agentChad', maya: 'agentMaya', marcus: 'agentMarcus', jordan: 'agentJordan', claire: 'agentClaire', lena: 'agentLena' };

export function agentStatus(readiness: Panel<AiTeamReadiness>, key: 'chad' | 'marcus' | 'claire'): AgentStatus {
  if (readiness.state === 'LOADING') return 'CHECKING';
  if (readiness.state === 'DENIED') return 'HIDDEN';
  if (readiness.state === 'UNAVAILABLE') return 'UNKNOWN';
  // The teaching key is moving from the legacy 'claire' to 'kai' (backend contract change); accept either for Kai.
  const agent = readiness.value.agents.find(item => item.agentKey === key || (key === 'claire' && (item.agentKey as string) === 'kai'));
  if (!agent) return 'UNKNOWN';
  if (agent.available) return 'READY';
  switch (agent.blockedBy) {
    case 'PROVIDER_RUNTIME_NOT_CONFIGURED': return 'PROVIDER_OFF';
    case 'NOT_AUTHORIZED': return 'NO_PERMISSION';
    case 'ORGANIZATION_AI_BUDGET_REACHED': return 'BUDGET';
    case 'NO_ELIGIBLE_ROUTE': return 'NO_ROUTE';
    default: return 'AI_OFF';
  }
}

export function homeAiTeam(readiness: Panel<AiTeamReadiness>, mode: HonInterfaceTheme): AgentCard[] {
  const kai: AgentCard = { id: 'kai', name: 'Kai', title: TITLES.kai!, portrait: teachingAiPortrait(mode), color: '#34d6e8', status: agentStatus(readiness, 'claire'), href: LIVE.kai!.href };
  const order = ['chad', 'marcus', 'alex', 'maya', 'jordan', 'claire', 'lena'];
  const team = order.map(id => HON_AI_TEAM.find(member => member.id === id)!).map((member): AgentCard => {
    const live = LIVE[member.id];
    return { id: member.id, name: member.name, title: TITLES[member.id]!, portrait: member.portrait, color: member.color,
      status: live ? agentStatus(readiness, live.key) : 'NOT_AVAILABLE', href: live?.href ?? null };
  });
  return [kai, ...team];
}
