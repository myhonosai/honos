import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSchoolPlanPromotions, offerHintFrom, promotionOfferHref, recordSchoolPlanPromotionEvent } from '../src/components/school-plan-promotions/http';
import { PlanPromotionCards } from '../src/components/school-plan-promotions/banner';
import { schoolPromotionText } from '../src/components/school-plan-promotions/copy';
import { honOsOneTimeRows, honOsPriceRows } from '../src/components/school-subscription/catalog';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-13T00:00:00.000Z';
const offer = { offerId: id(20), offerCode: 'HON_OS_FOUNDER_LIFETIME', offerKind: 'FOUNDER_LIFETIME', billingInterval: 'ONE_TIME', displayName: 'Founder lifetime',
  priceMinor: 357600, currency: 'USD' };
const promo = (patch: Record<string, unknown> = {}) => ({ promotionId: id(1), headline: 'Own HON OS for life', body: 'Founder lifetime is open for a short time.',
  buttonLabel: 'See the offer', offer, endsAt: '2027-01-01T00:00:00.000Z', dismissed: false, ...patch });
const view = (patch: Record<string, unknown> = {}) => ({ schoolId: id(5), promotions: [promo()], asOf: T, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('reads only this school, as a plain same-origin GET, and never shows an answer for another school', async () => {
  const f = stub(json({ data: view() }));
  const v = await loadSchoolPlanPromotions(id(5));
  expect(v.promotions).toHaveLength(1);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/schools/${id(5)}/plan-promotions`);
  expect(init).toMatchObject({ method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  for (const [answer, kind] of [[json({ data: view({ schoolId: id(6) }) }), 'INVALID'], [json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'],
    [json({}, 503), 'UNAVAILABLE'], [json({ data: view({ promotions: [{ ...promo(), audience: 'ALL_SCHOOLS' }] }) }), 'INVALID'],
    [new Response(JSON.stringify({ data: view() }), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'INVALID']] as const) {
    stub(answer);
    await expect(loadSchoolPlanPromotions(id(5))).rejects.toMatchObject({ kind });
  }
  const none = stub();
  await expect(loadSchoolPlanPromotions('../x')).rejects.toMatchObject({ kind: 'INVALID' });
  expect(none).not.toHaveBeenCalled();
});

it('records seen, opened and dismissed with the human-command marker and only the kind, and checks the receipt', async () => {
  const f = stub(json({ data: { promotionId: id(1), kind: 'OPENED', recorded: true } }));
  await recordSchoolPlanPromotionEvent(id(5), id(1), 'OPENED');
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/schools/${id(5)}/plan-promotions/${id(1)}/events`);
  expect(init).toMatchObject({ method: 'POST', keepalive: true, mode: 'same-origin', credentials: 'same-origin' });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'school-plan-promotion-event', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual({ kind: 'OPENED' });
  stub(json({ data: { promotionId: id(1), kind: 'SEEN', recorded: true } }));
  await expect(recordSchoolPlanPromotionEvent(id(5), id(1), 'DISMISSED')).rejects.toMatchObject({ kind: 'INVALID' });
});

it('links to the subscription page with the offer only as a hint, and accepts only a well-formed hint', () => {
  expect(promotionOfferHref(id(20).toUpperCase())).toBe(`/staff/subscription?offer=${id(20)}#hon-os-prices-title`);
  expect(offerHintFrom(`?offer=${id(20)}`)).toBe(id(20));
  for (const bad of ['', '?offer=', '?offer=checkout', `?offer=${id(20)}x`]) expect(offerHintFrom(bad)).toBeNull();
});

it('shows undismissed promotions with the server offer, an open link and Not now; dismissed ones and an empty list show nothing', () => {
  const html = renderToStaticMarkup(<PlanPromotionCards language="en" formattingLocale="en-US" promotions={[promo(), promo({ promotionId: id(2), dismissed: true, headline: 'Hidden one' })] as never}
    onOpen={() => {}} onDismiss={() => {}}/>);
  expect(html).toContain('Offers from HON'); expect(html).toContain('Own HON OS for life');
  expect(html).toContain('Founder lifetime · $3,576 one time · Until Dec 31, 2026');
  expect(html).toContain(`href="/staff/subscription?offer=${id(20)}#hon-os-prices-title"`);
  expect(html).toContain('Not now'); expect(html).not.toContain('Hidden one');
  expect(html).toContain('Nothing is bought or changed');
  expect(renderToStaticMarkup(<PlanPromotionCards language="en" formattingLocale="en-US" promotions={[promo({ dismissed: true })] as never} onOpen={() => {}} onDismiss={() => {}}/>)).toBe('');
  for (const lang of ['ko', 'es']) expect(schoolPromotionText(lang, 'region')).not.toBe(schoolPromotionText('en', 'region'));
});

it('marks a price card as the promoted offer only when the server says the school may buy it now', () => {
  const base = { offerSetVersion: 3, offers: [{ offerId: id(30), offerKind: 'REGULAR_ANNUAL', priceMinor: 249000, eligibility: 'ELIGIBLE' },
    { offerId: id(31), offerKind: 'FOUNDER_MONTHLY', priceMinor: 14900, eligibility: 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION' },
    { offerId: id(20), offerKind: 'FOUNDER_LIFETIME', billingInterval: 'ONE_TIME', offerCode: 'HON_OS_FOUNDER_LIFETIME', displayName: 'Founder lifetime', founder: true,
      priceMinor: 357600, refundWindowDays: 30, eligibility: 'SOLD_OUT' }] };
  const rows = honOsPriceRows(base as never, null);
  expect(rows.find(r => r.kind === 'REGULAR_ANNUAL')).toMatchObject({ offerId: id(30), eligible: true });
  expect(rows.find(r => r.kind === 'FOUNDER_MONTHLY')).toMatchObject({ offerId: id(31), eligible: false });
  expect(rows.find(r => r.kind === 'REGULAR_MONTHLY')).toMatchObject({ offerId: null, eligible: false });
  expect(honOsOneTimeRows(base as never)[0]).toMatchObject({ offerId: id(20), available: false });
  const source = readFileSync('src/components/school-subscription/hon-os-prices.tsx', 'utf8');
  expect(source).toContain('highlighted={!!hint && row.eligible && row.offerId === hint}');
  expect(source).toContain('highlighted={!!hint && row.available && row.offerId === hint}');
  for (const file of ['banner.tsx', 'http.ts']) expect(readFileSync(`src/components/school-plan-promotions/${file}`, 'utf8')).not.toMatch(/localStorage|sessionStorage|startSchoolCheckout|checkout\//);
});
