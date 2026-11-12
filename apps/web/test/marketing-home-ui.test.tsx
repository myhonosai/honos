import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CampaignFunnel, CampaignReadSummary } from '@hon/contracts';
import { MARKETING_LANGUAGES, marketingText } from '../src/components/marketing-home/copy';
import { MarketingError, funnelWindow, marketingApi, verifyCampaignList, verifyFunnel } from '../src/components/marketing-home/http';
import { MarketingView, campaignsFor, type MarketingViewProps } from '../src/components/marketing-home/view';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-11-05T12:00:00.000Z';
const SCHOOL = id(2);
const campaign = (n: number, over: Partial<CampaignReadSummary> = {}): CampaignReadSummary => ({ id: id(60 + n), schoolId: SCHOOL, version: 2, code: `SPRING-${n}`, name: `Spring open house ${n}`,
  goal: 'Fill the Saturday kids class', offerLabel: 'Free first week', channel: 'EVENT', status: 'ACTIVE', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-30T00:00:00.000Z',
  plannedBudgetMinor: 25000, currency: 'USD', createdAt: at, updatedAt: at, planningOnly: true, ...over } as CampaignReadSummary);
const NOW = Date.parse('2026-11-08T12:00:30.500Z');
const win = funnelWindow(NOW);
const funnel = (over: Record<string, unknown> = {}): CampaignFunnel => ({ campaign: campaign(1), from: win.from, to: win.to, asOf: at, leads: 9, trialLeads: 4,
  trialAppointments: 5, completedTrialAppointments: 3, wonLeads: 2, lostLeads: 1, archivedLeads: 0, enrollmentLinkage: 'UNAVAILABLE', revenueLinkage: 'UNAVAILABLE', ...over } as CampaignFunnel);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const props = (over: Partial<MarketingViewProps> = {}): MarketingViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true, tab: 'ACTIVE',
  list: { state: 'READY', items: [campaign(1), campaign(2, { status: 'DRAFT', name: 'Winter draft' }), campaign(3, { status: 'ARCHIVED', name: 'Old flyer' })] },
  selectedId: null, funnel: { state: 'NONE' }, ...over });
const render = (over: Partial<MarketingViewProps> = {}) => renderToStaticMarkup(<MarketingView {...props(over)}/>);

it('the funnel window is the last 30 days in whole UTC seconds, ending a minute before now', () => {
  expect(win).toEqual({ from: '2026-10-09T11:59:30.000Z', to: '2026-11-08T11:59:30.000Z' });
});

it('reads campaigns and one funnel at the fixed same-origin paths with no body and no school selector', async () => {
  const f = stub(json({ data: [campaign(1)], meta: { requestId: 'r' } }));
  await expect(marketingApi.campaigns(SCHOOL, signal(), () => true)).resolves.toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/marketing/campaigns');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(init.body).toBeUndefined();
  const g = stub(json({ data: funnel(), meta: {} }));
  await expect(marketingApi.funnel(SCHOOL, id(61).toUpperCase(), signal(), () => true, NOW)).resolves.toMatchObject({ leads: 9 });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/marketing/campaigns/${id(61)}/funnel?${new URLSearchParams(win)}`);
  await expect(marketingApi.funnel(SCHOOL, 'not-a-uuid', signal(), () => true, NOW)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
});

it('drift, duplicates, a mismatched funnel and failures are unavailable or denied, never an empty list or zero counts', async () => {
  expect(() => verifyCampaignList([campaign(1), campaign(1)], SCHOOL)).toThrow();
  expect(() => verifyCampaignList([{ ...campaign(1), planningOnly: false }], SCHOOL)).toThrow();
  expect(() => verifyCampaignList([{ ...campaign(1), extra: 1 }], SCHOOL)).toThrow();
  expect(() => verifyCampaignList([{ ...campaign(1), status: 'LIVE' }], SCHOOL)).toThrow();
  // 0227: every campaign must name the school this page shows.
  expect(verifyCampaignList([campaign(1)], SCHOOL.toUpperCase())).toHaveLength(1);
  expect(() => verifyCampaignList([campaign(1, { schoolId: id(3) })], SCHOOL)).toThrow();
  expect(() => verifyCampaignList([(({ schoolId: _s, ...rest }) => rest)(campaign(1))], SCHOOL)).toThrow();
  expect(() => verifyFunnel(funnel({ campaign: campaign(1, { schoolId: id(3) }) }), SCHOOL, id(61), win.from, win.to)).toThrow();
  for (const over of [{ campaign: campaign(2) }, { from: '2026-10-01T00:00:00.000Z' }, { enrollmentLinkage: 'LINKED' }, { wonLeads: 9, lostLeads: 1 },
    { trialLeads: 10 }, { completedTrialAppointments: 6 }, { leads: -1 }, { revenue: 5 }]) {
    expect(() => verifyFunnel(funnel(over), SCHOOL, id(61), win.from, win.to)).toThrow();
  }
  for (const [response, kind] of [[json({ data: [campaign(1)] }), 'UNAVAILABLE'], [json({}, 500), 'UNAVAILABLE'], [json({ code: 'FORBIDDEN' }, 403), 'DENIED'],
    [new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'UNAVAILABLE']] as const) {
    stub(response);
    await expect(marketingApi.campaigns(SCHOOL, signal(), () => true)).rejects.toMatchObject({ kind });
  }
});

it('a 401 for a retired read never ends the session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(marketingApi.campaigns(SCHOOL, signal(), () => false)).rejects.toBeInstanceOf(MarketingError);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(marketingApi.funnel(SCHOOL, id(61), signal(), () => false, NOW)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(marketingApi.campaigns(SCHOOL, signal(), () => true)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('shows nothing private before the shell verifies the school, while concealed, or with no school', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }]) {
    const html = render({ ...over, selectedId: id(61), funnel: { state: 'READY', campaignId: id(61), funnel: funnel() } });
    expect(html).not.toContain('Spring open house'); expect(html).not.toContain('Fill the Saturday'); expect(html).not.toContain('data-testid="campaign-funnel"');
  }
  expect(render({ concealed: true })).toContain('Campaigns are hidden');
});

it('lists campaigns by status tab; tabs only narrow what was read', () => {
  const html = render();
  expect(html).toContain('Spring open house 1'); expect(html).not.toContain('Winter draft'); expect(html).toContain('1 shown');
  expect(html).toMatch(/aria-pressed="true"[^>]*>Active</);
  expect(campaignsFor([campaign(3, { status: 'ARCHIVED' }), campaign(2, { status: 'DRAFT' }), campaign(1)], 'ALL').map((c) => c.status)).toEqual(['ACTIVE', 'DRAFT', 'ARCHIVED']);
  expect(render({ tab: 'PAUSED' })).toContain('No campaigns with this status');
  expect(render({ list: { state: 'DENIED' } })).toContain('exactly one school');
  expect(render({ list: { state: 'UNAVAILABLE' } })).toContain('Nothing is shown');
  expect(render({ list: { state: 'LOADING' } })).toContain('Reading campaigns');
});

it('a selected campaign shows its plan, a planned (not spent) budget, its own counts and links, with no form', () => {
  const html = render({ selectedId: id(61), funnel: { state: 'READY', campaignId: id(61), funnel: funnel() } });
  expect(html).toContain('Fill the Saturday kids class'); expect(html).toContain('$250.00'); expect(html).toContain('Planned, not spent');
  expect(html).toContain('data-testid="campaign-funnel"'); expect(html).toContain('>9<'); expect(html).toContain('Won is not enrollment or payment');
  for (const href of ['/staff/marketing/campaigns', '/staff/marketing/assistant', '/staff/marketing/forms', '/staff/marketing/intake']) expect(html).toContain(`href="${href}"`);
  expect(html).not.toMatch(/<form|method="post"/i);
  // Counts read for another campaign are never shown under this one.
  expect(render({ selectedId: id(62), tab: 'ALL', funnel: { state: 'READY', campaignId: id(61), funnel: funnel() } })).not.toContain('data-testid="campaign-funnel"');
  expect(render({ selectedId: id(63), tab: 'ALL' })).not.toContain('/staff/marketing/assistant');
  expect(render({ selectedId: id(61), funnel: { state: 'UNAVAILABLE' }, onReloadFunnel: () => {} })).toContain('>Reload</button>');
  expect(render({ selectedId: id(61), funnel: { state: 'DENIED' } })).toContain('does not include these counts');
});

it('has every phrase in Korean and Spanish; the page is first in the shell’s marketing group and in the route manifest', () => {
  for (const language of ['ko', 'es'] as const) expect(Object.keys(MARKETING_LANGUAGES[language]).sort()).toEqual(Object.keys(MARKETING_LANGUAGES.en).sort());
  expect(marketingText('ko', 'title')).toBe('마케팅'); expect(marketingText('es', 'title')).toBe('Marketing');
  const group = SCHOOL_SHELL_NAV.find((g) => g.routes.some((r) => r.href === '/staff/marketing/campaigns'));
  expect(group?.routes[0]?.href).toBe('/staff/marketing');
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8')) as { routes: { path: string; title: string }[] };
  expect(manifest.routes).toContainEqual({ path: '/staff/marketing', title: 'HON | Marketing' });
});
