import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_CHECKOUT_GROUPS, PUBLIC_CHECKOUT_ORDER_KEY, verifyPublicCheckoutOutcome, verifyPublicCheckoutPage, verifySchoolCheckoutPages, type PublicCheckoutOutcome, type PublicCheckoutPage } from '@hon/contracts';
import { CHECKOUT_LINKS_COMMAND, checkoutApi } from '../src/components/school-checkout/http';
import { SchoolCheckoutView, checkoutShareUrl, type SchoolCheckoutViewProps } from '../src/components/school-checkout/view';
import { PublicCheckoutView, checkoutLanguage, draftOrder, draftTotal, emptyDraft, newOrderKey, optionPrice, publicCheckoutApi, signUpOptions,
  type SignUpDraft, type SignUpProps } from '../src/components/school-checkout/public-checkout';
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

const publicRaw = (over: Record<string, unknown> = {}) => ({ publicId: PID, schoolName: 'Ideal Martial Arts', version: 3, title: { en: 'Summer camp', ko: '여름 캠프' },
  description: { en: 'A week of training.' }, currency: 'USD', maxParticipants: 3, blocks: [{ position: 'ABOVE', text: { en: 'Bring water.' } }],
  options: [
    { key: 'week', label: { en: 'Week' }, description: null, billing: 'ONE_TIME', priceMinor: 5000, recurringMinor: null, installments: null, downPayment: null,
      additionalParticipantMinor: 3000, mostPopular: true, placesLeft: 0, inFamilyApp: true },
    { key: 'monthly', label: { en: 'Monthly' }, description: { en: 'Uniform included.' }, billing: 'MONTHLY', priceMinor: null, recurringMinor: 22500, installments: 12,
      downPayment: { amountMinor: 45000, label: { en: 'First and last month' } }, additionalParticipantMinor: null, mostPopular: false, placesLeft: null, inFamilyApp: false },
    { key: 'trial', label: { en: 'Trial' }, description: null, billing: 'ONE_TIME', priceMinor: 0, recurringMinor: null, installments: null, downPayment: null,
      additionalParticipantMinor: null, mostPopular: false, placesLeft: 5, inFamilyApp: true }],
  addOns: [{ key: 'uniform', label: { en: 'Uniform' }, amountMinor: 2500, required: false }], questions: [], hasWaiver: true, waiver: { en: 'I accept the risks.' },
  thankYou: null, canPay: false, testMode: true, ...over });

it('shows the family page read only: prices, places, add-ons and how to sign up, in the family language', () => {
  const page = verifyPublicCheckoutPage(publicRaw(), PID);
  const html = renderToStaticMarkup(<PublicCheckoutView read={page} language="en-US"/>);
  for (const text of ['Ideal Martial Arts', 'Summer camp', 'Bring water.', '$50.00', 'Most popular', '>Full<', '$30.00 for each additional participant',
    '$450.00 today (First and last month), then $225.00 a month for 12 months', '>Free<', '5 places left', 'Uniform: $25.00 (optional)', 'Up to 3 participants',
    'HON Family app', 'Contact Ideal Martial Arts to sign up', 'waiver']) expect(html).toContain(text);
  // With no sign-up wiring (or no card processor) the page stays read only.
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
  expect(source).not.toMatch(/sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML|credentials: 'same-origin'/);
  // 0627: the only thing kept on the device is this link's random order key.
  expect(source.match(/localStorage\.\w+/g)).toEqual(['localStorage.getItem', 'localStorage.setItem', 'localStorage.removeItem']);
});

// 0627: sign up and pay from the link with no account (test mode only).
const payable = (over: Record<string, unknown> = {}) => verifyPublicCheckoutPage(publicRaw({ canPay: true,
  options: [{ ...publicRaw().options[0], placesLeft: 4 }, publicRaw().options[1], publicRaw().options[2]],
  addOns: [{ key: 'uniform', label: { en: 'Uniform' }, amountMinor: 2500, required: false }, { key: 'patch', label: { en: 'Patch' }, amountMinor: 500, required: true }],
  questions: [{ key: 'belt', label: { en: 'Belt' }, kind: 'CHOICE', required: true, options: [{ en: 'White' }, { en: 'Yellow' }] },
    { key: 'photo_ok', label: { en: 'Photos OK' }, kind: 'CHECKBOX', required: false, options: [] },
    { key: 'notes', label: { en: 'Notes' }, kind: 'TEXT', required: false, options: [] }], ...over }), PID);
const filled = (page: PublicCheckoutPage, over: Partial<SignUpDraft> = {}): SignUpDraft => ({ ...emptyDraft(page), optionKey: 'week',
  participants: [{ name: ' Ana Kim ', answers: { belt: 'White', notes: '  ' } }, { name: 'Ben Kim', answers: { belt: 'Yellow', photo_ok: true } }],
  buyer: { name: 'Jo Kim', email: ' Jo@Example.COM ', mobile: '+1 (555) 123-4567' }, waiverAccepted: true, ...over });
const noop = () => undefined;
const signUpProps = (draft: SignUpDraft, over: Partial<SignUpProps> = {}): SignUpProps => ({ draft, onDraft: noop, onSubmit: noop, busy: false, problem: null,
  outcome: null, onPay: noop, onCheck: noop, onCancel: noop, onRestart: noop, ...over });
const order = (status: string, amountMinor = 13500) => ({ orderId: id(70), title: 'Summer camp', optionKey: 'week', participantCount: 2, amountMinor, currency: 'USD',
  status, createdAt: '2026-11-21T10:00:00.000Z' });
const outcome = (over: Record<string, unknown> = {}) => verifyPublicCheckoutOutcome({ result: 'ORDER', order: order('OPEN'), payState: 'OPEN', url: null, expiresAt: null, ...over });

it('offers only one-time online options, and paid ones only when the school can take a card', () => {
  const page = payable();
  expect(signUpOptions(page).map(o => o.key)).toEqual(['week', 'trial']);
  expect(draftTotal(page, 'trial', 1, [])).toBe(500);
  expect(emptyDraft(page)).toMatchObject({ optionKey: '', addOns: ['patch'], waiverAccepted: false, website: '' });
  // Week $50 + second participant $30 + required patch $5 (+ uniform $25 when chosen).
  expect(draftTotal(page, 'week', 2, [])).toBe(8500); expect(draftTotal(page, 'week', 2, ['uniform'])).toBe(11000);
  const noCard = verifyPublicCheckoutPage(publicRaw(), PID);
  expect(signUpOptions(noCard).map(o => o.key)).toEqual(['trial']);
  expect(draftTotal(noCard, 'trial', 1, ['uniform'])).toBe(0);
  expect(signUpOptions(verifyPublicCheckoutPage(publicRaw({ addOns: [{ key: 'patch', label: { en: 'Patch' }, amountMinor: 500, required: true }] }), PID))).toEqual([]);
});

it('turns the form into the server order with trimmed answers, or names the first problem', () => {
  const page = payable();
  expect(draftOrder(page, filled(page))).toEqual({ expectedVersion: 3, optionKey: 'week', waiverAccepted: true, addOns: ['patch'],
    buyer: { name: 'Jo Kim', email: 'jo@example.com', mobile: '+15551234567' },
    participants: [{ name: 'Ana Kim', answers: { belt: 'White' } }, { name: 'Ben Kim', answers: { belt: 'Yellow', photo_ok: true } }], website: '' });
  expect(draftOrder(page, filled(page, { optionKey: 'monthly' }))).toBe('needed');
  expect(draftOrder(page, filled(page, { participants: [{ name: 'Ana', answers: {} }] }))).toBe('needed');
  expect(draftOrder(page, filled(page, { participants: [{ name: 'x'.repeat(121), answers: { belt: 'White' } }] }))).toBe('badName');
  expect(draftOrder(page, filled(page, { participants: Array.from({ length: 4 }, () => ({ name: 'Ana', answers: { belt: 'White' } })) }))).toBe('invalid');
  expect(draftOrder(page, filled(page, { buyer: { name: 'Jo', email: 'not-an-email', mobile: '' } }))).toBe('badEmail');
  expect(draftOrder(page, filled(page, { buyer: { name: 'Jo', email: 'jo@example.com', mobile: '555' } }))).toBe('badMobile');
  expect(draftOrder(page, filled(page, { waiverAccepted: false }))).toBe('waiverNeeded');
  expect(draftOrder(page, filled(page, { website: 'spam' }))).toMatchObject({ website: 'spam' });
});

it('shows the sign-up form with the waiver, questions, total and a hidden bot field', () => {
  const page = payable();
  const html = renderToStaticMarkup(<PublicCheckoutView read={page} language="en" signUp={signUpProps(filled(page))}/>);
  for (const text of ['data-testid="public-checkout-form"', 'Participant 1', 'Participant 2', 'Belt (required)', 'Photos OK', 'Patch: $5.00 (required)',
    'I accept the risks.', 'I have read and accept the waiver.', 'Total: $85.00', 'Continue to payment', 'Test mode: no real money is charged.', 'aria-hidden="true"'])
    expect(html).toContain(text);
  expect(html).not.toContain('Contact Ideal Martial Arts to sign up');
  expect(renderToStaticMarkup(<PublicCheckoutView read={page} language="en" signUp={signUpProps(filled(page), { problem: 'fullNow' })}/>)).toContain('There are not enough places left.');
  const free = verifyPublicCheckoutPage(publicRaw(), PID);
  const freeHtml = renderToStaticMarkup(<PublicCheckoutView read={free} language="es" signUp={signUpProps(emptyDraft(free))}/>);
  expect(freeHtml).toContain('Total: Gratis'); expect(freeHtml).toContain('>Inscribirse</button>'); expect(freeHtml).not.toContain('<legend>Extras</legend>');
});

it('shows where the order stands: unpaid with pay, processing, paid with the thank-you, review, or ended', () => {
  const page = payable({ thankYou: { en: 'See you Monday!' } });
  const at = (o: PublicCheckoutOutcome) => renderToStaticMarkup(<PublicCheckoutView read={page} language="en" signUp={signUpProps(emptyDraft(page), { outcome: o })}/>);
  const open = at(outcome());
  for (const text of ['waiting for payment', 'Total: $135.00', 'Pay now', 'Check again', 'Cancel this sign-up']) expect(open).toContain(text);
  expect(open).not.toContain('public-checkout-form');
  expect(at(outcome({ payState: 'PROCESSING' }))).toContain('still processing');
  const paid = at(outcome({ order: order('PAID'), payState: 'SUCCEEDED' }));
  expect(paid).toContain('signed up'); expect(paid).toContain('See you Monday!'); expect(paid).not.toContain('Pay now');
  expect(at(outcome({ order: order('REVIEW'), payState: 'SUCCEEDED' }))).toContain('will review');
  expect(at(outcome({ order: order('CANCELED'), payState: 'EXPIRED' }))).toContain('Start a new sign-up');
});

it('sends each order step as cookie-less JSON to its own path and accepts only a closed answer', async () => {
  const body = { key: 'k'.repeat(32) };
  const f = stub(json({ data: { result: 'ORDER', order: order('OPEN'), payState: 'OPEN', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expiresAt: '2026-11-21T10:30:00.000Z' } }));
  const answer = await publicCheckoutApi.step(PID, 'orders/pay', body, signal());
  expect(typeof answer === 'object' && answer.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/checkout-pages/${PID}/orders/pay`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', body: JSON.stringify(body) });
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  stub(json({ result: 'RATE_LIMITED' }, 429)); expect(await publicCheckoutApi.step(PID, 'orders', body, signal())).toMatchObject({ result: 'RATE_LIMITED', order: null });
  stub(json({ data: { result: 'ORDER', order: null, payState: 'NONE', url: null, expiresAt: null } })); expect(await publicCheckoutApi.step(PID, 'orders', body, signal())).toBe('UNAVAILABLE');
  stub(json({ result: 'UNAVAILABLE' }, 503)); expect(await publicCheckoutApi.step(PID, 'orders/status', body, signal())).toBe('UNAVAILABLE');
  expect(await publicCheckoutApi.step('nope', 'orders', body, signal())).toBe('UNAVAILABLE');
  expect(newOrderKey()).toMatch(PUBLIC_CHECKOUT_ORDER_KEY); expect(newOrderKey()).not.toBe(newOrderKey());
});
