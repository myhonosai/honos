import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreativeGeneration, CreativeGenerationInput } from '@hon/contracts';
import { CreativeGenerationError, createCreativeGeneration, listCreativeGenerations, prepareCreativeGeneration } from '../src/components/creative-studio/generation-http';
import { outcomeFromError, outcomeFromReceipt } from '../src/components/creative-studio/creative-studio';
import { studioWallet, type CreateOutcome, type GenerationsState } from '../src/components/creative-studio/model';
import { CreativeStudioView } from '../src/components/creative-studio/view';
import { id, rawWallet, reply, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input: CreativeGenerationInput = { operationCode: 'image.standard', units: 2, format: 'SQUARE', prompt: 'Kids class flyer, bright colors' };
const key = id(900);
function generation(status: CreativeGeneration['status'] = 'SUCCEEDED', extra: Partial<CreativeGeneration> = {}): CreativeGeneration {
  const done = status !== 'GENERATING', charged = status === 'SUCCEEDED' || status === 'RESOLVED_CHARGED';
  return { generationId: id(800), schoolId: scope.schoolId, operationCode: input.operationCode, mediaKind: 'IMAGE', units: input.units, format: input.format, prompt: input.prompt,
    status, failureReason: status === 'FAILED' ? 'PROVIDER_REJECTED' : status === 'UNDER_REVIEW' ? 'PROVIDER_UNKNOWN' : null, reservedCredits: 80,
    chargedCredits: charged ? 80 : null, createdAt: '2026-11-07T06:00:00.000Z', completedAt: done ? '2026-11-07T06:00:05.000Z' : null,
    assets: status === 'SUCCEEDED' ? [1, 2].map(n => ({ assetId: id(810 + n), ordinal: n, mediaType: 'image/png' as const, width: 1080, height: 1080, durationSeconds: null, origin: 'SYNTHETIC' as const })) : [],
    ...extra };
}
const balance = () => rawWallet().balance;
const receipt = (g = generation()) => ({ generation: g, balance: balance(), replayed: false });
const listBody = (provider: 'CONNECTED' | 'NOT_CONNECTED', items: CreativeGeneration[] = []) => ({ provider, generations: items, limit: 50 });
const signal = () => new AbortController().signal;

it('lists generations with a fixed same-origin GET and refuses rows for another school', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(listBody('NOT_CONNECTED', [generation()])));
  const list = await listCreativeGenerations(scope.schoolId, signal());
  expect(list.provider).toBe('NOT_CONNECTED'); expect(list.generations).toHaveLength(1);
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/generations`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  f.mockResolvedValue(reply(listBody('CONNECTED', [generation('SUCCEEDED', { schoolId: id(9) })])));
  await expect(listCreativeGenerations(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  f.mockResolvedValue(reply({}, 403));
  await expect(listCreativeGenerations(scope.schoolId, signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('sends exactly the closed request, the command header and the idempotency key', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(receipt()));
  const result = await createCreativeGeneration(scope.schoolId, input, key, signal());
  expect(result.generation.status).toBe('SUCCEEDED');
  const [path, init] = f.mock.calls[0]!;
  expect(path).toBe(`/api/v1/schools/${scope.schoolId}/creative-studio/generations`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect((init as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'saas-creative-generation-create', 'Idempotency-Key': key });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual(input);
});

it('refuses to send a request the contract would refuse', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const bad of [{ ...input, prompt: '' }, { ...input, prompt: ' padded ' }, { ...input, units: 0 }, { ...input, format: 'WIDE' }, { ...input, providerId: 'x' }]) {
    expect(() => prepareCreativeGeneration(bad as CreativeGenerationInput)).toThrow(CreativeGenerationError);
    await expect(createCreativeGeneration(scope.schoolId, bad as CreativeGenerationInput, key, signal())).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).not.toHaveBeenCalled();
});

it('separates definitive refusals from unknown outcomes', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const cases: [number, string | null, string][] = [
    [503, 'CREATIVE_PROVIDER_NOT_CONNECTED', 'NOT_CONNECTED'], [503, 'SAAS_UNAVAILABLE', 'UNKNOWN'], [422, 'CREATIVE_TOO_MANY_IN_PROGRESS', 'REFUSED'],
    [422, 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'REFUSED'], [409, 'SAAS_OUTCOME_UNKNOWN', 'UNKNOWN'], [409, 'CREATIVE_GENERATION_IN_PROGRESS', 'UNKNOWN'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'], [400, 'INVALID_SAAS_INPUT', 'INVALID'], [403, 'SAAS_FORBIDDEN', 'DENIED'], [500, null, 'UNKNOWN'], [404, 'SAAS_UNAVAILABLE', 'UNKNOWN']];
  for (const [status, code, kind] of cases) {
    f.mockResolvedValueOnce(Response.json(code ? { code } : {}, { status }));
    await expect(createCreativeGeneration(scope.schoolId, input, key, signal()), `${status} ${code}`).rejects.toMatchObject({ kind, code });
  }
  f.mockRejectedValueOnce(new TypeError('network'));
  await expect(createCreativeGeneration(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // A receipt that does not echo this request is not trusted as its outcome.
  f.mockResolvedValueOnce(reply(receipt(generation('SUCCEEDED', { prompt: 'Something else' }))));
  await expect(createCreativeGeneration(scope.schoolId, input, key, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('maps outcomes: only a known result releases the request', () => {
  expect(outcomeFromReceipt(receipt(generation('SUCCEEDED')))).toEqual({ kind: 'DONE' });
  expect(outcomeFromReceipt(receipt(generation('UNDER_REVIEW')))).toEqual({ kind: 'HELD' });
  expect(outcomeFromReceipt(receipt(generation('FAILED')))).toEqual({ kind: 'FAILED' });
  expect(outcomeFromReceipt(receipt(generation('GENERATING')))).toEqual({ kind: 'UNKNOWN' });
  expect(outcomeFromError(new CreativeGenerationError('REFUSED', 'X'))).toEqual({ kind: 'REFUSED', code: 'X' });
  expect(outcomeFromError(new CreativeGenerationError('NOT_CONNECTED'))).toEqual({ kind: 'NOT_CONNECTED' });
  expect(outcomeFromError(new Error('boom'))).toEqual({ kind: 'UNKNOWN' });
});

function activeWallet() {
  const raw = rawWallet();
  return studioWallet({ ...raw, walletVersion: 2, program: { ...raw.program, status: 'ACTIVE' }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: 500, heldCredits: 0, byKind: raw.balance.byKind.map(k => k.kind === 'INCLUDED_MONTHLY' ? { ...k, grantedCredits: 500, availableCredits: 500 } : k) },
    rates: { rateVersionId: id(40), rateVersion: 1, termsReference: 'terms', publishedAt: '2026-11-01T00:00:00.000Z', rates: [
      { operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 40, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL' }] } });
}
const view = (generations: GenerationsState, outcome: CreateOutcome = null, wallet = activeWallet()) => renderToStaticMarkup(
  <CreativeStudioView language="en" waiting={false} concealed={false} hasSchool studio={{ state: 'READY', wallet }} generations={generations} outcome={outcome} onCreate={() => {}} onCheckAgain={() => {}}/>);

it('offers the create form only when a provider is connected and the school can use it', () => {
  const off = view({ state: 'READY', provider: 'NOT_CONNECTED', items: [] });
  expect(off).toContain('data-create-state="NOT_CONNECTED"'); expect(off).toContain('Not connected yet');
  expect(off).not.toMatch(/<textarea|<select|<input/);
  const failed = view({ state: 'UNAVAILABLE' });
  expect(failed).toContain('data-create-state="NOT_CONNECTED"'); expect(failed).not.toMatch(/<textarea/);
  const open = view({ state: 'READY', provider: 'CONNECTED', items: [] });
  expect(open).toContain('data-create-state="OPEN"'); expect(open).toMatch(/<textarea/); expect(open).toContain('Standard image');
  expect(open).toContain('Do not include private student or family details');
  expect(open).toMatch(/<button type="submit" disabled="">Create<\/button>/);
  const ineligible = studioWallet({ ...rawWallet(), program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 } });
  const blocked = view({ state: 'READY', provider: 'CONNECTED', items: [] }, null, ineligible);
  expect(blocked).toContain('data-create-state="BLOCKED"'); expect(blocked).not.toMatch(/<textarea/);
});

it('says what happened, and offers Check again only for an unknown outcome', () => {
  const connected: GenerationsState = { state: 'READY', provider: 'CONNECTED', items: [] };
  expect(view(connected, { kind: 'DONE' })).toContain('Done. The result is listed below.');
  expect(view(connected, { kind: 'HELD' })).toContain('credits are held while HQ checks it');
  expect(view(connected, { kind: 'FAILED' })).toContain('Your credits were returned.');
  expect(view(connected, { kind: 'REFUSED', code: 'SAAS_CREATIVE_AI_PAUSED_BY_HQ' })).toContain('HQ has paused creative work');
  expect(view(connected, { kind: 'REFUSED', code: 'CREATIVE_TOO_MANY_IN_PROGRESS' })).toContain('three creations are already in progress');
  expect(view(connected, { kind: 'NOT_CONNECTED' })).toContain('Nothing was sent or charged.');
  for (const kind of ['UNKNOWN', 'HIDDEN_PENDING'] as const) expect(view(connected, { kind })).toContain('Check again');
  for (const kind of ['DONE', 'FAILED', 'NOT_CONNECTED', 'INVALID'] as const) expect(view(connected, { kind })).not.toContain('Check again');
  expect(view(connected, { kind: 'UNKNOWN' })).toContain('never creates a second one or charges twice');
  // While a request is unresolved the form is disabled.
  expect(view(connected, { kind: 'SENDING' })).toMatch(/<textarea[^>]*disabled=""/);
});

it('lists creations with status, credits and placeholder previews only', () => {
  const html = view({ state: 'READY', provider: 'CONNECTED', items: [generation('SUCCEEDED'), generation('UNDER_REVIEW', { generationId: id(801) }), generation('FAILED', { generationId: id(802) })] });
  expect(html).toContain('Your creations'); expect(html).toContain('Kids class flyer, bright colors');
  expect(html).toContain('Image 1080×1080 · preview not available yet');
  expect(html).toContain('80 credits held'); expect(html).toContain('Held for HQ review'); expect(html).toContain('Did not work · credits returned');
  expect(html).not.toMatch(/<img|https?:\/\//);
});

it('shows nothing private while concealed', () => {
  const html = renderToStaticMarkup(<CreativeStudioView language="en" waiting={false} concealed hasSchool studio={{ state: 'READY', wallet: activeWallet() }}
    generations={{ state: 'READY', provider: 'CONNECTED', items: [generation()] }} outcome={{ kind: 'UNKNOWN' }}/>);
  expect(html).not.toContain('Kids class flyer'); expect(html).not.toMatch(/<textarea/); expect(html).not.toContain('Check again');
});
