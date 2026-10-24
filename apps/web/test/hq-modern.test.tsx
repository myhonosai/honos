import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, type HqPlatformOverview } from '@hon/contracts';
import { HQ_AI, HQ_EXECUTIVES, HQ_GROWTH, HQ_NAV, HQ_PLANNED, HQ_REVENUE, hqPageLabel } from '../src/components/hq-modern/catalog';

const overview: HqPlatformOverview = {
  asOf: '2026-10-18T00:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 2, schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 0, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics },
  aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork },
};

vi.mock('../src/components/hq-modern/shell', () => ({
  useHqModern: () => ({ overview, art: 'realistic', view: 'modern', draft: '', setDraft: vi.fn(), openAssistant: vi.fn() }),
  HonCore: () => <span aria-label="HON Core"/>,
}));
import { HqModernDashboard, CompanySnapshot, NeedsAttention } from '../src/components/hq-modern/dashboard';
import { HqExecutiveWorkspace, HqPlannedPage } from '../src/components/hq-modern/pages';
import { HonComposer } from '../src/components/hq-modern/assistant';

describe('HQ Modern foundation', () => {
  it('keeps HQ identities separate and resolves context only from exact static paths', () => {
    expect(HQ_EXECUTIVES.map((item) => item.displayName)).toEqual(['Chase', 'Mia', 'Ethan', 'Olivia', 'Ryan', 'Sophia']);
    expect(hqPageLabel('/hq/executives/chase')).toBe('Chase workspace');
    for (const path of ['/staff/dashboard', '/hq/schools?schoolId=private', '/hq/executives/arbitrary', '/parent']) expect(hqPageLabel(path)).toBe('HQ workspace');
  });

  it('shows verified school counts and preserves unavailable financial, AI and attention facts', () => {
    const snapshot = renderToStaticMarkup(<CompanySnapshot/>);
    expect(snapshot).toContain('2 organizations');
    expect(snapshot).toContain('>3</strong>');
    expect(snapshot).toContain('Unavailable');
    const attention = renderToStaticMarkup(<NeedsAttention/>);
    for (const text of ['Pending approvals', 'Support escalations', 'Failed operations', 'Owner decisions', 'No pending count is assumed']) expect(attention).toContain(text);
    expect(attention).not.toMatch(/\b(0 pending|all clear|resolved|completed)\b/i);
  });

  it('renders the approved dashboard with named executive workspace links and no claimed AI work', () => {
    const html = renderToStaticMarkup(<HqModernDashboard/>);
    for (const executive of HQ_EXECUTIVES) expect(html).toContain(`href="/hq/executives/${executive.executiveKey}"`);
    for (const text of ['HON', 'Needs Your Attention', 'Company at a glance', 'Growth &amp; Referrals', 'No recorded work', 'Conversation unavailable']) expect(html).toContain(text);
    expect(html).not.toMatch(/\$[\d,]+|Working|Your AI team is on it|Ideal Martial Arts/);
    // Verified facts lead; the executive roster is a compact strip after the operational panels.
    const order = ['aria-label="Company performance overview"', 'id="hq-commercial-title"', 'id="hq-hon-title"', 'id="hq-attention-title"', 'id="hq-team-title"'].map((marker) => html.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('provides no sending or microphone activation when the services are unavailable', () => {
    const html = renderToStaticMarkup(<HonComposer context="Overview"/>);
    expect(html).toContain('Unsent message draft');
    expect(html).toContain('not sent or saved');
    expect(html).toMatch(/disabled="" aria-label="Send unavailable/);
    expect(html).toContain('Microphone off');
  });

  it('renders explicit planned states for every missing module and never grants business actions', () => {
    for (const path of Object.keys(HQ_PLANNED)) {
      const html = renderToStaticMarkup(<HqPlannedPage pagePath={path}/>);
      expect(html).toContain('Planned');
      expect(html).toContain('Unavailable');
      expect(html).toContain('No service is called');
    }
    const contest = renderToStaticMarkup(<HqPlannedPage pagePath="/hq/growth/contests"/>);
    expect(contest).toContain('Workflow preview');
    expect(contest).toContain('disabled=""');
  });

  it('keeps every executive workspace unavailable rather than inventing histories or recommendations', () => {
    for (const executive of HQ_EXECUTIVES) {
      const html = renderToStaticMarkup(<HqExecutiveWorkspace executiveKey={executive.executiveKey}/>);
      expect(html).toContain(executive.title);
      expect(html).toContain('Task history unavailable');
      expect(html).toContain('No recorded work');
      expect(html).toContain('Planned integration');
    }
  });

  it('links only to implemented HQ routes and retains the session gate plus independent strict projection', () => {
    for (const entry of [...HQ_NAV, ...HQ_GROWTH, ...HQ_REVENUE, ...HQ_AI]) expect(existsSync(`src/app${entry.path}/page.tsx`)).toBe(true);
    const layout = readFileSync('src/app/hq/layout.tsx', 'utf8');
    expect(layout.indexOf('await requireVerifiedWebSession()')).toBeLessThan(layout.indexOf('return <HqModernShell>'));
    const shell = readFileSync('src/components/hq-modern/shell.tsx', 'utf8');
    expect(shell).toContain('loadHqOverview()');
    expect(shell).toContain("access.kind === 'ready'");
    expect(shell).not.toMatch(/localStorage|sessionStorage|organizationId|schoolId|familyId|method:\s*'POST'/);
    const route = readFileSync('src/app/hq/executives/[executive]/page.tsx', 'utf8');
    expect(route).toContain('HQ_EXECUTIVES.some'); expect(route).toContain('notFound()');
  });
});
