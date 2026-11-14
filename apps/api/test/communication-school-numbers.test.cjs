// T2 (0352, docs/architecture/SCHOOL_OWN_SENDERS.md §4.2-§4.5): school number search, orders, HQ decision, purchase worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { TwilioRestNumberClient, FakeTwilioNumberClient, priceToMicrounits, schoolServiceFriendlyName } = require('../dist/communication/delivery/twilio-numbers.js');
const { SchoolNumberPurchaseWorker } = require('../dist/communication/delivery/school-number-purchase.js');
const { SchoolNumberService } = require('../dist/communication/delivery/school-number.service.js');
const { validateNumberOrderDecision, validateNumberOrderSettle, SchoolNumberOrderHqController } = require('../dist/communication/delivery/school-number.controller.js');
const { TwilioSubaccountVault, FakeTwilioProvisioningClient, TwilioProvisioningError } = require('../dist/communication/delivery/twilio-subaccounts.js');

const parent = `AC${'c'.repeat(32)}`;
const org = '33333333-3333-4333-8333-333333333333';
const school = '44444444-4444-4444-8444-444444444444';
const orderId = '66666666-6666-4666-8666-666666666666';
const lease = '77777777-7777-4777-8777-777777777777';
const phone = '+12125550111';
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: parent, TWILIO_AUTH_TOKEN: 'parent-token', HON_TWILIO_PROVISIONING_APPROVED: 'true', ...over });
const origin = 'https://api.hon.example';

function order(over = {}) {
  return { orderId, schoolId: school, phoneE164: phone, locality: 'New York', region: 'NY', monthlyPriceMicrounits: 1150000, status: 'REQUESTED',
    decisionNote: null, decidedAt: null, failureCode: null, outcomeUnknown: false, version: 1, createdAt: '2026-11-14T05:00:00Z', updatedAt: '2026-11-14T05:00:00Z', ...over };
}

/** A fake runtime database that records each SQL call and answers the 0352 functions. */
function fakeDatabase(answers = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('authorize_school_number_search')) return { rows: [{ data: answers.scope ?? { organizationId: org, schoolId: school, hasProvisionedSender: false, openOrder: null } }] };
      if (sql.includes('request_school_number')) {
        if (answers.requestError) throw answers.requestError;
        const input = JSON.parse(values[1]);
        return { rows: [{ data: order({ phoneE164: input.phoneE164, monthlyPriceMicrounits: input.monthlyPriceMicrounits }) }] };
      }
      if (sql.includes('read_school_number_orders')) return { rows: [{ data: { orders: [order()] } }] };
      if (sql.includes('cancel_school_number_order')) return { rows: [{ data: order({ status: 'CANCELLED', version: 2 }) }] };
      return { rows: [] };
    },
  };
  return { calls, withTenantTransaction: async (_context, fn) => fn(client), withTenantReadOnlyTransaction: async (_context, fn) => fn(client) };
}
const context = (over = {}) => ({ organizationId: org, schoolId: school, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI',
  externalSubject: 'subject-1', requestId: 'r', correlationId: 'r', idempotencyKey: '', ...over });

test('price: Twilio decimal prices become microunits; anything else is refused', () => {
  assert.equal(priceToMicrounits('1.15'), 1150000);
  assert.equal(priceToMicrounits('1'), 1000000);
  assert.equal(priceToMicrounits('0.000001'), 1);
  for (const bad of ['-1', '1.1234567', 'abc', '', null, undefined, {}]) assert.equal(priceToMicrounits(bad), null);
});

test('REST number client: READY only with parent credentials and the provisioning switch; switched off it calls nothing', async () => {
  const seen = [];
  const transport = async (url) => { seen.push(url); throw new Error('no network'); };
  assert.equal(new TwilioRestNumberClient(() => env(), transport).readiness(), 'READY');
  for (const over of [{ HON_TWILIO_PROVISIONING_APPROVED: undefined }, { HON_TWILIO_PROVISIONING_APPROVED: 'TRUE' }, { TWILIO_AUTH_TOKEN: '' }, { TWILIO_ACCOUNT_SID: 'AC1' }]) {
    const client = new TwilioRestNumberClient(() => env(over), transport);
    assert.equal(client.readiness(), 'CONFIGURATION_REQUIRED');
    await assert.rejects(client.searchLocalNumbers({ areaCode: '212' }), (e) => e instanceof TwilioProvisioningError && e.code === 'PROVISIONING_NOT_READY');
    await assert.rejects(client.buyNumber({ accountSid: `AC${'a'.repeat(32)}`, authToken: 't' }, phone, `${origin}/v`), (e) => e.code === 'PROVISIONING_NOT_READY');
  }
  assert.deepEqual(seen, []);
});

test('REST number client: search filters capabilities, attaches the local price, and a lost buy is UNKNOWN', async () => {
  const sub = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'sub-token' };
  const requests = [];
  const transport = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('AvailablePhoneNumbers')) {
      return new Response(JSON.stringify({ available_phone_numbers: [
        { phone_number: phone, locality: 'New York', region: 'NY', capabilities: { SMS: true, MMS: true, voice: true } },
        { phone_number: '+12125550222', locality: 'New York', region: 'NY', capabilities: { SMS: true, MMS: false, voice: true } },
      ] }), { status: 200 });
    }
    if (url.includes('pricing.twilio.com')) return new Response(JSON.stringify({ price_unit: 'USD', phone_number_prices: [{ number_type: 'local', base_price: '1.15', current_price: '1.15' }] }), { status: 200 });
    if (url.endsWith('IncomingPhoneNumbers.json') && init.method === 'POST') throw new Error('socket hang up');
    return new Response('{}', { status: 500 });
  };
  const client = new TwilioRestNumberClient(() => env(), transport);
  const found = await client.searchLocalNumbers({ areaCode: '212' });
  assert.deepEqual(found, [{ phoneE164: phone, locality: 'New York', region: 'NY', monthlyPriceMicrounits: 1150000 }]);
  assert.match(requests[0].url, new RegExp(`/Accounts/${parent}/AvailablePhoneNumbers/US/Local.json\\?AreaCode=212&SmsEnabled=true&MmsEnabled=true&VoiceEnabled=true`));
  await assert.rejects(client.buyNumber(sub, phone, `${origin}/v1/communications/webhooks/twilio/voice`), (e) => e instanceof TwilioProvisioningError && e.outcome === 'UNKNOWN');
  const buy = requests.find((r) => r.init.method === 'POST');
  assert.match(buy.url, new RegExp(`/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json$`));
  assert.equal(buy.init.headers.authorization, `Basic ${Buffer.from(`${sub.accountSid}:sub-token`).toString('base64')}`);
});

test('REST number client: Twilio refusing a sold number is FAILED NUMBER_UNAVAILABLE; a GET failure is RETRYABLE', async () => {
  const sub = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'sub-token' };
  const client = new TwilioRestNumberClient(() => env(), async (url, init) => init.method === 'POST'
    ? new Response(JSON.stringify({ code: 21422 }), { status: 400 }) : new Response('{}', { status: 503 }));
  await assert.rejects(client.buyNumber(sub, phone, `${origin}/v`), (e) => e.outcome === 'FAILED' && e.code === 'NUMBER_UNAVAILABLE');
  await assert.rejects(client.findIncomingNumber(sub, phone), (e) => e.outcome === 'RETRYABLE');
});

test('school service: provisioning off answers 503 NUMBER_PROVISIONING_OFF with no database or Twilio call', async () => {
  const database = fakeDatabase();
  const numbers = new FakeTwilioNumberClient({ ready: false });
  const service = new SchoolNumberService(database, numbers);
  await assert.rejects(service.search(context(), { areaCode: '212' }), (e) => e.getResponse().code === 'NUMBER_PROVISIONING_OFF');
  await assert.rejects(service.order(context({ idempotencyKey: 'order-key-1' }), { phoneE164: phone }), (e) => e.getResponse().code === 'NUMBER_PROVISIONING_OFF');
  assert.deepEqual(numbers.calls, []);
  assert.deepEqual(database.calls, []);
});

test('school service: search proves authority first; a bad query or a school with an open order searches nothing', async () => {
  const numbers = new FakeTwilioNumberClient();
  const database = fakeDatabase();
  const result = await new SchoolNumberService(database, numbers).search(context(), { areaCode: '212' });
  assert.equal(result.numbers.length, 3);
  assert.ok(database.calls.findIndex((c) => c.sql.includes('authorize_school_number_search')) >= 0);
  await assert.rejects(new SchoolNumberService(database, numbers).search(context(), { areaCode: '112' }), (e) => e.getResponse().code === 'INVALID_NUMBER_SEARCH');
  await assert.rejects(new SchoolNumberService(database, numbers).search(context(), { areaCode: '212', city: 'x' }), (e) => e.getResponse().code === 'INVALID_NUMBER_SEARCH');
  const busy = new FakeTwilioNumberClient();
  const open = await new SchoolNumberService(fakeDatabase({ scope: { organizationId: org, schoolId: school, hasProvisionedSender: false, openOrder: order() } }), busy)
    .search(context(), { areaCode: '212' });
  assert.deepEqual(open.numbers, []);
  assert.deepEqual(busy.calls, []);
  // Delegated or automated callers are refused before anything runs.
  await assert.rejects(new SchoolNumberService(database, numbers).search(context({ source: 'AI_AGENT' }), { areaCode: '212' }), (e) => e.getResponse().code === 'SENDER_MANAGE_FORBIDDEN');
});

test('school service: the stored price is the server\'s fresh Twilio quote, and the browser cannot send one', async () => {
  const numbers = new FakeTwilioNumberClient({ priceMicrounits: 1340000 });
  const database = fakeDatabase();
  const service = new SchoolNumberService(database, numbers);
  await assert.rejects(service.order(context({ idempotencyKey: 'order-key-1' }), { phoneE164: phone, monthlyPriceMicrounits: 1 }), (e) => e.getResponse().code === 'INVALID_NUMBER_ORDER');
  const placed = await service.order(context({ idempotencyKey: 'order-key-1' }), { phoneE164: phone });
  assert.equal(placed.monthlyPriceMicrounits, 1340000);
  const request = database.calls.find((c) => c.sql.includes('request_school_number'));
  assert.equal(JSON.parse(request.values[1]).monthlyPriceMicrounits, 1340000);
  assert.equal(request.values[2], 'order-key-1');
  assert.deepEqual(numbers.calls, ['lookup']);
  // A number Twilio no longer offers is refused without an order.
  numbers.gone.add('+12125550122');
  await assert.rejects(service.order(context({ idempotencyKey: 'order-key-2' }), { phoneE164: '+12125550122' }), (e) => e.getResponse().code === 'NUMBER_UNAVAILABLE');
  // A school with another open order is refused before Twilio is asked.
  const other = new FakeTwilioNumberClient();
  await assert.rejects(new SchoolNumberService(fakeDatabase({ scope: { organizationId: org, schoolId: school, hasProvisionedSender: false, openOrder: order({ phoneE164: '+13125550111' }) } }), other)
    .order(context({ idempotencyKey: 'order-key-3' }), { phoneE164: phone }), (e) => e.getResponse().code === 'NUMBER_ORDER_OPEN');
  assert.deepEqual(other.calls, []);
  // Database refusals are translated.
  const refused = Object.assign(new Error('SENDER_MANAGE_FORBIDDEN'), { code: '42501' });
  await assert.rejects(new SchoolNumberService(fakeDatabase({ requestError: refused }), new FakeTwilioNumberClient()).order(context({ idempotencyKey: 'order-key-4' }), { phoneE164: phone }),
    (e) => e.getStatus() === 403);
});

test('HQ decision input: APPROVE or REJECT with a version; a rejection needs a note', () => {
  assert.deepEqual(validateNumberOrderDecision({ decision: 'APPROVE', expectedVersion: 1 }), { decision: 'APPROVE', expectedVersion: 1 });
  assert.deepEqual(validateNumberOrderDecision({ decision: 'REJECT', note: ' Pick a local area code ', expectedVersion: 2 }), { decision: 'REJECT', note: 'Pick a local area code', expectedVersion: 2 });
  for (const bad of [null, [], {}, { decision: 'APPROVE' }, { decision: 'BUY', expectedVersion: 1 }, { decision: 'APPROVE', expectedVersion: 0 },
    { decision: 'APPROVE', expectedVersion: 1, schoolId: school }, { decision: 'APPROVE', expectedVersion: 1, note: 'x'.repeat(501) }, { decision: 'REJECT', expectedVersion: 1 }]) {
    assert.throws(() => validateNumberOrderDecision(bad));
  }
});

/** The worker's store: the 0351 subaccount functions plus the 0352 claim and record, over an in-memory row. */
function workerStore(claims) {
  const accounts = new Map();
  const recorded = [];
  return {
    recorded, accounts,
    isConfigured: () => true,
    async beginSchoolTwilioAccount(schoolId) {
      const row = accounts.get(schoolId);
      if (row?.accountSid) return { state: 'ACTIVE', accountSid: row.accountSid };
      accounts.set(schoolId, { claim: 'claim-1' });
      return { state: 'CLAIMED', claimToken: 'claim-1' };
    },
    async completeSchoolTwilioAccount(schoolId, claimToken, accountSid, sealed, keyId) {
      accounts.set(schoolId, { accountSid, sealed, keyId });
      return { accountSid };
    },
    async readTwilioWebhookAccount(accountSid) {
      const [schoolId, row] = [...accounts.entries()].find(([, r]) => r.accountSid === accountSid) ?? [];
      return row ? { schoolId, organizationId: org, sealedAuthToken: row.sealed, vaultKeyId: row.keyId } : null;
    },
    async claimSchoolNumberPurchases() { return claims.splice(0); },
    async recordSchoolNumberPurchase(result) { recorded.push(result); return { status: result.outcome, version: 2 }; },
  };
}
const claim = (over = {}) => ({ orderId, leaseToken: lease, schoolId: school, organizationId: org, phoneE164: phone, attempt: 1, outcomeUnknown: false, ...over });
const setup = (provisioning, vault) => ({ provisioning, vault: () => vault, origin: () => origin });

test('purchase worker: approved order gets a subaccount, the number, one Messaging Service with HON webhooks, and is recorded PURCHASED', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  const provisioning = new FakeTwilioProvisioningClient();
  const numbers = new FakeTwilioNumberClient();
  const store = workerStore([claim()]);
  const summary = await new SchoolNumberPurchaseWorker(store, numbers, setup(provisioning, vault)).runOnce();
  assert.deepEqual(summary, { claimed: 1, purchased: 1, failed: 0, unknown: 0, retry: 0, leaseLost: 0 });
  const [result] = store.recorded;
  const sub = store.accounts.get(school).accountSid;
  assert.equal(result.outcome, 'PURCHASED');
  assert.equal(result.accountSid, sub);
  assert.match(result.numberSid, /^PN[0-9a-f]{32}$/);
  assert.match(result.serviceSid, /^MG[0-9a-f]{32}$/);
  assert.equal(numbers.owned.get(sub).get(phone), result.numberSid);
  const service = numbers.services.get(sub).get(schoolServiceFriendlyName(school));
  assert.deepEqual(service.urls, { inboundUrl: `${origin}/v1/communications/webhooks/twilio/inbound`, statusUrl: `${origin}/v1/communications/webhooks/twilio/status` });
  assert.ok(service.numbers.has(result.numberSid));
  assert.deepEqual(numbers.calls, ['findNumber', 'buy', 'findService', 'createService', 'serviceHasNumber', 'addNumber']);
});

test('purchase worker: a buy whose answer was lost is UNKNOWN, and the next attempt finds the number instead of buying again', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  const provisioning = new FakeTwilioProvisioningClient();
  const numbers = new FakeTwilioNumberClient({ lose: ['buy'] });
  const claims = [claim()];
  const store = workerStore(claims);
  const worker = new SchoolNumberPurchaseWorker(store, numbers, setup(provisioning, vault));
  assert.equal((await worker.runOnce()).unknown, 1);
  assert.equal(store.recorded[0].outcome, 'UNKNOWN');
  claims.push(claim({ attempt: 2, outcomeUnknown: true }));
  assert.equal((await worker.runOnce()).purchased, 1);
  assert.equal(numbers.calls.filter((c) => c === 'buy').length, 1);
  assert.equal(store.recorded[1].outcome, 'PURCHASED');
});

test('purchase worker: a lost service create and a lost add are reconciled; the service is reused, never duplicated', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  const numbers = new FakeTwilioNumberClient({ lose: ['service', 'add'] });
  const claims = [claim()];
  const store = workerStore(claims);
  const worker = new SchoolNumberPurchaseWorker(store, numbers, setup(new FakeTwilioProvisioningClient(), vault));
  await worker.runOnce();
  claims.push(claim({ attempt: 2 }));
  await worker.runOnce();
  claims.push(claim({ attempt: 3 }));
  await worker.runOnce();
  assert.deepEqual(store.recorded.map((r) => r.outcome), ['UNKNOWN', 'UNKNOWN', 'PURCHASED']);
  assert.equal(numbers.calls.filter((c) => c === 'createService').length, 1);
  assert.equal(numbers.calls.filter((c) => c === 'addNumber').length, 1);
  assert.equal(numbers.calls.filter((c) => c === 'buy').length, 1);
});

test('purchase worker: switch off, missing vault or missing origin claims nothing and calls Twilio zero times', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  for (const [numbers, provisioning, v, o] of [
    [new FakeTwilioNumberClient({ ready: false }), new FakeTwilioProvisioningClient(), vault, origin],
    [new FakeTwilioNumberClient(), { readiness: () => 'CONFIGURATION_REQUIRED' }, vault, origin],
    [new FakeTwilioNumberClient(), new FakeTwilioProvisioningClient(), null, origin],
    [new FakeTwilioNumberClient(), new FakeTwilioProvisioningClient(), vault, undefined],
  ]) {
    const claims = [claim()];
    const store = workerStore(claims);
    const summary = await new SchoolNumberPurchaseWorker(store, numbers, { provisioning, vault: () => v, origin: () => o }).runOnce();
    assert.equal(summary.claimed, 0);
    assert.equal(claims.length, 1, 'nothing was claimed');
    assert.deepEqual(numbers.calls, []);
  }
});

test('purchase worker: a number Twilio already sold is FAILED NUMBER_UNAVAILABLE; a lost lease is counted, never re-recorded', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  const numbers = new FakeTwilioNumberClient();
  numbers.gone.add(phone);
  const store = workerStore([claim()]);
  await new SchoolNumberPurchaseWorker(store, numbers, setup(new FakeTwilioProvisioningClient(), vault)).runOnce();
  assert.deepEqual([store.recorded[0].outcome, store.recorded[0].failureCode], ['FAILED', 'NUMBER_UNAVAILABLE']);
  const lost = workerStore([claim()]);
  lost.recordSchoolNumberPurchase = async () => { throw Object.assign(new Error('PURCHASE_LEASE_LOST'), { code: '40001' }); };
  const summary = await new SchoolNumberPurchaseWorker(lost, new FakeTwilioNumberClient(), setup(new FakeTwilioProvisioningClient(), vault)).runOnce();
  assert.equal(summary.leaseLost, 1);
});

test('purchase worker: once the number is bought, a later failure or retry carries its SID so the order stays unsettled', async () => {
  const vault = new TwilioSubaccountVault(randomBytes(32), 'test-1');
  const numbers = new FakeTwilioNumberClient();
  numbers.createService = async () => { numbers.calls.push('createService'); throw new TwilioProvisioningError('FAILED', 'PROVIDER_REJECTED'); };
  const claims = [claim()];
  const store = workerStore(claims);
  const worker = new SchoolNumberPurchaseWorker(store, numbers, setup(new FakeTwilioProvisioningClient(), vault));
  await worker.runOnce();
  const sub = store.accounts.get(school).accountSid;
  assert.equal(store.recorded[0].outcome, 'FAILED');
  assert.equal(store.recorded[0].numberSid, numbers.owned.get(sub).get(phone));
  numbers.createService = async () => { numbers.calls.push('createService'); throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_UNREACHABLE'); };
  claims.push(claim({ attempt: 2 }));
  await worker.runOnce();
  assert.deepEqual([store.recorded[1].outcome, store.recorded[1].numberSid], ['RETRY', numbers.owned.get(sub).get(phone)]);
  // Before the buy, a retry carries no SID.
  const early = workerStore([claim()]);
  const fresh = new FakeTwilioNumberClient();
  fresh.findIncomingNumber = async () => { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_UNREACHABLE'); };
  await new SchoolNumberPurchaseWorker(early, fresh, setup(new FakeTwilioProvisioningClient(), vault)).runOnce();
  assert.equal(early.recorded[0].outcome, 'RETRY');
  assert.equal(early.recorded[0].numberSid, undefined);
});

test('school service: an unsettled earlier order blocks a new one before Twilio is asked', async () => {
  const numbers = new FakeTwilioNumberClient();
  const unsettled = order({ status: 'FAILED', failureCode: 'RECONCILE_REQUIRED', outcomeUnknown: true, phoneE164: '+13125550111' });
  await assert.rejects(new SchoolNumberService(fakeDatabase({ scope: { organizationId: org, schoolId: school, hasProvisionedSender: false, openOrder: unsettled } }), numbers)
    .order(context({ idempotencyKey: 'order-key-9' }), { phoneE164: phone }), (e) => e.getResponse().code === 'NUMBER_ORDER_UNSETTLED');
  assert.deepEqual(numbers.calls, []);
});

test('HQ settle: only BOUGHT or NOT_BOUGHT with a note and version, passed to the 0358 function; refusals are translated', async () => {
  assert.deepEqual(validateNumberOrderSettle({ finding: 'NOT_BOUGHT', note: ' Not on the subaccount ', expectedVersion: 7 }), { finding: 'NOT_BOUGHT', note: 'Not on the subaccount', expectedVersion: 7 });
  for (const bad of [null, {}, { finding: 'BOUGHT', expectedVersion: 1 }, { finding: 'MAYBE', note: 'x', expectedVersion: 1 }, { finding: 'BOUGHT', note: ' ', expectedVersion: 1 },
    { finding: 'BOUGHT', note: 'x', expectedVersion: 0 }, { finding: 'BOUGHT', note: 'x', expectedVersion: 1, schoolId: school }]) assert.throws(() => validateNumberOrderSettle(bad));
  const calls = [];
  const database = { callSaasBilling: async (name, params) => { calls.push([name, params]); if (params[1] === lease) throw Object.assign(new Error('NUMBER_ORDER_NOT_UNSETTLED'), { code: '55000' }); return { ok: true }; } };
  const controller = new SchoolNumberOrderHqController(database);
  const req = { honIdentity: { externalSubject: 'hq-subject' } };
  assert.deepEqual(await controller.settle(req, orderId, { finding: 'BOUGHT', note: 'PN found on the subaccount', expectedVersion: 3 }), { data: { ok: true } });
  assert.deepEqual(calls[0], ['settleSchoolNumberOrder', ['hq-subject', orderId, 'BOUGHT', 'PN found on the subaccount', '3']]);
  await assert.rejects(controller.settle(req, lease, { finding: 'NOT_BOUGHT', note: 'x', expectedVersion: 1 }), (e) => e.getResponse().code === 'NUMBER_ORDER_NOT_UNSETTLED');
  await assert.rejects(controller.settle(req, 'not-a-uuid', { finding: 'NOT_BOUGHT', note: 'x', expectedVersion: 1 }), (e) => e.getStatus() === 400);
  await assert.rejects(controller.settle({}, orderId, { finding: 'NOT_BOUGHT', note: 'x', expectedVersion: 1 }), (e) => e.getStatus() === 403);
});

test('fake number client is refused in production and staging', () => {
  assert.throws(() => new FakeTwilioNumberClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'production' }), /FAKE_TWILIO_PROVISIONING_REFUSED/);
  assert.throws(() => new FakeTwilioNumberClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'staging' }), /FAKE_TWILIO_PROVISIONING_REFUSED/);
  assert.throws(() => new FakeTwilioNumberClient({}, { NODE_ENV: 'production' }), /FAKE_TWILIO_PROVISIONING_REFUSED/);
});
