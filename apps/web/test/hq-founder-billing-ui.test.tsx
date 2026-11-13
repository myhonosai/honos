import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { commandErrorFor, founderBillingApi, FounderBillingError, keepForRetry } from '../src/components/hq-founder-billing/http';
import { FounderBillingScreen, ReviewActions } from '../src/components/hq-founder-billing/hq-founder-billing';
import { HQ_REVENUE } from '../src/components/hq-modern/catalog';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-12T08:00:00.000Z';
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const pool = (allocated = 2) => ({ capacity: 50, allocated, remaining: 50 - allocated, countingRule: 'FIRST_VERIFIED_SCHEDULE_PAYMENT', legacyFounderSalesCounted: false,
  spots: Array.from({ length: allocated }, (_, i) => ({ spotNumber: i + 1, organizationId: U(10 + i), schoolId: U(100 + i), bindingId: U(200 + i), offerId: U(300),
    offerKind: i % 2 ? 'FOUNDER_ANNUAL' : 'FOUNDER_MONTHLY', lockedPriceMinor: i % 2 ? 149400 : 19920, allocatedAt: AT })),
  heldWithoutSpot: allocated === 50 ? 1 : 0, checkoutAvailable: false, asOf: AT });
const item = { subjectKind: 'SCHEDULE_BINDING', subjectId: U(500), subjectVersion: 3, organizationId: U(60), schoolId: U(61), billingStatus: 'NEEDS_REVIEW',
  reason: 'FOUNDER_SPOT_UNAVAILABLE', heldItemCount: 1, heldAmountMinor: 19920, refundedAmountMinor: 0, fullyRefunded: false, receivedAt: AT, blocker: null,
  allowedDecisions: ['REFUND_OWED'], accessRetryAvailable: false, openResolution: null, providerActionExecuted: false };
const queue = (items: unknown[] = []) => ({ items, nextCursor: null, providerActionExecuted: false });
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

it('reads only the founder pool and the paid review queue with GET', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ok(String(path).endsWith('founder-pool') ? pool() : queue()));
  const view = await founderBillingApi.load(signal(), () => true);
  expect(view.pool.allocated).toBe(2);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/v1/hq/saas/founder-pool', '/api/v1/hq/saas/paid-reviews']);
  for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
});

it('refuses drift, a checkout claim and a miscounted pool, and maps denial', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const bad of [{ ...pool(), checkoutAvailable: true }, { ...pool(), remaining: 49 }, { ...pool(), extra: 1 }]) {
    fetch.mockImplementation(async (path) => ok(String(path).endsWith('founder-pool') ? bad : queue()));
    await expect(founderBillingApi.load(signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  fetch.mockImplementation(async () => new Response('{}', { status: 403 }));
  await expect(founderBillingApi.load(signal(), () => true)).rejects.toBeInstanceOf(FounderBillingError);
  await expect(founderBillingApi.load(signal(), () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('shows counted spots, a sold-out pool and a held late payment without any action', () => {
  const html = renderToStaticMarkup(<FounderBillingScreen read={{ state: 'READY', view: { pool: pool(50) as never, reviews: queue([item]) as never } }} onRefresh={() => {}}/>);
  for (const s of ['Founder spots', '50 of 50', 'sold out', 'Spot 1 · Founder monthly · $199.20 / month', 'Spot 2 · Founder annual · $1,494 / year',
    'Paid after all 50 founder spots were taken', 'Held $199.20 in 1 payment', 'Waiting for the HQ owner to record a refund owed', 'never refunded automatically']) expect(html).toContain(s);
  expect(html).not.toMatch(/<form|type="submit"/);
  const empty = renderToStaticMarkup(<FounderBillingScreen read={{ state: 'READY', view: { pool: pool(0) as never, reviews: queue() as never } }} onRefresh={() => {}}/>);
  expect(empty).toContain('No founder spot has been counted yet.'); expect(empty).toContain('No payment is held for review.'); expect(empty).toContain('50 left');
  expect(renderToStaticMarkup(<FounderBillingScreen read={{ state: 'DENIED' }} onRefresh={() => {}}/>)).toContain('HQ owner and billing operators');
});

it('is reachable from HQ Revenue and declared in the route manifest', () => {
  expect(HQ_REVENUE.some((e) => e.path === '/hq/revenue/founder-billing' && e.title === 'Founder Billing')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/hq/revenue/founder-billing')).toHaveLength(1);
});

const resolution = (verified = false) => ({ resolutionId: U(700), subjectKind: 'SCHEDULE_BINDING', subjectId: U(500), organizationId: U(60), decision: 'REFUND_OWED',
  status: verified ? 'REFUND_VERIFIED' : 'AWAITING_REFUND_EVIDENCE', version: verified ? 2 : 1, heldItemCount: 1, heldAmountMinor: 19920,
  reason: 'Late founder payment after spot 50', refundedAmountMinor: verified ? 19920 : null, refundEvidence: verified ? ['evt_refund_1'] : [],
  createdAt: AT, refundVerifiedAt: verified ? AT : null, providerActionExecuted: false });
const awaiting = { ...item, allowedDecisions: [], openResolution: resolution() };

it('records a refund owed as an exact HQ human command and binds the receipt to the item', async () => {
  const key = U(900);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ resolution: resolution(), item: awaiting, replayed: false }));
  await founderBillingApi.recordRefundOwed(item as never, '  Late founder payment after spot 50  ', key, signal(), () => true);
  const [path, init] = fetch.mock.calls[0]!;
  expect(path).toBe('/api/v1/hq/saas/paid-reviews/resolve');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'X-HON-Human-Command': 'saas-paid-review-resolve', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init!.body))).toEqual({ subjectKind: 'SCHEDULE_BINDING', subjectId: U(500), expectedVersion: 3, decision: 'REFUND_OWED',
    reason: 'Late founder payment after spot 50', confirmation: 'RESOLVE_PAID_REVIEW_NO_PROVIDER_ACTION' });
  fetch.mockImplementation(async () => ok({ resolution: { ...resolution(), subjectId: U(501) }, item: awaiting, replayed: false }));
  await expect(founderBillingApi.recordRefundOwed(item as never, 'Late founder payment after spot 50', key, signal(), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  fetch.mockClear();
  await expect(founderBillingApi.recordRefundOwed(item as never, 'too short', key, signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(fetch).not.toHaveBeenCalled();
});

it('verifies only stored refund evidence for an awaiting resolution', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ resolution: resolution(true), billingStatus: 'BOUND_TEST_ONLY', billingReviewOpen: false, replayed: false }));
  await founderBillingApi.verifyRefund(awaiting as never, U(901), signal(), () => true);
  const [path, init] = fetch.mock.calls[0]!;
  expect(path).toBe(`/api/v1/hq/saas/paid-reviews/${U(700)}/verify-refund`);
  expect(init).toMatchObject({ headers: { 'X-HON-Human-Command': 'saas-paid-review-verify-refund', 'Idempotency-Key': U(901) } });
  expect(JSON.parse(String(init!.body))).toEqual({ expectedVersion: 1, confirmation: 'VERIFY_RECORDED_REFUND_EVIDENCE_ONLY' });
  fetch.mockClear();
  await expect(founderBillingApi.verifyRefund(item as never, U(901), signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the retry key only when the outcome is unknown, and maps refusals before any write', async () => {
  expect(commandErrorFor(403, null).kind).toBe('DENIED');
  expect(commandErrorFor(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(commandErrorFor(422, 'SAAS_REFUND_EVIDENCE_MISSING')).toMatchObject({ kind: 'REFUSED', code: 'SAAS_REFUND_EVIDENCE_MISSING' });
  expect(commandErrorFor(404, 'SAAS_UNAVAILABLE').kind).toBe('CHANGED');
  expect(commandErrorFor(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(commandErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new FounderBillingError('UNKNOWN'))).toBe(true);
  for (const k of ['DENIED', 'CHANGED', 'REFUSED', 'INVALID'] as const) expect(keepForRetry(new FounderBillingError(k))).toBe(false);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ code: 'SAAS_REFUND_EVIDENCE_MISSING' }), { status: 422 }));
  await expect(founderBillingApi.verifyRefund(awaiting as never, U(902), signal(), () => true)).rejects.toMatchObject({ kind: 'REFUSED', code: 'SAAS_REFUND_EVIDENCE_MISSING' });
});

it('pages the queue only with the server cursor', async () => {
  const cursor = '2026-11-12T08:00:00.000000Z~' + U(5);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok(queue([item])));
  await founderBillingApi.more(cursor, signal(), () => true);
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/hq/saas/paid-reviews?cursor=${encodeURIComponent(cursor)}`);
  await expect(founderBillingApi.more('../hq', signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('offers the record step for an open item and the verify step for an awaiting one, never both, and nothing when blocked', () => {
  const noop = () => {};
  const record = renderToStaticMarkup(<ReviewActions item={item as never} api={founderBillingApi} onChanged={noop}/>);
  expect(record).toContain('Record refund owed'); expect(record).toContain('does not send a refund'); expect(record).not.toContain('Verify refund');
  const verify = renderToStaticMarkup(<ReviewActions item={awaiting as never} api={founderBillingApi} onChanged={noop}/>);
  expect(verify).toContain('Verify refund'); expect(verify).not.toContain('Record refund owed');
  expect(renderToStaticMarkup(<ReviewActions item={{ ...item, allowedDecisions: [], blocker: 'DISPUTE_POLICY_REQUIRED' } as never} api={founderBillingApi} onChanged={noop}/>)).toBe('');
  expect(renderToStaticMarkup(<ReviewActions item={{ ...awaiting, openResolution: resolution(true) } as never} api={founderBillingApi} onChanged={noop}/>)).toBe('');
});

it('labels money that reached a lifetime plan after an in-window refund ended it (0309)', () => {
  const ended = { ...item, billingStatus: 'REFUNDED_ENDED', reason: 'LIFETIME_REFUND_IN_WINDOW', heldAmountMinor: 357600 };
  const html = renderToStaticMarkup(<FounderBillingScreen read={{ state: 'READY', view: { pool: pool(0) as never, reviews: queue([ended]) as never } }} onRefresh={() => {}}/>);
  for (const s of ['Paid after this lifetime plan was refunded and ended', 'Held $3,576 in 1 payment']) expect(html).toContain(s);
  expect(html).not.toMatch(/<form|type="submit"/);
});
