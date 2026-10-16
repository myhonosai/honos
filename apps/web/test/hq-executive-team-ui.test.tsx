import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HqPlatformOverview } from '@hon/contracts';
import { HqExecutiveTeam, HqExecutiveTeamPresentation } from '../src/components/hq-executive-team';
import { loadHqOverview } from '../src/components/hq-overview-http';

function overview(): HqPlatformOverview {
  return {
    asOf: '2026-10-16T08:00:00.000Z', callerHqRole: 'OWNER' as const, organizationCount: 2, schoolCount: 3,
    onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
    configuredProviderStates: { disabled: 1, configured: 2, healthy: 3, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
    financialMetrics: { availability: 'UNAVAILABLE' as const, reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
    aiUsage: { availability: 'UNAVAILABLE' as const, reason: 'No authoritative HQ AI usage or cost projection is available.' },
    durableHqWork: { availability: 'UNAVAILABLE' as const, state: 'NO_RECORDED_WORK' as const, reason: 'No durable HQ executive work is recorded or active in HQ-1.' },
  };
}

const response = (value: unknown) => ({ ok: true, json: async () => ({ data: { overview: value } }) }) as Response;

describe('HQ Executive Team presentation', () => {
  it('reuses the one fixed same-origin HQ overview read rather than a second executive source', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(overview()));
    try {
      await expect(loadHqOverview()).resolves.toEqual(overview());
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/hq/overview', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
    } finally { fetchSpy.mockRestore(); }
  });

  it('renders only the approved locked roster, its informational relationship, and verified unavailable work evidence', () => {
    const html = renderToStaticMarkup(<HqExecutiveTeamPresentation overview={overview()} />);
    for (const text of ['HON', 'Chase', 'Mia', 'Ethan', 'Olivia', 'Ryan', 'Sophia', 'Owner approval → HON coordinator → specialists → shared Action Engine', 'NO RECORDED DURABLE WORK', 'Task, history, result, approval, and cost: unavailable']) expect(html).toContain(text);
    expect(html.match(/NO RECORDED WORK/g)).toHaveLength(7);
    expect(html).toContain('UNAVAILABLE');
    expect(html).not.toMatch(/Working|live activity|\$112k|Ideal Martial Arts|sample customer|schoolId|parentId|staffId/i);
  });

  it('keeps loading private until access verifies and offers the existing three display modes only', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<HqExecutiveTeam />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['Executive Team', 'VERIFYING HQ ACCESS', 'Presentation, not an execution surface.', 'Big-Button', 'Modern', 'Classic']) expect(html).toContain(text);
      expect(html.match(/aria-pressed=/g)).toHaveLength(3);
      expect(html).not.toMatch(/Chase|Mia|Working|sample customer/i);
    } finally { fetchSpy.mockRestore(); }
  });

  it('uses a dedicated dynamic no-index route, the existing overview boundary, and the route manifest without execution clients', () => {
    const route = readFileSync('src/app/hq/executives/page.tsx', 'utf8');
    const component = readFileSync('src/components/hq-executive-team.tsx', 'utf8');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string; title?: string }[] };
    expect(route).toContain('HqExecutiveTeam'); expect(route).toContain('force-dynamic'); expect(route).toContain('index: false');
    expect(component).toContain("from './hq-overview-http'"); expect(component).toContain('loadHqOverview'); expect(component).toContain("'big-button' | 'modern' | 'classic'");
    expect(component).not.toMatch(/fetch\(|method:\s*'POST'|invokeLLM|executeAction|sendMessage|provider-runtime|Idempotency-Key/i);
    expect(manifest.routes).toContainEqual({ path: '/hq/executives', title: 'HON HQ | Executive Team' });
  });
});
