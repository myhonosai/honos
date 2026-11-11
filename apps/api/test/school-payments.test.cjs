const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// B-TUI-2 piece 1 (0258): school payment processor connections, test mode only, no platform fee.
const load = () => import(path.join(__dirname, '../dist/school-payments/school-payment-adapter.js'));
const ALL = { bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true };
const connection = (patch = {}) => ({
  connectionId: '11111111-1111-4111-8111-111111111111', providerCode: 'STRIPE_CONNECT', mode: 'TEST', state: 'CONNECTED_ACTIVE', accountRef: 'acct_sim1234',
  chargesEnabled: true, payoutsEnabled: true, requirementsDue: false, capabilities: ALL, isDefault: false, onboardingPending: false, version: 3,
  statusObservedAt: '2026-11-11T10:00:00.000Z', startedAt: '2026-11-11T09:00:00.000Z', endedAt: null, endReason: null, ...patch,
});

test('0258 inputs are closed', () => {
  assert.deepEqual(contracts.validateStartSchoolPayConnectionInput({ providerCode: 'SQUARE' }), { providerCode: 'SQUARE' });
  for (const bad of [{}, { providerCode: 'PAYPAL' }, { providerCode: 'SQUARE', mode: 'LIVE' }, { providerCode: 'square' }, null]) {
    assert.throws(() => contracts.validateStartSchoolPayConnectionInput(bad), undefined, JSON.stringify(bad));
  }
  const state = 'a'.repeat(43);
  assert.deepEqual(contracts.validateFinishSchoolPayOnboardingInput({ expectedVersion: 2, state }), { expectedVersion: 2, state });
  assert.deepEqual(contracts.validateFinishSchoolPayOnboardingInput({ expectedVersion: 2, state, authorizationCode: 'sim_abc' }).authorizationCode, 'sim_abc');
  for (const bad of [{ expectedVersion: 2, state: 'short' }, { expectedVersion: 0, state }, { expectedVersion: 2, state, authorizationCode: 'a b' }, { expectedVersion: 2, state, extra: 1 }]) {
    assert.throws(() => contracts.validateFinishSchoolPayOnboardingInput(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => contracts.validateDisconnectSchoolPayInput({ expectedVersion: 1, reason: ' padded ' }));
  assert.throws(() => contracts.validateSchoolPayVersionInput({ expectedVersion: 1.5 }));
});

test('0258 connection verifier enforces the state rules', () => {
  assert.equal(contracts.verifySchoolPayConnection(connection()).state, 'CONNECTED_ACTIVE');
  const none = { ...contracts.NO_SCHOOL_PAY_CAPABILITIES };
  for (const bad of [
    connection({ mode: 'LIVE' }),
    connection({ state: 'CONNECTED_RESTRICTED' }), // capabilities while not active
    connection({ state: 'CONNECTED_RESTRICTED', capabilities: none, isDefault: true }), // default while not active
    connection({ state: 'DISCONNECTED', capabilities: none }), // ended without end facts
    connection({ state: 'PENDING_ONBOARDING', capabilities: none, onboardingPending: false, accountRef: null, endedAt: '2026-11-11T10:00:00.000Z', endReason: 'x' }),
    connection({ onboardingPending: true }),
    connection({ accountRef: null }),
    connection({ capabilities: { ...ALL, extra: true } }),
  ]) assert.throws(() => contracts.verifySchoolPayConnection(bad), undefined, JSON.stringify(bad));
  const processors = { canManage: true, platformFee: 'NONE', providers: [{ providerCode: 'STRIPE_CONNECT', displayName: 'Stripe', testSupported: true, liveAllowed: false }], connections: [connection()] };
  assert.equal(contracts.verifySchoolPaymentProcessors(processors).platformFee, 'NONE');
  assert.throws(() => contracts.verifySchoolPaymentProcessors({ ...processors, platformFee: 'PERCENT' }));
  assert.throws(() => contracts.verifySchoolPaymentProcessors({ ...processors, providers: [{ ...processors.providers[0], liveAllowed: true }] }));
  assert.throws(() => contracts.verifySchoolPaymentProcessors({ ...processors, connections: [connection(), connection({ connectionId: '22222222-2222-4222-8222-222222222222' })] }), undefined, 'two open per provider');
});

test('0258 capabilities are the adapter manifest narrowed by the provider', () => {
  const narrowed = contracts.narrowSchoolPayCapabilities({ ...ALL, bankDebit: false }, { ...ALL, refunds: false });
  assert.deepEqual(narrowed, { ...ALL, bankDebit: false, refunds: false });
});

test('0258 adapters: unconfigured by default, simulators only when asked and never in production', async () => {
  const { schoolPaymentAdaptersFromEnvironment, SchoolPaymentProviderError } = await load();
  for (const env of [{}, { HON_SCHOOL_PAY_SIMULATORS: '1', NODE_ENV: 'production' }, { HON_SCHOOL_PAY_SIMULATORS: 'true' }]) {
    const adapters = schoolPaymentAdaptersFromEnvironment(env);
    assert.deepEqual([...adapters.keys()], ['STRIPE_CONNECT', 'SQUARE']);
    for (const adapter of adapters.values()) {
      assert.equal(adapter.readiness(), 'NOT_CONFIGURED');
      await assert.rejects(adapter.retrieveStatus({ accountRef: 'acct_x123' }), (error) => error instanceof SchoolPaymentProviderError && error.outcome === 'PRE_SEND' && error.reason === 'NOT_CONFIGURED');
    }
  }
  const simulated = schoolPaymentAdaptersFromEnvironment({ HON_SCHOOL_PAY_SIMULATORS: '1', NODE_ENV: 'test' });
  assert.ok([...simulated.values()].every((adapter) => adapter.readiness() === 'READY'));
});

test('0258 simulators: Stripe account first, Square code exchange, status overrides, https or loopback returns only', async () => {
  const { SimulatedStripeConnectAdapter, SimulatedSquareAdapter, SchoolPaymentProviderError } = await load();
  const id = '33333333-3333-4333-8333-333333333333', state = 's'.repeat(43);
  const stripe = new SimulatedStripeConnectAdapter();
  const begun = await stripe.beginOnboarding({ connectionId: id, accountRef: null, state, returnUrl: 'https://app.example.test/staff/billing/payment-processors?connection=x' });
  assert.match(begun.accountRef, /^acct_sim[0-9a-f]{16}$/);
  assert.equal(new URL(begun.onboardingUrl).searchParams.get('state'), state);
  assert.deepEqual(await stripe.completeOnboarding({ connectionId: id, accountRef: begun.accountRef }), { accountRef: begun.accountRef });
  stripe.statuses.set(begun.accountRef, { requirementsDue: true });
  assert.equal((await stripe.retrieveStatus({ accountRef: begun.accountRef })).requirementsDue, true);
  await assert.rejects(stripe.beginOnboarding({ connectionId: id, accountRef: null, state, returnUrl: 'http://evil.example.test/x' }), SchoolPaymentProviderError);
  const square = new SimulatedSquareAdapter();
  assert.equal(square.manifest.bankDebit, false);
  const q = await square.beginOnboarding({ connectionId: id, accountRef: null, state, returnUrl: 'http://127.0.0.1:3000/x' });
  assert.equal(q.accountRef, null);
  const code = new URL(q.onboardingUrl).searchParams.get('code');
  assert.match((await square.completeOnboarding({ connectionId: id, accountRef: null, authorizationCode: code })).accountRef, /^MLSIM[0-9a-f]{16}$/);
  await assert.rejects(square.completeOnboarding({ connectionId: id, accountRef: null, authorizationCode: 'sim_wrong' }), (error) => error.outcome === 'FAILED');
  await square.disconnect({ accountRef: 'MLSIMabc' });
  assert.equal((await square.retrieveStatus({ accountRef: 'MLSIMabc' })).reauthorizationRequired, true);
});

test('0258 API: seven routes under human-UI guards; never the SaaS adapter, never a fee', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../src/school-payments/school-payment.controller.ts'), 'utf8');
  for (const route of [/@Get\(\)/, /@Post\('connections'\)/, /@Post\('connections\/:connectionId\/onboarding-link'\)/, /@Post\('connections\/:connectionId\/finish'\)/,
    /@Post\('connections\/:connectionId\/refresh'\)/, /@Post\('connections\/:connectionId\/default'\)/, /@Post\('connections\/:connectionId\/disconnect'\)/]) assert.match(controller, route);
  assert.equal((controller.match(/@UseGuards\(SchoolPay[A-Za-z]+HumanUiGuard\)/g) ?? []).length, 7);
  const sources = ['school-payment.service.ts', 'school-payment-adapter.ts', 'school-payment.controller.ts']
    .map((file) => fs.readFileSync(path.join(__dirname, '../src/school-payments', file), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /from '\.\.\/payments\/|@Inject\(PAYMENT_PROVIDER_ADAPTER\)|STRIPE_TEST_SECRET_KEY|STRIPE_TEST_WEBHOOK_SECRET|application_fee|app_fee_money/);
  const service = fs.readFileSync(path.join(__dirname, '../src/school-payments/school-payment.service.ts'), 'utf8');
  for (const fn of ['read_school_payment_processors', 'start_school_payment_connection', 'set_school_payment_onboarding_link', 'record_school_payment_status',
    'set_default_school_payment_connection', 'disconnect_school_payment_connection']) assert.match(service, new RegExp(`hon\\.${fn}\\(`));
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: SCHOOL_PAYMENT_ADAPTERS, useFactory: \(\) => schoolPaymentAdaptersFromEnvironment\(\)/);
});
