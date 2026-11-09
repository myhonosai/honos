import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AI_CONTROL_LANGUAGES } from '../src/components/hq-ai-control/copy';
import { AiControlError, aiControlApi, aiControlErrorFor, keepForRetry, lastDays, toMicro, usd } from '../src/components/hq-ai-control/http';
import { safetyBody } from '../src/components/hq-ai-control/hq-ai-control';
import { AiCostsView, AiSafetyView, type AiSafetyViewProps, type Names } from '../src/components/hq-ai-control/view';
import { HQ_AI, HQ_PLANNED } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), school2 = id(3), pauseId = id(40), inv = id(50), inv2 = id(51), key = id(77), principal = id(9);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AiControlError; } throw new Error('expected a failure'); };
const zero = { providerReportedCostMicrounits: 0, estimatedWriteOffCostMicrounits: 0, entries: 0, writeOffEntries: 0, lateProviderCostMicrounits: 0, lateProviderExpenseEntries: 0,
  supersededWriteOffEstimateMicrounits: 0 };
const amount = (over: Record<string, unknown> = {}) => ({ credits: 120, ...zero, providerReportedCostMicrounits: 41_500, entries: 3, ...over });
const FROM = '2026-10-10T00:00:00.000Z', TO = '2026-11-09T00:00:00.000Z';
const usage = (over: Record<string, unknown> = {}) => ({ from: FROM, to: TO, asOf: '2026-11-09T00:00:01.000Z', truncated: false, providerCostUnit: 'MICROUNITS_USD',
  schools: [
    { organizationId: org, schoolId: school, ...zero, providerReportedCostMicrounits: 41_500, estimatedWriteOffCostMicrounits: 2_000, entries: 4, writeOffEntries: 1,
      unreconciledInvocations: 2, byClass: {
        AGENT_INFERENCE: { ...amount({ estimatedWriteOffCostMicrounits: 2_000, entries: 4, writeOffEntries: 1 }),
          byAgent: { MARKETING: amount({ estimatedWriteOffCostMicrounits: 2_000, entries: 4, writeOffEntries: 1 }) } } } },
    { organizationId: org, schoolId: school2, ...zero, unreconciledInvocations: 1, byClass: {} },
  ],
  organizations: [{ organizationId: org, agentWindowStart: '2026-11-01T00:00:00.000Z', agentWindowEnd: '2026-12-01T00:00:00.000Z', agentCommittedCredits: 120,
    agentCeilingCredits: 12000, openUnknownHolds: 3, aiPaused: false }], ...over });
const pause = (over: Record<string, unknown> = {}) => ({ pauseId, organizationId: org, spendClass: 'ALL', reason: 'Provider bill spike under review', pausedAt: '2026-11-09T01:00:00.000Z',
  pausedByPrincipalId: principal, status: 'ACTIVE', endReason: null, endedAt: null, endedByPrincipalId: null, ...over });
const openItem = { agent: 'MARKETING', invocationId: inv, organizationId: org, schoolId: school, status: 'UNKNOWN', reservedCredits: 40, heldAt: '2026-11-08T10:00:00.000Z',
  countsAgainstCurrentWindow: true } as const;
const resolved = (over: Record<string, unknown> = {}) => ({ resolutionId: id(60), agent: 'TEACHING', invocationId: inv2, organizationId: org, schoolId: school, decision: 'WRITE_OFF',
  releasedCredits: 25, ledgerEntryId: id(61), customerCredits: 0, resolvedAt: '2026-11-08T12:00:00.000Z', reason: 'Provider has no record we can match',
  evidence: { estimatedProviderCostMicrounits: 2000 }, resolvedByPrincipalId: principal, priorStatus: 'UNKNOWN', heldAt: '2026-11-07T10:00:00.000Z', lateProviderExpense: null, ...over });
const names: Names = { schools: new Map([[school, 'Tiger Dojo — Main'], [school2, 'Tiger Dojo — North']]), orgs: new Map([[org, 'Tiger Dojo']]) };

it('reads usage as a plain same-origin GET with only from/to, and refuses an answer for another range', async () => {
  const f = stub(json({ data: usage() }));
  const report = await aiControlApi.usage(FROM, TO, signal(), () => true);
  expect(report.schools).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/ai/school-usage?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  expect(init.body).toBeUndefined();
  stub(json({ data: usage({ from: '2026-10-01T00:00:00.000Z' }) }));
  expect((await fails(aiControlApi.usage(FROM, TO, signal(), () => true))).kind).toBe('UNKNOWN');
  // More than 92 days never leaves the browser.
  const g = stub(json({ data: usage() }));
  expect((await fails(aiControlApi.usage('2026-01-01T00:00:00.000Z', TO, signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('rejects answers that are not exactly {data} or that drift from the contract', async () => {
  stub(json({ data: { pauses: [], asOf: '2026-11-09T00:00:00.000Z' }, meta: {} }));
  expect((await fails(aiControlApi.pauses(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { pauses: [pause({ reason: 'short' })], asOf: '2026-11-09T00:00:00.000Z' } }));
  expect((await fails(aiControlApi.pauses(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(aiControlApi.unknown(signal(), () => true))).kind).toBe('DENIED');
  stub(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  expect((await fails(aiControlApi.unknown(signal(), () => true))).kind).toBe('UNKNOWN');
});

it('ends the session on 401 only for a request that is still owned', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(new Response(null, { status: 401 }));
  expect((await fails(aiControlApi.pauses(signal(), () => false))).kind).toBe('SESSION');
  expect(seen).not.toHaveBeenCalled();
  stub(new Response(null, { status: 401 }));
  expect((await fails(aiControlApi.pauses(signal(), () => true))).kind).toBe('SESSION');
  expect(seen).toHaveBeenCalledTimes(1);
});

it('sends a pause as one POST with its own human-command marker and key, and checks the receipt matches', async () => {
  const body = { action: 'PAUSE', organizationId: org, spendClass: 'CREATIVE_MEDIA', reason: 'Provider bill spike under review' } as const;
  const f = stub(json({ data: { pauseId, organizationId: org, spendClass: 'CREATIVE_MEDIA', status: 'ACTIVE', replayed: false } }));
  expect((await aiControlApi.pause(body, key, signal(), () => true)).status).toBe('ACTIVE');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/ai/spend-pauses');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'X-HON-Human-Command': 'ai-spend-pause', 'Idempotency-Key': key, 'Content-Type': 'application/json' } });
  expect(JSON.parse(init.body as string)).toEqual(body);
  // A receipt for another class, or a resume answered as still active, is not this command's outcome.
  stub(json({ data: { pauseId, organizationId: org, spendClass: 'ALL', status: 'ACTIVE', replayed: false } }));
  expect((await fails(aiControlApi.pause(body, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { pauseId, organizationId: org, spendClass: 'CREATIVE_MEDIA', status: 'ACTIVE', replayed: true } }));
  expect((await fails(aiControlApi.pause({ ...body, action: 'RESUME' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  // A bad key or a short reason never reaches the network.
  const g = stub(json({}));
  expect((await fails(aiControlApi.pause(body, 'nope', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(aiControlApi.pause({ ...body, reason: 'short' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('settles a lost call and records a late charge on their own paths and markers', async () => {
  const body = { decision: 'NO_PROVIDER_CHARGE', reason: 'Provider console shows no charge', evidence: { providerLookupReference: 'req_abc.123' } } as const;
  const receipt = { resolutionId: id(60), agent: 'MARKETING', invocationId: inv, organizationId: org, schoolId: school, decision: 'NO_PROVIDER_CHARGE', releasedCredits: 40,
    ledgerEntryId: null, customerCredits: null, resolvedAt: '2026-11-09T02:00:00.000Z', replayed: false };
  const f = stub(json({ data: receipt }));
  await aiControlApi.resolve('MARKETING', inv.toUpperCase(), body, key, signal(), () => true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/ai/unknown-invocations/MARKETING/${inv}/resolve`);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('ai-unknown-resolve');
  stub(json({ data: { ...receipt, decision: 'WRITE_OFF', ledgerEntryId: id(61), customerCredits: 0 } }));
  expect((await fails(aiControlApi.resolve('MARKETING', inv, body, key, signal(), () => true))).kind).toBe('UNKNOWN');

  const late = { reason: 'Provider invoice line found later', evidence: { providerGenerationId: 'gen_1', inputTokens: 10, outputTokens: 20, providerCostMicrounits: 3100 } };
  const h = stub(json({ data: { expenseId: id(70), resolutionId: id(60), agent: 'TEACHING', invocationId: inv2, providerCostMicrounits: 3100, estimatedProviderCostMicrounits: 2000,
    customerCredits: 0, occurredAt: '2026-11-07T10:00:00.000Z', recordedAt: '2026-11-09T02:00:00.000Z', replayed: false } }));
  await aiControlApi.lateExpense('TEACHING', inv2, late, key, signal(), () => true);
  const [lpath, linit] = h.mock.calls[0] as unknown as [string, RequestInit];
  expect(lpath).toBe(`/api/v1/hq/ai/unknown-invocations/TEACHING/${inv2}/late-provider-expense`);
  expect((linit.headers as Record<string, string>)['X-HON-Human-Command']).toBe('ai-late-provider-expense');
  expect((await fails(aiControlApi.resolve('UNATTRIBUTED' as never, inv, body, key, signal(), () => true))).kind).toBe('INVALID');
});

it('maps refusals: only definite answers close a command, and only unknown or rate-limited ones keep the key', () => {
  expect(aiControlErrorFor(422, 'AI_SPEND_PAUSE_ALREADY_ACTIVE').kind).toBe('CHANGED');
  expect(aiControlErrorFor(422, 'AI_LATE_EXPENSE_ALREADY_RECORDED').kind).toBe('CHANGED');
  expect(aiControlErrorFor(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(aiControlErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(aiControlErrorFor(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(aiControlErrorFor(404, 'SAAS_UNAVAILABLE').kind).toBe('CHANGED');
  expect(aiControlErrorFor(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(aiControlErrorFor(422, 'SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(aiControlErrorFor(503, 'SAAS_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new AiControlError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new AiControlError('RATE'))).toBe(true);
  for (const kind of ['SESSION', 'DENIED', 'CHANGED', 'INVALID'] as const) expect(keepForRetry(new AiControlError(kind))).toBe(false);
});

it('converts dollars to micro-USD exactly and shows small amounts without rounding them to zero', () => {
  expect(toMicro('0.0123')).toBe(12_300); expect(toMicro('12')).toBe(12_000_000); expect(toMicro(' 1.000001 ')).toBe(1_000_001);
  for (const bad of ['', '-1', '1.0000001', '1e3', 'abc', '1,5']) expect(toMicro(bad)).toBeNull();
  expect(usd('en', 41_500)).toBe('$0.04'); expect(usd('en', 120)).toBe('$0.0001'); expect(usd('en', 7)).toBe('$0.000007'); expect(usd('en', 0)).toBe('$0.00');
  expect(lastDays(30, Date.parse('2026-11-09T00:00:00.123Z'))).toEqual({ from: FROM, to: TO });
});

it('builds each safety body from the form, taking a resume scope only from the listed active pause', () => {
  const list = { pauses: [pause() as never], asOf: '2026-11-09T00:00:00.000Z' };
  expect(safetyBody({ action: 'pause' }, { organizationId: '', spendClass: 'ALL', reason: '  Provider bill spike under review ' }, null))
    .toEqual({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider bill spike under review' });
  expect(safetyBody({ action: 'resume', pauseId }, { reason: 'Bill reviewed and fine', organizationId: id(99) }, list))
    .toEqual({ action: 'RESUME', organizationId: org, spendClass: 'ALL', reason: 'Bill reviewed and fine' });
  expect(() => safetyBody({ action: 'resume', pauseId: id(41) }, { reason: 'Bill reviewed and fine' }, list)).toThrow(AiControlError);
  expect(safetyBody({ action: 'resolve', invocationId: inv }, { decision: 'WRITE_OFF', estimate: '0.002', reason: 'No record at provider' }, null))
    .toEqual({ decision: 'WRITE_OFF', reason: 'No record at provider', evidence: { estimatedProviderCostMicrounits: 2000 } });
  expect(safetyBody({ action: 'late', invocationId: inv2 }, { providerGenerationId: ' gen_1 ', inputTokens: '10', outputTokens: '20', providerCost: '0.0031', reason: 'Invoice found later' }, null))
    .toEqual({ reason: 'Invoice found later', evidence: { providerGenerationId: 'gen_1', inputTokens: 10, outputTokens: 20, providerCostMicrounits: 3100 } });
  expect(() => safetyBody({ action: 'resolve', invocationId: inv }, { decision: 'RECORD_PROVIDER_COST', providerGenerationId: 'g', inputTokens: '1.5', outputTokens: '2', providerCost: '1' }, null)).toThrow(AiControlError);
  expect(() => safetyBody({ action: 'resolve', invocationId: inv }, { decision: 'GUESS', reason: 'whatever it is' }, null)).toThrow(AiControlError);
});

it('shows per-school usage with provider charges, HQ estimates and unknown calls apart, and hides it all when concealed', () => {
  const view = { state: 'READY', view: usage() } as never;
  const html = renderToStaticMarkup(<AiCostsView language="en" concealed={false} range="r30" usage={view} names={names}/>);
  expect(html).toContain('Tiger Dojo — Main'); expect(html).toContain('Tiger Dojo — North');
  expect(html).toContain('$0.04'); expect(html).toContain('$0.0020'); expect(html).toContain('2 calls'); expect(html).toContain('>1 call<');
  expect(html).toContain('Marketing');
  expect(html).toMatch(/aria-pressed="true"[^>]*>Last 30 days/);
  const hidden = renderToStaticMarkup(<AiCostsView language="en" concealed range="r30" usage={view} names={names} onReveal={() => {}}/>);
  expect(hidden).not.toContain('Tiger Dojo'); expect(hidden).not.toContain('$0.04'); expect(hidden).toContain('Show again');
  expect(renderToStaticMarkup(<AiCostsView language="en" concealed={false} range="r7" usage={{ state: 'DENIED' }} names={names}/>)).toContain('does not include AI costs');
  // Unnamed ids are shown as ids, never as a guessed name.
  expect(renderToStaticMarkup(<AiCostsView language="en" concealed={false} range="r7" usage={view} names={{ schools: new Map(), orgs: new Map() }}/>)).toContain('School 00000000');
});

const safety = (over: Partial<AiSafetyViewProps> = {}): string => renderToStaticMarkup(<AiSafetyView language="en" concealed={false} names={names} form={null} outcome={null}
  locked={false} canRetry={false}
  pauses={{ state: 'READY', view: { pauses: [pause(), pause({ pauseId: id(42), organizationId: null, status: 'ENDED', endReason: 'Bill reviewed and fine', endedAt: '2026-11-09T02:00:00.000Z', endedByPrincipalId: principal })], asOf: '2026-11-09T03:00:00.000Z' } } as never}
  unknown={{ state: 'READY', view: { open: [openItem], resolved: [resolved()], staleAfterSeconds: 900, asOf: '2026-11-09T03:00:00.000Z' } } as never} {...over}/>);

it('lists pauses and lost calls, offering resume only on active pauses and a late charge only on unmatched write-offs', () => {
  const html = safety();
  expect(html.match(/data-testid="pause-row"/g)).toHaveLength(2);
  expect(html.match(/>Resume</g)).toHaveLength(1);
  expect(html).toContain('Whole platform');
  expect(html).toContain('data-testid="unknown-row"'); expect(html).toContain('data-testid="resolved-row"');
  expect(html).toMatch(/Record a late provider charge/);
  const matched = safety({ unknown: { state: 'READY', view: { open: [], resolved: [resolved({ lateProviderExpense: { expenseId: id(70), providerCostMicrounits: 3100,
    occurredAt: '2026-11-07T10:00:00.000Z', recordedAt: '2026-11-09T02:00:00.000Z' } })], staleAfterSeconds: 900, asOf: '2026-11-09T03:00:00.000Z' } } as never });
  expect(matched).not.toMatch(/Record a late provider charge</); expect(matched).toContain('$0.0031');
  const pausing = safety({ form: { action: 'pause' } });
  expect(pausing).toContain('data-testid="pause-form"'); expect(pausing).toContain(`<option value="${org}">Tiger Dojo</option>`);
  expect(safety({ form: { action: 'resolve', invocationId: inv } })).toContain('data-testid="settle-form"');
});

it('offers Try again and Stop only for a kept command, and hides everything when concealed', () => {
  const kept = safety({ outcome: { kind: 'UNKNOWN', action: 'pause' }, locked: true, canRetry: true, onTryAgain: () => {}, onDiscard: () => {} });
  expect(kept).toContain('Try again'); expect(kept).toContain('Stop and check the lists');
  const refused = safety({ outcome: { kind: 'CHANGED', action: 'pause' }, onTryAgain: () => {}, onDiscard: () => {} });
  expect(refused).not.toContain('Try again'); expect(refused).not.toContain('Stop and check the lists');
  const hidden = safety({ concealed: true, onReveal: () => {} });
  expect(hidden).not.toContain('Provider bill spike'); expect(hidden).not.toContain('pause-row'); expect(hidden).toContain('Show again');
  expect(safety({ pauses: { state: 'DENIED' }, unknown: { state: 'UNAVAILABLE' } })).toContain('could not be read');
});

it('has every phrase in English, Korean and Spanish, and puts both screens in the HQ AI menu', () => {
  const keys = Object.keys(AI_CONTROL_LANGUAGES.en).sort();
  expect(Object.keys(AI_CONTROL_LANGUAGES.ko).sort()).toEqual(keys);
  expect(Object.keys(AI_CONTROL_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(AI_CONTROL_LANGUAGES)) for (const v of Object.values(table)) expect(v.trim().length).toBeGreaterThan(0);
  expect(HQ_AI.map((x) => x.path)).toEqual(expect.arrayContaining(['/hq/ai-costs', '/hq/ai-safety']));
  expect(Object.keys(HQ_PLANNED)).not.toContain('/hq/ai-costs');
  for (const page of ['src/app/hq/ai-costs/page.tsx', 'src/app/hq/ai-safety/page.tsx']) expect(existsSync(page)).toBe(true);
  expect(readFileSync('src/app/hq/ai-costs/page.tsx', 'utf8')).toContain('HqAiCosts');
  const routes = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes?: { path: string }[] } | { path: string }[];
  expect(JSON.stringify(routes)).toContain('"/hq/ai-safety"');
});

it("names Claire's Business Performance calls as their own AI team member in every language (0238)", () => {
  const claire = usage({ schools: [{ organizationId: org, schoolId: school, ...zero, providerReportedCostMicrounits: 41_500, entries: 3, unreconciledInvocations: 0, byClass: {
    AGENT_INFERENCE: { ...amount(), byAgent: { BUSINESS_PERFORMANCE: amount() } } } }] });
  const labels = { en: 'Claire, Business Performance', ko: 'Claire, 비즈니스 성과', es: 'Claire, Rendimiento del negocio' } as const;
  for (const language of ['en', 'ko', 'es'] as const) {
    const html = renderToStaticMarkup(<AiCostsView language={language} concealed={false} range="r30" usage={{ state: 'READY', view: claire } as never} names={names}/>);
    expect(html).toContain(labels[language]);
    expect(html).not.toContain('a_BUSINESS_PERFORMANCE');
  }
});
