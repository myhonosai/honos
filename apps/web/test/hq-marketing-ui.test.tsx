import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqMarketingCampaignList } from '@hon/contracts';
import { MarketingError, marketingApi, marketingCampaignId, marketingCommandError } from '../src/components/hq-marketing/http';
import { budgetMinorFrom, budgetTextFrom, createInputFrom, draftFrom, marketingOutcomeFor, updateInputFrom } from '../src/components/hq-marketing/model';
import { HqMarketingView, type MarketingViewProps } from '../src/components/hq-marketing/view';
import { marketingText } from '../src/components/hq-marketing/copy';
import { HQ_NAV, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = { principalId: id(50), displayName: 'Synthetic Marketer' };
const plan = { name: 'Spring founder push', goal: 'Book owner demos.', audience: 'NEW_SCHOOLS', offerLabel: 'Founder 50', channel: 'GOOGLE_ADS',
  startsOn: '2027-03-01', endsOn: '2027-03-31', plannedBudgetMinor: 250050 };
const camp = (patch: Record<string, unknown> = {}) => ({ campaignId: id(1), code: 'SPRING-GOOGLE', ...plan, status: 'DRAFT', currency: 'USD', createdBy: person,
  createdAt: T, updatedAt: T, version: 1, ...patch });
const summary = { DRAFT: 1, ACTIVE: 0, PAUSED: 0, ARCHIVED: 0, plannedBudgetOpenMinor: 250050 };
const listRaw = (patch: Record<string, unknown> = {}) => ({ campaigns: [camp()], limit: 25, nextCursor: null, summary, viewer: { ...person, canManage: true }, asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('reads the list with only the declared query and a plain same-origin GET; a page that does not fit the filter is never shown', async () => {
  const f = stub(json({ data: listRaw() }));
  await marketingApi.list({ status: 'OPEN', cursor: { createdAt: T, campaignId: id(9) } }, new AbortController().signal, yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/marketing/campaigns?status=OPEN&cursor=${new URLSearchParams({ c: `${T}~${id(9)}` }).toString().slice(2)}&limit=25`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  stub(json({ data: listRaw({ campaigns: [camp({ status: 'ARCHIVED' })], summary: { ...summary, DRAFT: 0, ARCHIVED: 1, plannedBudgetOpenMinor: 0 } }) }));
  await expect(marketingApi.list({ status: 'OPEN', cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  for (const [answer, kind] of [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({}, 503), 'UNKNOWN'], [json({ data: { ...listRaw(), extra: 1 } }), 'UNKNOWN']] as const) {
    stub(answer);
    await expect(marketingApi.list({ status: null, cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind });
  }
});

it('sends commands with the human-command marker and key, and refuses an answer that does not match the request', async () => {
  const key = id(77);
  const f = stub(json({ data: { operation: 'CREATE', campaign: camp(), replayed: false } }));
  const input = { code: 'SPRING-GOOGLE', ...plan } as const;
  await marketingApi.create(input as never, key, new AbortController().signal, yes);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/marketing/campaigns');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-marketing-campaign-create', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual(input);
  stub(json({ data: { operation: 'CREATE', campaign: camp({ plannedBudgetMinor: 1 }), replayed: false } }));
  await expect(marketingApi.create(input as never, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const s = stub(json({ data: { operation: 'STATUS', campaign: camp({ status: 'ACTIVE', version: 2 }), replayed: false } }));
  await marketingApi.status(id(1), { expectedVersion: 1, status: 'ACTIVE' }, key, new AbortController().signal, yes);
  expect(call(s)[0]).toBe(`/api/v1/hq/marketing/campaigns/${id(1)}/status`);
  stub(json({ data: { operation: 'STATUS', campaign: camp({ status: 'PAUSED', version: 2 }), replayed: false } }));
  await expect(marketingApi.status(id(1), { expectedVersion: 1, status: 'ACTIVE' }, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const u = stub();
  await expect(marketingApi.update('../x', { expectedVersion: 1, ...plan } as never, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(u).not.toHaveBeenCalled();
  expect(marketingCampaignId('nope')).toBeNull();
});

it('maps only definitive refusals; anything else is unknown and kept for an identical retry', () => {
  expect(marketingCommandError(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(marketingCommandError(422, 'HQ_CAMPAIGN_ARCHIVED').kind).toBe('CHANGED');
  expect(marketingCommandError(422, 'HQ_CAMPAIGN_CODE_TAKEN').kind).toBe('REFUSED');
  expect(marketingCommandError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  expect(marketingCommandError(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(marketingCommandError(503, null).kind).toBe('UNKNOWN');
  expect(marketingOutcomeFor(new MarketingError('UNKNOWN')).keep).toBe(true);
  expect(marketingOutcomeFor(new MarketingError('REFUSED', 'HQ_CAMPAIGN_NO_CHANGE'))).toEqual({ outcome: { kind: 'REFUSED', code: 'HQ_CAMPAIGN_NO_CHANGE' }, keep: false });
});

it('turns typed dollars into exact cents and the form into closed requests', () => {
  expect([budgetMinorFrom('2500'), budgetMinorFrom('2,500.5'), budgetMinorFrom('0.07'), budgetMinorFrom(' 12.30 ')]).toEqual([250000, 250050, 7, 1230]);
  for (const bad of ['', '-1', '1.234', 'abc', '1e5', '100000001']) expect(budgetMinorFrom(bad)).toBeNull();
  expect([budgetTextFrom(250000), budgetTextFrom(250050), budgetTextFrom(7)]).toEqual(['2500', '2500.50', '0.07']);
  const draft = { ...draftFrom(camp() as never), code: 'spring-google', name: '  Spring founder push ' };
  expect(createInputFrom(draft)).toEqual({ code: 'SPRING-GOOGLE', ...plan });
  expect(updateInputFrom(draft, 3)).toEqual({ expectedVersion: 3, ...plan });
  expect(createInputFrom({ ...draft, endsOn: '2027-02-01' })).toBeNull();
  expect(createInputFrom({ ...draft, budget: '1.234' })).toBeNull();
  expect(createInputFrom({ ...draft, channel: 'TIKTOK' })).toBeNull();
  expect(createInputFrom({ ...draft, goal: 'Book demos.\n  Then follow up.' })?.goal).toBe('Book demos. Then follow up.');
});

const props = (patch: Partial<MarketingViewProps> = {}): MarketingViewProps => {
  const view = validateHqMarketingCampaignList(listRaw());
  return { language: 'en', formattingLocale: 'en-US', concealed: false, state: { state: 'READY', view, campaigns: view.campaigns, loadingMore: false, moreFailed: false },
    filter: 'OPEN', form: null, outcome: null, locked: false, canRetry: false, onFilter: () => {}, onMore: () => {}, onRefresh: () => {}, onReveal: () => {},
    onForm: () => {}, onCreate: () => {}, onUpdate: () => {}, onStatus: () => {}, onTryAgain: () => {}, ...patch };
};

it('shows ad accounts as not connected, planned budget as planned only, and status moves from the allowed table', () => {
  const html = renderToStaticMarkup(<HqMarketingView {...props()}/>);
  expect(html).toContain('data-ad-account="GOOGLE_ADS"'); expect(html).toContain('data-ad-account="META_ADS"');
  expect(html.match(/Not connected/g)).toHaveLength(2);
  expect(html).toContain('Planned, not spent'); expect(html).toContain('$2,500.50');
  expect(html).toContain('data-marketing-status="ACTIVE"'); expect(html).toContain('data-marketing-status="ARCHIVED"');
  expect(html).not.toContain('data-marketing-status="PAUSED"');
  expect(html).toContain('New campaign');
});

it('hides every change for a read-only viewer and for archived campaigns', () => {
  const view = validateHqMarketingCampaignList(listRaw({ viewer: { ...person, canManage: false } }));
  const ro = renderToStaticMarkup(<HqMarketingView {...props({ state: { state: 'READY', view, campaigns: view.campaigns, loadingMore: false, moreFailed: false } })}/>);
  expect(ro).toContain('You can read HQ campaigns but not change them.');
  expect(ro).not.toContain('New campaign'); expect(ro).not.toContain('data-marketing-status'); expect(ro).not.toContain('Edit plan');
  const archived = validateHqMarketingCampaignList(listRaw({ campaigns: [camp({ status: 'ARCHIVED' })], summary: { ...summary, DRAFT: 0, ARCHIVED: 1, plannedBudgetOpenMinor: 0 } }));
  const ar = renderToStaticMarkup(<HqMarketingView {...props({ filter: null, state: { state: 'READY', view: archived, campaigns: archived.campaigns, loadingMore: false, moreFailed: false } })}/>);
  expect(ar).toContain('Archived campaigns cannot change.'); expect(ar).not.toContain('data-marketing-status');
});

it('shows nothing while concealed, loading or denied', () => {
  for (const [p, text] of [[{ concealed: true }, 'hidden while this tab'], [{ state: { state: 'LOADING' } }, 'Reading HQ campaigns'],
    [{ state: { state: 'DENIED' } }, 'does not include marketing']] as const) {
    const html = renderToStaticMarkup(<HqMarketingView {...props(p as Partial<MarketingViewProps>)}/>);
    expect(html).toContain(text); expect(html).not.toContain('SPRING-GOOGLE'); expect(html).not.toContain('data-ad-account');
  }
});

it('is reachable from HQ navigation with three languages', () => {
  expect(HQ_NAV.map(i => i.path)).toContain('/hq/marketing');
  expect(hqPageLabel('/hq/marketing')).toBe('Marketing & Creative');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/hq/marketing')).toHaveLength(1);
  for (const lang of ['ko', 'es']) expect(marketingText(lang, 'title')).not.toBe(marketingText('en', 'title'));
  const source = readFileSync('src/components/hq-marketing/view.tsx', 'utf8');
  expect(source).not.toMatch(/fetch\(|googleapis|graph\.facebook/);
});
