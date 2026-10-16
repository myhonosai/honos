import { describe, expect, it } from 'vitest';
import { HON_HQ_EXECUTIVE_CATALOG } from '@hon/contracts';
import { verifyHqPlatformOverview } from './hq-overview.js';

const overview = () => ({
  asOf: '2026-10-16T08:00:00.000Z',
  callerHqRole: 'OWNER',
  organizationCount: 2,
  schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 3, degraded: 0, unavailable: 1 },
  taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
  aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' },
});

describe('HQ-1 executive catalog and platform overview contract', () => {
  it('contains only the approved fixed executive hierarchy with presentation-only unavailable workspaces', () => {
    expect(HON_HQ_EXECUTIVE_CATALOG.map((entry) => [entry.executiveKey, entry.domain])).toEqual([
      ['hon', 'EXECUTIVE_COORDINATION'],
      ['chase', 'GROWTH'],
      ['mia', 'CUSTOMER_SUCCESS'],
      ['ethan', 'PRODUCT'],
      ['olivia', 'FINANCE'],
      ['ryan', 'REVENUE'],
      ['sophia', 'OPERATIONS'],
    ]);
    for (const entry of HON_HQ_EXECUTIVE_CATALOG) {
      expect(entry.workspace).toEqual({ availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' });
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'domain', 'executiveKey', 'summary', 'title', 'workspace']);
      expect(JSON.stringify(entry)).not.toMatch(/principal|model|provider|authority|permission|credential|cost|tool/i);
    }
  });

  it('reconstructs the sole permitted aggregate-only overview shape', () => {
    expect(verifyHqPlatformOverview(overview())).toEqual(overview());
  });

  it('rejects private, financial, authority, work-evidence, and malformed count fields', () => {
    for (const patch of [
      { organizationId: 'private-id' },
      { schoolName: 'private school' },
      { email: 'private@example.test' },
      { providerId: 'OPENROUTER' },
      { modelId: 'private-model' },
      { credentialSecretRef: 'hon-secret:00000000-0000-4000-8000-000000000000' },
      { mrr: 1 },
      { arr: 1 },
      { cash: 1 },
      { grossMargin: 1 },
      { costMicros: 1 },
      { principalId: 'private-id' },
      { authority: 'AUTO' },
      { prompt: 'private' },
      { output: 'private' },
      { workItems: [] },
      { callerHqRole: 'HON_HQ_SUPPORT' },
      { onboarding: { ...overview().onboarding, requestCount: 2 } },
      { configuredProviderStates: { ...overview().configuredProviderStates, modelCount: 1 } },
      { durableHqWork: { ...overview().durableHqWork, state: 'WORKING' } },
      { financialMetrics: { availability: 'AVAILABLE', reason: overview().financialMetrics.reason } },
    ]) {
      expect(() => verifyHqPlatformOverview({ ...overview(), ...patch })).toThrow('HQ_OVERVIEW_INVALID');
    }
  });
});
