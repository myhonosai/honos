const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const contracts = require('@hon/contracts');
const { HqNumberService, HQ_SERVICE_FRIENDLY_NAME, environmentHqNumberSetup } = require('../dist/hq-communications/hq-number.service.js');
const { FakeTwilioNumberClient } = require('../dist/communication/delivery/twilio-numbers.js');
const { TwilioProvisioningError } = require('../dist/communication/delivery/twilio-subaccounts.js');

// HQ-NUM (0704): HQ buys its own texting number on HON's parent Twilio account. The database proves the HQ owner before
// any Twilio call; a switched-off API makes no Twilio call; every step reads before it creates, so Finish setup after a
// lost answer never buys twice; only a refusal before HON holds the number fails the order.
const U = () => randomUUID(), T = '2026-11-28T00:00:00.000Z';
const PARENT = { accountSid: 'AC' + 'a'.repeat(32), authToken: 'parent-token' };
const SETUP = { parent: () => PARENT, origin: () => 'https://api.hon.example' };
const person = { principalId: U(), displayName: 'David' };

/** In-memory stand-in for the 0704 functions (the DB proof covers the real ones). */
function fakeBilling({ owner = true, activeSender = false } = {}) {
  const state = { orders: [], activeSender, calls: [] };
  const deny = () => { const e = new Error('SAAS_FORBIDDEN'); e.status = 403; e.getStatus = () => 403; throw e; };
  const json = (o) => { const { lease, ...rest } = o; return { ...rest, inProgress: !!lease }; };
  return {
    state,
    async call(op, params, validate) {
      state.calls.push(op);
      if (!owner) deny();
      if (op === 'readHqNumberOrders') return validate({ orders: state.orders.map(json), hasActiveSmsSender: state.activeSender, asOf: T });
      if (op === 'startHqNumberOrder') {
        const input = JSON.parse(params[1]);
        const order = { orderId: U(), ...input, status: 'BUYING', numberSid: null, serviceSid: null, failureCode: null, senderId: null,
          requestedBy: person, requestedAt: T, finishedAt: null, version: 1, lease: null };
        state.orders.unshift(order);
        return validate({ order: json(order), replayed: false });
      }
      if (op === 'claimHqNumberOrder') {
        const order = state.orders.find((o) => o.orderId === params[1]);
        if (order.status !== 'BUYING') return validate({ order: json(order), leaseToken: null });
        if (order.lease) { const e = new Error('busy'); e.response = { code: 'HQ_NUMBER_ORDER_BUSY' }; e.getStatus = () => 422; throw e; }
        order.lease = U(); order.version += 1;
        return validate({ order: json(order), leaseToken: order.lease });
      }
      if (op === 'finishHqNumberOrder') {
        const order = state.orders.find((o) => o.orderId === params[1]); const input = JSON.parse(params[2]);
        if (order.lease !== input.leaseToken) { const e = new Error('busy'); e.response = { code: 'HQ_NUMBER_ORDER_BUSY' }; e.getStatus = () => 422; throw e; }
        if (input.outcome === 'RELEASE') { order.lease = null; order.version += 1; return validate({ order: json(order), replayed: false, sender: null }); }
        Object.assign(order, { lease: null, status: input.outcome, numberSid: input.numberSid, serviceSid: input.serviceSid, failureCode: input.failureCode,
          finishedAt: T, version: order.version + 1 });
        let sender = null;
        if (input.outcome === 'READY') {
          order.senderId = U(); state.activeSender = true;
          sender = { senderId: order.senderId, channel: 'SMS', status: 'ACTIVE', emailFrom: null, emailDisplayName: null, smsServiceSid: input.serviceSid,
            smsReplyNumber: order.phoneE164, a2pState: 'NOT_REGISTERED', mmsConverterConfirmed: true, createdBy: person, createdAt: T, version: 1 };
        }
        return validate({ order: json(order), replayed: false, sender });
      }
      throw new Error('unexpected ' + op);
    },
  };
}
const make = (opts = {}) => {
  const billing = fakeBilling(opts.billing);
  const twilio = opts.twilio ?? new FakeTwilioNumberClient({ ready: opts.ready ?? true });
  return { billing, twilio, service: new HqNumberService(billing, twilio, opts.setup ?? SETUP) };
};
const PHONE = '+15125550111';

test('contracts: HQ number command values match the SaaS command table and inputs are closed', () => {
  assert.deepEqual(contracts.HQ_NUMBER_COMMANDS, { buy: contracts.SAAS_COMMANDS.buyHqNumber, finish: contracts.SAAS_COMMANDS.finishHqNumberOrder });
  assert.deepEqual(contracts.validateHqNumberBuyInput({ phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }), { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 });
  for (const bad of [{ phoneE164: '5125550111', monthlyPriceMicrounits: 1 }, { phoneE164: PHONE, monthlyPriceMicrounits: -1 }, { phoneE164: PHONE },
    { phoneE164: PHONE, monthlyPriceMicrounits: 1.5 }, { phoneE164: PHONE, monthlyPriceMicrounits: 1, extra: 1 }])
    assert.throws(() => contracts.validateHqNumberBuyInput(bad), JSON.stringify(bad));
});

test('switched off: no Twilio call for search, buy or finish; the panel says SWITCHED_OFF', async () => {
  const { service, twilio } = make({ ready: false });
  assert.deepEqual(await service.search('s', { areaCode: '512' }), { status: 'SWITCHED_OFF', numbers: [] });
  await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'NUMBER_PROVISIONING_OFF');
  assert.equal((await service.view('s')).provisioning, 'SWITCHED_OFF');
  const noCreds = make({ setup: { parent: () => null, origin: () => 'https://api.hon.example' } });
  assert.equal((await noCreds.service.view('s')).provisioning, 'SWITCHED_OFF');
  assert.deepEqual(twilio.calls, []); assert.deepEqual(noCreds.twilio.calls, []);
});

test('not the HQ owner: refused by the database before any Twilio call', async () => {
  const { service, twilio } = make({ billing: { owner: false } });
  await assert.rejects(service.search('s', { areaCode: '512' }));
  await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()));
  assert.deepEqual(twilio.calls, []);
});

test('buy: re-quotes, buys on the parent account, makes the hon-hq service with the number and the HQ sender', async () => {
  const { service, twilio, billing } = make();
  const found = await service.search('s', { areaCode: '512' });
  assert.equal(found.status, 'READY'); assert.ok(found.numbers.length);
  const pick = found.numbers[0];
  const receipt = await service.buy('s', { phoneE164: pick.phoneE164, monthlyPriceMicrounits: pick.monthlyPriceMicrounits }, U());
  assert.equal(receipt.order.status, 'READY');
  assert.equal(receipt.sender.smsReplyNumber, pick.phoneE164); assert.equal(receipt.sender.a2pState, 'NOT_REGISTERED');
  assert.ok(twilio.owned.get(PARENT.accountSid).has(pick.phoneE164), 'bought on the parent account');
  const svc = twilio.services.get(PARENT.accountSid).get(HQ_SERVICE_FRIENDLY_NAME);
  assert.equal(svc.sid, receipt.order.serviceSid); assert.ok(svc.numbers.has(receipt.order.numberSid));
  assert.equal(svc.urls.inboundUrl, 'https://api.hon.example/v1/communications/webhooks/twilio/inbound');
  assert.equal(svc.urls.statusUrl, 'https://api.hon.example/v1/communications/webhooks/twilio/hq-status');
  assert.equal(billing.state.orders[0].monthlyPriceMicrounits, 1150000, 'the API quote is kept');
  // With a sender now active, search returns nothing and another buy is refused before Twilio.
  const before = twilio.calls.length;
  assert.deepEqual((await service.search('s', { areaCode: '512' })).numbers, []);
  await assert.rejects(service.buy('s', { phoneE164: '+15125550122', monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'HQ_SENDER_EXISTS');
  assert.equal(twilio.calls.length, before);
});

test('price went up or number gone: nothing is ordered or bought', async () => {
  const { service, twilio, billing } = make({ twilio: new FakeTwilioNumberClient({ priceMicrounits: 1_500_000 }) });
  await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'PRICE_CHANGED');
  twilio.gone.add('+15125550122');
  await assert.rejects(service.buy('s', { phoneE164: '+15125550122', monthlyPriceMicrounits: 1500000 }, U()), (e) => e.response?.code === 'NUMBER_UNAVAILABLE');
  assert.ok(!twilio.calls.includes('buy')); assert.ok(!billing.state.calls.includes('startHqNumberOrder'));
});

test('lost answers: the order stays BUYING and Finish setup completes it without a second buy or service', async () => {
  for (const lose of ['buy', 'service', 'add']) {
    const twilio = new FakeTwilioNumberClient({ lose: [lose] });
    const { service, billing } = make({ twilio });
    await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'HQ_NUMBER_SETUP_INCOMPLETE', lose);
    const order = billing.state.orders[0];
    assert.equal(order.status, 'BUYING', lose);
    // After a lost buy the lease stays (Twilio's list may lag); after the number is held it is released at once.
    assert.equal(!!order.lease, lose === 'buy', `${lose}: lease kept only when the buy outcome is unknown`);
    if (lose === 'buy') {
      await assert.rejects(service.finish('s', order.orderId, {}), (e) => e.response?.code === 'HQ_NUMBER_ORDER_BUSY');
      order.lease = null; // the five minutes pass
    }
    const done = await service.finish('s', order.orderId, {});
    assert.equal(done.order.status, 'READY', lose);
    assert.equal(twilio.calls.filter((c) => c === 'buy').length, 1, `${lose}: bought once`);
    assert.equal(twilio.calls.filter((c) => c === 'createService').length, 1, `${lose}: one service`);
    // Buying the same number again resumes nothing new: the order is READY and a sender exists.
    await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'HQ_SENDER_EXISTS');
  }
});

test('a definite refusal before HON holds the number fails the order and frees the slot', async () => {
  const twilio = new FakeTwilioNumberClient();
  twilio.buyNumber = async () => { twilio.calls.push('buy'); throw new TwilioProvisioningError('FAILED', 'NUMBER_UNAVAILABLE'); };
  const { service, billing } = make({ twilio });
  const r = await service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U());
  assert.equal(r.order.status, 'FAILED'); assert.equal(r.order.failureCode, 'NUMBER_UNAVAILABLE'); assert.equal(r.sender, null);
  assert.equal(billing.state.activeSender, false);
});

test('a refusal after HON holds the number never fails the order (it keeps the number for Finish setup)', async () => {
  const twilio = new FakeTwilioNumberClient();
  twilio.createService = async () => { throw new TwilioProvisioningError('FAILED', 'PROVIDER_REJECTED'); };
  const { service, billing } = make({ twilio });
  await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'HQ_NUMBER_SETUP_INCOMPLETE');
  assert.equal(billing.state.orders[0].status, 'BUYING');
});

test('finish: closed body, unknown order, finished order replay', async () => {
  const { service } = make();
  await assert.rejects(service.finish('s', U(), { x: 1 }), (e) => e.response?.code === 'INVALID_SAAS_INPUT');
  await assert.rejects(service.finish('s', U(), {}), (e) => e.response?.code === 'SAAS_UNAVAILABLE');
  const r = await service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U());
  const again = await service.finish('s', r.order.orderId, {});
  assert.equal(again.replayed, true); assert.equal(again.order.status, 'READY');
});

test('environment setup: parent credentials only with a valid account SID and a token', () => {
  assert.equal(environmentHqNumberSetup(() => ({})).parent(), null);
  assert.equal(environmentHqNumberSetup(() => ({ TWILIO_ACCOUNT_SID: 'ACnope', TWILIO_AUTH_TOKEN: 'x' })).parent(), null);
  assert.deepEqual(environmentHqNumberSetup(() => ({ TWILIO_ACCOUNT_SID: PARENT.accountSid, TWILIO_AUTH_TOKEN: ' t ' })).parent(), { accountSid: PARENT.accountSid, authToken: 't' });
});

test('two runs at once (double click, early Finish setup): one Twilio run, one purchase, order READY', async () => {
  const twilio = new FakeTwilioNumberClient();
  const realFind = twilio.findIncomingNumber.bind(twilio);
  let release; const gate = new Promise((r) => { release = r; });
  twilio.findIncomingNumber = async (...args) => { const r = await realFind(...args); await gate; return r; };
  const { service, billing } = make({ twilio });
  const body = { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 };
  const first = service.buy('s', body, U());
  await new Promise((r) => setImmediate(r));
  const order = billing.state.orders[0];
  await assert.rejects(service.buy('s', body, U()), (e) => e.response?.code === 'HQ_NUMBER_ORDER_BUSY', 'second Buy refused before Twilio');
  await assert.rejects(service.finish('s', order.orderId, {}), (e) => e.response?.code === 'HQ_NUMBER_ORDER_BUSY', 'early Finish setup refused');
  release();
  assert.equal((await first).order.status, 'READY');
  assert.equal(twilio.calls.filter((c) => c === 'buy').length, 1);
});

test('"not available" for a number HON already holds never fails the order', async () => {
  const twilio = new FakeTwilioNumberClient();
  let first = true;
  twilio.findIncomingNumber = async (sub, phone) => { twilio.calls.push('findNumber'); if (first) { first = false; return null; } return { numberSid: 'PN' + 'c'.repeat(32) }; };
  twilio.buyNumber = async () => { twilio.calls.push('buy'); throw new TwilioProvisioningError('FAILED', 'NUMBER_UNAVAILABLE'); };
  const { service, billing } = make({ twilio });
  await assert.rejects(service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U()), (e) => e.response?.code === 'HQ_NUMBER_SETUP_INCOMPLETE');
  assert.equal(billing.state.orders[0].status, 'BUYING');
  assert.equal(billing.state.orders[0].lease, null, 'released: HON holds the number');
});

test('a hon-hq service made earlier is set to HON\'s webhooks with MMS Converter on before it is used', async () => {
  const twilio = new FakeTwilioNumberClient();
  const old = await twilio.createService(PARENT, HQ_SERVICE_FRIENDLY_NAME, { inboundUrl: 'https://old.example/in', statusUrl: 'https://old.example/st' });
  twilio.mmsOff.add(old.serviceSid);
  const { service } = make({ twilio });
  const r = await service.buy('s', { phoneE164: PHONE, monthlyPriceMicrounits: 1150000 }, U());
  assert.equal(r.order.serviceSid, old.serviceSid);
  assert.ok(twilio.calls.includes('configureService'));
  assert.ok(!twilio.mmsOff.has(old.serviceSid));
  assert.equal(twilio.services.get(PARENT.accountSid).get(HQ_SERVICE_FRIENDLY_NAME).urls.inboundUrl, 'https://api.hon.example/v1/communications/webhooks/twilio/inbound');
});
