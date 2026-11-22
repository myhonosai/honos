import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_CHECKOUT_GROUPS, verifyPublicCheckoutPage, verifySchoolCheckoutPages } from '@hon/contracts';
import { CHECKOUT_LINKS_COMMAND, checkoutApi } from '../src/components/school-checkout/http';
import { SchoolCheckoutView, checkoutShareUrl, type SchoolCheckoutViewProps } from '../src/components/school-checkout/view';
import { PublicCheckoutView, checkoutLanguage, optionPrice, publicCheckoutApi } from '../src/components/school-checkout/public-checkout';
import { id } from './account-status-fixtures';

// Checkout page share links (0620): a Copy link / Open page pair on each live page, and the read-only family page.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const org = id(1), school = id(2), pageA = id(60), pageB = id(61), scope = { organizationId: org, schoolId: school };
const PID = 'a1'.repeat(24), PID_B = 'b2'.repeat(24);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const oneTime = (over: Record<string, unknown> = {}) => ({ key: 'option_1', label: { en: 'Week' }, description: null, planId: null, billing: 'ONE_TIME', priceMinor: 5000,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0, availableThrough: null,
  mostPopular: false, createsMembership: false, ...over });
const content = (title: string) => ({ currency: 'USD', title: { en: title }, description: null, blocks: [], multiParticipant: { enabled: false, maxPerOrder: 1 },
  customFields: [], addOns: [], options: [oneTime()], waiver: null, receiptNote: null, thankYou: null });
const read = verifySchoolCheckoutPages({ settings: { version: 0, groups: DEFAULT_CHECKOUT_GROUPS, pageOrder: [] }, plans: [], pages: [
  { pageId: pageA, slug: 'summer-camp', groupKey: 'camp', status: 'PUBLISHED', content: content('Summer camp'), version: 2, updatedAt: '2026-11-21T10:00:00.000Z' },
  { pageId: pageB, slug: 'trial', groupKey: 'trial', status: 'DRAFT', content: content('Trial'), version: 1, updatedAt: '2026-11-21T10:00:00.000Z' }] });
const props = (over: Partial<SchoolCheckoutViewProps> = {}): SchoolCheckoutViewProps => ({
  language: 'en-US', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', read }, filter: 'ALL', editor: null, groups: null, editLanguage: 'en',
  problems: [], outcome: null, locked: false, canRetry: false, origin: 'https://app.myhonos.com', links: { state: 'READY', byPage: { [pageA]: PID, [pageB]: PID_B } }, ...over });

it('asks for the links as their own human command with no key and accepts only a closed answer', async () => {
  const f = stub(json({ data: { links: [{ pageId: pageA, publicId: PID }] }, meta: {} }));
  expect((await checkoutApi.links(scope, signal(), () => true)).links[0]?.publicId).toBe(PID);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/checkout-pages/links`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': CHECKOUT_LINKS_COMMAND } });
  expect(Object.keys(init.headers as object).some((k) => /idempotency/i.test(k))).toBe(false);
  expect(CHECKOUT_LINKS_COMMAND).toBe('school_checkout.links.issue');
  stub(json({ data: { links: [{ pageId: pageA, publicId: 'x' }] }, meta: {} }));
  await expect(checkoutApi.links(scope, signal(), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'SCHOOL_CHECKOUT_FORBIDDEN' }, 403));
  await expect(checkoutApi.links(scope, signal(), () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('shows the family link with Copy link and Open page on a live page only', () => {
  const html = renderToStaticMarkup(<SchoolCheckoutView {...props()}/>);
  const url = checkoutShareUrl('https://app.myhonos.com', PID);
  expect(url).toBe(`https://app.myhonos.com/checkout/${PID}`);
  expect(html).toContain(`<code data-testid="checkout-link">${url}</code>`);
  expect(html).toContain('>Copy link<');
  expect(html).toMatch(new RegExp(`<a[^>]*href="${url}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Open page</a>`));
  expect(html).not.toContain(PID_B);
  expect(html).toContain('this page opens for families once it is live');
  expect(html).not.toContain('Families cannot open these pages yet');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ copied: pageA })}/>)).toContain('>Copied<');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ copied: `failed:${pageA}` })}/>)).toContain('Could not copy');
  expect(renderToStaticMarkup(<SchoolCheckoutView {...props({ links: { state: 'LOADING' } })}/>)).toContain('Getting the family link');
  const failed = renderToStaticMarkup(<SchoolCheckoutView {...props({ links: { state: 'UNAVAILABLE' } })}/>);
  expect(failed).toContain('could not be loaded'); expect(failed).not.toContain('Copy link');
});

const publicRaw = (over: Record<string, unknown> = {}) => ({ publicId: PID, schoolName: 'Ideal Martial Arts', title: { en: 'Summer camp', ko: '여름 캠프' },
  description: { en: 'A week of training.' }, currency: 'USD', maxParticipants: 3, blocks: [{ position: 'ABOVE', text: { en: 'Bring water.' } }],
  options: [
    { key: 'week', label: { en: 'Week' }, description: null, billing: 'ONE_TIME', priceMinor: 5000, recurringMinor: null, installments: null, downPayment: null,
      additionalParticipantMinor: 3000, mostPopular: true, placesLeft: 0, inFamilyApp: true },
    { key: 'monthly', label: { en: 'Monthly' }, description: { en: 'Uniform included.' }, billing: 'MONTHLY', priceMinor: null, recurringMinor: 22500, installments: 12,
      downPayment: { amountMinor: 45000, label: { en: 'First and last month' } }, additionalParticipantMinor: null, mostPopular: false, placesLeft: null, inFamilyApp: false },
    { key: 'trial', label: { en: 'Trial' }, description: null, billing: 'ONE_TIME', priceMinor: 0, recurringMinor: null, installments: null, downPayment: null,
      additionalParticipantMinor: null, mostPopular: false, placesLeft: 5, inFamilyApp: true }],
  addOns: [{ label: { en: 'Uniform' }, amountMinor: 2500, required: false }], hasWaiver: true, ...over });

it('shows the family page read only: prices, places, add-ons and how to sign up, in the family language', () => {
  const page = verifyPublicCheckoutPage(publicRaw(), PID);
  const html = renderToStaticMarkup(<PublicCheckoutView read={page} language="en-US"/>);
  for (const text of ['Ideal Martial Arts', 'Summer camp', 'Bring water.', '$50.00', 'Most popular', '>Full<', '$30.00 for each additional participant',
    '$450.00 today (First and last month), then $225.00 a month for 12 months', '>Free<', '5 places left', 'Uniform: $25.00 (optional)', 'Up to 3 participants',
    'HON Family app', 'Contact the school to sign up', 'waiver']) expect(html).toContain(text);
  expect(html).not.toMatch(/<form|<input|<button/);
  expect(renderToStaticMarkup(<PublicCheckoutView read={page} language="ko"/>)).toContain('여름 캠프');
  expect(renderToStaticMarkup(<PublicCheckoutView read={verifyPublicCheckoutPage(publicRaw({ options: [publicRaw().options[1]] }), PID)} language="en"/>)).not.toContain('HON Family app');
  expect(checkoutLanguage('es-MX')).toBe('es'); expect(checkoutLanguage('fr')).toBe('en');
  expect(optionPrice(page.options[1]!, 'USD', 'es')).toContain('al mes');
  expect(renderToStaticMarkup(<PublicCheckoutView read="NOT_FOUND" language="en"/>)).toContain('This page is not available');
  expect(renderToStaticMarkup(<PublicCheckoutView read="UNAVAILABLE" language="en"/>)).toContain('Try again');
});

it('reads the family page with no cookie and only for a well-formed link', async () => {
  const f = stub(json({ data: publicRaw() }));
  const page = await publicCheckoutApi.read(PID, signal());
  expect(typeof page === 'object' && page.title.en).toBe('Summer camp');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/checkout-pages/${PID}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  expect(await publicCheckoutApi.read('nope', signal())).toBe('NOT_FOUND');
  stub(json({ result: 'INVALID' }, 404)); expect(await publicCheckoutApi.read(PID, signal())).toBe('NOT_FOUND');
  stub(json({ data: publicRaw({ publicId: PID_B }) })); expect(await publicCheckoutApi.read(PID, signal())).toBe('UNAVAILABLE');
  stub(json({ data: publicRaw(), extra: 1 })); expect(await publicCheckoutApi.read(PID, signal())).toBe('UNAVAILABLE');
  stub(json({ result: 'UNAVAILABLE' }, 503)); expect(await publicCheckoutApi.read(PID, signal())).toBe('UNAVAILABLE');
});

it('is a dynamic noindex public route in the route manifest that never reads a session', () => {
  const route = readFileSync('src/app/checkout/[publicId]/page.tsx', 'utf8');
  expect(route).toContain("export const dynamic = 'force-dynamic'"); expect(route).toContain('index: false'); expect(route).toContain("referrer: 'no-referrer'");
  expect(route).not.toMatch(/requireVerifiedWebSession|cookies\(|searchParams/);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/checkout/:publicId')).toEqual([{ path: '/checkout/:publicId', title: 'Sign up' }]);
  const source = readFileSync('src/components/school-checkout/public-checkout.tsx', 'utf8');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML|credentials: 'same-origin'/);
});
