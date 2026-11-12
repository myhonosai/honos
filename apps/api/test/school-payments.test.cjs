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

// B-TUI-2 piece 3 (0265): payer saved methods, test mode only, never a card number.
const PAYER = '44444444-4444-4444-8444-444444444444', CONN = '11111111-1111-4111-8111-111111111111';
const method = (patch = {}) => ({
  methodId: '55555555-5555-4555-8555-555555555555', billingAccountId: PAYER, connectionId: CONN, kind: 'CARD', brand: 'VISA', last4: '4242', expMonth: 12, expYear: 2034,
  status: 'ACTIVE', isDefault: true, consentTextVersion: 'card-on-file-v1', version: 1, createdAt: '2026-11-12T08:00:00.000Z', removedAt: null, removeReason: null, ...patch,
});
const setup = (patch = {}) => ({
  setupId: '66666666-6666-4666-8666-666666666666', billingAccountId: PAYER, connectionId: CONN, state: 'PENDING', setupRef: 'seti_sim0123456789abcdef', methodKinds: ['CARD'],
  consentTextVersion: 'card-on-file-v1', expiresAt: '2026-11-12T09:00:00.000Z', methodId: null, version: 1, createdAt: '2026-11-12T08:00:00.000Z', ...patch,
});

test('0265 inputs are closed and never take a card number', () => {
  assert.deepEqual(contracts.validateStartSchoolPayMethodSetupInput({ connectionId: CONN, methodKinds: ['US_BANK_ACCOUNT', 'CARD'], consentTextVersion: 'v1' }),
    { connectionId: CONN, methodKinds: ['CARD', 'US_BANK_ACCOUNT'], consentTextVersion: 'v1' });
  for (const bad of [{ connectionId: CONN, methodKinds: [], consentTextVersion: 'v1' }, { connectionId: CONN, methodKinds: ['CARD', 'CARD'], consentTextVersion: 'v1' },
    { connectionId: CONN, methodKinds: ['CASH'], consentTextVersion: 'v1' }, { connectionId: CONN, methodKinds: ['CARD'], consentTextVersion: 'V 1' },
    { connectionId: CONN, methodKinds: ['CARD'], consentTextVersion: 'v1', cardNumber: '4242424242424242' }, { connectionId: 'x', methodKinds: ['CARD'], consentTextVersion: 'v1' }]) {
    assert.throws(() => contracts.validateStartSchoolPayMethodSetupInput(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => contracts.validateFinishSchoolPayMethodSetupInput({ expectedVersion: 1, setupState: 'short' }));
  assert.equal(contracts.validateFinishSchoolPayMethodSetupInput({ expectedVersion: 1, setupState: 's'.repeat(43) }).expectedVersion, 1);
  assert.throws(() => contracts.validateRemoveSchoolPayMethodInput({ expectedVersion: 1, reason: '' }));
});

test('0265 verifiers: card and bank facts, removed state, one default, expiry window', () => {
  assert.equal(contracts.verifySchoolPayMethod(method()).brand, 'VISA');
  assert.equal(contracts.verifySchoolPayMethod(method({ kind: 'US_BANK_ACCOUNT', brand: 'BANK', last4: '6789', expMonth: null, expYear: null, isDefault: false })).kind, 'US_BANK_ACCOUNT');
  for (const bad of [method({ kind: 'US_BANK_ACCOUNT' }), method({ brand: 'BANK' }), method({ expMonth: null }), method({ last4: '42' }), method({ cardNumber: '4242' }),
    method({ status: 'REMOVED' }), method({ status: 'REMOVED', isDefault: true, removedAt: '2026-11-12T08:30:00.000Z', removeReason: 'x' }), method({ expMonth: 13 })]) {
    assert.throws(() => contracts.verifySchoolPayMethod(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => contracts.verifySchoolPayMethodSetup(setup({ state: 'COMPLETED' })), undefined, 'completed without a method');
  assert.throws(() => contracts.verifySchoolPayMethodSetup(setup({ expiresAt: '2026-11-12T10:00:00.000Z' })), undefined, 'longer than one hour');
  const payer = { billingAccountId: PAYER, canManage: true, platformFee: 'NONE', payerName: 'Avery Family',
    connections: [{ connectionId: CONN, providerCode: 'STRIPE_CONNECT', displayName: 'Stripe', accountRef: 'acct_sim1234', isDefault: true, storedCard: true, bankDebit: true, customerRef: null }],
    methods: [method()], setups: [setup()] };
  assert.equal(contracts.verifySchoolPayPayerMethods(payer, PAYER).methods.length, 1);
  assert.throws(() => contracts.verifySchoolPayPayerMethods({ ...payer, platformFee: 'PERCENT' }));
  assert.throws(() => contracts.verifySchoolPayPayerMethods({ ...payer, methods: [method(), method({ methodId: '77777777-7777-4777-8777-777777777777' })] }), undefined, 'two defaults');
  assert.throws(() => contracts.verifySchoolPayPayerMethods({ ...payer, methods: [method({ billingAccountId: CONN })] }), undefined, 'another payer');
  assert.throws(() => contracts.verifySchoolPayPayerMethods(payer, CONN), undefined, 'wrong payer');
  const expiring = { asOfMonth: '2026-11', methods: [{ methodId: method().methodId, billingAccountId: PAYER, payerName: 'A', connectionId: CONN, brand: 'VISA', last4: '4242', expMonth: 10, expYear: 2026, isDefault: true, expired: true }] };
  assert.equal(contracts.verifySchoolPayExpiringMethods(expiring).methods[0].expired, true);
  assert.throws(() => contracts.verifySchoolPayExpiringMethods({ ...expiring, methods: [{ ...expiring.methods[0], expired: false }] }), undefined, 'expired flag must match');
  assert.throws(() => contracts.verifySchoolPayExpiringMethods({ ...expiring, methods: [{ ...expiring.methods[0], expMonth: 3, expYear: 2027, expired: false }] }), undefined, 'beyond next month');
  assert.throws(() => contracts.verifySchoolPayMethodRemoval({ method: method(), providerMethodRef: 'pm_sim1', connectionId: CONN }, { methodId: method().methodId, billingAccountId: PAYER }), undefined, 'not removed');
});

test('0265 simulators: customer once, hosted setup, retrieval with overrides, Square cards only, unconfigured refuses before sending', async () => {
  const { SimulatedStripeConnectAdapter, SimulatedSquareAdapter, UnconfiguredSchoolPaymentAdapter, SchoolPaymentProviderError } = await load();
  const stripe = new SimulatedStripeConnectAdapter();
  const { customerRef } = await stripe.ensureCustomer({ accountRef: 'acct_sim1', billingAccountId: PAYER, customerRef: null });
  assert.match(customerRef, /^cus_sim[0-9a-f]{16}$/);
  assert.deepEqual(await stripe.ensureCustomer({ accountRef: 'acct_sim1', billingAccountId: PAYER, customerRef }), { customerRef });
  const begun = await stripe.beginMethodSetup({ accountRef: 'acct_sim1', customerRef, setupId: setup().setupId, methodKinds: ['CARD'], state: 's'.repeat(43), returnUrl: 'https://app.example.test/staff/billing/saved-payment-methods?setup=x' });
  assert.match(begun.setupRef, /^seti_sim[0-9a-f]{16}$/);
  assert.equal(new URL(begun.setupUrl).searchParams.get('state'), 's'.repeat(43));
  const card = await stripe.retrieveMethodSetup({ accountRef: 'acct_sim1', customerRef, setupRef: begun.setupRef });
  assert.deepEqual({ ...card, methodRef: undefined }, { customerRef, methodRef: undefined, kind: 'CARD', brand: 'VISA', last4: '4242', expMonth: 12, expYear: 2034 });
  stripe.setupOutcomes.set(begun.setupRef, { incomplete: true });
  await assert.rejects(stripe.retrieveMethodSetup({ accountRef: 'acct_sim1', customerRef, setupRef: begun.setupRef }), (error) => error.reason === 'SETUP_INCOMPLETE');
  await assert.rejects(stripe.retrieveMethodSetup({ accountRef: 'acct_other', customerRef, setupRef: begun.setupRef }), (error) => error.outcome === 'FAILED');
  const square = new SimulatedSquareAdapter();
  await assert.rejects(square.beginMethodSetup({ accountRef: 'MLSIM1', customerRef: 'SQCUSTSIM1', setupId: setup().setupId, methodKinds: ['US_BANK_ACCOUNT'], state: 's'.repeat(43), returnUrl: 'http://127.0.0.1/x' }),
    (error) => error instanceof SchoolPaymentProviderError && error.outcome === 'PRE_SEND');
  const unconfigured = new UnconfiguredSchoolPaymentAdapter('STRIPE_CONNECT');
  for (const call of [() => unconfigured.ensureCustomer(), () => unconfigured.beginMethodSetup(), () => unconfigured.retrieveMethodSetup(), () => unconfigured.detachMethod()]) {
    await assert.rejects(call(), (error) => error.outcome === 'PRE_SEND' && error.reason === 'NOT_CONFIGURED');
  }
});

test('0265 API: six routes under human-UI guards; provider references never reach the browser', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../src/school-payments/school-pay-method.controller.ts'), 'utf8');
  for (const route of [/@Get\('payers\/:billingAccountId\/methods'\)/, /@Get\('saved-methods\/expiring'\)/, /@Post\('payers\/:billingAccountId\/method-setups'\)/,
    /@Post\('payers\/:billingAccountId\/method-setups\/:setupId\/finish'\)/, /@Post\('payers\/:billingAccountId\/methods\/:methodId\/default'\)/,
    /@Post\('payers\/:billingAccountId\/methods\/:methodId\/remove'\)/]) assert.match(controller, route);
  assert.equal((controller.match(/@UseGuards\(SchoolPay[A-Za-z]+HumanUiGuard\)/g) ?? []).length, 6);
  assert.match(controller, /schoolPayPayerMethodsForBrowser\(data\)/); assert.match(controller, /schoolPaySetupForBrowser\(result\.receipt\.setup\)/);
  const service = fs.readFileSync(path.join(__dirname, '../src/school-payments/school-pay-method.service.ts'), 'utf8');
  for (const fn of ['read_school_pay_payer_methods', 'read_school_pay_expiring_methods', 'start_school_pay_method_setup', 'finish_school_pay_method_setup',
    'set_default_school_pay_method', 'remove_school_pay_method']) assert.match(service, new RegExp(`hon\\.${fn}\\(`));
  assert.doesNotMatch(service + controller, /from '\.\.\/payments\/|PAYMENT_PROVIDER_ADAPTER|STRIPE_TEST_SECRET_KEY|application_fee|app_fee_money|cardNumber|cvc/i);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /SchoolPayMethodController,/); assert.match(module, /SchoolPayMethodService,/);
});

test('0265 browser views carry no provider account, customer or setup reference', () => {
  const full = { billingAccountId: PAYER, canManage: true, platformFee: 'NONE', payerName: 'Avery Family',
    connections: [{ connectionId: CONN, providerCode: 'STRIPE_CONNECT', displayName: 'Stripe', accountRef: 'acct_sim1234', isDefault: true, storedCard: true, bankDebit: true, customerRef: 'cus_sim1234' }],
    methods: [method()], setups: [setup()] };
  const view = contracts.schoolPayPayerMethodsForBrowser(contracts.verifySchoolPayPayerMethods(full, PAYER));
  assert.doesNotMatch(JSON.stringify(view), /acct_sim|cus_sim|seti_sim/);
  assert.equal(view.connections[0].hasCustomer, true);
  assert.deepEqual(contracts.verifySchoolPayPayerMethodsView(JSON.parse(JSON.stringify(view)), PAYER), view);
  assert.throws(() => contracts.verifySchoolPayPayerMethodsView(full, PAYER), undefined, 'a body with references is refused');
  assert.throws(() => contracts.verifySchoolPayPayerMethodsView({ ...view, setups: [setup()] }, PAYER), undefined, 'a setup with its reference is refused');
  const start = { setup: contracts.schoolPaySetupForBrowser(setup()), setupUrl: 'https://checkout.stripe.test/x' };
  assert.equal(contracts.verifySchoolPaySetupStartView(start, { billingAccountId: PAYER }).setupUrl, 'https://checkout.stripe.test/x');
  assert.throws(() => contracts.verifySchoolPaySetupStartView({ setup: setup(), setupUrl: null }));
});
