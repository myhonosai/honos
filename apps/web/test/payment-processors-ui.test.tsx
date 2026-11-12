import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { ProcessorError, keepForRetry, processorErrorFor, processorsApi, providerReturnFrom, safeOnboardingUrl } from '../src/components/payment-processors/http';
import { processorBody, takeProviderReturn } from '../src/components/payment-processors/payment-processors';
import { PaymentProcessorsView, type PaymentProcessorsViewProps } from '../src/components/payment-processors/view';
import { id } from './account-status-fixtures';

// B-TUI-2 piece 1-web (0258): the staff page connects the school's own Stripe or Square account, test mode only, no HON fee.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), connectionId = id(30), key = id(77), scope = { organizationId: org, schoolId: school };
const state = 's'.repeat(43);
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ProcessorError; } throw new Error('expected a failure'); };
const ALL = { bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true };
const NONE = { bankDebit: false, offSessionRecurring: false, oneTimeCard: false, refunds: false, storedCard: false };
const connection = (over: Record<string, unknown> = {}) => ({ connectionId, providerCode: 'STRIPE_CONNECT', mode: 'TEST', state: 'CONNECTED_ACTIVE', accountRef: 'acct_sim1234',
  chargesEnabled: true, payoutsEnabled: true, requirementsDue: false, capabilities: ALL, isDefault: false, onboardingPending: false, version: 3,
  statusObservedAt: '2026-11-11T10:00:00.000Z', startedAt: '2026-11-11T09:00:00.000Z', endedAt: null, endReason: null, ...over });
const pending = (over: Record<string, unknown> = {}) => connection({ state: 'PENDING_ONBOARDING', accountRef: null, chargesEnabled: false, payoutsEnabled: false,
  capabilities: NONE, onboardingPending: true, version: 2, statusObservedAt: null, ...over });
const providers = [{ providerCode: 'STRIPE_CONNECT', displayName: 'Stripe', testSupported: true, liveAllowed: false },
  { providerCode: 'SQUARE', displayName: 'Square', testSupported: true, liveAllowed: false }];
const processorsRaw = (over: Record<string, unknown> = {}) => ({ canManage: true, platformFee: 'NONE', providers, connections: [connection()], ...over });

it('reads processors as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: processorsRaw(), meta }));
  const read = await processorsApi.processors({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.platformFee).toBe('NONE');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/processors`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [processorsRaw({ platformFee: 'PERCENT' }), processorsRaw({ providers: [{ ...providers[0], liveAllowed: true }] }),
    processorsRaw({ connections: [connection({ mode: 'LIVE' })] }), processorsRaw({ extra: 1 })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(processorsApi.processors(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('sends each command with its own human-command header and key, and verifies the receipt', async () => {
  const f = stub(json({ data: { connection: pending() }, meta: { ...meta, replayed: false } }));
  await processorsApi.start(scope, 'STRIPE_CONNECT', key, signal(), () => true);
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/processors/connections`);
  expect(init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'school_pay.connection.start', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual({ providerCode: 'STRIPE_CONNECT' });
  // A start answered for another provider is never accepted.
  stub(json({ data: { connection: pending({ providerCode: 'SQUARE' }) }, meta }));
  expect((await fails(processorsApi.start(scope, 'STRIPE_CONNECT', key, signal(), () => true))).kind).toBe('UNKNOWN');

  const url = `https://connect.stripe.com/setup/x?state=${state}`;
  const g = stub(json({ data: { connection: pending(), onboardingUrl: url }, meta }));
  expect((await processorsApi.onboardingLink(scope, connectionId, { expectedVersion: 2 }, key, signal(), () => true)).onboardingUrl).toBe(url);
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/payments/processors/connections/${connectionId}/onboarding-link`);
  expect(init).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.connection.onboarding_link' } });
  stub(json({ data: { connection: pending(), onboardingUrl: null }, meta: { ...meta, replayed: true } }));
  expect((await processorsApi.onboardingLink(scope, connectionId, { expectedVersion: 2 }, key, signal(), () => true)).onboardingUrl).toBeNull();
  for (const bad of ['javascript:alert(1)', 'http://evil.example/x', 'https://user:pw@connect.stripe.com/x']) {
    stub(json({ data: { connection: pending(), onboardingUrl: bad }, meta }));
    expect((await fails(processorsApi.onboardingLink(scope, connectionId, { expectedVersion: 2 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }

  const h = stub(json({ data: { connection: connection({ version: 3 }) }, meta }));
  await processorsApi.finish(scope, connectionId, { expectedVersion: 2, state, authorizationCode: 'sim_abc' }, key, signal(), () => true);
  [path, init] = h.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toMatch(/\/connections\/[0-9a-f-]+\/finish$/);
  expect(init).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.connection.finish' } });
  expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2, state, authorizationCode: 'sim_abc' });
  // A finish that answers still pending is not success.
  stub(json({ data: { connection: pending() }, meta }));
  expect((await fails(processorsApi.finish(scope, connectionId, { expectedVersion: 2, state }, key, signal(), () => true))).kind).toBe('UNKNOWN');

  stub(json({ data: { connection: connection({ isDefault: false }) }, meta }));
  expect((await fails(processorsApi.setDefault(scope, connectionId, { expectedVersion: 3 }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const d = stub(json({ data: { connection: connection({ isDefault: true, version: 4 }) }, meta }));
  await processorsApi.setDefault(scope, connectionId, { expectedVersion: 3 }, key, signal(), () => true);
  expect((d.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'school_pay.connection.default' } });

  const ended = connection({ state: 'DISCONNECTED', capabilities: NONE, chargesEnabled: false, endedAt: '2026-11-11T12:00:00.000Z', endReason: 'Switching', version: 4 });
  stub(json({ data: { connection: ended }, meta: { ...meta, providerRevoked: true } }));
  expect((await processorsApi.disconnect(scope, connectionId, { expectedVersion: 3, reason: 'Switching' }, key, signal(), () => true)).providerRevoked).toBe(true);
  stub(json({ data: { connection: ended }, meta }));
  expect((await processorsApi.disconnect(scope, connectionId, { expectedVersion: 3, reason: 'Switching' }, key, signal(), () => true)).providerRevoked).toBe(false);

  // Bad input or key never reaches the network.
  const none = stub(json({}, 500));
  expect((await fails(processorsApi.start(scope, 'PAYPAL' as never, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(processorsApi.refresh(scope, connectionId, { expectedVersion: 3 }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(processorsApi.disconnect(scope, connectionId, { expectedVersion: 3, reason: ' padded ' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', async () => {
  expect(processorErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(processorErrorFor(409, 'SCHOOL_PAY_CONNECTION_STATE').kind).toBe('STATE');
  expect(processorErrorFor(409, 'SCHOOL_PAY_CONNECTION_EXISTS').kind).toBe('EXISTS');
  expect(processorErrorFor(409, 'SCHOOL_PAY_ACCOUNT_LINKED_ELSEWHERE').kind).toBe('LINKED_ELSEWHERE');
  expect(processorErrorFor(403, 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH').kind).toBe('STATE_MISMATCH');
  expect(processorErrorFor(403, 'SCHOOL_PAY_MANAGE_FORBIDDEN').kind).toBe('DENIED');
  expect(processorErrorFor(503, 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED').kind).toBe('NOT_CONFIGURED');
  expect(processorErrorFor(502, 'SCHOOL_PAY_PROVIDER_REJECTED').kind).toBe('PROVIDER_REJECTED');
  expect(processorErrorFor(503, 'SCHOOL_PAY_PROVIDER_UNKNOWN').kind).toBe('UNKNOWN');
  expect(processorErrorFor(409, 'SCHOOL_PAY_CONFLICT').kind).toBe('UNKNOWN');
  expect(keepForRetry(new ProcessorError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new ProcessorError('STATE'))).toBe(false);
  const events: string[] = []; (globalThis.window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, () => events.push('ended'));
  stub(json({}, 401));
  expect((await fails(processorsApi.processors(scope, signal(), () => true))).kind).toBe('SESSION');
  stub(json({}, 401));
  expect((await fails(processorsApi.processors(scope, signal(), () => false))).kind).toBe('SESSION');
  expect(events).toEqual(['ended']);
});

it('takes the provider return out of the address bar at once and accepts only a well-formed one', () => {
  const replace = vi.fn();
  const back = takeProviderReturn({ pathname: '/staff/billing/payment-processors', search: `?connection=${connectionId.toUpperCase()}&state=${state}&code=sim_abc` }, { replaceState: replace });
  expect(back).toEqual({ connectionId, state, authorizationCode: 'sim_abc', providerError: false });
  expect(replace).toHaveBeenCalledWith(null, '', '/staff/billing/payment-processors');
  // Even a malformed return is removed from the address bar; it is just not used.
  const again = vi.fn();
  expect(takeProviderReturn({ pathname: '/p', search: '?state=short&connection=nope' }, { replaceState: again })).toBeNull();
  expect(again).toHaveBeenCalledOnce();
  const untouched = vi.fn();
  expect(takeProviderReturn({ pathname: '/p', search: '' }, { replaceState: untouched })).toBeNull();
  expect(untouched).not.toHaveBeenCalled();
  expect(providerReturnFrom(`?connection=${connectionId}&state=${state}&code=a%20b`)?.authorizationCode).toBeNull();
  expect(providerReturnFrom(`?connection=${connectionId}&state=${state}&error=access_denied`)?.providerError).toBe(true);
  expect(safeOnboardingUrl('http://127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x');
  expect(safeOnboardingUrl('ftp://connect.stripe.com/')).toBeNull();
});

it('builds bodies from the verified read only: its version, the matching return, a single-line reason', () => {
  const read = processorsRaw({ connections: [pending()] }) as never;
  const back = { connectionId, state, authorizationCode: 'sim_abc', providerError: false };
  expect(processorBody('finish', read, connectionId, { returned: back })).toEqual({ expectedVersion: 2, state, authorizationCode: 'sim_abc' });
  expect(() => processorBody('finish', read, connectionId, { returned: { ...back, connectionId: id(31) } })).toThrow();
  expect(() => processorBody('finish', read, connectionId, { returned: { ...back, providerError: true } })).toThrow();
  expect(() => processorBody('finish', read, connectionId, { returned: null })).toThrow();
  expect(() => processorBody('finish', processorsRaw() as never, connectionId, { returned: back })).toThrow();
  expect(processorBody('link', read, connectionId)).toEqual({ expectedVersion: 2 });
  expect(processorBody('disconnect', processorsRaw() as never, connectionId, { reason: '  Moving\nto Square ' })).toEqual({ expectedVersion: 3, reason: 'Moving to Square' });
  expect(() => processorBody('disconnect', processorsRaw() as never, connectionId, { reason: '   ' })).toThrow();
  expect(() => processorBody('refresh', processorsRaw({ canManage: false }) as never, connectionId)).toThrow();
  expect(() => processorBody('refresh', processorsRaw() as never, id(99))).toThrow();
});

const props = (over: Partial<PaymentProcessorsViewProps> = {}): PaymentProcessorsViewProps => ({ language: 'en-US', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', read: processorsRaw() as never }, returned: null, form: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows each provider, its connection and only the actions its state and the staff permission allow', () => {
  const page = renderToStaticMarkup(<PaymentProcessorsView {...props()}/>);
  expect(page).toContain('HON takes no fee'); expect(page).toContain('Test mode only');
  expect(page).toContain('Ready to take payments (test mode)'); expect(page).toContain('account ending 1234');
  expect(page).not.toContain('acct_sim1234');
  expect(page).toContain('Make default'); expect(page).toContain('Check status'); expect(page).toContain('Connect Square');
  const isDefault = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: { state: 'READY', read: processorsRaw({ connections: [connection({ isDefault: true })] }) as never } })}/>);
  expect(isDefault).toContain('default for this school'); expect(isDefault).not.toContain('Make default');
  const setup = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: { state: 'READY', read: processorsRaw({ connections: [pending()] }) as never } })}/>);
  expect(setup).toContain('Continue setup'); expect(setup).not.toContain('Check status');
  const readOnly = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: { state: 'READY', read: processorsRaw({ canManage: false }) as never } })}/>);
  for (const action of ['Connect Square', 'Make default', 'Check status', 'Disconnect']) expect(readOnly).not.toContain(action);
  expect(readOnly).toContain('needs the manage payment processors permission');
  const form = renderToStaticMarkup(<PaymentProcessorsView {...props({ form: { kind: 'disconnect', connectionId } })}/>);
  expect(form).toContain('data-testid="disconnect-form"'); expect(form).toContain('Money already in your Stripe account stays there');
  const ended = connection({ state: 'DISCONNECTED', capabilities: NONE, endedAt: '2026-11-11T12:00:00.000Z', endReason: 'Switching', version: 4 });
  const history = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: { state: 'READY', read: processorsRaw({ connections: [ended] }) as never } })}/>);
  expect(history).toContain('Earlier connections'); expect(history).toContain('Switching'); expect(history).toContain('Connect Stripe');
});

it('offers Finish connecting only for a pending connection the return names, and shows outcomes plainly', () => {
  const back = { connectionId, state, authorizationCode: null, providerError: false };
  const pendingRead = { state: 'READY' as const, read: processorsRaw({ connections: [pending()] }) as never };
  const finish = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: pendingRead, returned: back })}/>);
  expect(finish).toContain('Finish connecting Stripe'); expect(finish).not.toContain(state);
  expect(renderToStaticMarkup(<PaymentProcessorsView {...props({ returned: back })}/>)).not.toContain('Finish connecting');
  const refused = renderToStaticMarkup(<PaymentProcessorsView {...props({ list: pendingRead, returned: { ...back, providerError: true } })}/>);
  expect(refused).toContain('cancelled or refused'); expect(refused).not.toContain('Finish connecting');
  const unknown = renderToStaticMarkup(<PaymentProcessorsView {...props({ outcome: { kind: 'UNKNOWN', action: 'finish' }, canRetry: true })}/>);
  expect(unknown).toContain('nothing happens twice'); expect(unknown).toContain('Try again');
  const revoked = renderToStaticMarkup(<PaymentProcessorsView {...props({ outcome: { kind: 'DONE', action: 'disconnect', providerRevoked: false } })}/>);
  expect(revoked).toContain('did not confirm');
  expect(renderToStaticMarkup(<PaymentProcessorsView {...props({ outcome: { kind: 'NOT_CONFIGURED', action: 'link' } })}/>)).toContain('not set up in this environment');
  expect(renderToStaticMarkup(<PaymentProcessorsView {...props({ list: { state: 'DENIED' } })}/>)).toContain('permission at this school');
  expect(renderToStaticMarkup(<PaymentProcessorsView {...props({ concealed: true })}/>)).not.toContain('account ending');
});

it('is a protected dynamic noindex no-referrer page in the billing menu and the route manifest', () => {
  const page = readFileSync('src/app/staff/billing/payment-processors/page.tsx', 'utf8');
  expect(page).toContain("export const dynamic = 'force-dynamic'"); expect(page).toContain('requireVerifiedWebSession'); expect(page).toContain('index: false');
  expect(page).toContain("referrer: 'no-referrer'");
  expect(page).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/billing/payment-processors')?.href).toBe('/staff/billing/payment-processors');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'billing')?.routes.some((r) => r.href === '/staff/billing/payment-processors')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/billing/payment-processors')).toEqual([{ path: '/staff/billing/payment-processors', title: 'HON | Payment processors' }]);
  // The page never stores the return anywhere but memory.
  const source = ['payment-processors.tsx', 'http.ts', 'view.tsx'].map((f) => readFileSync(`src/components/payment-processors/${f}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
});
