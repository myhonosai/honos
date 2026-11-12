import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifySchoolCheckoutPages } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { CheckoutError, checkoutApi, checkoutErrorFor, keepForRetry } from '../src/components/school-checkout/http';
import { amountMinor, cleanText, contentFrom, draftFrom, draftProblems, editDraft, EMPTY_TEXT, nextKey } from '../src/components/school-checkout/draft';
import { mergeDrafts, saveInput } from '../src/components/school-checkout/school-checkout';
import { SchoolCheckoutView, type SchoolCheckoutViewProps } from '../src/components/school-checkout/view';
import { id } from './account-status-fixtures';

// B-TUI-2 piece 9b (0269): staff edit what families see on the enrollment checkout and the tuition payment page. No HON fee.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), planA = id(40), planB = id(41), planGone = id(42), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CheckoutError; } throw new Error('expected a failure'); };
const plan = (planId: string, displayName: string, over: Record<string, unknown> = {}) => ({ planId, displayName, priceMinor: 15000, currency: 'USD', billingFrequency: 'MONTHLY', available: true, ...over });
const plans = [plan(planA, 'Little Dragons'), plan(planB, 'Adult Kickboxing', { priceMinor: 18900 }), plan(planGone, 'Old Summer Camp', { available: false })];
const content = (over: Record<string, unknown> = {}) => ({ planIds: [planA], addOns: [{ key: 'addon_1', label: { en: 'Uniform', ko: '도복' }, amountMinor: 4500, currency: 'USD', required: true }],
  customFields: [{ key: 'question_1', label: { en: 'Shirt size' }, kind: 'CHOICE', required: true, options: [{ en: 'Small' }, { en: 'Large', es: 'Grande' }] }],
  waiver: { text: { en: 'I agree to the school rules.\nParents sign for children.' } }, receiptNote: null, thankYou: { en: 'Welcome to the dojang!' }, ...over });
const page = (over: Record<string, unknown> = {}) => ({ pageId: id(60), kind: 'ENROLLMENT', status: 'PUBLISHED', content: content(), version: 3, updatedAt: '2026-11-12T10:00:00.000Z', ...over });
const pagesRaw = (over: Record<string, unknown> = {}) => ({ enrollment: page(), tuition: null, plans, ...over });
const read = (over: Record<string, unknown> = {}) => verifySchoolCheckoutPages(pagesRaw(over));

it('reads checkout pages as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: pagesRaw(), meta }));
  const result = await checkoutApi.pages({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(result.enrollment?.version).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [pagesRaw({ extra: 1 }), pagesRaw({ tuition: page() }), pagesRaw({ enrollment: page({ content: content({ planIds: [] }) }) }),
    pagesRaw({ enrollment: page({ content: content({ thankYou: { en: '<script>' } }) }) })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(checkoutApi.pages(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('saves with its own human-command header and key, and accepts only the next version of the same kind and status', async () => {
  const input = { kind: 'ENROLLMENT' as const, expectedVersion: 3, status: 'PUBLISHED' as const, content: content() as never };
  const f = stub(json({ data: { page: page({ version: 4 }) }, meta: { ...meta, replayed: false } }));
  expect((await checkoutApi.save(scope, input, key, signal(), () => true)).page.version).toBe(4);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages`);
  expect(init).toMatchObject({ method: 'POST', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': 'school_checkout.page.save', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual(input);
  for (const bad of [page({ version: 3 }), page({ version: 5 }), page({ kind: 'TUITION', version: 4 }), page({ status: 'DRAFT', version: 4 })]) {
    stub(json({ data: { page: bad }, meta }));
    expect((await fails(checkoutApi.save(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  // Bad input or key never reaches the network.
  const none = stub(json({}, 500));
  expect((await fails(checkoutApi.save(scope, { ...input, content: content({ planIds: [] }) as never }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(checkoutApi.save(scope, input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(checkoutErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(checkoutErrorFor(422, 'CHECKOUT_PLAN_UNAVAILABLE').kind).toBe('PLAN_UNAVAILABLE');
  expect(checkoutErrorFor(422, 'CHECKOUT_PLANS_REQUIRED').kind).toBe('PLANS_REQUIRED');
  expect(checkoutErrorFor(403, 'SCHOOL_CHECKOUT_FORBIDDEN').kind).toBe('DENIED');
  expect(checkoutErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(checkoutErrorFor(409, 'SCHOOL_CHECKOUT_CONFLICT').kind).toBe('UNKNOWN');
  expect(checkoutErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('UNKNOWN');
  expect(checkoutErrorFor(503, 'SCHOOL_CHECKOUT_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new CheckoutError('UNKNOWN'))).toBe(true); expect(keepForRetry(new CheckoutError('RATE'))).toBe(true);
  expect(keepForRetry(new CheckoutError('CHANGED'))).toBe(false);
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(checkoutApi.pages(scope, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(checkoutApi.pages(scope, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('round-trips a saved page through the draft, leaves empty translations out and cleans what staff type', () => {
  const saved = read().enrollment;
  const draft = draftFrom(saved);
  expect(draft.addOns[0]).toMatchObject({ amount: '45.00', label: { en: 'Uniform', ko: '도복', es: '' } });
  expect(contentFrom(draft)).toEqual(saved?.content);
  expect(draftFrom(null)).toMatchObject({ planIds: [], addOns: [], waiverOn: false, waiver: EMPTY_TEXT });
  expect(amountMinor('25', 'USD')).toBe(2500); expect(amountMinor(' 25.5 ', 'USD')).toBe(2550); expect(amountMinor('0.01', 'USD')).toBe(1);
  for (const bad of ['0', '-5', '1,000', '25.555', '$25', 'abc', '', '1000000']) expect(amountMinor(bad, 'USD')).toBeNull();
  // Each currency in its own units: KRW has no minor digits, KWD has three.
  expect(amountMinor('50000', 'KRW')).toBe(50000); expect(amountMinor('50000.5', 'KRW')).toBeNull();
  expect(amountMinor('1.250', 'KWD')).toBe(1250); expect(amountMinor('1.2505', 'KWD')).toBeNull();
  const won = draftFrom(verifySchoolCheckoutPages(pagesRaw({ enrollment: page({ content: content({ addOns: [{ key: 'addon_1', label: { en: 'Uniform' }, amountMinor: 50000, currency: 'KRW', required: true }] }) }) })).enrollment);
  expect(won.addOns[0]?.amount).toBe('50000');
  expect(contentFrom(won).addOns[0]?.amountMinor).toBe(50000);
  expect(cleanText('  Big   blue\nbelt ', false)).toBe('Big blue belt');
  expect(cleanText(' Line one  \r\nLine two ', true)).toBe('Line one\nLine two');
  expect(nextKey('addon', ['addon_1', 'addon_3'])).toBe('addon_2');
  // An empty receipt note is no note; a blank Korean text falls back to English.
  const edited = editDraft(editDraft(draft, { type: 'text', target: 'receiptNote', text: { en: '  ', ko: '', es: '' } }), { type: 'addOn', index: 0, patch: { label: { en: 'Uniform', ko: ' ', es: '' } } });
  expect(contentFrom(edited).receiptNote).toBeNull();
  expect(contentFrom(edited).addOns[0]?.label).toEqual({ en: 'Uniform' });
});

it('edits plans, add-ons, questions and texts as pure steps', () => {
  let d = draftFrom(null);
  d = editDraft(d, { type: 'plan', planId: planA, shown: true }); d = editDraft(d, { type: 'plan', planId: planB, shown: true });
  d = editDraft(d, { type: 'planMove', planId: planB, by: -1 });
  expect(d.planIds).toEqual([planB, planA]);
  expect(editDraft(d, { type: 'planMove', planId: planB, by: -1 })).toBe(d);
  d = editDraft(d, { type: 'addAddOn', currency: 'USD' }); d = editDraft(d, { type: 'addAddOn', currency: 'USD' });
  d = editDraft(d, { type: 'removeAddOn', index: 0 }); d = editDraft(d, { type: 'addAddOn', currency: 'USD' });
  expect(d.addOns.map((a) => a.key)).toEqual(['addon_2', 'addon_1']);
  d = editDraft(d, { type: 'addField' }); d = editDraft(d, { type: 'field', index: 0, patch: { kind: 'CHOICE' } });
  expect(d.customFields[0]?.options).toHaveLength(2);
  d = editDraft(d, { type: 'addOption', index: 0 }); d = editDraft(d, { type: 'removeOption', index: 0, option: 2 });
  d = editDraft(d, { type: 'option', index: 0, option: 1, text: { en: 'Yes', ko: '', es: 'Sí' } });
  expect(d.customFields[0]?.options[1]).toEqual({ en: 'Yes', ko: '', es: 'Sí' });
  expect(editDraft(d, { type: 'field', index: 0, patch: { kind: 'TEXT' } }).customFields[0]?.options).toEqual([]);
  d = editDraft(d, { type: 'waiverOn', on: true });
  expect(d.waiverOn).toBe(true);
});

it('lists every problem in plain words and builds the save from the verified read only', () => {
  const r = read();
  let d = editDraft(draftFrom(null), { type: 'addAddOn', currency: 'USD' });
  d = editDraft(editDraft(d, { type: 'addField' }), { type: 'field', index: 0, patch: { kind: 'CHOICE' } });
  d = editDraft(d, { type: 'waiverOn', on: true });
  const problems = draftProblems(d, 'ENROLLMENT', true, r.plans);
  expect(problems).toEqual(expect.arrayContaining(['Choose at least one plan before publishing the enrollment page.', 'Add-on 1 name needs English text.',
    'Add-on 1 needs a plain amount in USD, such as 25 or 25.00.', 'Question 1 needs English text.', 'The waiver needs English text.']));
  expect(draftProblems(editDraft(draftFrom(null), { type: 'plan', planId: planGone, shown: true }), 'TUITION', false, r.plans)).toEqual(['Old Summer Camp is no longer available. Remove it from this page.']);
  expect(draftProblems(editDraft(draftFrom(null), { type: 'text', target: 'thankYou', text: { en: 'Hi <b>', ko: '', es: '' } }), 'TUITION', false, r.plans)[0]).toContain('without < or >');
  expect(draftProblems(draftFrom(null), 'TUITION', true, r.plans)).toEqual([]);

  expect(saveInput(r, 'ENROLLMENT', 'DRAFT', draftFrom(r.enrollment))).toMatchObject({ kind: 'ENROLLMENT', expectedVersion: 3, status: 'DRAFT' });
  expect(saveInput(r, 'TUITION', 'PUBLISHED', draftFrom(null))).toMatchObject({ kind: 'TUITION', expectedVersion: 0, status: 'PUBLISHED' });
  expect(() => saveInput(r, 'ENROLLMENT', 'PUBLISHED', draftFrom(null))).toThrow(expect.objectContaining({ kind: 'PLANS_REQUIRED' }));
  expect(() => saveInput(r, 'TUITION', 'DRAFT', d)).toThrow(expect.objectContaining({ kind: 'INVALID' }));

  // A fresh read keeps unsaved edits and takes the server's version elsewhere.
  const mine = editDraft(draftFrom(r.enrollment), { type: 'waiverOn', on: false });
  const merged = mergeDrafts(r, { ENROLLMENT: mine, TUITION: null }, { ENROLLMENT: true, TUITION: false });
  expect(merged.ENROLLMENT).toBe(mine); expect(merged.TUITION).toEqual(draftFrom(null));
  expect(mergeDrafts(r, { ENROLLMENT: mine, TUITION: null }, { ENROLLMENT: false, TUITION: false }).ENROLLMENT).toEqual(draftFrom(r.enrollment));
});

const props = (over: Partial<SchoolCheckoutViewProps> = {}): SchoolCheckoutViewProps => {
  const r = read();
  return { language: 'en-US', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', read: r }, kind: 'ENROLLMENT', editLanguage: 'en',
    draft: draftFrom(r.enrollment), dirty: false, problems: [], outcome: null, locked: false, canRetry: false, ...over };
};

it('shows the plans in order, the add-ons, questions and texts, and only the plans that can still be added', () => {
  const html = renderToStaticMarkup(<SchoolCheckoutView {...props()}/>);
  expect(html).toContain('HON adds no fee'); expect(html).toContain('Published · version 3');
  expect(html).toContain('Little Dragons · $150.00 monthly');
  const krw = verifySchoolCheckoutPages(pagesRaw({ enrollment: null, plans: [plan(planA, 'Little Dragons', { priceMinor: 150000, currency: 'KRW' })] }));
  const wonPage = renderToStaticMarkup(<SchoolCheckoutView {...props({ list: { state: 'READY', read: krw }, draft: draftFrom(null) })}/>);
  expect(wonPage).toContain('₩150,000'); expect(wonPage).not.toContain('₩1,500');
  expect(html).toContain('Add Adult Kickboxing'); expect(html).not.toContain('Add Old Summer Camp');
  expect(html).toContain('value="Uniform"'); expect(html).toContain('value="45.00"'); expect(html).toContain('Shirt size');
  expect(html).toContain('I agree to the school rules.'); expect(html).toContain('Welcome to the dojang!');
  expect(html).toContain('Save and publish'); expect(html).not.toContain('Discard changes');
  const korean = renderToStaticMarkup(<SchoolCheckoutView {...props({ editLanguage: 'ko' })}/>);
  expect(korean).toContain('value="도복"'); expect(korean).toContain('in 한국어 (Korean), optional');
  const dirty = renderToStaticMarkup(<SchoolCheckoutView {...props({ dirty: true, problems: ['Add-on 1 needs a plain amount in USD, such as 25 or 25.00.'] })}/>);
  expect(dirty).toContain('you have unsaved changes'); expect(dirty).toContain('Discard changes'); expect(dirty).toContain('Fix these before saving');
  expect(dirty).toMatch(/<button type="button" role="tab"[^>]*disabled=""[^>]*>Tuition payment page/);
  const tuition = renderToStaticMarkup(<SchoolCheckoutView {...props({ kind: 'TUITION', draft: draftFrom(null) })}/>);
  expect(tuition).toContain('Not saved yet.'); expect(tuition).toContain('That is fine for a tuition payment page');
});

it('shows outcomes plainly and hides everything when concealed or not allowed', () => {
  const unknown = renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'UNKNOWN', status: 'PUBLISHED' }, canRetry: true, locked: true })}/>);
  expect(unknown).toContain('nothing happens twice'); expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'CHANGED', status: 'DRAFT' } })}/>)).toContain('Your edits are still here');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'DONE', status: 'DRAFT' } })}/>)).toContain('families do not see drafts');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ list: { state: 'DENIED' } })}/>)).toContain('manage checkout pages permission');
  const hidden = renderToStaticMarkup(<SchoolCheckoutView {...props({ concealed: true })}/>);
  expect(hidden).not.toContain('Uniform'); expect(hidden).toContain('Hidden while this tab');
});

it('is a protected dynamic noindex page in the billing menu and the route manifest, with nothing kept in storage', () => {
  const pageSource = readFileSync('src/app/staff/billing/checkout-pages/page.tsx', 'utf8');
  expect(pageSource).toContain("export const dynamic = 'force-dynamic'"); expect(pageSource).toContain('requireVerifiedWebSession'); expect(pageSource).toContain('index: false');
  expect(pageSource).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/billing/checkout-pages')?.href).toBe('/staff/billing/checkout-pages');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'billing')?.routes.some((r) => r.href === '/staff/billing/checkout-pages')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/billing/checkout-pages')).toEqual([{ path: '/staff/billing/checkout-pages', title: 'HON | Checkout pages' }]);
  const source = ['school-checkout.tsx', 'http.ts', 'view.tsx', 'draft.ts'].map((f) => readFileSync(`src/components/school-checkout/${f}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML/);
});
