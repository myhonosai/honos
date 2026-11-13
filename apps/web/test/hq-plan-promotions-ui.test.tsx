import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqPlanPromotionList } from '@hon/contracts';
import { promotionCommandError, promotionId, promotionsApi } from '../src/components/hq-plan-promotions/http';
import { createInputFrom, draftFrom, schoolIdsFrom, updateInputFrom, windowFrom } from '../src/components/hq-plan-promotions/model';
import { HqPlanPromotionsView, type PromotionViewProps } from '../src/components/hq-plan-promotions/view';
import { promotionText } from '../src/components/hq-plan-promotions/copy';
import { hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const person = { principalId: id(50), displayName: 'Synthetic Owner' };
const offer = { offerId: id(20), offerCode: 'HON_OS_FOUNDER_LIFETIME', offerKind: 'FOUNDER_LIFETIME', billingInterval: 'ONE_TIME', displayName: 'Founder lifetime',
  priceMinor: 357600, currency: 'USD', offerSetVersion: 3, onSale: true };
const annual = { ...offer, offerId: id(21), offerCode: 'HON_OS_ANNUAL', offerKind: 'STANDARD', billingInterval: 'ANNUAL', displayName: 'HON OS annual', priceMinor: 249000 };
const content = { headline: 'Own HON OS for life', body: 'Founder lifetime is open for a short time.', buttonLabel: 'See the offer', audience: 'MONTHLY_PLAN',
  schoolIds: [] as string[], startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', marketingCampaignId: null };
const reach = { seenSchools: 4, openedSchools: 2, dismissedSchools: 1, purchaseStartedSchools: 1, countsAre: 'RECORDED_EVENTS_NOT_ESTIMATES' };
const promo = (patch: Record<string, unknown> = {}) => ({ promotionId: id(1), code: 'FOUNDER-LIFETIME', ...content, offer, status: 'DRAFT', live: false,
  approvedDigest: null, firstStartedAt: null, createdBy: person, createdAt: T, updatedAt: T, version: 1, ...patch });
const item = (patch: Record<string, unknown> = {}) => ({ ...promo(patch), reach });
const listRaw = (patch: Record<string, unknown> = {}) => ({ promotions: [item()], limit: 25, nextCursor: null, offers: [offer, annual],
  viewer: { ...person, canManage: true }, messaging: 'IN_APP_ONLY', asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;

it('reads the list with only the declared query and a plain same-origin GET; a page that does not fit the filter is never shown', async () => {
  const f = stub(json({ data: listRaw() }));
  await promotionsApi.list({ status: 'OPEN', cursor: { createdAt: T, promotionId: id(9) } }, signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/plan-promotions?status=OPEN&cursor=${new URLSearchParams({ c: `${T}~${id(9)}` }).toString().slice(2)}&limit=25`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  stub(json({ data: listRaw({ promotions: [item({ status: 'ENDED', approvedDigest: DIGEST, firstStartedAt: T })] }) }));
  await expect(promotionsApi.list({ status: 'OPEN', cursor: null }, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  for (const [answer, kind] of [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({}, 503), 'UNKNOWN'],
    [json({ data: { ...listRaw(), messaging: 'EMAIL' } }), 'UNKNOWN'], [json({ data: { ...listRaw(), extra: 1 } }), 'UNKNOWN']] as const) {
    stub(answer);
    await expect(promotionsApi.list({ status: null, cursor: null }, signal(), yes)).rejects.toMatchObject({ kind });
  }
});

it('starts a draft only with the preview digest, sends the human-command marker and key, and refuses answers that do not match', async () => {
  const key = id(77);
  const started = promo({ status: 'ACTIVE', live: true, approvedDigest: DIGEST, firstStartedAt: T2, updatedAt: T2, version: 2 });
  const f = stub(json({ data: { operation: 'STATUS', promotion: started, replayed: false } }));
  await promotionsApi.status(id(1), { expectedVersion: 1, status: 'ACTIVE', previewDigest: DIGEST }, key, signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/plan-promotions/${id(1)}/status`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-plan-promotion-status', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 1, status: 'ACTIVE', previewDigest: DIGEST });
  // An answer approving different wording than the preview the owner saw is not accepted as done.
  stub(json({ data: { operation: 'STATUS', promotion: { ...started, approvedDigest: 'b'.repeat(64) }, replayed: false } }));
  await expect(promotionsApi.status(id(1), { expectedVersion: 1, status: 'ACTIVE', previewDigest: DIGEST }, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const none = stub();
  await expect(promotionsApi.status(id(1), { expectedVersion: 1, status: 'PAUSED', previewDigest: DIGEST } as never, key, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(promotionsApi.update('../x', { expectedVersion: 1, ...content, offerId: offer.offerId } as never, key, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(none).not.toHaveBeenCalled();
  const c = stub(json({ data: { operation: 'CREATE', promotion: promo(), replayed: false } }));
  const input = { code: 'FOUNDER-LIFETIME', ...content, offerId: offer.offerId } as const;
  await promotionsApi.create(input as never, key, signal(), yes);
  expect(call(c)[0]).toBe('/api/v1/hq/plan-promotions');
  expect(call(c)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'hq-plan-promotion-create' });
  stub(json({ data: { operation: 'CREATE', promotion: promo({ headline: 'Something else' }), replayed: false } }));
  await expect(promotionsApi.create(input as never, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  expect(promotionId('nope')).toBeNull();
});

it('maps only definitive refusals; anything else is unknown', () => {
  expect(promotionCommandError(409, 'HQ_PLAN_PROMOTION_PREVIEW_STALE').kind).toBe('CHANGED');
  expect(promotionCommandError(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(promotionCommandError(422, 'HQ_PLAN_PROMOTION_NOT_DRAFT').kind).toBe('CHANGED');
  expect(promotionCommandError(422, 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE').kind).toBe('REFUSED');
  expect(promotionCommandError(422, 'HQ_PLAN_PROMOTION_CODE_TAKEN').kind).toBe('REFUSED');
  expect(promotionCommandError(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(promotionCommandError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  expect(promotionCommandError(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(promotionCommandError(503, null).kind).toBe('UNKNOWN');
});

it('turns UTC calendar days into the promotion window and the form into closed requests', () => {
  expect(windowFrom('2026-12-01', '2026-12-31')).toEqual({ startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' });
  expect(windowFrom('2026-12-01', '2026-12-01')).toEqual({ startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-02T00:00:00.000Z' });
  expect(windowFrom('2026-12-01', '2027-02-28')).not.toBeNull();
  for (const [a, b] of [['2026-12-01', '2027-03-01'], ['2026-12-02', '2026-12-01'], ['2026-02-30', '2026-03-01'], ['', '2026-03-01']]) expect(windowFrom(a!, b!)).toBeNull();
  expect(schoolIdsFrom(` ${id(3).toUpperCase()}\n${id(4)}, ${id(5)} `)).toEqual([id(3), id(4), id(5)]);
  const draft = { ...draftFrom(promo() as never), code: 'founder-lifetime', headline: '  Own HON OS for life ' };
  expect(draft.firstDay).toBe('2026-12-01'); expect(draft.lastDay).toBe('2026-12-31');
  expect(createInputFrom(draft)).toEqual({ code: 'FOUNDER-LIFETIME', ...content, offerId: offer.offerId });
  expect(updateInputFrom(draft, 3)).toEqual({ expectedVersion: 3, ...content, offerId: offer.offerId });
  // School ids are only sent for "Schools I pick", and that audience needs at least one.
  expect(createInputFrom({ ...draft, schoolIds: id(3) })?.schoolIds).toEqual([]);
  expect(createInputFrom({ ...draft, audience: 'SELECTED_SCHOOLS', schoolIds: id(3) })?.schoolIds).toEqual([id(3)]);
  expect(createInputFrom({ ...draft, audience: 'SELECTED_SCHOOLS', schoolIds: '' })).toBeNull();
  expect(createInputFrom({ ...draft, audience: 'EVERYONE' })).toBeNull();
  expect(createInputFrom({ ...draft, buttonLabel: 'x' })).toBeNull();
  expect(createInputFrom({ ...draft, body: 'Line one.\n  Line two.' })?.body).toBe('Line one. Line two.');
});

const ready = (raw: Record<string, unknown>) => { const view = validateHqPlanPromotionList(raw);
  return { state: 'READY' as const, view, promotions: view.promotions, loadingMore: false, moreFailed: false }; };
const props = (patch: Partial<PromotionViewProps> = {}): PromotionViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: ready(listRaw()), filter: 'OPEN', form: null, preview: null, outcome: null, locked: false, canRetry: false, onFilter: () => {}, onMore: () => {},
  onRefresh: () => {}, onReveal: () => {}, onForm: () => {}, onCreate: () => {}, onUpdate: () => {}, onPreview: () => {}, onStart: () => {},
  onStatus: () => {}, onTryAgain: () => {}, ...patch });

it('offers a draft only Preview and start (never a bare start), and shows the server preview before Start', () => {
  const html = renderToStaticMarkup(<HqPlanPromotionsView {...props()}/>);
  expect(html).toContain('data-promotion-preview-open=""'); expect(html).toContain('data-promotion-status="ENDED"');
  expect(html).not.toContain('data-promotion-status="ACTIVE"'); expect(html).not.toContain('data-promotion-start');
  expect(html).toContain('Founder lifetime · $3,576 one time'); expect(html).toContain('Schools on a monthly plan');
  expect(html).toContain('In the app only. No email or text is sent.');
  expect(html).not.toContain('Schools that saw it'); // a draft has never been shown
  const withPreview = renderToStaticMarkup(<HqPlanPromotionsView {...props({ preview: { promotionId: id(1), state: 'READY', version: 1,
    preview: { digest: DIGEST, offerOnSale: false, audienceSchools: 12, eligibleSchools: 7, asOf: T2 } } })}/>);
  expect(withPreview).toContain('data-promotion-start=""'); expect(withPreview).toMatch(/Schools in the audience now<\/dt><dd>12/);
  expect(withPreview).toMatch(/can buy this offer now<\/dt><dd>7/); expect(withPreview).toContain('not on sale right now');
  const failed = renderToStaticMarkup(<HqPlanPromotionsView {...props({ preview: { promotionId: id(1), state: 'FAILED' } })}/>);
  expect(failed).toContain('Nothing was started.'); expect(failed).not.toContain('data-promotion-start');
});

it('shows recorded reach for running promotions, pause and end moves, and nothing changeable once ended', () => {
  const running = item({ status: 'ACTIVE', live: true, approvedDigest: DIGEST, firstStartedAt: T2, updatedAt: T2, version: 2 });
  const html = renderToStaticMarkup(<HqPlanPromotionsView {...props({ state: ready(listRaw({ promotions: [running] })) })}/>);
  expect(html).toContain('data-promotion-live="true"'); expect(html).toMatch(/Schools that saw it<\/dt><dd>4/);
  expect(html).toContain('Counts of recorded school actions, not estimates.');
  expect(html).toContain('data-promotion-status="PAUSED"'); expect(html).toContain('data-promotion-status="ENDED"');
  expect(html).not.toContain('Edit draft'); expect(html).not.toContain('data-promotion-preview-open');
  const ended = item({ status: 'ENDED', approvedDigest: DIGEST, firstStartedAt: T2, updatedAt: T2, version: 3 });
  const done = renderToStaticMarkup(<HqPlanPromotionsView {...props({ filter: null, state: ready(listRaw({ promotions: [ended] })) })}/>);
  expect(done).toContain('Ended promotions cannot change.'); expect(done).not.toContain('data-promotion-status');
});

it('hides every change for a read-only viewer and asks for a published offer before a new promotion', () => {
  const ro = renderToStaticMarkup(<HqPlanPromotionsView {...props({ state: ready(listRaw({ viewer: { ...person, canManage: false } })) })}/>);
  expect(ro).toContain('Only the HQ owner can create or change promotions.');
  expect(ro).not.toContain('New promotion'); expect(ro).not.toContain('data-promotion-status'); expect(ro).not.toContain('data-promotion-preview-open');
  const empty = renderToStaticMarkup(<HqPlanPromotionsView {...props({ state: ready(listRaw({ offers: [] })) })}/>);
  expect(empty).toContain('data-promotion-no-offers'); expect(empty).not.toContain('New promotion');
  const form = renderToStaticMarkup(<HqPlanPromotionsView {...props({ form: { mode: 'CREATE' } })}/>);
  expect(form).toContain('data-promotion-form="create"'); expect(form).toContain('HON OS annual · $2,490 per year');
});

it('shows nothing while concealed, loading or denied', () => {
  for (const [p, text] of [[{ concealed: true }, 'hidden while this tab'], [{ state: { state: 'LOADING' } }, 'Reading plan promotions'],
    [{ state: { state: 'DENIED' } }, 'does not include marketing']] as const) {
    const html = renderToStaticMarkup(<HqPlanPromotionsView {...props(p as Partial<PromotionViewProps>)}/>);
    expect(html).toContain(text); expect(html).not.toContain('FOUNDER-LIFETIME'); expect(html).not.toContain('Own HON OS for life');
  }
});

it('is linked from Marketing & Creative, listed once in the route manifest, in three languages, and sends nothing outside the app', () => {
  expect(readFileSync('src/components/hq-marketing/view.tsx', 'utf8')).toContain('href="/hq/marketing/promotions"');
  expect(hqPageLabel('/hq/marketing/promotions')).toBe('Plan promotions');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/hq/marketing/promotions')).toHaveLength(1);
  for (const lang of ['ko', 'es']) expect(promotionText(lang, 'title')).not.toBe(promotionText('en', 'title'));
  for (const file of ['view.tsx', 'hq-plan-promotions.tsx', 'http.ts', 'model.ts']) {
    const source = readFileSync(`src/components/hq-plan-promotions/${file}`, 'utf8');
    expect(source).not.toMatch(/fetch\(|localStorage|sessionStorage|checkout|mailto:|sms:/i);
  }
});
