import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqCreativeStudio, type HqCreativeGeneration } from '@hon/contracts';
import { creativeApi } from '../src/components/hq-creative/http';
import { budgetInputFrom, requestInputFrom, resolvable, resolveInputFrom } from '../src/components/hq-creative/model';
import { HqCreativeView, type CreativeViewProps } from '../src/components/hq-creative/view';
import { creativeText } from '../src/components/hq-creative/copy';
import { marketingCommandError } from '../src/components/hq-marketing/http';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = { principalId: id(50), displayName: 'Synthetic Marketer' };
const budget = (patch: Record<string, unknown> = {}) => ({ periodStart: '2026-11-01', creditCap: 100, usedCredits: 20, heldCredits: 10, availableCredits: 70,
  inProgress: 0, version: 2, setBy: { principalId: id(51), displayName: 'Synthetic Owner' }, setAt: T, ...patch });
const gen = (patch: Record<string, unknown> = {}) => ({ generationId: id(1), periodStart: '2026-11-01', campaign: null, operationCode: 'image.generate', mediaKind: 'IMAGE',
  units: 2, format: 'SQUARE', prompt: 'Founder poster', status: 'SUCCEEDED', failureReason: null, reservedCredits: 20, chargedCredits: 20, requestedBy: person,
  version: 2, createdAt: T, completedAt: T2, assets: [{ assetId: id(9), ordinal: 1, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, origin: 'SYNTHETIC' }], ...patch });
const rate = { operationCode: 'image.generate', mediaKind: 'IMAGE', displayName: 'Image', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 4 };
const studio = (patch: Record<string, unknown> = {}) => ({ provider: 'NOT_CONNECTED', budget: budget(), budgetHistory: [], rates: [rate], generations: [gen()], limit: 50,
  viewer: { ...person, canManage: true, isOwner: false }, asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const ask = { operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'Founder poster', campaignId: null } as const;

it('reads the studio with a plain same-origin GET and refuses drift', async () => {
  const f = stub(json({ data: studio() }));
  expect((await creativeApi.studio(new AbortController().signal, yes)).provider).toBe('NOT_CONNECTED');
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/marketing/creative');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  for (const [answer, kind] of [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({ data: { ...studio(), providerId: 'X' } }), 'UNKNOWN'],
    [json({ data: studio({ generations: [{ ...gen(), schoolId: id(3) }] }) }), 'UNKNOWN']] as const) {
    stub(answer);
    await expect(creativeApi.studio(new AbortController().signal, yes)).rejects.toMatchObject({ kind });
  }
});

it('sends a request with the human-command marker and key; an answer about a different request is never trusted', async () => {
  const key = id(77);
  const f = stub(json({ data: { generation: gen(), budget: budget(), replayed: false } }));
  await creativeApi.create(ask, key, new AbortController().signal, yes);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/marketing/creative/generations');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-creative-generation-create', 'Idempotency-Key': key });
  expect(JSON.parse(init.body as string)).toEqual(ask);
  stub(json({ data: { generation: gen({ units: 1, chargedCredits: 10, reservedCredits: 10 }), budget: budget(), replayed: false } }));
  await expect(creativeApi.create(ask, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' }, 503));
  await expect(creativeApi.create(ask, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'REFUSED', code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
  stub(json({}, 503));
  await expect(creativeApi.create(ask, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const b = stub(json({ data: { budget: budget({ creditCap: 300, availableCredits: 270 }), replayed: false } }));
  await creativeApi.setBudget({ periodStart: '2026-11-01', creditCap: 300, expectedVersion: 2, reason: 'More posters' }, key, new AbortController().signal, yes);
  expect(call(b)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'hq-creative-budget-set' });
  stub(json({ data: { budget: budget(), replayed: false } }));
  await expect(creativeApi.setBudget({ periodStart: '2026-11-01', creditCap: 300, expectedVersion: 2, reason: 'More posters' }, key, new AbortController().signal, yes))
    .rejects.toMatchObject({ kind: 'UNKNOWN' });
  const r = stub(json({ data: { generation: gen({ status: 'RESOLVED_NOT_CHARGED', chargedCredits: null, assets: [], failureReason: 'PROVIDER_UNKNOWN', version: 3 }), budget: budget(), replayed: false } }));
  await creativeApi.resolve(id(1), { expectedVersion: 2, resolution: 'NOT_CHARGED', finalUnits: null, providerCostMicrounits: null, evidenceReference: 'Invoice 9' }, key, new AbortController().signal, yes);
  expect(call(r)[0]).toBe(`/api/v1/hq/marketing/creative/generations/${id(1)}/resolution`);
});

it('maps every HQ creative rule refusal as definitive (nothing saved) and anything else as unknown', () => {
  for (const code of ['HQ_CREATIVE_BUDGET_NOT_SET', 'HQ_CREATIVE_BUDGET_EXHAUSTED', 'HQ_CREATIVE_TOO_MANY_IN_PROGRESS', 'HQ_CREATIVE_PAUSED_BY_HQ', 'HQ_CREATIVE_CAP_BELOW_USE'])
    expect(marketingCommandError(422, code).kind).toBe('REFUSED');
  expect(marketingCommandError(409, 'SAAS_TRANSITION_NOT_ALLOWED').kind).toBe('CHANGED');
  expect(marketingCommandError(422, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(marketingCommandError(503, 'SAAS_UNAVAILABLE').kind).toBe('UNKNOWN');
});

it('builds closed requests from typed forms', () => {
  expect(requestInputFrom({ operationCode: 'image.generate', units: ' 2 ', format: 'SQUARE', prompt: '  Line one\r\nLine two  ', campaignId: '' }))
    .toEqual({ operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'Line one\nLine two', campaignId: null });
  for (const bad of [{ units: '0' }, { units: '1.5' }, { format: 'WIDE' }, { prompt: '   ' }, { campaignId: 'x' }])
    expect(requestInputFrom({ operationCode: 'image.generate', units: '2', format: 'SQUARE', prompt: 'p', campaignId: '', ...bad })).toBeNull();
  const b = validateHqCreativeStudio(studio()).budget;
  expect(budgetInputFrom({ creditCap: '1,500', reason: ' More   posters ' }, b)).toEqual({ periodStart: '2026-11-01', creditCap: 1500, expectedVersion: 2, reason: 'More posters' });
  expect(budgetInputFrom({ creditCap: '1500', reason: '' }, b)).toBeNull();
  expect(budgetInputFrom({ creditCap: '1', reason: 'First cap' }, { ...b, creditCap: null, version: null, setBy: null, setAt: null, availableCredits: 0 })?.expectedVersion).toBeNull();
  const held = gen({ status: 'UNDER_REVIEW', chargedCredits: null, assets: [], failureReason: 'PROVIDER_UNKNOWN' }) as unknown as HqCreativeGeneration;
  expect(resolveInputFrom({ resolution: 'SUCCEEDED', finalUnits: '2', evidenceReference: 'Invoice 9' }, held)).toMatchObject({ finalUnits: 2, expectedVersion: 2 });
  expect(resolveInputFrom({ resolution: 'SUCCEEDED', finalUnits: '3', evidenceReference: 'Invoice 9' }, held)).toBeNull();
  expect(resolveInputFrom({ resolution: 'NOT_CHARGED', finalUnits: '9', evidenceReference: 'Invoice 9' }, held)).toMatchObject({ finalUnits: null });
  expect(resolvable(held, T2)).toBe(true);
  const running = gen({ status: 'GENERATING', chargedCredits: null, assets: [], completedAt: null }) as unknown as HqCreativeGeneration;
  expect([resolvable(running, '2026-11-01T00:01:00.000Z'), resolvable(running, '2026-11-01T00:02:00.000Z')]).toEqual([false, true]);
});

const props = (patch: Partial<CreativeViewProps> = {}): CreativeViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', view: validateHqCreativeStudio(studio()) }, campaigns: [], outcome: null, locked: false, canRetry: false, resolving: null,
  onRefresh: () => {}, onReveal: () => {}, onRequest: () => {}, onBudget: () => {}, onResolveOpen: () => {}, onResolve: () => {}, onTryAgain: () => {}, ...patch });

it('shows the separate HQ budget and turns requests off honestly when no provider is connected', () => {
  const html = renderToStaticMarkup(<HqCreativeView {...props()}/>);
  expect(html).toContain('HQ budget, separate from schools');
  expect(html).toContain('data-creative-provider="NOT_CONNECTED"');
  expect(html).toContain("needs David&#x27;s approval");
  expect(html).toContain('data-creative-requests-off=""');
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  expect(html).not.toContain('data-creative-budget-form');
  expect(html).toContain('1 synthetic test result(s). No media is stored yet.');
  const on = renderToStaticMarkup(<HqCreativeView {...props({ state: { state: 'READY', view: validateHqCreativeStudio(studio({ provider: 'CONNECTED' })) } })}/>);
  expect(on).not.toContain('data-creative-requests-off');
  const unset = renderToStaticMarkup(<HqCreativeView {...props({ state: { state: 'READY', view: validateHqCreativeStudio(studio({ provider: 'CONNECTED',
    budget: budget({ creditCap: null, usedCredits: 0, heldCredits: 0, availableCredits: 0, version: null, setBy: null, setAt: null }) })) } })}/>);
  expect(unset).toContain('data-creative-budget="unset"'); expect(unset).toContain('data-creative-requests-off=""');
});

it('the HQ owner sees the cap form and Resolve on held requests; readers see no forms', () => {
  const held = gen({ status: 'UNDER_REVIEW', chargedCredits: null, assets: [], failureReason: 'UNVERIFIED_RESULT' });
  const owner = renderToStaticMarkup(<HqCreativeView {...props({ state: { state: 'READY', view: validateHqCreativeStudio(studio({ generations: [held],
    viewer: { ...person, canManage: true, isOwner: true } })) }, resolving: id(1) })}/>);
  expect(owner).toContain('data-creative-budget-form=""');
  expect(owner).toContain(`data-creative-resolve-form="${id(1)}"`);
  expect(owner).toContain('Held for HQ owner review');
  const reader = renderToStaticMarkup(<HqCreativeView {...props({ state: { state: 'READY', view: validateHqCreativeStudio(studio({ generations: [held],
    viewer: { ...person, canManage: false, isOwner: false } })) } })}/>);
  expect(reader).not.toContain('data-creative-request-form'); expect(reader).not.toContain('data-creative-budget-form'); expect(reader).not.toContain('data-creative-resolve-form');
  expect(reader).toContain('You can read HQ creative requests but not make them.');
});

it('explains each refusal and keeps an unknown outcome retryable; concealed shows nothing', () => {
  const refused = renderToStaticMarkup(<HqCreativeView {...props({ outcome: { kind: 'REFUSED', code: 'HQ_CREATIVE_BUDGET_EXHAUSTED' } })}/>);
  expect(refused).toContain('Not enough HQ credits left this month. Nothing was reserved.');
  const unknown = renderToStaticMarkup(<HqCreativeView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true, locked: true })}/>);
  expect(unknown).toContain('Try again');
  const hidden = renderToStaticMarkup(<HqCreativeView {...props({ concealed: true })}/>);
  expect(hidden).not.toContain('Founder poster'); expect(hidden).toContain('Show again');
});

it('has every label in Korean and Spanish, links from Marketing & Creative, and is a known route', () => {
  for (const language of ['ko', 'es']) expect(creativeText(language, 'budgetSeparate')).not.toBe(creativeText('en', 'budgetSeparate'));
  expect(readFileSync('src/components/hq-marketing/view.tsx', 'utf8')).toContain('href="/hq/marketing/creative"');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/hq/marketing/creative')).toHaveLength(1);
});
