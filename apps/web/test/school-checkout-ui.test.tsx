import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CHECKOUT_GROUPS, verifySchoolCheckoutPages } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { CHECKOUT_SAVE_COMMAND, CHECKOUT_SETTINGS_COMMAND, CheckoutError, checkoutApi, checkoutErrorFor, keepForRetry } from '../src/components/school-checkout/http';
import {
  amountMinor, cleanText, contentFrom, draftFrom, draftProblems, duplicateDraft, editPage, EMPTY_TEXT, freeSlug, fromPrice, newDraft, nextKey, optionSummary,
  saveInputFrom, slugFrom, type PageDraft,
} from '../src/components/school-checkout/draft';
import { groupsInput, movedOrder } from '../src/components/school-checkout/school-checkout';
import { SchoolCheckoutView, type SchoolCheckoutViewProps } from '../src/components/school-checkout/view';
import { id } from './account-status-fixtures';

// Checkout CP2 (0402): many named checkout pages per school, modeled on the owner's current CRM. No HON fee, no payment here.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), planA = id(40), planB = id(41), planGone = id(42), key = id(77), scope = { organizationId: org, schoolId: school };
const pageA = id(60), pageB = id(61), pageC = id(62);
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CheckoutError; } throw new Error('expected a failure'); };
const plan = (planId: string, displayName: string, over: Record<string, unknown> = {}) => ({ planId, displayName, priceMinor: 15000, currency: 'USD', billingFrequency: 'MONTHLY', available: true, ...over });
const plans = [plan(planA, 'Little Dragons'), plan(planB, 'Adult Kickboxing', { priceMinor: 18900 }), plan(planGone, 'Old Summer Camp', { available: false })];
const oneTime = (over: Record<string, unknown> = {}) => ({ key: 'option_1', label: { en: '6 Months 1 time' }, description: { en: 'Uniform included.' }, planId: planA, billing: 'ONE_TIME',
  priceMinor: 121500, recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0,
  availableThrough: null, mostPopular: false, createsMembership: true, ...over });
const monthly = (over: Record<string, unknown> = {}) => oneTime({ key: 'option_2', label: { en: 'Monthly' }, description: null, billing: 'MONTHLY', priceMinor: null, recurringMinor: 22500,
  installments: 10, collectionMethod: 'AUTO_CHARGE', downPayment: { amountMinor: 45000, label: { en: 'First and last month' } }, mostPopular: true, ...over });
const content = (over: Record<string, unknown> = {}) => ({ currency: 'USD', title: { en: 'Green Belt', ko: '그린벨트' }, description: { en: 'Line one.\nLine two.' },
  blocks: [{ position: 'ABOVE', text: { en: 'Pick a plan.' } }], multiParticipant: { enabled: true, maxPerOrder: 4 },
  customFields: [{ key: 'question_1', label: { en: 'Shirt size' }, kind: 'CHOICE', required: true, options: [{ en: 'Small' }, { en: 'Large', es: 'Grande' }] }],
  addOns: [{ key: 'addon_1', label: { en: 'Uniform', ko: '도복' }, amountMinor: 4500, currency: 'USD', required: true }],
  options: [oneTime(), monthly()], waiver: { text: { en: 'I agree to the school rules.' } }, receiptNote: null, thankYou: { en: 'Welcome to the dojang!' }, ...over });
const page = (over: Record<string, unknown> = {}) => ({ pageId: pageA, slug: 'green-belt', groupKey: 'membership', status: 'PUBLISHED', content: content(), version: 3,
  updatedAt: '2026-11-12T10:00:00.000Z', ...over });
const settings = (over: Record<string, unknown> = {}) => ({ version: 2, groups: DEFAULT_CHECKOUT_GROUPS, pageOrder: [pageA, pageB], ...over });
const pagesRaw = (over: Record<string, unknown> = {}) => ({ settings: settings(), plans, pages: [page(),
  page({ pageId: pageB, slug: 'free-trial', groupKey: 'trial', status: 'DRAFT', version: 1, content: content({ title: { en: 'Free trial' }, options: [oneTime({ priceMinor: 0, planId: null, createsMembership: false })],
    addOns: [], customFields: [], blocks: [], multiParticipant: { enabled: false, maxPerOrder: 1 }, waiver: null, thankYou: null }) }),
  page({ pageId: pageC, slug: 'old-camp', groupKey: 'camp', status: 'ARCHIVED', version: 5, content: content({ title: { en: 'Old camp' }, options: [] }) })], ...over });
const read = (over: Record<string, unknown> = {}) => verifySchoolCheckoutPages(pagesRaw(over));
const first = () => read().pages[0] as NonNullable<ReturnType<typeof read>['pages'][number]>;
const groupKeys = DEFAULT_CHECKOUT_GROUPS.map((g) => g.key);

it('reads checkout pages as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: pagesRaw(), meta }));
  const result = await checkoutApi.pages({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(result.pages.map((p) => p.slug)).toEqual(['green-belt', 'free-trial', 'old-camp']);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [pagesRaw({ extra: 1 }), pagesRaw({ pages: [page(), page()] }), pagesRaw({ pages: [page({ content: content({ options: [] }) })] }),
    pagesRaw({ pages: [page({ content: content({ thankYou: { en: '<script>' } }) })] }), pagesRaw({ enrollment: null })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(checkoutApi.pages(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('saves a page with its own human-command header and key, and accepts only the next version of that page, address, status and group', async () => {
  const input = saveInputFrom(draftFrom(first()), 'PUBLISHED');
  expect(input).toMatchObject({ pageId: pageA, expectedVersion: 3, slug: 'green-belt', groupKey: 'membership', status: 'PUBLISHED' });
  const f = stub(json({ data: { page: page({ version: 4 }) }, meta: { ...meta, replayed: false } }));
  expect((await checkoutApi.save(scope, input, key, signal(), () => true)).page.version).toBe(4);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages`);
  expect(init).toMatchObject({ method: 'POST', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': CHECKOUT_SAVE_COMMAND, 'Idempotency-Key': key } });
  expect(CHECKOUT_SAVE_COMMAND).toBe('school_checkout.page.save');
  expect(JSON.parse(String(init.body))).toEqual(input);
  for (const bad of [page({ version: 3 }), page({ version: 5 }), page({ pageId: pageB, version: 4 }), page({ slug: 'other', version: 4 }), page({ status: 'DRAFT', version: 4 }),
    page({ groupKey: 'trial', version: 4 })]) {
    stub(json({ data: { page: bad }, meta }));
    expect((await fails(checkoutApi.save(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  // A new page (no id, version 0) takes the id the server gives it, at version 1 with the address sent.
  const fresh = saveInputFrom(editPage(newDraft('trial', 'USD', ['green-belt']), { type: 'text', target: 'title', text: { en: 'Kids Trial', ko: '', es: '' } }), 'DRAFT');
  expect(fresh).toMatchObject({ pageId: null, expectedVersion: 0, slug: 'kids-trial', status: 'DRAFT' });
  stub(json({ data: { page: page({ pageId: id(70), slug: 'kids-trial', groupKey: 'trial', status: 'DRAFT', version: 1, content: fresh.content }) }, meta }));
  expect((await checkoutApi.save(scope, fresh, key, signal(), () => true)).page.pageId).toBe(id(70));
  // Bad input or key never reaches the network.
  const none = stub(json({}, 500));
  expect((await fails(checkoutApi.save(scope, { ...input, content: content({ options: [] }) as never }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(checkoutApi.save(scope, { ...input, slug: 'Bad Slug' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(checkoutApi.save(scope, input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('saves groups and page order on /settings with the settings command, accepting only the next settings version', async () => {
  const r = read();
  const input = groupsInput(r, [...DEFAULT_CHECKOUT_GROUPS.map((g) => ({ key: g.key, label: g.label.en, ko: '', es: '' })), { key: null, label: 'Birthday Parties', ko: '', es: 'Fiestas' }]);
  expect(input.groups.at(-1)).toEqual({ key: 'birthday_parties', label: { en: 'Birthday Parties', es: 'Fiestas' } });
  expect(input).toMatchObject({ expectedVersion: 2, pageOrder: [pageA, pageB, pageC] });
  const f = stub(json({ data: { settings: settings({ version: 3, groups: input.groups }) }, meta }));
  expect((await checkoutApi.saveSettings(scope, input, key, signal(), () => true)).settings.version).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages/settings`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': CHECKOUT_SETTINGS_COMMAND, 'Idempotency-Key': key } });
  expect(CHECKOUT_SETTINGS_COMMAND).toBe('school_checkout.settings.save');
  stub(json({ data: { settings: settings({ version: 2 }) }, meta }));
  expect((await fails(checkoutApi.saveSettings(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}, 500));
  expect((await fails(checkoutApi.saveSettings(scope, { ...input, groups: [] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
  // New groups never collide: a repeated or symbol-only name gets its own key.
  const keys = groupsInput(r, [{ key: 'sales', label: 'Sales', ko: '', es: '' }, { key: null, label: 'Sales', ko: '', es: '' }, { key: null, label: '!!', ko: '', es: '' }, { key: null, label: '2026 Camp', ko: '', es: '' }]).groups.map((g) => g.key);
  expect(new Set(keys).size).toBe(4); expect(keys.every((k) => /^[a-z][a-z0-9_]*$/.test(k))).toBe(true);
  // Moving a page swaps it with its neighbour in the grid order; the ends do not move.
  expect(movedOrder(r, pageB, -1)).toEqual([pageB, pageA, pageC]);
  expect(movedOrder(r, pageA, -1)).toBeNull(); expect(movedOrder(r, pageC, 1)).toBeNull(); expect(movedOrder(r, id(99), 1)).toBeNull();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(checkoutErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(checkoutErrorFor(422, 'CHECKOUT_PLAN_UNAVAILABLE').kind).toBe('PLAN_UNAVAILABLE');
  expect(checkoutErrorFor(422, 'CHECKOUT_OPTIONS_REQUIRED').kind).toBe('OPTIONS_REQUIRED');
  expect(checkoutErrorFor(422, 'CHECKOUT_SLUG_TAKEN').kind).toBe('SLUG_TAKEN');
  expect(checkoutErrorFor(422, 'CHECKOUT_SLUG_FIXED').kind).toBe('NOT_FOUND');
  expect(checkoutErrorFor(422, 'CHECKOUT_NOT_FOUND').kind).toBe('NOT_FOUND');
  expect(checkoutErrorFor(422, 'CHECKOUT_GROUP_UNKNOWN').kind).toBe('GROUP_UNKNOWN');
  expect(checkoutErrorFor(422, 'CHECKOUT_GROUP_IN_USE').kind).toBe('GROUP_IN_USE');
  expect(checkoutErrorFor(422, 'CHECKOUT_LIMIT_REACHED').kind).toBe('LIMIT');
  expect(checkoutErrorFor(422, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(checkoutErrorFor(403, 'SCHOOL_CHECKOUT_FORBIDDEN').kind).toBe('DENIED');
  expect(checkoutErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(checkoutErrorFor(409, 'SCHOOL_CHECKOUT_CONFLICT').kind).toBe('UNKNOWN');
  expect(checkoutErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('UNKNOWN');
  expect(checkoutErrorFor(503, 'SCHOOL_CHECKOUT_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new CheckoutError('UNKNOWN'))).toBe(true); expect(keepForRetry(new CheckoutError('RATE'))).toBe(true);
  expect(keepForRetry(new CheckoutError('CHANGED'))).toBe(false); expect(keepForRetry(new CheckoutError('SLUG_TAKEN'))).toBe(false);
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(checkoutApi.pages(scope, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(checkoutApi.pages(scope, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('round-trips a saved page through the draft, leaves empty translations out and cleans what staff type', () => {
  const saved = first();
  const draft = draftFrom(saved);
  expect(draft.addOns[0]).toMatchObject({ amount: '45.00', label: { en: 'Uniform', ko: '도복', es: '' } });
  expect(draft.options[1]).toMatchObject({ billing: 'MONTHLY', recurring: '225.00', installments: '10', downOn: true, down: '450.00', price: '' });
  expect(contentFrom(draft)).toEqual(saved.content);
  for (const p of read().pages) expect(contentFrom(draftFrom(p))).toEqual(p.content);
  expect(amountMinor('25', 'USD')).toBe(2500); expect(amountMinor(' 25.5 ', 'USD')).toBe(2550); expect(amountMinor('0.01', 'USD')).toBe(1);
  expect(amountMinor('0', 'USD')).toBeNull(); expect(amountMinor('0', 'USD', true)).toBe(0);
  for (const bad of ['-5', '1,000', '25.555', '$25', 'abc', '', '1000000']) expect(amountMinor(bad, 'USD')).toBeNull();
  // Each currency in its own units: KRW has no minor digits, KWD has three.
  expect(amountMinor('50000', 'KRW')).toBe(50000); expect(amountMinor('50000.5', 'KRW')).toBeNull();
  expect(amountMinor('1.250', 'KWD')).toBe(1250); expect(amountMinor('1.2505', 'KWD')).toBeNull();
  expect(cleanText('  Big   blue\nbelt ', false)).toBe('Big blue belt');
  expect(cleanText(' Line one  \r\nLine two ', true)).toBe('Line one\nLine two');
  expect(nextKey('addon', ['addon_1', 'addon_3'])).toBe('addon_2');
  // An empty receipt note is no note; a blank Korean text falls back to English.
  const edited = editPage(editPage(draft, { type: 'text', target: 'receiptNote', text: { en: '  ', ko: '', es: '' } }), { type: 'addOn', index: 0, patch: { label: { en: 'Uniform', ko: ' ', es: '' } } });
  expect(contentFrom(edited).receiptNote).toBeNull();
  expect(contentFrom(edited).addOns[0]?.label).toEqual({ en: 'Uniform' });
  // Addresses: from a title, and the first free one.
  expect(slugFrom('  Green Belt — Kids!  ')).toBe('green-belt-kids'); expect(slugFrom('Taekwondo Niños')).toBe('taekwondo-ninos');
  expect(freeSlug('Green Belt', ['green-belt', 'green-belt-2'])).toBe('green-belt-3'); expect(freeSlug('!', [])).toBe('page');
  const long = `${'a'.repeat(54)}-bcd`;
  expect(freeSlug(long, [long])).toBe(`${'a'.repeat(54)}-2`);
});

it('edits page details, options, questions and add-ons as pure steps', () => {
  let d: PageDraft = newDraft('trial', 'USD', ['new-page']);
  expect(d).toMatchObject({ pageId: null, version: 0, slug: 'new-page-2', options: [], waiverOn: false, waiver: EMPTY_TEXT });
  // A new page's address follows its English title until staff type their own; a saved page's address is fixed.
  d = editPage(d, { type: 'text', target: 'title', text: { en: 'Summer Camp', ko: '', es: '' } });
  expect(d.slug).toBe('summer-camp');
  d = editPage(d, { type: 'meta', patch: { slug: 'camp-2026' } });
  expect(editPage(d, { type: 'text', target: 'title', text: { en: 'Winter Camp', ko: '', es: '' } }).slug).toBe('camp-2026');
  expect(editPage(draftFrom(first()), { type: 'meta', patch: { slug: 'changed' } }).slug).toBe('green-belt');
  // Multi-participant starts at 4 per order and returns to 1 when turned off.
  d = editPage(d, { type: 'meta', patch: { multiOn: true } }); expect(d.maxPerOrder).toBe('4');
  expect(editPage(d, { type: 'meta', patch: { multiOn: false } }).maxPerOrder).toBe('1');
  d = editPage(d, { type: 'addOption', billing: 'ONE_TIME' }); d = editPage(d, { type: 'addOption', billing: 'MONTHLY' });
  d = editPage(d, { type: 'option', index: 0, patch: { mostPopular: true } }); d = editPage(d, { type: 'option', index: 1, patch: { mostPopular: true } });
  expect(d.options.map((o) => o.mostPopular)).toEqual([false, true]);
  d = editPage(d, { type: 'moveOption', index: 1, by: -1 });
  expect(d.options.map((o) => o.key)).toEqual(['option_2', 'option_1']);
  expect(editPage(d, { type: 'moveOption', index: 0, by: -1 })).toBe(d);
  d = editPage(d, { type: 'duplicateOption', index: 0 });
  expect(d.options.map((o) => [o.key, o.mostPopular])).toEqual([['option_2', true], ['option_3', false], ['option_1', false]]);
  // Without a plan an option cannot create a membership.
  d = editPage(d, { type: 'option', index: 0, patch: { createsMembership: true } }); expect(d.options[0]?.createsMembership).toBe(false);
  d = editPage(d, { type: 'option', index: 0, patch: { planId: planA, createsMembership: true } }); expect(d.options[0]?.createsMembership).toBe(true);
  d = editPage(d, { type: 'option', index: 0, patch: { planId: null } }); expect(d.options[0]?.createsMembership).toBe(false);
  d = editPage(d, { type: 'addField', preset: 'belt' });
  expect(d.customFields[0]).toMatchObject({ key: 'question_1', kind: 'CHOICE', required: true, label: { en: 'Belt size' } });
  expect(d.customFields[0]?.options).toHaveLength(8);
  d = editPage(d, { type: 'addField' }); d = editPage(d, { type: 'field', index: 1, patch: { kind: 'CHOICE' } });
  expect(d.customFields[1]?.options).toEqual([EMPTY_TEXT, EMPTY_TEXT]);
  d = editPage(d, { type: 'addChoice', index: 1 }); d = editPage(d, { type: 'removeChoice', index: 1, choice: 2 });
  d = editPage(d, { type: 'choice', index: 1, choice: 1, text: { en: 'Yes', ko: '', es: 'Sí' } });
  expect(d.customFields[1]?.options[1]).toEqual({ en: 'Yes', ko: '', es: 'Sí' });
  expect(editPage(d, { type: 'field', index: 1, patch: { kind: 'TEXT' } }).customFields[1]?.options).toEqual([]);
  d = editPage(d, { type: 'addAddOn' }); d = editPage(d, { type: 'addAddOn' }); d = editPage(d, { type: 'removeAddOn', index: 0 }); d = editPage(d, { type: 'addAddOn' });
  expect(d.addOns.map((a) => a.key)).toEqual(['addon_2', 'addon_1']);
  d = editPage(d, { type: 'addBlock', position: 'BELOW' }); expect(d.blocks).toEqual([{ position: 'BELOW', text: EMPTY_TEXT }]);
  // Duplicate page: same content as a new page with its own free address.
  const copy = duplicateDraft(first(), ['green-belt', 'green-belt-copy']);
  expect(copy).toMatchObject({ pageId: null, version: 0, slug: 'green-belt-copy-2', title: { en: 'Green Belt (copy)', ko: '그린벨트' } });
  expect(contentFrom(copy).options).toEqual(first().content.options);
});

it('lists every problem in plain words, and states prices and option summaries like the current CRM', () => {
  const r = read();
  const taken = r.pages.map((p) => p.slug);
  let d = editPage(newDraft('nope', 'USD', taken), { type: 'addAddOn' });
  d = editPage(editPage(d, { type: 'addField' }), { type: 'field', index: 0, patch: { kind: 'CHOICE' } });
  d = editPage(d, { type: 'meta', patch: { waiverOn: true, slug: 'free-trial' } });
  d = editPage(editPage(d, { type: 'addOption', billing: 'MONTHLY' }), { type: 'addOption', billing: 'ONE_TIME' });
  d = editPage(d, { type: 'option', index: 1, patch: { planId: planGone, price: '10', label: { en: 'Camp', ko: '', es: '' } } });
  const problems = draftProblems(d, 'PUBLISHED', r.plans, taken, groupKeys);
  expect(problems).toEqual(expect.arrayContaining(['Another page already uses this address. Choose a different one.', 'Choose a page group.', 'The page title needs English text.',
    'Add-on 1 name needs English text.', 'Add-on 1 needs a plain amount in USD, such as 25 or 25.00.', 'Question 1 needs English text.', 'The waiver needs English text.',
    'Option 1 monthly amount needs a plain amount in USD, such as 25 or 25.00.', 'Option 2: Old Summer Camp is no longer available. Choose another plan.']));
  expect(draftProblems(newDraft('trial', 'USD', []), 'PUBLISHED', r.plans, [], groupKeys)).toContain('Add at least one pricing option before publishing.');
  expect(draftProblems(editPage(newDraft('trial', 'USD', []), { type: 'text', target: 'title', text: { en: 'Hi <b>', ko: '', es: '' } }), 'DRAFT', r.plans, [], groupKeys)[0]).toContain('without < or >');
  expect(draftProblems(editPage(newDraft('trial', 'USD', []), { type: 'meta', patch: { slug: 'Bad--Slug' } }), 'DRAFT', r.plans, [], groupKeys)[0]).toContain('lowercase letters');
  // A saved page keeps its own address; an archived page may keep an unavailable plan.
  expect(draftProblems(draftFrom(first()), 'PUBLISHED', r.plans, taken, groupKeys)).toEqual([]);
  const gone = editPage(draftFrom(first()), { type: 'option', index: 0, patch: { planId: planGone } });
  expect(draftProblems(gone, 'DRAFT', r.plans, taken, groupKeys)).toHaveLength(1);
  expect(draftProblems(gone, 'ARCHIVED', r.plans, taken, groupKeys)).toEqual([]);
  expect(() => saveInputFrom(d, 'DRAFT')).toThrow();

  expect(fromPrice(first().content)).toBe('From $450.00 + $225.00/mo');
  expect(fromPrice(r.pages[1]?.content as never)).toBe('$0.00');
  expect(fromPrice(r.pages[2]?.content as never)).toBeNull();
  const [one, month] = draftFrom(first()).options;
  expect(optionSummary(one as never, 'USD')).toBe('Customer pays $1,215.00 today.');
  expect(optionSummary(month as never, 'USD')).toBe('Customer pays $450.00 today (First and last month), then $225.00/mo starting 1 month after purchase, 10 monthly payments in all.');
  expect(optionSummary({ ...(month as never as object), downOn: false, installments: '0' } as never, 'USD')).toBe('Customer pays $225.00 today, then $225.00/mo, ongoing.');
  expect(optionSummary({ ...(month as never as object), recurring: 'abc' } as never, 'USD')).toBeNull();
});

const props = (over: Partial<SchoolCheckoutViewProps> = {}): SchoolCheckoutViewProps => ({
  language: 'en-US', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', read: read() }, filter: 'ALL', editor: null, groups: null, editLanguage: 'en',
  problems: [], outcome: null, locked: false, canRetry: false, ...over });
const editing = (over: Partial<SchoolCheckoutViewProps> = {}, draft: PageDraft = draftFrom(first())) => props({ editor: { draft, dirty: false, tab: 'DETAILS' }, ...over });

it('shows a grid of named pages with group filters, prices, status and actions; archived pages only under Archived', () => {
  const html = renderToStaticMarkup(<SchoolCheckoutView {...props()}/>);
  expect(html).toContain('HON adds no fee'); expect(html).toContain('3 pages · 1 live');
  expect(html.match(/data-testid="checkout-page-card"/g)).toHaveLength(2);
  expect(html).toContain('Green Belt'); expect(html).toContain('Free trial'); expect(html).not.toContain('Old camp');
  expect(html).toContain('From $450.00 + $225.00/mo · 2 options · Multi-participant · Creates membership');
  expect(html).toContain('>Live<'); expect(html).toContain('>Draft<'); expect(html).toContain('Put in draft'); expect(html).toContain('>Publish<');
  expect(html).toContain('Duplicate page'); expect(html).toContain('Manage groups'); expect(html).toContain('>Tournament<');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move Green Belt earlier"/);
  const trial = renderToStaticMarkup(<SchoolCheckoutView {...props({ filter: 'trial' })}/>);
  expect(trial).toContain('Free trial'); expect(trial).not.toContain('Green Belt');
  const archived = renderToStaticMarkup(<SchoolCheckoutView {...props({ filter: 'ARCHIVED' })}/>);
  expect(archived).toContain('Old camp'); expect(archived).toContain('Restore as draft'); expect(archived).not.toContain('Free trial');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ filter: 'event' })}/>)).toContain('No pages in this group.');
  const empty = renderToStaticMarkup(<SchoolCheckoutView {...props({ list: { state: 'READY', read: read({ pages: [], settings: settings({ pageOrder: [] }) }) } })}/>);
  expect(empty).toContain('No checkout pages yet.');
  const groups = renderToStaticMarkup(<SchoolCheckoutView {...props({ groups: [{ key: 'membership', label: 'Membership', ko: '', es: '' }, { key: 'event', label: 'Event', ko: '', es: '' }] })}/>);
  expect(groups).toContain('Save groups'); expect(groups).toContain('>In use<'); expect(groups).toContain('>Remove<');
});

it('edits a page in tabs with a family preview, in the language chosen', () => {
  const details = renderToStaticMarkup(<SchoolCheckoutView {...editing()}/>);
  expect(details).toContain('Edit checkout page'); expect(details).toContain('Live · version 3');
  expect(details).toContain('Page address: green-belt (fixed'); expect(details).toContain('value="Uniform"'); expect(details).toContain('value="45.00"');
  expect(details).toContain('Shirt size'); expect(details).toContain('Family preview'); expect(details).toContain('Due today for one participant: $1,260.00');
  expect(details).toContain('Most popular'); expect(details).not.toContain('data-testid="checkout-pricing"');
  const pricing = renderToStaticMarkup(<SchoolCheckoutView {...editing({ editor: { draft: draftFrom(first()), dirty: true, tab: 'PRICING' } })}/>);
  expect(pricing).toContain('data-testid="checkout-pricing"'); expect(pricing).toMatch(/aria-pressed="true"[^>]*>Pricing options/); expect(pricing).not.toContain('role="tab"'); expect(pricing).toContain('value="1215.00"'); expect(pricing).toContain('value="225.00"');
  expect(pricing).toContain('Auto charge with HON autopay (test mode only)'); expect(pricing).toContain('10 monthly payments in all');
  expect(pricing).toContain('Little Dragons · $150.00'); expect(pricing).not.toContain('Old Summer Camp');
  expect(pricing).toContain('you have unsaved changes'); expect(pricing).toContain('Close without saving');
  const agreement = renderToStaticMarkup(<SchoolCheckoutView {...editing({ editor: { draft: draftFrom(first()), dirty: false, tab: 'AGREEMENT' } })}/>);
  expect(agreement).toContain('I agree to the school rules.'); expect(agreement).toContain('Welcome to the dojang!'); expect(agreement).toContain('Agreement &amp; waiver');
  const korean = renderToStaticMarkup(<SchoolCheckoutView {...editing({ editLanguage: 'ko' })}/>);
  expect(korean).toContain('value="도복"'); expect(korean).toContain('in 한국어 (Korean), optional'); expect(korean).toContain('그린벨트');
  const fresh = renderToStaticMarkup(<SchoolCheckoutView {...editing({ problems: ['The page title needs English text.'] }, newDraft('trial', 'USD', []))}/>);
  expect(fresh).toContain('New checkout page'); expect(fresh).toContain('Not saved yet.'); expect(fresh).toContain('Fix these before saving');
  expect(fresh).toContain('Add at least one pricing option to publish this page.'); expect(fresh).toMatch(/<button[^>]*disabled=""[^>]*>Save and publish/);
  const archived = renderToStaticMarkup(<SchoolCheckoutView {...editing({}, draftFrom(read().pages[2] as never))}/>);
  expect(archived).toContain('Save (stays archived)'); expect(archived).not.toContain('Save as draft');
});

it('shows outcomes plainly and hides everything when concealed or not allowed', () => {
  const unknown = renderToStaticMarkup(<SchoolCheckoutView {...editing({ outcome: { kind: 'UNKNOWN', what: 'PAGE', status: 'PUBLISHED' }, canRetry: true, locked: true })}/>);
  expect(unknown).toContain('nothing happens twice'); expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'CHANGED', what: 'PAGE', status: 'DRAFT' } })}/>)).toContain('Someone else saved this');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'DONE', what: 'PAGE', status: 'DRAFT' } })}/>)).toContain('families do not see drafts');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ outcome: { kind: 'GROUP_IN_USE', what: 'SETTINGS', status: null } })}/>)).toContain('move those pages to another group first');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ list: { state: 'DENIED' } })}/>)).toContain('manage checkout pages permission');
  const hidden = renderToStaticMarkup(<SchoolCheckoutView {...editing({ concealed: true })}/>);
  expect(hidden).not.toContain('Uniform'); expect(hidden).not.toContain('Green Belt'); expect(hidden).toContain('Hidden while this tab');
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
  expect(source).not.toMatch(/application_fee|stripe\.com|squareup|card_number/i);
});
