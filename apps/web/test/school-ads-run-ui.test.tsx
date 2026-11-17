import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SocialAd, SocialAdsView, SocialPostList } from '@hon/contracts';
import { AdsError, adsApi, adsErrorFor, keepAdsForRetry, toCents } from '../src/components/school-ads/http';
import { MetaAds, boostableFrom, type MetaAdsProps } from '../src/components/school-ads/meta-ads';
import { AdsView } from '../src/components/school-ads/view';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const at = '2026-11-17T05:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const ad = (over: Partial<SocialAd> = {}): SocialAd => ({ adId: id(60), accountId: id(40), targetId: id(50), postId: id(51), accountName: 'Synthetic Dojo Page', budgetCents: 5000,
  currency: 'USD', startsOn: '2026-11-17', endsOn: '2026-11-23', status: 'DRAFT', operation: null, resolvedByPerson: false, createdAt: at, version: 1, ...over });
const view = (over: Partial<SocialAdsView> = {}): SocialAdsView => ({ budget: { monthlyCapCents: 30000, currency: 'USD', version: 1 }, committedThisMonthCents: 5000,
  ads: [ad()], today: '2026-11-17', checkedAt: at, adsEnabled: true, ...over });
const props = (over: Partial<MetaAdsProps> = {}): MetaAdsProps => ({ language: 'en', locale: 'en-US',
  ads: { state: 'READY', view: view(), boostable: [{ targetId: id(50), pageName: 'Synthetic Dojo Page', excerpt: 'Free trial week' }] },
  budgetForm: { amount: '300.00', currency: 'USD' }, draftForm: { targetId: '', amount: '', startsOn: '2026-11-17', endsOn: '2026-11-17' },
  confirming: null, outcome: null, locked: false, canRetry: false, ...over });
const render = (over: Partial<MetaAdsProps> = {}) => renderToStaticMarkup(<MetaAds {...props(over)} />);

it('reads ads and posts with plain GETs and sends each write with its own command and key', async () => {
  const f = stub(json({ data: view(), meta }));
  expect((await adsApi.read(scope, signal(), () => true)).budget?.monthlyCapCents).toBe(30000);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/ads`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const p = stub(json({ data: { posts: [], publishEnabled: false, checkedAt: at }, meta }));
  await adsApi.posts(scope, new Date(at), signal(), () => true);
  const url = new URL((p.mock.calls[0] as unknown as [string])[0], 'https://x');
  expect(url.pathname).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/posts`);
  expect([...url.searchParams.keys()].sort()).toEqual(['from', 'to']);
  const cases: [() => Promise<unknown>, string, string, unknown, unknown][] = [
    [() => adsApi.budget(scope, { monthlyCapCents: 30000, currency: 'USD', expectedVersion: 1 }, key, signal(), () => true), 'ads/budget', 'marketing.social.ads.budget', { monthlyCapCents: 30000, currency: 'USD', expectedVersion: 1 }, view()],
    [() => adsApi.draft(scope, { targetId: id(50), budgetCents: 5000, startsOn: '2026-11-17', endsOn: '2026-11-23' }, key, signal(), () => true), 'ads', 'marketing.social.ads.create', { targetId: id(50), budgetCents: 5000, startsOn: '2026-11-17', endsOn: '2026-11-23' }, ad()],
    [() => adsApi.operation(scope, id(60), { operation: 'ACTIVATE', expectedVersion: 3 }, key, signal(), () => true), `ads/${id(60)}/operation`, 'marketing.social.ads.operation', { operation: 'ACTIVATE', expectedVersion: 3 }, ad({ status: 'ACTIVE', operation: 'ACTIVATE', version: 4 })],
    [() => adsApi.cancel(scope, id(60), 1, key, signal(), () => true), `ads/${id(60)}/cancel`, 'marketing.social.ads.cancel', { expectedVersion: 1 }, ad({ status: 'CANCELLED', version: 2 })],
    [() => adsApi.resolve(scope, id(60), { state: 'PAUSED', expectedVersion: 5 }, key, signal(), () => true), `ads/${id(60)}/resolve`, 'marketing.social.ads.resolve', { state: 'PAUSED', expectedVersion: 5 }, ad({ status: 'PAUSED', operation: 'PAUSE', version: 6 })],
  ];
  for (const [call, suffix, command, body, answer] of cases) {
    const g = stub(json({ data: answer, meta }));
    await call();
    const [gp, gi] = g.mock.calls[0] as unknown as [string, RequestInit];
    expect(gp).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/${suffix}`);
    expect(gi.headers).toMatchObject({ 'X-HON-Human-Command': command, 'Idempotency-Key': key });
    expect(JSON.parse(gi.body as string)).toEqual(body);
  }
});

it('refuses an answer about another ad, maps refusals to closed kinds and keeps only unknown outcomes', async () => {
  stub(json({ data: ad({ adId: id(61), status: 'ACTIVE', operation: 'ACTIVATE' }), meta }));
  const e = await adsApi.operation(scope, id(60), { operation: 'ACTIVATE', expectedVersion: 1 }, key, signal(), () => true).catch((x: unknown) => x);
  expect((e as AdsError).kind).toBe('UNKNOWN');
  expect(adsErrorFor(409, 'SOCIAL_AD_OVER_CAP').kind).toBe('OVER_CAP');
  expect(adsErrorFor(409, 'SOCIAL_ADS_OFF').kind).toBe('ADS_OFF');
  expect(adsErrorFor(409, 'SOCIAL_AD_NO_BUDGET').kind).toBe('NO_BUDGET');
  expect(adsErrorFor(409, 'SOCIAL_VERSION_CONFLICT').kind).toBe('STALE');
  expect(adsErrorFor(503, 'SOCIAL_ADS_NOT_ENABLED').kind).toBe('NOT_ENABLED');
  expect(adsErrorFor(503, 'OTHER').kind).toBe('UNKNOWN');
  expect(adsErrorFor(409, 'SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(adsErrorFor(403, null).kind).toBe('DENIED');
  expect(keepAdsForRetry(new AdsError('UNKNOWN'))).toBe(true);
  expect(keepAdsForRetry(new AdsError('OVER_CAP'))).toBe(false);
  await expect(adsApi.operation(scope, 'not-an-id', { operation: 'PAUSE', expectedVersion: 1 }, key, signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('reads money exactly', () => {
  expect(toCents('25')).toBe(2500);
  expect(toCents('25.5')).toBe(2550);
  expect(toCents(' 300.05 ')).toBe(30005);
  for (const bad of ['', '-1', '1.234', 'abc', '1,000', '1e3']) expect(toCents(bad), bad).toBeNull();
});

it('only offers Facebook posts HON actually published', () => {
  const t = (n: number, platform: 'FACEBOOK' | 'INSTAGRAM', status: 'PUBLISHED' | 'FAILED') => ({ targetId: id(n), accountId: id(40), platform, displayName: 'Page', status,
    failureCode: null, skipReason: null, resolvedByPerson: false, settledAt: null, version: 1 });
  const list = { publishEnabled: true, checkedAt: at, posts: [{ postId: id(51), text: 'Free trial week', linkUrl: null, status: 'APPROVED', publishAt: null, accountIds: [id(40)], version: 2,
    createdAt: at, updatedAt: at, approvedAt: at, cancelledAt: null, targets: [t(50, 'FACEBOOK', 'PUBLISHED'), t(52, 'INSTAGRAM', 'PUBLISHED'), t(53, 'FACEBOOK', 'FAILED')] }] } as unknown as SocialPostList;
  expect(boostableFrom(list).map(b => b.targetId)).toEqual([id(50)]);
});

it('shows the monthly limit, a draft with approve and cancel, and no spend button on a draft', () => {
  const html = render();
  expect(html).toContain('$300.00');
  expect(html).toContain('$50.00');
  expect(html).toContain('data-ads-op="CREATE"');
  expect(html).toContain('data-ads-cancel');
  expect(html).not.toContain('data-ads-op="ACTIVATE"');
  expect(html).toContain('Free trial week');
});

it('turning on asks first, and only the confirm step sends ACTIVATE', () => {
  let html = render({ ads: { state: 'READY', view: view({ ads: [ad({ status: 'PAUSED', operation: 'CREATE', version: 3 })] }), boostable: [] } });
  expect(html).toContain('data-ads-op="ACTIVATE-ASK"');
  expect(html).not.toContain('data-ads-op="ACTIVATE"');
  html = render({ confirming: id(60), ads: { state: 'READY', view: view({ ads: [ad({ status: 'PAUSED', operation: 'CREATE', version: 3 })] }), boostable: [] } });
  expect(html).toContain('Meta starts spending');
  expect(html).toContain('data-ads-op="ACTIVATE"');
  html = render({ ads: { state: 'READY', view: view({ ads: [ad({ status: 'ACTIVE', operation: 'ACTIVATE', version: 5 })] }), boostable: [] } });
  expect(html).toContain('data-ads-op="PAUSE"');
});

it('an unknown create can only be settled as not created; an unknown turn-on can be paused or settled', () => {
  let html = render({ ads: { state: 'READY', view: view({ ads: [ad({ status: 'UNKNOWN', operation: 'CREATE', version: 2 })] }), boostable: [] } });
  expect(html).toContain('data-ads-resolve="NOT_CREATED"');
  expect(html).not.toContain('data-ads-resolve="ACTIVE"');
  expect(html).not.toContain('data-ads-op="PAUSE"');
  html = render({ ads: { state: 'READY', view: view({ ads: [ad({ status: 'UNKNOWN', operation: 'ACTIVATE', version: 4 })] }), boostable: [] } });
  expect(html).toContain('data-ads-resolve="ACTIVE"');
  expect(html).toContain('data-ads-resolve="PAUSED"');
  expect(html).toContain('data-ads-op="PAUSE"');
});

it('while ads are off at HON OS the page says so and every Meta step is disabled', () => {
  const html = render({ ads: { state: 'READY', view: view({ adsEnabled: false }), boostable: [] } });
  expect(html).toContain('data-ads-off');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-ads-op="CREATE"/);
  expect(html).toContain('No published Facebook posts yet');
});

it('hides ads from people without ad permission and offers Try again only for a kept unknown request', () => {
  expect(render({ ads: { state: 'DENIED' } })).toContain('Only people with ad permission');
  expect(render({ ads: { state: 'DENIED' } })).not.toContain('Synthetic Dojo Page');
  const html = render({ outcome: { kind: 'UNKNOWN', action: 'ACTIVATE' }, canRetry: true });
  expect(html).toContain('Try again');
  expect(render({ outcome: { kind: 'OVER_CAP', action: 'CREATE' } })).toContain('monthly ad limit');
  expect(render({ outcome: { kind: 'OVER_CAP', action: 'CREATE' } })).not.toContain('Try again');
});

it('the Ads page shows the Meta controls only once a Facebook Page is connected', () => {
  const base = { language: 'en', waiting: false, concealed: false, hasSchool: true, connecting: false, outcome: null, run: (({ language: _l, locale: _c, ...rest }) => rest)(props()) };
  const page = { accountId: id(40), platform: 'FACEBOOK' as const, displayName: 'Synthetic Dojo Page', status: 'CONNECTED' as const, publishEnabled: true, inboxEnabled: false,
    adsEnabled: true, version: 1, connectedAt: at, updatedAt: at, disconnectedAt: null };
  expect(renderToStaticMarkup(<AdsView {...base} list={{ state: 'READY', list: { profileLinked: true, connectEnabled: true, accounts: [], checkedAt: at } }} />)).not.toContain('data-ads-budget');
  expect(renderToStaticMarkup(<AdsView {...base} list={{ state: 'READY', list: { profileLinked: true, connectEnabled: true, accounts: [page], checkedAt: at } }} />)).toContain('data-ads-budget');
});
