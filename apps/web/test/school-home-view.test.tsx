import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));
import { SchoolHomeView, type SchoolHomeViewProps } from '../src/components/home/view';
import { HOME_LOADING } from '../src/components/home/model';
import { homeText } from '../src/components/home/copy';
import { SchoolHome, panelFromError } from '../src/components/home/home';
import { CommandCenterAccessError } from '../src/components/command-center-http';
import { CrmLeadAccessError } from '../src/components/crm-leads-http';
import { AiTeamReadinessAccessError } from '../src/components/ai-team-readiness-http';
import { NOW, ORG, SCHOOL, ready, sessions } from './school-home-fixtures';

const esc = (value: string) => value.replaceAll('&', '&amp;').replaceAll('’', '’');
const base: SchoolHomeViewProps = { language: 'en', mode: 'modern', schoolName: 'Sunrise Taekwondo', selection: { organizationId: ORG, schoolId: SCHOOL }, sources: ready(), now: NOW };
const render = (props: Partial<SchoolHomeViewProps> = {}) => renderToStaticMarkup(<SchoolHomeView {...base} {...props} />);

describe('school home view', () => {
  it('renders the reference layout from verified reads: greeting, HON, AI team, KPIs, lists', () => {
    const html = render();
    expect(html).toContain('Good morning, <span>Sunrise Taekwondo</span>');
    for (const text of ['Ask HON', 'Your AI team', 'Kai', 'Chad', 'Marcus', 'Claire', 'Lena', '286', '412', '1,257', 'Little Tigers', 'Adult Sparring', 'Jordan Example', 'Call back trial family'])
      expect(html).toContain(text);
    expect(html).not.toContain('Tomorrow class');
    expect(html).not.toContain('Cancelled class');
    expect(html).not.toContain('Won Lead');
    expect(html).toContain('data-hon-native');
  });

  it('is honest about what is not connected: revenue, attendance rate, assistant replies, unbuilt agents', () => {
    const html = render();
    expect(html).toMatch(/data-kpi="revenue"[^>]*data-state="NOT_CONNECTED"/);
    expect(html).toMatch(/data-kpi="attendanceRate"[^>]*data-state="NOT_CONNECTED"/);
    expect(html).toContain(homeText('en', 'honStatus'));
    // The fixture's readiness lists only Marcus, Kai and Chad: nobody else is claimed as available.
    for (const id of ['alex', 'maya', 'jordan', 'claire', 'lena']) expect(html).toMatch(new RegExp(`data-agent="${id}" data-status="UNKNOWN"`));
    expect(html).toMatch(/data-agent="kai" data-status="PROVIDER_OFF"/);
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain('eian');
    // No link to an agent readiness does not list.
    expect(html).not.toMatch(/(Open workspace|Ask): (Alex|Maya|Jordan|Claire|Lena)/);
    expect(html).toContain('Open workspace: Kai');
  });

  it('never claims there are no classes today from a bounded snapshot, and labels capacity as capacity', () => {
    expect(render()).toContain('Capacity 20');
    expect(render()).not.toMatch(/spots/);
    const none = render({ sources: { ...ready(), sessions: { state: 'READY', value: [] } } });
    expect(none).toContain(esc(homeText('en', 'scheduleEmpty'))); expect(none).toContain('loaded schedule');
    // Fifty earlier rows fill the snapshot: today may be missing, so say so instead of "none".
    const earlier = Array.from({ length: 50 }, (_, index) => ({ ...sessions()[0]!, sessionId: `s-${index}`, startsAt: new Date(NOW.getTime() - (index + 2) * 86_400_000).toISOString() }));
    const saturated = render({ sources: { ...ready(), sessions: { state: 'READY', value: earlier } } });
    expect(saturated).toContain('data-schedule="partial"');
    expect(saturated).not.toContain(esc(homeText('en', 'scheduleEmpty')));
  });
  it('presents the AI team as included: a reached limit is never a customer charge, and no credit wording appears', () => {
    expect(homeText('en', 'statusBUDGET')).toBe('Included AI limit reached this month. Nothing is charged.');
    for (const language of ['en', 'ko', 'es']) expect(homeText(language, 'statusBUDGET')).not.toMatch(/budget|presupuesto|예산/i);
    expect(render()).not.toMatch(/credit|crédito|크레딧/i);
  });
  it('tells the viewer the overview is hidden while away, with no school content', () => {
    const html = render({ selection: null, schoolName: null, concealed: true });
    expect(html).toContain(esc(homeText('en', 'concealed')));
    expect(html).not.toContain('Sunrise Taekwondo');
  });
  it('shows each refused or unverified panel on its own, with no numbers in its place', () => {
    const html = render({ sources: { ...ready(), operations: { state: 'DENIED' }, leads: { state: 'UNAVAILABLE' }, readiness: { state: 'DENIED' } } });
    expect(html).toContain(esc(homeText('en', 'panelDenied')));
    expect(html).toContain(esc(homeText('en', 'panelUnavailable')));
    expect(html).toContain(homeText('en', 'statusHIDDEN'));
    expect(html).not.toContain('412');
    expect(html).not.toContain('Jordan Example');
    expect(html).toContain('Little Tigers');
  });

  it('shows loading everywhere before any read completes, and nothing school-specific without a verified school', () => {
    const loading = render({ sources: HOME_LOADING });
    expect(loading).not.toMatch(/>\d{2,}</);
    expect(loading).toContain(homeText('en', 'statusCHECKING'));
    const none = render({ selection: null });
    expect(none).toContain(esc(homeText('en', 'noSchool')));
    expect(none).not.toContain('Sunrise');
    expect(none).not.toContain('Little Tigers');
    expect(render({ selection: null, waiting: true })).toContain(homeText('en', 'loading'));
  });

  it('adds the verified prefill only to scoped links', () => {
    const html = render();
    expect(html).toContain(`href="/staff/operations?organizationId=${ORG}&amp;schoolId=${SCHOOL}"`);
    expect(html).toContain(`href="/staff/crm/leads?organizationId=${ORG}&amp;schoolId=${SCHOOL}"`);
    expect(html).toContain('href="/staff/hon"');
    expect(html).toContain('href="/staff/work"');
  });

  it.each(['ko', 'es'] as const)('renders %s copy', language => {
    const html = render({ language });
    expect(html).toContain(homeText(language, 'teamTitle'));
    expect(html).toContain(homeText(language, 'askHon'));
    expect(html).not.toContain('Your AI team');
  });

  it.each(['modern', 'classic', 'big-button'] as const)('uses the same data in %s view', mode => {
    const html = render({ mode });
    expect(html).toContain('286');
    expect(html).toContain(mode === 'classic' ? '/ai/kai-illustrated.webp' : mode === 'big-button' ? '/ai/kai-chibi.webp' : '/ai/kai.webp');
  });

  it('first container render performs no read and shows no school content', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<SchoolHome />);
    expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
    expect(html).toContain('data-home="no-school"');
  });

  it('treats access refusals as denied and every other failure as unverified', () => {
    expect(panelFromError(new CommandCenterAccessError('x', 403))).toEqual({ state: 'DENIED' });
    expect(panelFromError(new CrmLeadAccessError('x'))).toEqual({ state: 'DENIED' });
    expect(panelFromError(new AiTeamReadinessAccessError(403))).toEqual({ state: 'DENIED' });
    expect(panelFromError(new Error('boom'))).toEqual({ state: 'UNAVAILABLE' });
  });

  it('uses existing protected GET reads only: no mutation, AI invocation or provider client', () => {
    const container = readFileSync('src/components/home/home.tsx', 'utf8');
    const view = readFileSync('src/components/home/view.tsx', 'utf8');
    for (const source of [container, view]) expect(source).not.toMatch(/method:\s*'POST'|Idempotency-Key|mutateHumanWork|decideActionReview|invokeLLM|executeAction|sendMessage|localStorage|sessionStorage/);
    expect(view).not.toMatch(/fetch\(/);
    const route = readFileSync('src/app/staff/dashboard/page.tsx', 'utf8');
    for (const text of ['requireVerifiedWebSession', 'index: false', 'follow: false', 'force-dynamic', '<SchoolHome />']) expect(route).toContain(text);
    expect(route).not.toMatch(/searchParams|fetch\(/);
  });
});

it('is the page main landmark (the shell has none of its own)', () => {
  const html = renderToStaticMarkup(<SchoolHomeView {...base} />);
  expect(html.match(/<main/g)).toHaveLength(1);
});
