import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommerceReviewView } from '@hon/contracts';
import { CommerceReview, ReviewResult } from '../src/components/school-shopify/review';
import { REVIEW_LANGUAGES, reviewText } from '../src/components/school-shopify/review-copy';
import { ReviewError, reviewApi, reviewErrorFor } from '../src/components/school-shopify/review-http';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const brief = { focus: 'PRICING', question: 'Which prices look too low?' } as const;
const view = (patch: Partial<CommerceReviewView> = {}): CommerceReviewView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief, mine: true,
  summary: 'A quiet month with thin margins on uniforms.', findings: [{ area: 'SALES', title: 'Two orders', detail: 'Two orders in the last 30 days.' }],
  recommendations: [{ area: 'PRICING', title: 'Look at the uniform price', detail: 'The uniform earns little after cost.' }], problems: [],
  createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const result = (v: CommerceReviewView, language = 'en') => renderToStaticMarkup(<ReviewResult view={v} language={language} when={() => 'Nov 21'} locked={false} onClose={vi.fn()} />);
afterEach(() => { vi.unstubAllGlobals(); });

it('while it checks, the card explains what Marcus sees and offers no ask button', () => {
  const html = renderToStaticMarkup(<CommerceReview language="en" canManage locked={false} when={() => ''} review={{ api: reviewApi, scope }} />);
  expect(html).toContain('data-commerce-review="CHECKING"');
  expect(html).toContain('He sees no customer names or addresses, and a review changes nothing in HON or Shopify.');
  expect(html).not.toContain('data-ask-review'); expect(html).not.toContain('data-review-off'); expect(html).not.toContain('data-review-result');
});

it('a review is shown under the AI notice with its areas, and only its owner can mark or dismiss it while open', () => {
  const open = result(view());
  expect(open).toContain('data-review-result="RESULT_RECORDED"');
  expect(open).toContain('Marcus wrote this with AI from your store totals.');
  expect(open).toContain('Review: Prices and margins · Nov 21'); expect(open).toContain('Question: Which prices look too low?');
  expect(open).toContain('A quiet month with thin margins on uniforms.'); expect(open).toContain('Look at the uniform price');
  expect(open).toContain('data-review-mark'); expect(open).toContain('data-review-dismiss');
  const reviewed = result(view({ status: 'APPLIED' }));
  expect(reviewed).toContain('data-review-reviewed'); expect(reviewed).not.toContain('data-review-mark'); expect(reviewed).not.toContain('data-review-dismiss');
  const other = result(view({ mine: false }));
  expect(other).toContain('Asked by someone else at your school.'); expect(other).not.toContain('data-review-mark'); expect(other).not.toContain('data-review-dismiss');
  expect(result(view({ recommendations: [] }))).toContain('Marcus had no recommendation this time.');
  // Review text is shown as text, never as markup.
  expect(result(view({ summary: '<img src=x onerror=1>' }))).not.toContain('<img');
});

it('every wording key exists in English, Korean and Spanish', () => {
  const keys = Object.keys(REVIEW_LANGUAGES.en).sort();
  expect(Object.keys(REVIEW_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(REVIEW_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(REVIEW_LANGUAGES)) for (const text of Object.values(table)) expect(text.trim().length).toBeGreaterThan(0);
  expect(reviewText('es', 'reviewFor', { focus: 'Ventas', when: 'hoy' })).toBe('Revisión: Ventas · hoy');
  expect(result(view(), 'ko')).toContain('Marcus가 발견한 점');
});

it('the client reads, asks and closes on the exact school path with its own command and key', async () => {
  const f = stub(json({ data: { aiAvailable: true, requests: [view()] } }), json({ data: view() }), json({ data: view({ status: 'APPLIED' }) }));
  const yes = () => true, signal = new AbortController().signal;
  await expect(reviewApi.list(scope, signal, yes)).resolves.toMatchObject({ aiAvailable: true, requests: [{ id: ID }] });
  await expect(reviewApi.request(scope, brief, KEY, signal, yes)).resolves.toMatchObject({ status: 'RESULT_RECORDED' });
  await expect(reviewApi.close(scope, ID, 'APPLIED', KEY, signal, yes)).resolves.toMatchObject({ status: 'APPLIED' });
  const calls = f.mock.calls as unknown as [string, RequestInit][];
  const base = `/api/v1/organizations/${ORG}/schools/${SCHOOL}/shopify/commerce-reviews`;
  expect(calls.map(c => [c[0], c[1].method])).toEqual([[base, 'GET'], [base, 'POST'], [`${base}/${ID}/close`, 'POST']]);
  const h = (n: number) => calls[n]![1].headers as Record<string, string>;
  expect(h(0)['Idempotency-Key']).toBeUndefined(); expect(h(0)['X-HON-Human-Command']).toBeUndefined();
  expect([h(1)['X-HON-Human-Command'], h(1)['Idempotency-Key']]).toEqual(['shopify.commerce.review.request', KEY]);
  expect(JSON.parse(String(calls[1]![1].body))).toEqual(brief);
  expect(h(2)['X-HON-Human-Command']).toBe('shopify.commerce.review.close');
  expect(JSON.parse(String(calls[2]![1].body))).toEqual({ status: 'APPLIED' });
  for (const c of calls) expect([c[1].credentials, c[1].mode, c[1].redirect, c[1].referrerPolicy]).toEqual(['same-origin', 'same-origin', 'error', 'no-referrer']);
});

it('refuses bad input before sending, maps refusals plainly, and treats anything unexpected as unknown', async () => {
  const f = stub(); const yes = () => true, signal = new AbortController().signal;
  await expect(reviewApi.request(scope, { focus: 'CUSTOMERS' as never, question: '' }, KEY, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(reviewApi.request(scope, brief, 'not-a-key', signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(reviewApi.close(scope, 'x', 'DISMISSED', KEY, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(reviewApi.list({ ...scope, schoolId: 'x' }, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect([reviewErrorFor(403, 'SHOPIFY_REVIEW_SPEND_STOPPED').kind, reviewErrorFor(403, 'SHOPIFY_REVIEW_FORBIDDEN').kind, reviewErrorFor(409, 'SHOPIFY_REVIEW_NOT_CONNECTED').kind,
    reviewErrorFor(409, 'SHOPIFY_REVIEW_NOT_OPEN').kind, reviewErrorFor(404, 'SHOPIFY_REVIEW_NOT_FOUND').kind, reviewErrorFor(503, 'SHOPIFY_REVIEW_UNAVAILABLE').kind])
    .toEqual(['PAUSED', 'NO_ACCESS', 'NOT_CONNECTED', 'GONE', 'GONE', 'UNKNOWN']);
  stub(json({ data: { aiAvailable: true, requests: [], extra: 1 } }));
  await expect(reviewApi.list(scope, signal, yes)).rejects.toBeInstanceOf(ReviewError);
  stub(json({ data: { ...view(), findings: [{ area: 'SALES', title: 'x', detail: 'y', productId: 1 }] } }));
  await expect(reviewApi.request(scope, brief, KEY, signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});
