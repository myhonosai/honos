import { describe, expect, it } from 'vitest';
import { HON_AI_TEAM } from '@hon/design-system';
import { agentStatus, homeAiTeam, homeKpis, leadOutcomes, membershipMix, myTasks, recentLeads, reportDays, todaySessions } from '../src/components/home/model';
import { command, leads, NOW, operations, readiness, readinessAgent, sessions, work } from './school-home-fixtures';

describe('school home model', () => {
  it('takes every KPI straight from a verified read and never estimates revenue or attendance rate', () => {
    const kpis = homeKpis({ command: { state: 'READY', value: command() }, operations: { state: 'READY', value: operations() } });
    const value = (key: string) => { const kpi = kpis.find(item => item.key === key)!; return kpi.state === 'VALUE' ? kpi.value : kpi.state; };
    expect(value('activeMemberships')).toBe(286);
    expect(value('students')).toBe(412);
    expect(value('newLeads')).toBe(7);
    expect(value('trials')).toBe(3);
    expect(value('checkIns')).toBe(1200 + 40 + 17);
    expect(value('approvals')).toBe(4);
    expect(value('revenue')).toBe('NOT_CONNECTED');
    expect(value('attendanceRate')).toBe('NOT_CONNECTED');
    expect(reportDays(operations())).toBe(30);
  });

  it('keeps a refused or unverified source out of the numbers instead of showing zero', () => {
    const kpis = homeKpis({ command: { state: 'DENIED' }, operations: { state: 'UNAVAILABLE' } });
    expect(kpis.filter(kpi => kpi.state === 'VALUE')).toEqual([]);
    expect(kpis.find(kpi => kpi.key === 'newLeads')?.state).toBe('DENIED');
    expect(kpis.find(kpi => kpi.key === 'students')?.state).toBe('UNAVAILABLE');
    expect(homeKpis({ command: { state: 'LOADING' }, operations: { state: 'LOADING' } }).filter(kpi => kpi.state === 'LOADING')).toHaveLength(6);
  });

  it('builds lead outcomes and membership mix from current counts', () => {
    expect(leadOutcomes(operations()).map(bar => [bar.key, bar.value])).toEqual([['OPEN', 38], ['WON', 21], ['LOST', 9]]);
    expect(membershipMix(operations()).map(bar => [bar.key, bar.value])).toEqual([['ACTIVE', 286], ['FROZEN', 6], ['CANCELLATION_PENDING', 4], ['DRAFT', 3]]);
  });

  it('lists only today’s non-cancelled classes in start order, newest open leads, and soonest tasks', () => {
    expect(todaySessions(sessions(), NOW).map(item => item.name)).toEqual(['Morning Basics', 'Little Tigers', 'Adult Sparring']);
    expect(recentLeads(leads()).map(item => item.givenName)).toEqual(['Jordan', 'Avery']);
    expect(myTasks(work()).map(item => item.workItemId)).toEqual(['w1', 'w2']);
  });

  it('shows the owner roster: Kai for teaching, then the seven specialists, with Claire as Business Performance', () => {
    const team = homeAiTeam({ state: 'READY', value: readiness() }, 'realistic');
    expect(team.map(card => card.name)).toEqual(['Kai', 'Chad', 'Marcus', 'Alex', 'Maya', 'Jordan', 'Claire', 'Lena']);
    expect(team.find(card => card.id === 'claire')).toMatchObject({ title: 'agentClaire', status: 'NOT_AVAILABLE', href: null });
    expect(team.find(card => card.id === 'kai')).toMatchObject({ href: '/staff/teaching-assistant', portrait: '/ai/kai.webp' });
    expect(team.some(card => card.id === 'eian')).toBe(false);
    for (const id of ['alex', 'maya', 'jordan', 'lena']) expect(team.find(card => card.id === id)).toMatchObject({ status: 'NOT_AVAILABLE', href: null });
    for (const member of HON_AI_TEAM) expect(team.find(card => card.id === member.id)?.portrait).toBe(member.portrait);
  });

  it('draws every agent in the chosen art style without changing who is available', () => {
    const realistic = homeAiTeam({ state: 'READY', value: readiness() }, 'realistic');
    for (const style of ['illustrated', 'chibi'] as const) {
      const team = homeAiTeam({ state: 'READY', value: readiness() }, style);
      for (const card of team) expect(card.portrait).toBe(`/ai/${card.id}-${style}.webp`);
      expect(team.map(card => card.status)).toEqual(realistic.map(card => card.status));
    }
  });

  it('takes agent status from readiness: the teaching key belongs to Kai, never to Claire', () => {
    const live = readiness([readinessAgent('marcus', 'MARKETING', 6, { authorized: false, available: false, blockedBy: 'NOT_AUTHORIZED' }),
      readinessAgent('claire', 'TEACHING', 6, { providerRuntime: 'READY', available: true, blockedBy: null }),
      readinessAgent('chad', 'CHAD_FOLLOW_UP', 3, { spendDecision: 'AI_PAUSED_BY_HQ', available: false, blockedBy: 'AI_PAUSED_BY_HQ' })]);
    const team = homeAiTeam({ state: 'READY', value: live }, 'realistic');
    expect(team.find(card => card.id === 'kai')?.status).toBe('READY');
    expect(team.find(card => card.id === 'claire')?.status).toBe('NOT_AVAILABLE');
    expect(team.find(card => card.id === 'marcus')?.status).toBe('NO_PERMISSION');
    expect(team.find(card => card.id === 'chad')?.status).toBe('AI_OFF');
    expect(agentStatus({ state: 'READY', value: readiness() }, 'chad')).toBe('PROVIDER_OFF');
    expect(agentStatus({ state: 'DENIED' }, 'chad')).toBe('HIDDEN');
    expect(agentStatus({ state: 'UNAVAILABLE' }, 'chad')).toBe('UNKNOWN');
    expect(agentStatus({ state: 'LOADING' }, 'chad')).toBe('CHECKING');
    const budget = readiness([readinessAgent('marcus', 'MARKETING', 6, { blockedBy: 'ORGANIZATION_AI_BUDGET_REACHED' }), readinessAgent('claire', 'TEACHING', 6, { route: 'NO_ELIGIBLE_ROUTE', blockedBy: 'NO_ELIGIBLE_ROUTE' }), readinessAgent('chad', 'CHAD_FOLLOW_UP', 3)]);
    expect(agentStatus({ state: 'READY', value: budget }, 'marcus')).toBe('BUDGET');
    expect(agentStatus({ state: 'READY', value: budget }, 'claire')).toBe('NO_ROUTE');
  });
});
