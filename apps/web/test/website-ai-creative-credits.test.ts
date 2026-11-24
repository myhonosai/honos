import { afterEach, expect, it, vi } from 'vitest';
import { verifyWebsiteAiPrice, type SaasCreativeSchoolWallet } from '@hon/contracts';
import { websiteAiApi } from '../src/components/school-website/ai-http';
import { websiteAiText } from '../src/components/school-website/ai-copy';
import { studioWallet } from '../src/components/creative-studio/model';

// 0670: AI website edits are paid from creative credits when the school can use them, otherwise from included AI.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

it('reads the price with one same-origin GET and verifies it', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { data: { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 5, availableCredits: 120 } }); }));
  const price = await websiteAiApi.price({ organizationId: ORG, schoolId: SCHOOL }, AbortSignal.timeout(5000), () => true);
  expect(price).toEqual({ paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 5, availableCredits: 120 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/website/ai-edits/price`);
  expect(calls[0]!.init.method).toBe('GET');
  expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBeNull();
});

it('accepts exactly the two price shapes and nothing else', () => {
  expect(verifyWebsiteAiPrice({ paidWith: 'INCLUDED_AI', creditsPerEdit: null, availableCredits: null }).paidWith).toBe('INCLUDED_AI');
  expect(verifyWebsiteAiPrice({ paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 5, availableCredits: 0 }).paidWith).toBe('CREATIVE_CREDITS');
  for (const bad of [null, [], { paidWith: 'INCLUDED_AI', creditsPerEdit: 5, availableCredits: null }, { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 0, availableCredits: 1 },
    { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 5, availableCredits: -1 }, { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: 5, availableCredits: 1, providerCost: 9 },
    { paidWith: 'FREE', creditsPerEdit: null, availableCredits: null }]) expect(() => verifyWebsiteAiPrice(bad)).toThrow();
});

it('says what each message costs and why a creative-paid message could not start, in three languages', () => {
  expect(websiteAiText('en', 'costCreative', { n: '5', left: '120' })).toBe('Each message uses 5 creative credits (120 left). Credits come back if Marcus cannot answer.');
  expect(websiteAiText('en', 'costIncluded')).toBe('Messages use your included AI.');
  for (const lang of ['ko', 'es']) {
    expect(websiteAiText(lang, 'costCreative', { n: '5', left: '120' })).toContain('120');
    for (const k of ['r_CREATIVE_CREDITS_EXHAUSTED', 'r_CREATIVE_NOT_PRICED', 'r_CREATIVE_NOT_ELIGIBLE', 'r_CREATIVE_EDIT_IN_PROGRESS', 'costIncluded'] as const) expect(websiteAiText(lang, k)).not.toBe(websiteAiText('en', k));
  }
});

it('keeps the website rate out of the image and video studio', () => {
  const rate = (operationCode: string, mediaKind: string, billingUnit: string, maxUnitsPerRequest: number) =>
    ({ operationCode, mediaKind, displayName: operationCode, billingUnit, creditsPerUnit: 10, maxUnitsPerRequest, rateBasis: 'PROVISIONAL' });
  const wallet = {
    program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: 12000, heldCredits: 0 }, history: [], packages: [],
    rates: { rates: [rate('image.generate', 'IMAGE', 'IMAGE', 8), rate('video.generate', 'VIDEO', 'VIDEO_SECOND', 60), rate('website.edit', 'WEBSITE', 'REQUEST', 1)] },
  } as unknown as SaasCreativeSchoolWallet;
  expect(studioWallet(wallet).rates?.map(r => r.operationCode)).toEqual(['image.generate', 'video.generate']);
});
