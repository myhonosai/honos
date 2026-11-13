const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// B-TUI-2 piece 2 (0320): real Stripe Connect test-mode and Square sandbox adapters over an injected transport (no
// network in tests), and the per-school credential vault. Test/sandbox only; HON takes no fee on any school payment.
const loadAdapters = () => import(path.join(__dirname, '../dist/school-payments/school-payment-adapter.js'));
const loadSandbox = () => import(path.join(__dirname, '../dist/school-payments/school-payment-sandbox-adapters.js'));
const loadVault = () => import(path.join(__dirname, '../dist/school-payments/school-payment-vault.js'));

const CONNECTION = '44444444-4444-4444-8444-444444444444';
const STATE = 's'.repeat(43);
const RETURN = 'https://app.example.test/staff/billing/payment-processors?connection=44444444-4444-4444-8444-444444444444';
const STRIPE_KEY = `sk_test_${'a'.repeat(99)}`;
const SQUARE = { HON_TUITION_SQUARE_SANDBOX_APP_ID: 'sandbox-sq0idb-abcdefghijklmnopqrstuv', HON_TUITION_SQUARE_SANDBOX_APP_SECRET: `sandbox-sq0csb-${'b'.repeat(43)}` };
const VAULT = { HON_SCHOOL_PAY_VAULT_KEY: randomBytes(32).toString('base64'), HON_SCHOOL_PAY_VAULT_KEY_ID: 'proof-1' };

/** A recording fake transport: answers from a route table, keeps every request. */
function fakeTransport(routes) {
  const calls = [];
  const send = async (request) => {
    calls.push(request);
    const route = routes.find((r) => r.method === request.method && (typeof r.url === 'string' ? request.url === r.url : r.url.test(request.url)));
    if (!route) throw new Error(`unexpected ${request.method} ${request.url}`);
    if (route.throws) throw route.throws;
    return typeof route.reply === 'function' ? route.reply(request) : route.reply;
  };
  return { send, calls };
}
const form = (body) => Object.fromEntries(new URLSearchParams(body));

test('0320 vault: seals with AES-256-GCM bound to the connection; wrong key, id or binding never opens', async () => {
  const { SchoolPaymentVault, schoolPaymentVaultFromEnvironment } = await loadVault();
  const vault = schoolPaymentVaultFromEnvironment(VAULT);
  assert.equal(vault.keyId, 'proof-1');
  const binding = { connectionId: CONNECTION, providerCode: 'SQUARE', accountRef: 'MLABC123' };
  const secret = { accessToken: 'EAAAtoken-secret', refreshToken: 'EQAArefresh-secret', accessExpiresAt: '2026-12-13T00:00:00.000Z' };
  const sealed = vault.seal(binding, secret);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  assert.doesNotMatch(sealed, /secret|EAAA|EQAA/);
  assert.notEqual(vault.seal(binding, secret), sealed, 'a fresh IV each time');
  assert.deepEqual(vault.open(binding, 'proof-1', sealed), secret);
  assert.throws(() => vault.open({ ...binding, connectionId: '55555555-5555-4555-8555-555555555555' }, 'proof-1', sealed), /SCHOOL_PAY_VAULT/);
  assert.throws(() => vault.open({ ...binding, accountRef: 'MLOTHER1' }, 'proof-1', sealed), /SCHOOL_PAY_VAULT/);
  assert.throws(() => vault.open(binding, 'proof-2', sealed), /SCHOOL_PAY_VAULT/);
  const tampered = sealed.slice(0, -3) + (sealed.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.throws(() => vault.open(binding, 'proof-1', tampered), /SCHOOL_PAY_VAULT/);
  const other = new SchoolPaymentVault(randomBytes(32), 'proof-1');
  assert.throws(() => other.open(binding, 'proof-1', sealed), /SCHOOL_PAY_VAULT/);
  for (const bad of [{}, { HON_SCHOOL_PAY_VAULT_KEY: randomBytes(16).toString('base64'), HON_SCHOOL_PAY_VAULT_KEY_ID: 'k' },
    { HON_SCHOOL_PAY_VAULT_KEY: VAULT.HON_SCHOOL_PAY_VAULT_KEY, HON_SCHOOL_PAY_VAULT_KEY_ID: 'Bad Id' },
    { HON_SCHOOL_PAY_VAULT_KEY: 'not base64!!', HON_SCHOOL_PAY_VAULT_KEY_ID: 'k' }]) assert.equal(schoolPaymentVaultFromEnvironment(bad), null, JSON.stringify(Object.keys(bad)));
  assert.throws(() => vault.seal(binding, { ...secret, accessToken: '' }), /SCHOOL_PAY_VAULT/);
});

test('0320 environment: simulators first, then real sandbox adapters only with valid test keys, never a live key', async () => {
  const { schoolPaymentAdaptersFromEnvironment } = await loadAdapters();
  const { StripeConnectTestAdapter, SquareSandboxAdapter } = await loadSandbox();
  const real = schoolPaymentAdaptersFromEnvironment({ HON_TUITION_STRIPE_TEST_SECRET_KEY: STRIPE_KEY, ...SQUARE, ...VAULT });
  assert.ok(real.get('STRIPE_CONNECT') instanceof StripeConnectTestAdapter);
  assert.ok(real.get('SQUARE') instanceof SquareSandboxAdapter);
  assert.ok([...real.values()].every((a) => a.readiness() === 'READY'));
  assert.equal(real.get('SQUARE').credentialKind, 'OAUTH_TOKENS');
  assert.equal(real.get('STRIPE_CONNECT').credentialKind, 'NONE');
  const cases = [
    [{ HON_TUITION_STRIPE_TEST_SECRET_KEY: `sk_live_${'a'.repeat(99)}` }, 'STRIPE_CONNECT'],
    [{ HON_TUITION_STRIPE_TEST_SECRET_KEY: `rk_live_${'a'.repeat(99)}` }, 'STRIPE_CONNECT'],
    [{ HON_TUITION_STRIPE_TEST_SECRET_KEY: 'sk_test_' }, 'STRIPE_CONNECT'],
    [{ STRIPE_TEST_SECRET_KEY: STRIPE_KEY }, 'STRIPE_CONNECT'], // HON's SaaS key is never used for tuition
    [{ ...SQUARE, HON_TUITION_SQUARE_SANDBOX_APP_ID: 'sq0idp-production-app-id-123456' , ...VAULT }, 'SQUARE'],
    [{ ...SQUARE }, 'SQUARE'], // no vault key
    [{ HON_TUITION_SQUARE_SANDBOX_APP_ID: SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID, ...VAULT }, 'SQUARE'],
  ];
  for (const [env, code] of cases) assert.equal(schoolPaymentAdaptersFromEnvironment(env).get(code).readiness(), 'NOT_CONFIGURED', JSON.stringify(Object.keys(env)));
  const simulated = schoolPaymentAdaptersFromEnvironment({ HON_SCHOOL_PAY_SIMULATORS: '1', NODE_ENV: 'test', HON_TUITION_STRIPE_TEST_SECRET_KEY: STRIPE_KEY });
  assert.ok(!(simulated.get('STRIPE_CONNECT') instanceof StripeConnectTestAdapter), 'simulators win when asked');
  const production = schoolPaymentAdaptersFromEnvironment({ HON_SCHOOL_PAY_SIMULATORS: '1', NODE_ENV: 'production', HON_TUITION_STRIPE_TEST_SECRET_KEY: STRIPE_KEY });
  assert.ok(production.get('STRIPE_CONNECT') instanceof StripeConnectTestAdapter, 'production never simulates; test keys still only reach test mode');
});

test('0320 Stripe: full-dashboard account (no personal data, no fee), idempotent creation, hosted link, status from the account', async () => {
  const { StripeConnectTestAdapter } = await loadSandbox();
  const t = fakeTransport([
    { method: 'POST', url: 'https://api.stripe.com/v1/accounts', reply: { status: 200, body: { id: 'acct_1TestSchool0001', object: 'account' } } },
    { method: 'POST', url: 'https://api.stripe.com/v1/account_links', reply: { status: 200, body: { object: 'account_link', url: 'https://connect.stripe.com/setup/s/acct_1TestSchool0001/abc' } } },
  ]);
  const stripe = new StripeConnectTestAdapter(STRIPE_KEY, t.send);
  const begun = await stripe.beginOnboarding({ connectionId: CONNECTION, accountRef: null, state: STATE, returnUrl: RETURN });
  assert.deepEqual(begun, { onboardingUrl: 'https://connect.stripe.com/setup/s/acct_1TestSchool0001/abc', accountRef: 'acct_1TestSchool0001' });
  const [account, accountLink] = t.calls;
  assert.equal(account.headers.Authorization, `Bearer ${STRIPE_KEY}`);
  assert.equal(account.headers['Idempotency-Key'], `hon-school-pay-account-${CONNECTION}`);
  assert.equal(account.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(account.body), {
    'controller[stripe_dashboard][type]': 'full', 'controller[fees][payer]': 'account', 'controller[losses][payments]': 'stripe',
    'controller[requirement_collection]': 'stripe', 'metadata[hon_connection_id]': CONNECTION,
  });
  const linkBody = form(accountLink.body);
  assert.equal(linkBody.account, 'acct_1TestSchool0001');
  assert.equal(linkBody.type, 'account_onboarding');
  assert.equal(new URL(linkBody.return_url).searchParams.get('state'), STATE);
  assert.equal(new URL(linkBody.refresh_url).searchParams.get('state'), null, 'an expired link never carries the state');
  assert.equal(new URL(linkBody.refresh_url).searchParams.get('connection'), CONNECTION);
  for (const call of t.calls) assert.doesNotMatch(call.body, /application_fee|fee_amount|email|business_profile|individual/);

  const again = fakeTransport([{ method: 'POST', url: 'https://api.stripe.com/v1/account_links', reply: { status: 200, body: { url: 'https://connect.stripe.com/setup/s/x/y' } } }]);
  const reused = await new StripeConnectTestAdapter(STRIPE_KEY, again.send).beginOnboarding({ connectionId: CONNECTION, accountRef: 'acct_1TestSchool0001', state: STATE, returnUrl: RETURN });
  assert.equal(reused.accountRef, 'acct_1TestSchool0001');
  assert.equal(again.calls.length, 1, 'an existing account is never created again');

  for (const url of ['http://connect.stripe.com/x', 'https://evil.example.test/setup', 'https://user:pw@connect.stripe.com/x']) {
    const bad = fakeTransport([{ method: 'POST', url: 'https://api.stripe.com/v1/account_links', reply: { status: 200, body: { url } } }]);
    await assert.rejects(new StripeConnectTestAdapter(STRIPE_KEY, bad.send).beginOnboarding({ connectionId: CONNECTION, accountRef: 'acct_1TestSchool0001', state: STATE, returnUrl: RETURN }),
      (e) => e.outcome === 'UNKNOWN', url);
  }
  assert.deepEqual(await stripe.completeOnboarding({ connectionId: CONNECTION, accountRef: 'acct_1TestSchool0001' }), { accountRef: 'acct_1TestSchool0001' });
  await assert.rejects(stripe.completeOnboarding({ connectionId: CONNECTION, accountRef: 'acct_1TestSchool0001', authorizationCode: 'x' }), (e) => e.outcome === 'PRE_SEND');

  const account2 = (patch) => ({ status: 200, body: { id: 'acct_1TestSchool0001', object: 'account', charges_enabled: true, payouts_enabled: true,
    requirements: { currently_due: [], past_due: [], disabled_reason: null }, capabilities: { card_payments: 'active', us_bank_account_ach_payments: 'active' }, ...patch } });
  const statusOf = async (reply) => new StripeConnectTestAdapter(STRIPE_KEY, fakeTransport([{ method: 'GET', url: 'https://api.stripe.com/v1/accounts/acct_1TestSchool0001', reply }]).send)
    .retrieveStatus({ accountRef: 'acct_1TestSchool0001' });
  const active = await statusOf(account2({}));
  assert.deepEqual(active, { accountRef: 'acct_1TestSchool0001', chargesEnabled: true, payoutsEnabled: true, requirementsDue: false, reauthorizationRequired: false,
    capabilities: { bankDebit: true, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true } });
  const restricted = await statusOf(account2({ charges_enabled: false, requirements: { currently_due: ['external_account'], past_due: [], disabled_reason: 'requirements.past_due' },
    capabilities: { card_payments: 'inactive' } }));
  assert.equal(restricted.requirementsDue, true);
  assert.equal(restricted.capabilities.oneTimeCard, false);
  assert.equal(restricted.capabilities.bankDebit, false);
  assert.equal((await statusOf({ status: 403, body: { error: { type: 'invalid_request_error', code: 'account_invalid' } } })).reauthorizationRequired, true);
  await assert.rejects(statusOf(account2({ id: 'acct_somethingElse' })), (e) => e.outcome === 'UNKNOWN', 'another account answered');
  await assert.rejects(statusOf({ status: 500, body: {} }), (e) => e.outcome === 'UNKNOWN');
  await assert.rejects(statusOf({ status: 400, body: { error: { type: 'invalid_request_error' } } }), (e) => e.outcome === 'FAILED');
  await assert.rejects(stripe.disconnect({ accountRef: 'acct_1TestSchool0001' }), (e) => e.outcome === 'PRE_SEND' && e.reason === 'REVOKE_NOT_SUPPORTED');
});

test('0320 Stripe transport: network failure or timeout is UNKNOWN, never success', async () => {
  const { StripeConnectTestAdapter } = await loadSandbox();
  const stripe = new StripeConnectTestAdapter(STRIPE_KEY, fakeTransport([{ method: 'POST', url: 'https://api.stripe.com/v1/accounts', throws: new Error('ECONNRESET') }]).send);
  await assert.rejects(stripe.beginOnboarding({ connectionId: CONNECTION, accountRef: null, state: STATE, returnUrl: RETURN }), (e) => e.outcome === 'UNKNOWN' && !/ECONNRESET/.test(e.message));
  assert.throws(() => new StripeConnectTestAdapter(`sk_live_${'a'.repeat(99)}`), (e) => e.reason === 'LIVE_MODE_REFUSED');
});

test('0320 Square: sandbox authorize URL with fixed scopes, code exchange to vault-ready tokens, renew, status, revoke', async () => {
  const { SquareSandboxAdapter } = await loadSandbox();
  const tokenReply = (request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.client_id, SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID);
    assert.equal(body.client_secret, SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_SECRET);
    if (body.grant_type === 'authorization_code') assert.equal(body.code, 'sandbox-code-123');
    else { assert.equal(body.grant_type, 'refresh_token'); assert.equal(body.refresh_token, 'EQAArefresh'); }
    return { status: 200, body: { access_token: body.grant_type === 'refresh_token' ? 'EAAAnew' : 'EAAAfirst', token_type: 'bearer', expires_at: '2026-12-13T05:00:00Z', merchant_id: 'MLMERCHANT01', refresh_token: 'EQAArefresh' } };
  };
  const t = fakeTransport([
    { method: 'POST', url: 'https://connect.squareupsandbox.com/oauth2/token', reply: tokenReply },
    { method: 'GET', url: 'https://connect.squareupsandbox.com/v2/merchants/MLMERCHANT01', reply: { status: 200, body: { merchant: { id: 'MLMERCHANT01', status: 'ACTIVE' } } } },
    { method: 'GET', url: 'https://connect.squareupsandbox.com/v2/locations', reply: { status: 200, body: { locations: [{ id: 'L1', status: 'ACTIVE', capabilities: ['CREDIT_CARD_PROCESSING'] }] } } },
    { method: 'POST', url: 'https://connect.squareupsandbox.com/oauth2/revoke', reply: { status: 200, body: { success: true } } },
  ]);
  const square = new SquareSandboxAdapter(SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID, SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_SECRET, t.send, () => new Date('2026-11-13T05:00:00Z'));
  assert.equal(square.manifest.bankDebit, false);
  const begun = await square.beginOnboarding({ connectionId: CONNECTION, accountRef: null, state: STATE, returnUrl: RETURN });
  assert.equal(begun.accountRef, null);
  const authorize = new URL(begun.onboardingUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://connect.squareupsandbox.com/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'), SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID);
  assert.equal(authorize.searchParams.get('state'), STATE);
  assert.equal(authorize.searchParams.get('session'), 'false');
  assert.equal(authorize.searchParams.get('scope'), 'MERCHANT_PROFILE_READ PAYMENTS_READ PAYMENTS_WRITE CUSTOMERS_READ CUSTOMERS_WRITE');
  assert.equal(t.calls.length, 0, 'building the authorize link sends nothing');
  assert.doesNotMatch(begun.onboardingUrl, /sq0csb/, 'the secret never reaches the browser');

  const done = await square.completeOnboarding({ connectionId: CONNECTION, accountRef: null, authorizationCode: 'sandbox-code-123' });
  assert.deepEqual(done, { accountRef: 'MLMERCHANT01', credential: { accessToken: 'EAAAfirst', refreshToken: 'EQAArefresh', accessExpiresAt: '2026-12-13T05:00:00.000Z' } });
  await assert.rejects(square.completeOnboarding({ connectionId: CONNECTION, accountRef: null }), (e) => e.outcome === 'PRE_SEND');

  const observation = await square.retrieveStatus({ accountRef: 'MLMERCHANT01', credential: done.credential });
  assert.deepEqual(observation, { accountRef: 'MLMERCHANT01', chargesEnabled: true, payoutsEnabled: true, requirementsDue: false, reauthorizationRequired: false,
    capabilities: { bankDebit: false, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true } });
  const statusCalls = t.calls.filter((c) => c.method === 'GET');
  assert.ok(statusCalls.every((c) => c.headers.Authorization === 'Bearer EAAAfirst' && c.headers['Square-Version']));
  await assert.rejects(square.retrieveStatus({ accountRef: 'MLMERCHANT01' }), (e) => e.outcome === 'PRE_SEND', 'no token, no call');

  assert.equal(square.needsRenewal(done.credential), false);
  assert.equal(square.needsRenewal({ ...done.credential, accessExpiresAt: '2026-11-19T05:00:00.000Z' }), true, 'within 7 days');
  const renewed = await square.renewCredential({ accountRef: 'MLMERCHANT01', credential: done.credential });
  assert.equal(renewed.accessToken, 'EAAAnew');
  assert.equal(renewed.refreshToken, 'EQAArefresh');

  await square.disconnect({ accountRef: 'MLMERCHANT01' });
  const revoke = t.calls.find((c) => c.url.endsWith('/oauth2/revoke'));
  assert.equal(revoke.headers.Authorization, `Client ${SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_SECRET}`);
  assert.deepEqual(JSON.parse(revoke.body), { client_id: SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID, merchant_id: 'MLMERCHANT01' });
  for (const call of t.calls) assert.ok(call.url.startsWith('https://connect.squareupsandbox.com/'), 'sandbox host only');
});

test('0320 Square: refusals, revoked access and lost answers map to FAILED, reauthorization and UNKNOWN', async () => {
  const { SquareSandboxAdapter } = await loadSandbox();
  const make = (routes) => new SquareSandboxAdapter(SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_ID, SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_SECRET, fakeTransport(routes).send, () => new Date('2026-11-13T05:00:00Z'));
  const credential = { accessToken: 'EAAAx', refreshToken: 'EQAAx', accessExpiresAt: '2026-12-13T05:00:00.000Z' };
  await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, reply: { status: 401, body: { errors: [{ code: 'UNAUTHORIZED' }] } } }])
    .completeOnboarding({ connectionId: CONNECTION, accountRef: null, authorizationCode: 'used-code' }), (e) => e.outcome === 'FAILED');
  await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, reply: { status: 200, body: { access_token: 'EAAAx', merchant_id: 'bad id!', expires_at: '2026-12-13T05:00:00Z', refresh_token: 'r' } } }])
    .completeOnboarding({ connectionId: CONNECTION, accountRef: null, authorizationCode: 'c' }), (e) => e.outcome === 'UNKNOWN');
  await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, throws: new Error('timeout') }])
    .completeOnboarding({ connectionId: CONNECTION, accountRef: null, authorizationCode: 'c' }), (e) => e.outcome === 'UNKNOWN');
  const revoked = await make([{ method: 'GET', url: /merchants/, reply: { status: 401, body: { errors: [{ code: 'ACCESS_TOKEN_REVOKED' }] } } }])
    .retrieveStatus({ accountRef: 'MLMERCHANT01', credential });
  assert.equal(revoked.reauthorizationRequired, true);
  const inactive = await make([
    { method: 'GET', url: /merchants/, reply: { status: 200, body: { merchant: { id: 'MLMERCHANT01', status: 'INACTIVE' } } } },
    { method: 'GET', url: /locations/, reply: { status: 200, body: { locations: [{ id: 'L1', status: 'ACTIVE', capabilities: [] }] } } },
  ]).retrieveStatus({ accountRef: 'MLMERCHANT01', credential });
  assert.equal(inactive.chargesEnabled, false);
  assert.equal(inactive.requirementsDue, true);
  await assert.rejects(make([{ method: 'GET', url: /merchants/, reply: { status: 200, body: { merchant: { id: 'MLOTHER', status: 'ACTIVE' } } } }])
    .retrieveStatus({ accountRef: 'MLMERCHANT01', credential }), (e) => e.outcome === 'UNKNOWN');
  assert.throws(() => new SquareSandboxAdapter('sq0idp-production', SQUARE.HON_TUITION_SQUARE_SANDBOX_APP_SECRET), (e) => e.reason === 'LIVE_MODE_REFUSED');
  // A seller who revoked HON: the renewal answers 401 or invalid_grant -> GRANT_REVOKED (recorded as reauthorization), never UNKNOWN.
  for (const reply of [{ status: 401, body: { errors: [{ code: 'UNAUTHORIZED' }] } }, { status: 400, body: { errors: [{ code: 'INVALID_GRANT' }] } }, { status: 400, body: { error: 'invalid_grant' } }]) {
    await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, reply }]).renewCredential({ accountRef: 'MLMERCHANT01', credential }),
      (e) => e.outcome === 'FAILED' && e.reason === 'GRANT_REVOKED', JSON.stringify(reply));
  }
  for (const reply of [{ status: 500, body: {} }, { status: 429, body: {} }]) {
    await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, reply }]).renewCredential({ accountRef: 'MLMERCHANT01', credential }), (e) => e.outcome === 'UNKNOWN');
  }
  await assert.rejects(make([{ method: 'POST', url: /oauth2\/token$/, reply: { status: 400, body: { errors: [{ code: 'BAD_REQUEST' }] } } }]).renewCredential({ accountRef: 'MLMERCHANT01', credential }),
    (e) => e.outcome === 'FAILED' && e.reason === 'PROVIDER_REJECTED', 'another 400 is a plain refusal');
});

test('0320 sources: fixed sandbox hosts, tuition keys only, no fee, no secret logged', () => {
  const dir = path.join(__dirname, '../src/school-payments');
  const sandbox = fs.readFileSync(path.join(dir, 'school-payment-sandbox-adapters.ts'), 'utf8');
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /connect\.squareup\.com|application_fee|app_fee_money|console\.|(?<![A-Z_])STRIPE_TEST_SECRET_KEY|from '\.\.\/payments\//);
  assert.match(sandbox, /'https:\/\/api\.stripe\.com'/);
  assert.match(sandbox, /'https:\/\/connect\.squareupsandbox\.com'/);
  const env = fs.readFileSync(path.join(dir, 'school-payment-adapter.ts'), 'utf8');
  for (const name of ['HON_TUITION_STRIPE_TEST_SECRET_KEY', 'HON_TUITION_SQUARE_SANDBOX_APP_ID', 'HON_TUITION_SQUARE_SANDBOX_APP_SECRET']) assert.match(env, new RegExp(name));
});

test('0320 service: state checked before the exchange, credential stored with the status record, revoke skipped while the account is used elsewhere', () => {
  const service = fs.readFileSync(path.join(__dirname, '../src/school-payments/school-payment.service.ts'), 'utf8');
  for (const fn of ['check_school_payment_onboarding_state', 'record_school_payment_status_with_credential', 'read_school_payment_credential', 'read_school_payment_account_use']) {
    assert.match(service, new RegExp(`hon\\.${fn}\\(`), fn);
  }
  const finish = service.slice(service.indexOf('async finish('), service.indexOf('async refresh('));
  assert.ok(finish.indexOf('checkOnboardingState') < finish.indexOf('completeOnboarding'), 'state check before the code exchange');
  assert.ok(finish.indexOf('vault.seal') < finish.indexOf('this.write('), 'sealed before the one write');
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: SCHOOL_PAYMENT_VAULT, useFactory: \(\) => schoolPaymentVaultForProcess\(\)/);
});
