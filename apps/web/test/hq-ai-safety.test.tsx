import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_UNKNOWN_AGENTS } from '@hon/contracts';
import { HQ_AI_SAFETY_API, HqAiSafetyError, preparePause, prepareResolution } from '../src/components/hq-modern/ai-safety-http';
import { HqAiSafetyView, pauseInput, resolutionInput, type AiSafetyViewProps, type Records } from '../src/components/hq-modern/ai-safety';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const AS_OF = '2026-11-06T18:00:00.000Z';
const records = (): Records => ({
  pauses: { asOf: AS_OF, pauses: [
    { pauseId: id(1), organizationId: null, spendClass: 'CREATIVE_MEDIA', reason: 'Provider incident under review', pausedAt: AS_OF, pausedByPrincipalId: id(2), status: 'ACTIVE', endReason: null, endedAt: null, endedByPrincipalId: null },
    { pauseId: id(3), organizationId: id(4), spendClass: 'ALL', reason: 'Suspected abuse being checked', pausedAt: AS_OF, pausedByPrincipalId: id(2), status: 'ENDED', endReason: 'Checked and cleared by owner', endedAt: AS_OF, endedByPrincipalId: id(2) },
  ] },
  queue: { asOf: AS_OF, staleAfterSeconds: 900, resolved: [], open: [
    { agent: 'MARKETING', invocationId: id(5), organizationId: id(4), schoolId: id(6), status: 'UNKNOWN', reservedCredits: 12, heldAt: AS_OF, countsAgainstCurrentWindow: true },
  ] },
});
const noop = () => {};
const props = (over: Partial<AiSafetyViewProps> = {}): AiSafetyViewProps => ({ phase: 'READY', records: records(), pending: null, notice: null,
  onRefresh: noop, onPause: noop, onResume: noop, onResolve: noop, onRetry: noop, onDiscard: noop, ...over });
const render = (over: Partial<AiSafetyViewProps> = {}) => renderToStaticMarkup(<HqAiSafetyView {...props(over)} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('HQ AI safety view', () => {
  it('lists active and ended pauses and the open lost-outcome queue, with no customer charge wording', () => {
    const html = render();
    for (const text of ['Emergency AI pauses', '1 active', 'Creative Studio media · whole platform', 'Ended pauses (1)', 'Lost provider outcomes', '1 open', 'Marcus · marketing drafts · result lost', '12 internal usage units held'])
      expect(html).toContain(text);
    expect(html).toContain('Nothing here charges a school');
    expect(html).not.toMatch(/customer credits|purchased credit/i);
  });
  it('shows no records unless READY, and offers sign-in only for an ended session', () => {
    for (const phase of ['LOADING', 'CONCEALED', 'FORBIDDEN', 'UNAVAILABLE', 'SESSION'] as const) {
      const html = render({ phase, records: phase === 'CONCEALED' ? records() : null });
      expect(html).not.toContain('data-ai-safety-records');
      expect(html).not.toContain('Provider incident under review');
    }
    expect(render({ phase: 'SESSION', records: null })).toContain('href="/auth/login"');
  });
  it('locks every control while a command is pending and offers an exact retry only for an unknown outcome', () => {
    const prepared = { path: '/x', command: 'ai-spend-pause', key: id(7), body: '{}' };
    const unknown = render({ pending: { prepared, label: 'Pause all AI work', kind: 'pause', state: 'UNKNOWN' } });
    expect(unknown).toContain('Retry the same request'); expect(unknown).toContain('cannot apply it twice');
    expect(unknown).toMatch(/<fieldset disabled=""/);
    expect(render({ pending: { prepared, label: 'Pause', kind: 'pause', state: 'FORBIDDEN' } })).not.toContain('Retry the same request');
  });
  it('shows a definitive refusal with a refresh, never an outcome-recovery retry', () => {
    const prepared = { path: '/x', command: 'ai-spend-pause', key: id(7), body: '{}' };
    for (const refusal of ['AI_SPEND_PAUSE_ALREADY_ACTIVE', 'AI_SPEND_PAUSE_NOT_ACTIVE', 'AI_UNKNOWN_NOT_RESOLVABLE', 'AI_UNKNOWN_ORIGIN_UNAVAILABLE'] as const) {
      const html = render({ pending: { prepared, label: 'Resume all AI work', kind: 'pause', state: 'REFUSED', refusal } });
      expect(html).toContain('Nothing'); expect(html).toContain('Refresh records'); expect(html).not.toContain('Retry the same request');
    }
  });
  it('never renders request labels, notices or retry while concealed or ended; only a generic line in a fresh node', () => {
    const prepared = { path: '/x', command: 'ai-unknown-resolve', key: id(7), body: '{}' };
    for (const phase of ['CONCEALED', 'SESSION'] as const) for (const state of ['SENDING', 'UNKNOWN'] as const) {
      const html = render({ phase, records: null, notice: 'Resolve call 11111111: recorded.', pending: { prepared, label: 'Resolve call 11111111', kind: 'resolve', state } });
      expect(html).not.toContain('11111111'); expect(html).not.toContain('Retry the same request'); expect(html).not.toContain('data-ai-safety-private');
      expect(html).toContain('data-pending-hidden'); expect(html).toContain('Refresh to see it again');
    }
    const visible = render({ notice: 'Resolve call 11111111: recorded.', pending: { prepared, label: 'Resolve call 11111111', kind: 'resolve', state: 'UNKNOWN' } });
    expect(visible.match(/data-ai-safety-private=""/g)).toHaveLength(2);
  });
});

describe('HQ AI safety agents', () => {
  it('labels every canonical UNKNOWN agent, including HON assistant replies', () => {
    const base = records();
    const html = render({ records: { ...base, queue: { ...base.queue, open: AI_UNKNOWN_AGENTS.map((agent, index) => ({ ...base.queue.open[0]!, agent, invocationId: id(index + 1) })) } } });
    for (const label of ['Marcus', 'Kai', 'Chad', 'HON · assistant replies']) expect(html).toContain(label);
    expect(html).not.toContain('undefined');
  });
});

describe('HQ AI safety input', () => {
  it('requires confirmation, a 10–500 character reason and a valid organization for a scoped pause', () => {
    const base = { scope: 'PLATFORM' as const, organizationId: '', spendClass: 'ALL' as const, reason: 'Provider incident in progress', confirmed: true };
    expect(pauseInput(base)).toEqual({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider incident in progress' });
    expect(pauseInput({ ...base, confirmed: false })).toBeNull();
    expect(pauseInput({ ...base, reason: 'short' })).toBeNull();
    expect(pauseInput({ ...base, scope: 'ORGANIZATION', organizationId: 'not-a-uuid' })).toBeNull();
    expect(pauseInput({ ...base, scope: 'ORGANIZATION', organizationId: id(4).toUpperCase() })?.organizationId).toBe(id(4));
  });
  it('maps each resolution decision to its closed evidence shape', () => {
    const form = { reason: 'Checked the provider usage page', reference: 'gen_123', inputTokens: '10', outputTokens: '20', costMicrounits: '1500' };
    expect(resolutionInput({ ...form, decision: 'NO_PROVIDER_CHARGE' })).toEqual({ decision: 'NO_PROVIDER_CHARGE', reason: form.reason, evidence: { providerLookupReference: 'gen_123' } });
    expect(resolutionInput({ ...form, decision: 'WRITE_OFF' })).toEqual({ decision: 'WRITE_OFF', reason: form.reason, evidence: { estimatedProviderCostMicrounits: 1500 } });
    expect(resolutionInput({ ...form, decision: 'RECORD_PROVIDER_COST' })?.evidence).toEqual({ providerGenerationId: 'gen_123', inputTokens: 10, outputTokens: 20, providerCostMicrounits: 1500 });
    expect(resolutionInput({ ...form, decision: 'WRITE_OFF', reason: 'no' })).toBeNull();
  });
});

describe('HQ AI safety transport', () => {
  it('prepares contract-valid commands with a fixed path, the exact command header name and a fresh key; invalid input never leaves the browser', () => {
    const pause = preparePause({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider incident in progress' });
    expect(pause.path).toBe('/api/v1/hq/ai/spend-pauses'); expect(pause.command).toBe('ai-spend-pause');
    expect(JSON.parse(pause.body)).toEqual({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider incident in progress' });
    const resolve = prepareResolution('TEACHING', id(5), { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider usage page', evidence: { providerLookupReference: 'ref-1' } });
    expect(resolve.path).toBe(`/api/v1/hq/ai/unknown-invocations/TEACHING/${id(5)}/resolve`);
    expect(() => preparePause({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'short' })).toThrow(HqAiSafetyError);
    expect(() => prepareResolution('NOBODY' as never, id(5), { decision: 'WRITE_OFF', reason: 'Checked the provider usage page', evidence: { estimatedProviderCostMicrounits: 1 } })).toThrow(HqAiSafetyError);
  });
  it('sends the frozen body and key once per call, and treats a network failure or 5xx as an unknown outcome', async () => {
    const prepared = preparePause({ action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider incident in progress' });
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init); throw new TypeError('network'); }));
    await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init); return new Response('{}', { status: 503 }); }));
    await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    expect(calls.map(call => [call.body, (call.headers as Record<string, string>)['Idempotency-Key'], (call.headers as Record<string, string>)['X-HON-Human-Command']]))
      .toEqual([[prepared.body, prepared.key, 'ai-spend-pause'], [prepared.body, prepared.key, 'ai-spend-pause']]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"SAAS_FORBIDDEN"}', { status: 403 })));
    await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'FORBIDDEN' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { pauseId: id(1), organizationId: null, spendClass: 'ALL', status: 'ACTIVE', replayed: false } }), { status: 200 })));
    await expect(HQ_AI_SAFETY_API.sendPause(prepared)).resolves.toMatchObject({ status: 'ACTIVE' });
  });
  it('keeps 409 SAAS_OUTCOME_UNKNOWN and unrecognized 409/422 as UNKNOWN; closed 422 rule refusals and definitive 409s are not retryable', async () => {
    const prepared = preparePause({ action: 'RESUME', organizationId: null, spendClass: 'ALL', reason: 'Provider incident resolved' });
    const reply = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
    reply(409, JSON.stringify({ code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key' }));
    await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    reply(409, 'not json'); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    reply(409, JSON.stringify({ code: 'SOMETHING_NEW' })); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    reply(409, JSON.stringify({ code: 'SAAS_VERSION_CONFLICT' })); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'CONFLICT' });
    reply(409, JSON.stringify({ code: 'IDEMPOTENCY_KEY_REUSED' })); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'CONFLICT' });
    for (const code of ['AI_SPEND_PAUSE_ALREADY_ACTIVE', 'AI_SPEND_PAUSE_NOT_ACTIVE']) {
      reply(422, JSON.stringify({ code })); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'REFUSED', refusal: code });
    }
    reply(422, JSON.stringify({ code: 'SAAS_OFFER_NOT_AVAILABLE' })); await expect(HQ_AI_SAFETY_API.sendPause(prepared)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    for (const decision of [
      { decision: 'RECORD_PROVIDER_COST', reason: 'Checked the provider usage page', evidence: { providerGenerationId: 'gen-1', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 10 } },
      { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider usage page', evidence: { providerLookupReference: 'ref-1' } },
      { decision: 'WRITE_OFF', reason: 'Checked the provider usage page', evidence: { estimatedProviderCostMicrounits: 10 } },
    ] as const) {
      const resolution = prepareResolution('MARKETING', id(5), decision);
      for (const code of ['AI_UNKNOWN_NOT_RESOLVABLE', 'AI_UNKNOWN_ORIGIN_UNAVAILABLE']) {
        reply(422, JSON.stringify({ code })); await expect(HQ_AI_SAFETY_API.sendResolution(resolution)).rejects.toMatchObject({ kind: 'REFUSED', refusal: code });
      }
      reply(409, JSON.stringify({ code: 'SAAS_OUTCOME_UNKNOWN' })); await expect(HQ_AI_SAFETY_API.sendResolution(resolution)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    }
  });
  it('reads only closed, validated records and never returns a drifted body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: records().pauses, extra: 1 }), { status: 200 })));
    await expect(HQ_AI_SAFETY_API.pauses(new AbortController().signal)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: records().queue }), { status: 200 })));
    await expect(HQ_AI_SAFETY_API.queue(new AbortController().signal)).resolves.toMatchObject({ open: [{ agent: 'MARKETING' }] });
    const dispatch = vi.fn(); vi.stubGlobal('window', { dispatchEvent: dispatch });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(HQ_AI_SAFETY_API.pauses(new AbortController().signal)).rejects.toMatchObject({ kind: 'SESSION' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
