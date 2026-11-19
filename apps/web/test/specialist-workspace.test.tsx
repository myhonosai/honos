import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CreativeGeneration, MembershipPlanListing, SchoolReportPeriod, SchoolReports } from '@hon/contracts';
import { SpecialistWorkspaceView, SPECIALIST_SOURCES, WORKSPACE_LOADING, type WorkspaceSources } from '../src/components/specialist-workspace/view';
import { workspacePanelFromError } from '../src/components/specialist-workspace/workspace';
import { WORKSPACE_COPY, workspaceText } from '../src/components/specialist-workspace/copy';
import { attendanceOutcomes, campaignCounts, isSpecialistKey, publishedPlans, recentCreative, recentMonths, specialistWorkspaceHref, weekSessions, type SpecialistKey } from '../src/components/specialist-workspace/model';
import { CommandCenterAccessError } from '../src/components/command-center-http';
import { PlannedAbsenceReviewAccessError } from '../src/components/planned-absence-review-http';
import { ReportsError } from '../src/components/school-reports/http';
import { CreativeGenerationError } from '../src/components/creative-studio/generation-http';
import { HonConversationError } from '../src/components/hon-command/hon-conversation-http';
import { NOW, SCHOOL, command, operations, readiness, readinessAgent, sessions, work } from './school-home-fixtures';

// Synthetic values only; no real school, family or student data.
const ANALYSTS = [['alex', 'GENERAL_MANAGEMENT'], ['jordan', 'OPERATIONS'], ['claire', 'BUSINESS_PERFORMANCE'], ['lena', 'CREATIVE_COMMERCE']] as const;
const allReady = () => readiness(ANALYSTS.map(([key, agent]) => readinessAgent(key, agent, 15, { providerRuntime: 'READY', available: true, blockedBy: null })));
const period = (month: string, over: Partial<SchoolReportPeriod> = {}): SchoolReportPeriod => ({
  month, from: `${month}-01T00:00:00.000Z`, to: `${month}-28T00:00:00.000Z`, partial: false,
  attendance: { classesHeld: 40, checkIns: 512, absences: 31, studentsAttended: 120 }, enrollment: { newLeads: 22, leadsWon: 9, newMemberships: 8 },
  retention: { activeAtStart: 280, activeAtEnd: 286, ended: 4, retainedFromStart: 276 },
  revenue: [{ currency: 'USD', billedMinor: 4_250_000, recordedPaymentsMinor: 4_100_000, onlinePaymentsMinor: 3_900_000, refundsMinor: 15_000 }], ...over });
const reports = (): SchoolReports => ({ schoolId: SCHOOL, schoolName: 'Sample Dojo', timezone: 'America/Los_Angeles', months: 3, generatedAt: '2026-11-06T09:00:00.000Z',
  cancelledWithoutDate: 0, periods: [period('2026-09'), period('2026-11', { partial: true }), period('2026-10'), period('2026-08')] });
const plan = (planId: string, displayName: string, priceMinor: number, over: Partial<MembershipPlanListing> = {}): MembershipPlanListing => ({
  planId, planCode: displayName.toUpperCase().replace(/\W/g, '_').slice(0, 20), version: 1, displayName, description: null, programId: null, availability: 'AVAILABLE',
  currency: 'USD', priceMinor, billingFrequency: 'MONTHLY', termKind: 'FIXED_MONTHS', termMonths: 12, publishedAt: '2026-10-01T00:00:00.000Z', programName: null, ...over });
const generation = (n: number, status: CreativeGeneration['status'], createdAt: string): CreativeGeneration => ({
  generationId: `g${n}`, schoolId: SCHOOL, operationCode: 'image.basic', mediaKind: 'IMAGE', units: 1, format: 'SQUARE', prompt: 'Spring promo poster', status,
  failureReason: null, reservedCredits: 10, chargedCredits: null, createdAt, completedAt: null, assets: [] } as unknown as CreativeGeneration);
const campaigns = () => [{ id: 'c1', label: 'Spring', detail: 'active', version: null }, { id: 'c2', label: 'Summer', detail: 'draft', version: null },
  { id: 'c3', label: 'Back to school', detail: 'active', version: null }];

const full = (): WorkspaceSources => ({
  readiness: { state: 'READY', value: allReady() },
  command: { state: 'READY', value: { ...command(), dailyBriefing: '7 new leads arrived in the last 24 hours.',
    recommendations: [{ id: 'REVIEW_PENDING_APPROVALS', title: 'Review 4 approvals', why: 'Requests are waiting for a person.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false }] } },
  work: { state: 'READY', value: work() },
  sessions: { state: 'READY', value: sessions() },
  absences: { state: 'READY', value: [{ id: 'p1', studentProfileId: 's1', startsAt: '2026-11-10T00:00:00.000Z', endsAt: '2026-11-12T00:00:00.000Z', reason: null, version: 1, submittedAt: '2026-11-05T00:00:00.000Z' }] },
  operations: { state: 'READY', value: operations() },
  reports: { state: 'READY', value: reports() },
  plans: { state: 'READY', value: { plans: [plan('p2', 'Black Belt Club', 24900), plan('p1', 'Basic', 12900), plan('p3', 'Retired plan', 9900, { availability: 'UNAVAILABLE' })], programs: [] } },
  campaigns: { state: 'READY', value: campaigns() },
  creative: { state: 'READY', value: [generation(1, 'SUCCEEDED', '2026-11-01T00:00:00.000Z'), generation(2, 'FAILED', '2026-11-02T00:00:00.000Z'), generation(3, 'SUCCEEDED', '2026-09-01T00:00:00.000Z')] },
});
const view = (agent: SpecialistKey, sources: WorkspaceSources = full(), over: Partial<Parameters<typeof SpecialistWorkspaceView>[0]> = {}) => renderToStaticMarkup(
  <SpecialistWorkspaceView agent={agent} language="en" artStyle="realistic" now={NOW} waiting={false} concealed={false} hasSchool sources={sources}
    renderAsk={() => <p data-testid="ask-box">ASK BOX</p>} {...over} />);

describe('specialist workspace model', () => {
  it('names the four workspaces and their routes', () => {
    expect(['alex', 'jordan', 'claire', 'lena'].every(isSpecialistKey)).toBe(true);
    expect(isSpecialistKey('maya')).toBe(false);
    expect(specialistWorkspaceHref('jordan')).toBe('/staff/ai-team/jordan');
  });

  it('lists the next 7 days of classes, earliest first, without cancelled ones', () => {
    const week = weekSessions(sessions(), NOW);
    expect(week.map(s => s.name)).toEqual(['Little Tigers', 'Adult Sparring', 'Tomorrow class']);
    expect(weekSessions(sessions(), new Date(NOW.getTime() + 30 * 86_400_000))).toEqual([]);
  });

  it('reads attendance outcomes in a fixed order with the window length', () => {
    expect(attendanceOutcomes(operations())).toEqual({ days: 30, rows: [
      { key: 'PRESENT', value: 1200 }, { key: 'LATE', value: 40 }, { key: 'EXCUSED_ABSENCE', value: 12 }, { key: 'UNEXCUSED_ABSENCE', value: 30 }, { key: 'MAKEUP', value: 17 }] });
  });

  it('shows the newest three months first', () => {
    expect(recentMonths(reports()).map(p => p.month)).toEqual(['2026-11', '2026-10', '2026-09']);
  });

  it('counts campaigns by status, lists plans on sale cheapest first, and counts only the last 30 days of creative work', () => {
    expect(campaignCounts(campaigns())).toEqual([{ status: 'ACTIVE', count: 2 }, { status: 'DRAFT', count: 1 }, { status: 'PAUSED', count: 0 }]);
    expect(publishedPlans((full().plans as { state: 'READY'; value: { plans: MembershipPlanListing[] } }).value.plans).map(p => p.displayName)).toEqual(['Basic', 'Black Belt Club']);
    const creative = (full().creative as { state: 'READY'; value: CreativeGeneration[] }).value;
    expect(recentCreative(creative, NOW)).toEqual({ total: 2, byStatus: [{ status: 'FAILED', count: 1 }, { status: 'SUCCEEDED', count: 1 }] });
  });
});

describe('specialist workspace page', () => {
  it('loads only the reads each specialist uses, and always readiness', () => {
    expect(SPECIALIST_SOURCES).toEqual({ alex: ['readiness', 'command', 'work'], jordan: ['readiness', 'sessions', 'absences', 'operations'],
      claire: ['readiness', 'reports', 'command'], lena: ['readiness', 'plans', 'campaigns', 'creative'] });
  });

  it('Alex shows the briefing, priorities with their links, school counts and my open work', () => {
    const html = view('alex');
    expect(html).toContain('Alex, General Manager');
    expect(html).toContain('7 new leads arrived in the last 24 hours.');
    expect(html).toContain('href="/staff/action-center/approvals">Review 4 approvals</a>');
    expect(html).toContain('New leads (24 hours): <strong>7</strong>');
    expect(html).toContain('Call back trial family');
    expect(html).toContain('ASK BOX');
  });

  it('Jordan shows this week’s classes, absences waiting for review and attendance', () => {
    const html = view('jordan');
    expect(html).toContain('3 classes scheduled');
    expect(html).toContain('Little Tigers'); expect(html).not.toContain('Cancelled class');
    expect(html).toContain('1 waiting');
    expect(html).toContain('Attendance, last 30 days'); expect(html).toContain('Unexcused absence: <strong>30</strong>');
    expect(html).toContain('href="/staff/attendance/planned-absences"');
  });

  it('Jordan never shows another school’s absence queue', () => {
    const html = view('jordan', { ...full(), absences: { state: 'READY', value: null } });
    expect(html).toContain('belongs to another school'); expect(html).not.toContain('1 waiting');
  });

  it('Claire shows three months of reports with revenue labelled as HON records, and paid invoices', () => {
    const html = view('claire');
    expect(html.match(/data-testid="claire-month"/g)).toHaveLength(3);
    expect(html).toContain('November 2026 (so far)');
    expect(html).toContain('Kept from start: <strong>276</strong>');
    expect(html).toContain('$42,500.00');
    expect(html).toContain('not accounting or bank-settled');
    expect(html).toContain('2 paid invoices');
  });

  it('Lena shows plans on sale, campaigns by status and recent creative work', () => {
    const html = view('lena');
    expect(html).toContain('Basic'); expect(html).toContain('$129.00 per month · 12-month term');
    expect(html).not.toContain('Retired plan');
    expect(html).toContain('Active: <strong>2</strong>');
    expect(html).toContain('2 requests');
  });

  it('shows a refused or unverifiable read as such and never a value in its place', () => {
    const html = view('alex', { ...full(), command: { state: 'DENIED' }, work: { state: 'UNAVAILABLE' } });
    expect(html).toContain('Your role does not include this view.');
    expect(html).toContain('could not be verified right now');
    expect(html).not.toContain('New leads (24 hours)');
    expect(view('claire', { ...full(), reports: { state: 'LOADING' } })).toContain('Loading…');
  });

  it('offers the Ask box only when readiness clears the specialist, and says why otherwise', () => {
    const off = readiness(ANALYSTS.map(([key, agent]) => readinessAgent(key, agent, 15)));
    for (const panel of [{ state: 'READY', value: off }, { state: 'LOADING' }, { state: 'DENIED' }, { state: 'UNAVAILABLE' }] as WorkspaceSources['readiness'][]) {
      const html = view('lena', { ...full(), readiness: panel });
      expect(html).not.toContain('ASK BOX');
      expect(html).toContain('Lena is not available right now');
    }
    expect(view('lena')).toContain('href="/staff/hon?ask=lena"');
  });

  it('shows nothing from the school while hidden, checking, or without a school', () => {
    for (const over of [{ concealed: true }, { waiting: true }, { hasSchool: false }]) {
      const html = view('alex', full(), over);
      expect(html).not.toContain('7 new leads'); expect(html).not.toContain('ASK BOX');
    }
    expect(view('alex', WORKSPACE_LOADING, { concealed: true })).toContain('Hidden while this window is in the background.');
  });

  it('speaks Korean and Spanish, with every key translated', () => {
    for (const lang of ['ko', 'es'] as const) expect(Object.keys(WORKSPACE_COPY[lang]).sort()).toEqual(Object.keys(WORKSPACE_COPY.en).sort());
    expect(renderToStaticMarkup(<SpecialistWorkspaceView agent="jordan" language="ko" artStyle="realistic" now={NOW} waiting={false} concealed={false} hasSchool sources={full()} />))
      .toContain(workspaceText('ko', 'jordanTitle'));
  });

  it('maps refusals to "not in your access" and everything else to "could not be verified"', () => {
    for (const error of [new CommandCenterAccessError('x', 403), new PlannedAbsenceReviewAccessError(403), new ReportsError('DENIED'), new CreativeGenerationError('DENIED'), new HonConversationError('FORBIDDEN')])
      expect(workspacePanelFromError(error)).toEqual({ state: 'DENIED' });
    for (const error of [new Error('boom'), new PlannedAbsenceReviewAccessError(409), new ReportsError('UNAVAILABLE'), new HonConversationError('UNKNOWN')])
      expect(workspacePanelFromError(error)).toEqual({ state: 'UNAVAILABLE' });
  });

  it('contains no developer jargon', () => {
    for (const agent of ['alex', 'jordan', 'claire', 'lena'] as const) {
      const html = view(agent);
      for (const word of ['UUID', 'OPENROUTER', 'provider', 'NOT_AUTHORIZED', 'undefined', 'NaN']) expect(html).not.toContain(word);
    }
  });
});
