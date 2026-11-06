import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
