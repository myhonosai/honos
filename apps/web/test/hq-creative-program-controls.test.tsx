import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { validateSaasCreativeHqWalletList, validateSaasCreativeRatesInput } from '@hon/contracts';
import { creditsApi } from '../src/components/hq-creative-credits/http';
import { APPROVED_CREATIVE_RATES, ProgramControls } from '../src/components/hq-creative-credits/program-controls';
import { list, rates } from './hq-creative-credits-fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const signal = () => new AbortController().signal;
const render = (over: Record<string, unknown>) => renderToStaticMarkup(<ProgramControls language="en" list={validateSaasCreativeHqWalletList(list(over))} onDone={() => {}}/>);
const key = '11111111-1111-4111-8111-111111111111';

it('publishes the owner-approved credit prices exactly (10/image, 20/s video, 10/avatar, 15/s avatar video, 8/s photo video)', () => {
  const body = validateSaasCreativeRatesInput(APPROVED_CREATIVE_RATES);
  expect(body.rates.map((r) => [r.operationCode, r.billingUnit, r.creditsPerUnit])).toEqual([
    ['image.generate', 'IMAGE', 10], ['video.generate', 'VIDEO_SECOND', 20], ['avatar.create', 'IMAGE', 10], ['avatar.video', 'VIDEO_SECOND', 15], ['avatar.photo.video', 'VIDEO_SECOND', 8]]);
});
it('shows Publish credit prices first, then Turn on, then Turn off', () => {
  expect(render({ rates: null })).toContain('data-testid="credits-program-publish"');
  expect(render({ rates: null })).toContain('20 credits per second');
  expect(render({})).toContain('data-testid="credits-program-on"');
  expect(render({ program: { status: 'ACTIVE', version: 2, monthlyIncludedCredits: 12000 } })).toContain('data-testid="credits-program-off"');
});
it('sends the program command with the HQ owner marker, an idempotency key and the read version, and checks the receipt', async () => {
  const f = vi.fn(async () => json({ data: { program: { status: 'ACTIVE', version: 2, monthlyIncludedCredits: 12000, authorizationReference: 'HQ owner pressed Turn on in HQ Creative Credits', changedAt: '2026-11-26T08:00:00.000Z' }, replayed: false } }));
  vi.stubGlobal('fetch', f);
  const r = await creditsApi.program({ action: 'ACTIVATE', expectedVersion: 1, authorizationReference: 'HQ owner pressed Turn on in HQ Creative Credits' }, key, signal(), () => true);
  expect(r.program.status).toBe('ACTIVE');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/creative-credits/program');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-program', 'Idempotency-Key': key });
  expect(JSON.parse(String(init.body))).toEqual({ action: 'ACTIVATE', expectedVersion: 1, authorizationReference: 'HQ owner pressed Turn on in HQ Creative Credits' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: { program: { status: 'INACTIVE', version: 2, monthlyIncludedCredits: 12000, authorizationReference: 'x', changedAt: '2026-11-26T08:00:00.000Z' }, replayed: false } })));
  await expect(creditsApi.program({ action: 'ACTIVATE', expectedVersion: 1, authorizationReference: 'x' }, key, signal(), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});
it('sends the rates command and refuses a receipt with different prices', async () => {
  const published = { ...rates(), rates: APPROVED_CREATIVE_RATES.rates.map((r) => ({ ...r, rateBasis: 'PROVISIONAL' })) };
  const f = vi.fn(async () => json({ data: { rates: published, retiredRateVersionId: null, replayed: false } }));
  vi.stubGlobal('fetch', f);
  await creditsApi.rates(APPROVED_CREATIVE_RATES, key, signal(), () => true);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-rates-publish' });
  const wrong = { ...published, rates: published.rates.map((r) => ({ ...r, creditsPerUnit: r.creditsPerUnit + 1 })) };
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: { rates: wrong, retiredRateVersionId: null, replayed: false } })));
  await expect(creditsApi.rates(APPROVED_CREATIVE_RATES, key, signal(), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});
