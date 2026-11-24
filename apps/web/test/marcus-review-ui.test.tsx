import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MarcusReviewView } from '@hon/contracts';
import { MarcusReviewError, marcusReviewApi, marcusReviewErrorFor } from '../src/components/hon-command/marcus-review-http';
import { MARCUS_REVIEW_NOTICE, MarcusReviewPanel, MarcusReviewResult } from '../src/components/hon-command/marcus-review-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const view = (patch: Partial<MarcusReviewView> = {}): MarcusReviewView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { period: 'LAST_90_DAYS', question: '' },
  summary: 'Twelve new leads, mostly from the trial form.', findings: [{ title: 'Trial form works', detail: 'Eight of twelve leads came from it.' }],
  nextSteps: [{ title: 'Call open leads', detail: 'Four are still open.', area: 'chad' }, { title: 'Keep the offer', detail: 'It brings most leads.', area: null }],
  problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks the Marcus marketing review available and keeps publishing, ads and spend human-only', () => {
  const marcus = HON_COMMAND_ROSTER.find((a) => a.id === 'marcus')!;
  expect(marcus.capabilities.find((c) => /Marketing performance review/.test(c.label))?.state).toBe('AVAILABLE');
  expect(marcus.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED').map((c) => c.label)).toEqual(['Publish, advertise or spend']);
});

it('lists with a plain GET and asks and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: { aiAvailable: true, reviews: [view()] } }));
  expect((await marcusReviewApi.list(scope, signal(), yes)).reviews).toHaveLength(1);
  let [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/marcus/reviews`); expect(init.method).toBe('GET');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();

  f = stub(json({ data: view() }));
  await marcusReviewApi.request(scope, { period: 'LAST_30_DAYS', question: 'Which campaign works?' }, KEY, signal(), yes);
  [url, init] = call(f);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('marcus.review.request'); expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
  expect(JSON.parse(init.body as string)).toEqual({ period: 'LAST_30_DAYS', question: 'Which campaign works?' });

  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, findings: null, nextSteps: null }) }));
  await marcusReviewApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f);
  expect(url).toMatch(/\/marcus\/reviews\/33333333-3333-4333-8333-333333333333\/close$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('marcus.review.close');
});

it('refuses bad input before anything is sent, and maps refusals to plain outcomes', async () => {
  const f = stub();
  await expect(marcusReviewApi.request(scope, { period: 'LAST_30_DAYS', question: ' padded' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(marcusReviewApi.request(scope, { period: 'LAST_YEAR' as never, question: '' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(marcusReviewApi.dismiss(scope, 'not-a-uuid', KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect(marcusReviewErrorFor(403, 'MARCUS_REVIEW_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(marcusReviewErrorFor(403, 'MARCUS_REVIEW_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(marcusReviewErrorFor(409, 'MARCUS_REVIEW_NOT_OPEN').kind).toBe('GONE');
  expect(marcusReviewErrorFor(503, null).kind).toBe('UNKNOWN');
  stub(json({ code: 'MARCUS_REVIEW_FORBIDDEN' }, 403));
  await expect(marcusReviewApi.request(scope, { period: 'LAST_30_DAYS', question: '' }, KEY, signal(), yes)).rejects.toBeInstanceOf(MarcusReviewError);
  expect(MARCUS_REVIEW_NOTICE.NO_ACCESS).toMatch(/Nothing was sent/);
});

it('shows the summary, findings and next steps with the teammate who can help, and a dismiss button', () => {
  const html = renderToStaticMarkup(<MarcusReviewResult view={view()} busy={false} onDismiss={() => {}} />);
  expect(html).toContain('Twelve new leads, mostly from the trial form.'); expect(html).toContain('last 90 days');
  expect(html).toContain('Trial form works'); expect(html).toContain('Eight of twelve leads came from it.');
  expect(html).toContain('Call open leads'); expect(html).toContain('Chad · lead follow-up'); expect(html).toContain('data-marcus-step="1"');
  expect(html).not.toContain('data-marcus-area="null"'); expect(html).toContain('data-marcus-dismiss'); expect(html).toContain('Check it before you act on it');
});

it('starts by checking availability and never renders a review before the server answers', () => {
  const html = renderToStaticMarkup(<MarcusReviewPanel scope={scope} api={{ ...marcusReviewApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('data-marcus-review="CHECKING"'); expect(html).not.toContain('data-marcus-ask'); expect(html).not.toContain('data-marcus-result');
});
