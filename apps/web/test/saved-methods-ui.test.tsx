import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { MethodError, keepForRetry, methodErrorFor, methodsQueryFrom, savedMethodsApi } from '../src/components/saved-methods/http';
import { methodBody, payerOptions, takeMethodsQuery } from '../src/components/saved-methods/saved-methods';
import { CONSENT, SavedMethodsView, methodLabel, type SavedMethodsViewProps } from '../src/components/saved-methods/view';
import { id } from './account-status-fixtures';

// B-TUI-2 piece 3-web (0321): staff save a payer's card or bank account with the school's own processor, test mode only, no HON fee.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), payerId = id(10), connectionId = id(30), methodId = id(40), setupId = id(50), key = id(77);
const scope = { organizationId: org, schoolId: school };
const state = 's'.repeat(43);
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MethodError; } throw new Error('expected a failure'); };
const method = (over: Record<string, unknown> = {}) => ({ methodId, billingAccountId: payerId, connectionId, kind: 'CARD', brand: 'VISA', last4: '4242', expMonth: 12, expYear: 2034,
  status: 'ACTIVE', isDefault: false, consentTextVersion: 'card-on-file-v1', version: 2, createdAt: '2026-11-11T10:00:00.000Z', removedAt: null, removeReason: null, ...over });
const setup = (over: Record<string, unknown> = {}) => ({ setupId, billingAccountId: payerId, connectionId, state: 'PENDING', methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1',
  expiresAt: '2026-11-11T11:00:00.000Z', methodId: null, version: 1, createdAt: '2026-11-11T10:00:00.000Z', ...over });
const conn = (over: Record<string, unknown> = {}) => ({ connectionId, providerCode: 'STRIPE_CONNECT', displayName: 'Stripe', isDefault: true, storedCard: true, bankDebit: true, hasCustomer: true, ...over });
const payerRaw = (over: Record<string, unknown> = {}) => ({ billingAccountId: payerId, canManage: true, platformFee: 'NONE', payerName: 'Rivera family',
  connections: [conn()], methods: [method()], setups: [], ...over });

it('reads a payer as a plain same-origin GET, and refuses any provider reference or drift', async () => {
  const f = stub(json({ data: payerRaw(), meta }));
  const read = await savedMethodsApi.payer({ organizationId: org.toUpperCase(), schoolId: school }, payerId, signal(), () => true);
  expect(read.platformFee).toBe('NONE'); expect(read.connections[0]?.hasCustomer).toBe(true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/payers/${payerId}/methods`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [payerRaw({ platformFee: 'PERCENT' }), payerRaw({ billingAccountId: id(11) }), payerRaw({ connections: [{ ...conn(), accountRef: 'acct_sim1' }] }),
    payerRaw({ connections: [{ ...conn(), customerRef: 'cus_sim1' }] }), payerRaw({ setups: [{ ...setup(), setupRef: 'seti_sim1' }] }), payerRaw({ extra: 1 })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(savedMethodsApi.payer(scope, payerId, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const g = stub(json({ data: { asOfMonth: '2026-11', methods: [] }, meta }));
  await savedMethodsApi.expiring(scope, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/saved-methods/expiring`);
});

it('sends each command with its own human-command header and key, and verifies the receipt', async () => {
  const url = `https://checkout.stripe.com/setup/x?state=${state}`;
  const f = stub(json({ data: { setup: setup(), setupUrl: url }, meta }));
  const start = await savedMethodsApi.startSetup(scope, payerId, { connectionId, methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1' }, key, signal(), () => true);
  expect(start.setupUrl).toBe(url);
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/payers/${payerId}/method-setups`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'school_pay.method.setup', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({ connectionId, methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1' });
  for (const bad of [{ setup: setup(), setupUrl: 'javascript:alert(1)' }, { setup: { ...setup(), setupRef: 'seti_sim1' }, setupUrl: url },
    { setup: setup({ connectionId: id(31) }), setupUrl: url }, { setup: setup({ state: 'COMPLETED', methodId }), setupUrl: url }]) {
    stub(json({ data: bad, meta }));
    expect((await fails(savedMethodsApi.startSetup(scope, payerId, { connectionId, methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ data: { setup: setup(), setupUrl: null }, meta: { ...meta, replayed: true } }));
  expect((await savedMethodsApi.startSetup(scope, payerId, { connectionId, methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1' }, key, signal(), () => true)).setupUrl).toBeNull();

  const g = stub(json({ data: { method: method() }, meta }));
  await savedMethodsApi.finishSetup(scope, payerId, setupId, { expectedVersion: 1, setupState: state }, key, signal(), () => true);
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/payers/${payerId}/method-setups/${setupId}/finish`);
  expect(init).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.method.finish' } });

  const h = stub(json({ data: { method: method({ isDefault: true, version: 3 }) }, meta }));
  await savedMethodsApi.setDefault(scope, payerId, methodId, { expectedVersion: 2 }, key, signal(), () => true);
  [path, init] = h.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toMatch(/\/methods\/[0-9a-f-]+\/default$/); expect(init).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.method.default' } });
  stub(json({ data: { method: method() }, meta }));
  expect((await fails(savedMethodsApi.setDefault(scope, payerId, methodId, { expectedVersion: 2 }, key, signal(), () => true))).kind).toBe('UNKNOWN');

  const removed = method({ status: 'REMOVED', removedAt: '2026-11-11T12:00:00.000Z', removeReason: 'Card replaced', version: 3 });
  const r = stub(json({ data: { method: removed }, meta: { ...meta, providerDetached: false } }));
  expect((await savedMethodsApi.remove(scope, payerId, methodId, { expectedVersion: 2, reason: 'Card replaced' }, key, signal(), () => true)).providerDetached).toBe(false);
  expect((r.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.method.remove' } });

  const none = stub(json({}));
  expect((await fails(savedMethodsApi.remove(scope, payerId, methodId, { expectedVersion: 2, reason: '' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(savedMethodsApi.setDefault(scope, payerId, methodId, { expectedVersion: 2 }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(methodErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(methodErrorFor(409, 'SCHOOL_PAY_SETUP_INCOMPLETE').kind).toBe('INCOMPLETE');
  expect(methodErrorFor(409, 'SCHOOL_PAY_METHOD_ALREADY_DEFAULT').kind).toBe('STATE');
  expect(methodErrorFor(403, 'SCHOOL_PAY_SETUP_STATE_MISMATCH').kind).toBe('STATE_MISMATCH');
  expect(methodErrorFor(403, 'SCHOOL_PAY_METHOD_MANAGE_FORBIDDEN').kind).toBe('DENIED');
  expect(methodErrorFor(422, 'SCHOOL_PAY_SETUP_EXPIRED').kind).toBe('EXPIRED');
  expect(methodErrorFor(422, 'SCHOOL_PAY_METHODS_UNAVAILABLE').kind).toBe('UNAVAILABLE');
  expect(methodErrorFor(422, 'SCHOOL_PAY_CUSTOMER_MISMATCH').kind).toBe('CUSTOMER_MISMATCH');
  expect(methodErrorFor(503, 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED').kind).toBe('NOT_CONFIGURED');
  expect(methodErrorFor(503, 'SCHOOL_PAY_PROVIDER_UNKNOWN').kind).toBe('UNKNOWN');
  expect(methodErrorFor(409, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new MethodError('UNKNOWN'))).toBe(true); expect(keepForRetry(new MethodError('RATE'))).toBe(true);
  expect(keepForRetry(new MethodError('STATE'))).toBe(false);
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(savedMethodsApi.payer(scope, payerId, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(savedMethodsApi.payer(scope, payerId, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('takes the link out of the address bar at once and accepts only a well-formed return', () => {
  const replace = vi.fn();
  const query = takeMethodsQuery({ pathname: '/staff/billing/saved-payment-methods', search: `?payer=${payerId.toUpperCase()}&setup=${setupId}&state=${state}` }, { replaceState: replace });
  expect(query).toEqual({ payerId, returned: { payerId, setupId, setupState: state } });
  expect(replace).toHaveBeenCalledWith(null, '', '/staff/billing/saved-payment-methods');
  expect(methodsQueryFrom(`?payer=${payerId}`)).toEqual({ payerId, returned: null });
  expect(methodsQueryFrom(`?payer=${payerId}&setup=${setupId}&state=short`).returned).toBeNull();
  expect(methodsQueryFrom(`?setup=${setupId}&state=${state}`)).toEqual({ payerId: null, returned: null });
  const again = vi.fn();
  expect(takeMethodsQuery({ pathname: '/p', search: '?payer=nope' }, { replaceState: again })).toEqual({ payerId: null, returned: null });
  expect(again).toHaveBeenCalledOnce();
  const untouched = vi.fn();
  takeMethodsQuery({ pathname: '/p', search: '' }, { replaceState: untouched });
  expect(untouched).not.toHaveBeenCalled();
});

it('builds bodies from the verified read only: the consent version, the setup version, the matching return, a single-line reason', () => {
  const read = payerRaw({ setups: [setup()] }) as never;
  expect(methodBody('setup', read, connectionId, { kind: 'US_BANK_ACCOUNT' })).toEqual({ connectionId, methodKinds: ['US_BANK_ACCOUNT'], consentTextVersion: CONSENT.US_BANK_ACCOUNT.version });
  expect(() => methodBody('setup', payerRaw({ connections: [conn({ bankDebit: false })] }) as never, connectionId, { kind: 'US_BANK_ACCOUNT' })).toThrow();
  expect(() => methodBody('setup', read, id(31))).toThrow();
  const back = { payerId, setupId, setupState: state };
  expect(methodBody('finish', read, setupId, { returned: back })).toEqual({ expectedVersion: 1, setupState: state });
  expect(() => methodBody('finish', read, setupId, { returned: { ...back, payerId: id(11) } })).toThrow();
  expect(() => methodBody('finish', payerRaw() as never, setupId, { returned: back })).toThrow();
  expect(() => methodBody('finish', read, setupId, { returned: null })).toThrow();
  expect(methodBody('default', read, methodId)).toEqual({ expectedVersion: 2 });
  expect(methodBody('remove', read, methodId, { reason: '  Card\nreplaced ' })).toEqual({ expectedVersion: 2, reason: 'Card replaced' });
  expect(() => methodBody('default', payerRaw({ canManage: false }) as never, methodId)).toThrow();
  expect(() => methodBody('remove', read, id(41), { reason: 'x' })).toThrow();
  const items = [{ billingAccountId: payerId, participant: { givenName: 'Ana', familyName: 'Rivera' } }, { billingAccountId: payerId, participant: { givenName: 'Leo', familyName: 'Rivera' } },
    { billingAccountId: payerId, participant: { givenName: 'Ana', familyName: 'Rivera' } }, { billingAccountId: id(11), participant: null }] as never;
  expect(payerOptions(items)).toEqual([{ payerId, label: 'Ana Rivera, Leo Rivera' }, { payerId: id(11), label: 'Payer with no participant recorded' }]);
});

const props = (over: Partial<SavedMethodsViewProps> = {}): SavedMethodsViewProps => ({ language: 'en-US', waiting: false, concealed: false, hasSchool: true, schoolName: 'Tiger Dojo',
  payers: { state: 'READY', payers: [{ payerId, label: 'Ana Rivera' }] }, payerId, payer: { state: 'READY', read: payerRaw() as never },
  expiring: { state: 'READY', read: { asOfMonth: '2026-11', methods: [] } }, returned: null, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows saved methods and only the actions the staff permission allows; the consent names the school', () => {
  const page = renderToStaticMarkup(<SavedMethodsView {...props()}/>);
  expect(page).toContain('Visa ending 4242 · expires 12/2034'); expect(page).toContain('HON takes no fee'); expect(page).toContain('Test mode only');
  expect(page).toContain('Make default'); expect(page).toContain('Add a card or bank account');
  const readOnly = renderToStaticMarkup(<SavedMethodsView {...props({ payer: { state: 'READY', read: payerRaw({ canManage: false }) as never } })}/>);
  for (const action of ['Make default', 'Add a card or bank account', '>Remove<']) expect(readOnly).not.toContain(action);
  const add = renderToStaticMarkup(<SavedMethodsView {...props({ form: { kind: 'add' } })}/>);
  expect(add).toContain('I allow Tiger Dojo to save this card'); expect(add).toContain('US bank account'); expect(add).toContain('HON never sees the card or account number');
  const noBank = renderToStaticMarkup(<SavedMethodsView {...props({ form: { kind: 'add' }, payer: { state: 'READY', read: payerRaw({ connections: [conn({ bankDebit: false })] }) as never } })}/>);
  expect(noBank).not.toContain('US bank account');
  const noConn = renderToStaticMarkup(<SavedMethodsView {...props({ payer: { state: 'READY', read: payerRaw({ connections: [] }) as never } })}/>);
  expect(noConn).toContain('Connect a payment processor'); expect(noConn).not.toContain('Add a card or bank account');
  const remove = renderToStaticMarkup(<SavedMethodsView {...props({ form: { kind: 'remove', methodId } })}/>);
  expect(remove).toContain('data-testid="remove-form"');
  expect(methodLabel({ brand: 'BANK', last4: '6789', expMonth: null, expYear: null })).toBe('Bank account ending 6789');
});

it('offers Finish saving only with a return, lists expiring cards, and shows outcomes plainly', () => {
  const back = { payerId, setupId, setupState: state };
  const finish = renderToStaticMarkup(<SavedMethodsView {...props({ returned: back })}/>);
  expect(finish).toContain('Finish saving'); expect(finish).not.toContain(state);
  expect(renderToStaticMarkup(<SavedMethodsView {...props()}/>)).not.toContain('Finish saving');
  const expiring = renderToStaticMarkup(<SavedMethodsView {...props({ expiring: { state: 'READY', read: { asOfMonth: '2026-11', methods: [
    { methodId, billingAccountId: payerId, payerName: 'Rivera family', connectionId, brand: 'VISA', last4: '1111', expMonth: 10, expYear: 2026, isDefault: true, expired: true }] } } })}/>);
  expect(expiring).toContain('Rivera family'); expect(expiring).toContain('ending 1111'); expect(expiring).toContain('expired');
  const unknown = renderToStaticMarkup(<SavedMethodsView {...props({ outcome: { kind: 'UNKNOWN', action: 'finish' }, canRetry: true })}/>);
  expect(unknown).toContain('nothing happens twice'); expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<SavedMethodsView {...props({ outcome: { kind: 'DONE', action: 'remove', providerDetached: false } })}/>)).toContain('did not confirm');
  expect(renderToStaticMarkup(<SavedMethodsView {...props({ outcome: { kind: 'EXPIRED', action: 'finish' } })}/>)).toContain('setups last one hour');
  expect(renderToStaticMarkup(<SavedMethodsView {...props({ payer: { state: 'DENIED' } })}/>)).toContain('not allowed');
  const hidden = renderToStaticMarkup(<SavedMethodsView {...props({ concealed: true })}/>);
  expect(hidden).not.toContain('4242'); expect(hidden).toContain('Hidden while');
});

it('is a protected dynamic noindex no-referrer page in the billing menu and the route manifest, with nothing kept in storage', () => {
  const page = readFileSync('src/app/staff/billing/saved-payment-methods/page.tsx', 'utf8');
  expect(page).toContain("export const dynamic = 'force-dynamic'"); expect(page).toContain('requireVerifiedWebSession'); expect(page).toContain('index: false');
  expect(page).toContain("referrer: 'no-referrer'");
  expect(page).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/billing/saved-payment-methods')?.href).toBe('/staff/billing/saved-payment-methods');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'billing')?.routes.some((r) => r.href === '/staff/billing/saved-payment-methods')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/billing/saved-payment-methods')).toEqual([{ path: '/staff/billing/saved-payment-methods', title: 'HON | Saved payment methods' }]);
  const source = ['saved-methods.tsx', 'http.ts', 'view.tsx'].map((f) => readFileSync(`src/components/saved-methods/${f}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML/);
});
