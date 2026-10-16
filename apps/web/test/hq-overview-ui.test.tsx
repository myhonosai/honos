import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HqOverview } from '../src/components/hq-overview';
import { HqOverviewAccessError, loadHqOverview, verifyHqOverviewSnapshot } from '../src/components/hq-overview-http';

function overview() {
  return {
    asOf: '2026-10-16T08:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 2, schoolCount: 3,
    onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
    configuredProviderStates: { disabled: 1, configured: 2, healthy: 3, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
    financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
    aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
    durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' },
  };
}

const response = (value: unknown) => ({ ok: true, json: async () => ({ data: { overview: value } }) }) as Response;

describe('HQ overview UI', () => {
  it('loads exactly one fixed same-origin GET projection and reconstructs the closed aggregate-only response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(overview()));
    try {
      await expect(loadHqOverview()).resolves.toEqual(overview());
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/hq/overview', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on private identifiers, financial values, authority, model/provider, prompt/output, work evidence, and fake activity', () => {
    for (const patch of [
      { organizationId: 'private' }, { schoolName: 'private school' }, { userEmail: 'private@example.test' },
      { providerId: 'OPENROUTER' }, { modelId: 'private-model' }, { credentialConfigured: true },
      { mrr: 100 }, { arr: 1200 }, { cash: 50 }, { grossMargin: 80 }, { aiCost: 2 },
      { principalId: 'private' }, { authority: 'AUTO' }, { prompt: 'private' }, { output: 'private' },
      { workItems: [] }, { durableHqWork: { ...overview().durableHqWork, state: 'WORKING' } },
      { configuredProviderStates: { ...overview().configuredProviderStates, modelCount: 1 } },
    ]) expect(() => verifyHqOverviewSnapshot({ ...overview(), ...patch })).toThrow();
  });

  it('maps 401 and 403 to access errors and never turns unavailable into sample data', async () => {
    for (const status of [401, 403] as const) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status } as Response);
      try { await expect(loadHqOverview()).rejects.toEqual(expect.any(HqOverviewAccessError)); } finally { fetchSpy.mockRestore(); }
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    try { await expect(loadHqOverview()).rejects.toThrow('No result is shown'); } finally { fetchSpy.mockRestore(); }
  });

  it('renders a conventional initial state with the approved catalog and unavailable/no-recorded-work markers only', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<HqOverview />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['HQ overview', 'VERIFYING HQ ACCESS', 'Chase', 'Mia', 'Ethan', 'Olivia', 'Ryan', 'Sophia', 'No recorded HQ work', 'Commands, delegation, voice, and executive workspaces are not active.']) expect(html).toContain(text);
      expect(html.match(/aria-pressed=/g)).toHaveLength(3);
      expect(html).not.toMatch(/\$112k|MRR\s*<\/|AI Cost \/ School|Working|Your AI team is on it|Ideal Martial Arts/i);
    } finally { fetchSpy.mockRestore(); }
  });

  it('replaces the /hq reference mock, declares exactly three presentation modes, and imports no execution/provider/mutation client', () => {
    const route = readFileSync('src/app/hq/page.tsx', 'utf8');
    const component = readFileSync('src/components/hq-overview.tsx', 'utf8');
    const http = readFileSync('src/components/hq-overview-http.ts', 'utf8');
    expect(route).toContain('HqOverview'); expect(route).not.toContain('HonReferenceSuite'); expect(route).toContain('index: false');
    expect(component).toContain("'big-button' | 'modern' | 'classic'");
    expect(component).not.toMatch(/invokeLLM|executeAction|sendMessage|provider-runtime|payment|method:\s*'POST'|working/i);
    expect(http).toContain("const PATH = '/api/v1/hq/overview'");
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|invokeLLM|executeAction|sendMessage|provider-runtime|payment/i);
  });
});
