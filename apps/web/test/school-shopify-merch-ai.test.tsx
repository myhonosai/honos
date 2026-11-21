import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { MerchAiView } from '@hon/contracts';
import { buildDraft } from '../src/components/school-shopify/editor';
import { shopifyText } from '../src/components/school-shopify/copy';
import { MerchAiError, merchAiApi, merchAiErrorFor } from '../src/components/school-shopify/merch-ai-http';
import { DEFAULT_BRIEF, MerchStudio, StudioIdeas, aiBrief, marcusConcepts, type StudioProps } from '../src/components/school-shopify/studio';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const ctx = (currency: string | null = 'USD') => ({ t: (k: Parameters<typeof shopifyText>[1], v?: Record<string, string>) => shopifyText('en', k, v), locale: 'en-US', domain: 'ima-test.myshopify.com', currency });
const props = (over: Partial<StudioProps> = {}): StudioProps => ({ ctx: ctx(), language: 'en', school: 'Ideal Martial Arts', brand: { state: 'NONE' }, canEdit: true, locked: false,
  onPropose: vi.fn(), creativeHref: '/staff/creative-studio', ...over });
const idea = (style: 'MINIMAL' | 'ATHLETIC', price: string | null) => ({ style, title: `Tournament ${style.toLowerCase()} hoodie`, description: 'A warm hoodie for tournament day.',
  productType: 'Hoodie', price, printNotes: 'One-color chest print.' });
const view = (patch: Partial<MerchAiView> = {}): MerchAiView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, mine: true,
  brief: { kind: 'HOODIE', styles: ['MINIMAL', 'ATHLETIC'], colors: ['Black'], notes: 'Spring tournament' },
  summary: 'Two looks.', ideas: [idea('MINIMAL', '55.00'), idea('ATHLETIC', null)], problems: [], createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
afterEach(() => { vi.unstubAllGlobals(); });

it('sends the brief exactly as the server takes it: fixed look order, parsed colors, trimmed notes', () => {
  expect(aiBrief({ kind: 'HAT', styles: ['STREETWEAR', 'MINIMAL'], colors: ' Black, black ,Red', notes: '  for camp  ' }))
    .toEqual({ kind: 'HAT', styles: ['MINIMAL', 'STREETWEAR'], colors: ['Black', 'Red'], notes: 'for camp' });
  expect(aiBrief(DEFAULT_BRIEF).notes).toBe('');
});

it('turns Marcus ideas into Shopify drafts, keeping a price only in a US dollar store', () => {
  const usd = marcusConcepts('en', view(), 'Ideal Martial Arts', 'USD');
  expect(usd.map(c => [c.source, c.style, c.fields.price, c.fields.sku, c.printNotes])).toEqual([
    ['MARCUS', 'MINIMAL', '55.00', 'IMA-HOODIE-MIN', 'One-color chest print.'], ['MARCUS', 'ATHLETIC', '', 'IMA-HOODIE-ATH', 'One-color chest print.']]);
  expect(buildDraft(usd[0]!.fields)).not.toBe('INVALID');
  expect(marcusConcepts('en', view(), 'Dojo', 'CAD').every(c => c.fields.price === '')).toBe(true);
  expect(marcusConcepts('en', view({ status: 'DISMISSED', ideas: null, summary: null }), 'Dojo', 'USD')).toEqual([]);
});

it('labels Marcus ideas as AI, shows print notes, and offers dismiss only while they are open', () => {
  const ideas = marcusConcepts('en', view(), 'Ideal Martial Arts', 'USD');
  const html = renderToStaticMarkup(<StudioIdeas {...props()} ideas={ideas} editing={null} onEdit={vi.fn()} marcusStatus="RESULT_RECORDED" onDismiss={vi.fn()} />);
  expect(html).toContain('data-studio-source="MARCUS"');
  expect(html).toContain('Marcus wrote these ideas with AI');
  expect(html).not.toContain('data-studio-source="TEMPLATE"');
  expect(html).toContain('Print notes: One-color chest print.');
  expect(html).toContain('data-marcus-dismiss');
  expect(html).not.toMatch(/data-state="CHECKED"/);
  const used = renderToStaticMarkup(<StudioIdeas {...props()} ideas={ideas} editing={null} onEdit={vi.fn()} marcusStatus="APPLIED" onDismiss={vi.fn()} />);
  expect(used).toContain('data-marcus-used'); expect(used).not.toContain('data-marcus-dismiss');
});

it('without Marcus the studio shows only starter ideas; while it checks, no ask button is shown', () => {
  const plain = renderToStaticMarkup(<MerchStudio {...props()} />);
  expect(plain).not.toContain('data-ask-marcus'); expect(plain).not.toContain('data-marcus="off"'); expect(plain).not.toContain('data-studio-notes');
  const checking = renderToStaticMarkup(<MerchStudio {...props({ merchAi: { api: merchAiApi, scope } })} />);
  expect(checking).not.toContain('data-ask-marcus');
  // A store reader never asks Marcus.
  expect(renderToStaticMarkup(<MerchStudio {...props({ canEdit: false, merchAi: { api: merchAiApi, scope } })} />)).not.toContain('data-marcus');
});

it('the client reads, asks and closes on the exact school path with its own command and key', async () => {
  const f = stub(json({ data: { aiAvailable: true, requests: [view()] } }), json({ data: view() }), json({ data: view({ status: 'APPLIED' }) }));
  const yes = () => true, signal = new AbortController().signal;
  await expect(merchAiApi.list(scope, signal, yes)).resolves.toMatchObject({ aiAvailable: true, requests: [{ id: ID }] });
  await expect(merchAiApi.request(scope, aiBrief({ ...DEFAULT_BRIEF, styles: ['MINIMAL', 'ATHLETIC'] }), KEY, signal, yes)).resolves.toMatchObject({ status: 'RESULT_RECORDED' });
  await expect(merchAiApi.close(scope, ID, 'APPLIED', KEY, signal, yes)).resolves.toMatchObject({ status: 'APPLIED' });
  const calls = f.mock.calls as unknown as [string, RequestInit][];
  const base = `/api/v1/organizations/${ORG}/schools/${SCHOOL}/shopify/merch-ideas`;
  expect(calls.map(c => [c[0], c[1].method])).toEqual([[base, 'GET'], [base, 'POST'], [`${base}/${ID}/close`, 'POST']]);
  const h = (n: number) => calls[n]![1].headers as Record<string, string>;
  expect(h(0)['Idempotency-Key']).toBeUndefined(); expect(h(0)['X-HON-Human-Command']).toBeUndefined();
  expect([h(1)['X-HON-Human-Command'], h(1)['Idempotency-Key']]).toEqual(['shopify.merch.ai.request', KEY]);
  expect(h(2)['X-HON-Human-Command']).toBe('shopify.merch.ai.close');
  expect(JSON.parse(String(calls[2]![1].body))).toEqual({ status: 'APPLIED' });
  for (const c of calls) expect([c[1].credentials, c[1].mode, c[1].redirect, c[1].referrerPolicy]).toEqual(['same-origin', 'same-origin', 'error', 'no-referrer']);
});

it('refuses bad input before sending, maps refusals plainly, and treats anything unexpected as unknown', async () => {
  const f = stub(); const yes = () => true, signal = new AbortController().signal;
  await expect(merchAiApi.request(scope, { ...aiBrief(DEFAULT_BRIEF), styles: [] }, KEY, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(merchAiApi.request(scope, aiBrief(DEFAULT_BRIEF), 'not-a-key', signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(merchAiApi.close(scope, 'x', 'DISMISSED', KEY, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(merchAiApi.list({ ...scope, schoolId: 'x' }, signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect([merchAiErrorFor(403, 'SHOPIFY_MERCH_AI_SPEND_STOPPED').kind, merchAiErrorFor(403, 'SHOPIFY_MERCH_AI_FORBIDDEN').kind, merchAiErrorFor(409, 'SHOPIFY_MERCH_AI_NOT_CONNECTED').kind,
    merchAiErrorFor(409, 'SHOPIFY_MERCH_AI_NOT_OPEN').kind, merchAiErrorFor(404, 'SHOPIFY_MERCH_AI_NOT_FOUND').kind, merchAiErrorFor(503, 'SHOPIFY_MERCH_AI_UNAVAILABLE').kind])
    .toEqual(['PAUSED', 'NO_ACCESS', 'NOT_CONNECTED', 'GONE', 'GONE', 'UNKNOWN']);
  stub(json({ data: { aiAvailable: true, requests: [], extra: 1 } }));
  await expect(merchAiApi.list(scope, signal, yes)).rejects.toBeInstanceOf(MerchAiError);
  stub(json({ data: { ...view(), ideas: [{ ...idea('MINIMAL', '50.00'), imageUrl: 'https://x.test/a.png' }] } }));
  await expect(merchAiApi.request(scope, aiBrief(DEFAULT_BRIEF), KEY, signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});
