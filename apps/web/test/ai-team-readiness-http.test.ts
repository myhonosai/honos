import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiTeamReadinessAccessError, aiTeamReadinessPath, loadAiTeamReadiness, verifyAiTeamReadiness } from '../src/components/ai-team-readiness-http';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const agent = (agentKey: string, name: string, credits: number, over: Record<string, unknown> = {}) => ({ agentKey, agent: name, authorized: true, spendDecision: 'ALLOWED',
  route: 'CONFIGURED', requestCredits: credits, providerRuntime: 'CONFIGURATION_REQUIRED', available: false, blockedBy: 'PROVIDER_RUNTIME_NOT_CONFIGURED', ...over });
const readinessFixture = (over: Record<string, unknown> = {}) => ({
  organizationId: A, schoolId: B, completeEntitlement: true, agentBudget: null, asOf: '2026-11-06T10:00:00.000Z', honConversation: { contract: true },
  agents: [agent('marcus', 'MARKETING', 6), agent('kai', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3), agent('hon', 'HON_REPLY', 10), agent('claire', 'BUSINESS_PERFORMANCE', 15),
    agent('alex', 'GENERAL_MANAGEMENT', 15), agent('jordan', 'OPERATIONS', 15), agent('lena', 'CREATIVE_COMMERCE', 15), agent('maya', 'RETENTION', 15)], ...over,
});
const envelope = (data: unknown) => ({ data, meta: { requestId: 'r', correlationId: 'r' } });

afterEach(() => vi.unstubAllGlobals());

describe('AI team readiness client', () => {
  it('reads only the fixed same-origin path for well-formed selectors', () => {
    expect(aiTeamReadinessPath(A.toUpperCase(), B)).toBe(`/api/v1/organizations/${A}/schools/${B}/ai/team/capabilities`);
    expect(() => aiTeamReadinessPath('x', B)).toThrow();
    expect(() => aiTeamReadinessPath(A, `${B}/../x`)).toThrow();
  });

  it('accepts the exact contract for the requested school only', () => {
    expect(verifyAiTeamReadiness(envelope(readinessFixture()), A, B).agents.map(item => item.agentKey)).toEqual(['marcus', 'kai', 'chad', 'hon', 'claire', 'alex', 'jordan', 'lena', 'maya']);
    expect(() => verifyAiTeamReadiness(envelope(readinessFixture({ schoolId: C })), A, B)).toThrow();
    expect(() => verifyAiTeamReadiness({ data: readinessFixture() }, A, B)).toThrow();
    expect(() => verifyAiTeamReadiness(envelope({ ...readinessFixture(), extra: 1 }), A, B)).toThrow();
    // A provider-off agent may never be reported available.
    expect(() => verifyAiTeamReadiness(envelope(readinessFixture({ agents: [agent('marcus', 'MARKETING', 6, { available: true, blockedBy: null }),
      agent('kai', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3), agent('hon', 'HON_REPLY', 10), agent('claire', 'BUSINESS_PERFORMANCE', 15),
    agent('alex', 'GENERAL_MANAGEMENT', 15), agent('jordan', 'OPERATIONS', 15), agent('lena', 'CREATIVE_COMMERCE', 15)] })), A, B)).toThrow();
  });

  it('maps 401/403 to an access error and anything else to an unverified failure', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      await expect(loadAiTeamReadiness(A, B)).rejects.toBeInstanceOf(AiTeamReadinessAccessError);
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(loadAiTeamReadiness(A, B)).rejects.not.toBeInstanceOf(AiTeamReadinessAccessError);
  });

  it('sends a credentialed same-origin GET with no body or command headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope(readinessFixture())), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await loadAiTeamReadiness(A, B);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toMatch(/Idempotency|Human-Command/);
  });
});
