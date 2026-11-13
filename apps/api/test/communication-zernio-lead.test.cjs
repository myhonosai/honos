const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { ZernioLeadWebhookVerifier, ZernioWebhookError, parseZernioLeadFormInput, zernioLeadIntakeReady } = require('../dist/communication/delivery/zernio-lead-webhook.js');
const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');

const secret = 's'.repeat(40);
const env = (over = {}) => ({ ZERNIO_WEBHOOK_SECRET: secret, HON_ZERNIO_LEAD_INTAKE_APPROVED: 'true', ...over });
const event = (over = {}, lead = {}) => ({
  id: 'evt_123', event: 'lead.received', timestamp: '2026-11-09T10:00:00Z',
  lead: { id: 'zl1', leadgenId: '9001', formId: '777', formName: 'Trial class', adId: '55', adsetId: '66', campaignId: '77', isOrganic: false,
    fields: { full_name: 'Ada Lovelace', email: 'ADA@Example.test', phone_number: '+1 555 555 0101', class_time: ['k1', 'k2'], note: { nested: true } }, ...lead },
  account: { id: '12345', accountId: '12345', platform: 'facebook', profileId: 'p1' }, ...over,
});
const sign = (body, key = secret) => createHmac('sha256', key).update(body).digest('hex');
const raw = (value) => Buffer.from(JSON.stringify(value));
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof ZernioWebhookError ? error.reason : error.message; } };

test('Zernio lead intake is INACTIVE unless a long secret and the exact approval are set', () => {
  assert.equal(zernioLeadIntakeReady(env()), true);
  for (const over of [{ ZERNIO_WEBHOOK_SECRET: undefined }, { ZERNIO_WEBHOOK_SECRET: 'short' }, { HON_ZERNIO_LEAD_INTAKE_APPROVED: 'yes' }, { HON_ZERNIO_LEAD_INTAKE_APPROVED: undefined }]) {
    assert.equal(zernioLeadIntakeReady(env(over)), false);
    const body = raw(event());
    assert.equal(reason(() => new ZernioLeadWebhookVerifier(() => env(over)).verify(body, sign(body))), 'NOT_CONFIGURED');
  }
});

test('Zernio signature: hex HMAC-SHA256 of the raw body; forged, altered or missing signatures are refused', () => {
  const verifier = new ZernioLeadWebhookVerifier(() => env());
  const body = raw(event());
  const lead = verifier.verify(body, sign(body));
  assert.deepEqual(lead, { eventId: 'evt_123', leadgenId: '9001', accountId: '12345', formId: '777',
    fields: { full_name: 'Ada Lovelace', email: 'ADA@Example.test', phone_number: '+1 555 555 0101', class_time: 'k1, k2' },
    ad: { adId: '55', adsetId: '66', campaignId: '77', isOrganic: false } });
  assert.equal(reason(() => verifier.verify(body, sign(body, 'x'.repeat(40)))), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.verify(Buffer.from(body.toString().replace('Ada', 'Eve')), sign(body))), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.verify(body, undefined)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.verify(body, sign(body).toUpperCase())), 'SIGNATURE_INVALID');
});

test('only signed lead.received for a Facebook account is a lead; other events and test deliveries are ignored; bad shapes are malformed', () => {
  const verifier = new ZernioLeadWebhookVerifier(() => env());
  const check = (value) => { const body = raw(value); return verifier.verify(body, sign(body)); };
  assert.equal(check(event({ event: 'post.published' })), null);
  assert.equal(check(event({ test: true })), null);
  const malformed = (value) => reason(() => check(value));
  assert.equal(malformed(event({ account: { id: '12345', platform: 'instagram' } })), 'MALFORMED');
  assert.equal(malformed(event({ id: 'bad id with spaces' })), 'MALFORMED');
  assert.equal(malformed(event({}, { leadgenId: undefined })), 'MALFORMED');
  assert.equal(malformed(event({}, { formId: '../x' })), 'MALFORMED');
  assert.equal(malformed(event({}, { fields: [] })), 'MALFORMED');
  const notJson = Buffer.from('not json');
  assert.equal(reason(() => verifier.verify(notJson, sign(notJson))), 'MALFORMED');
  const organic = check(event({}, { adId: null, adsetId: null, campaignId: null, isOrganic: true }));
  assert.deepEqual(organic.ad, { isOrganic: true });
});

test('HQ Zernio form mapping input is strict', () => {
  const ok = { accountId: '12345', formId: '777', pipelineId: '11111111-1111-4111-8111-111111111111', pipelineStageId: '22222222-2222-4222-8222-222222222222', status: 'ACTIVE' };
  assert.deepEqual(parseZernioLeadFormInput(ok), ok);
  assert.deepEqual(parseZernioLeadFormInput({ ...ok, fieldMap: { givenName: 'first_name', familyName: 'last_name', phone: 'phone' }, expectedVersion: 2 }),
    { ...ok, fieldMap: { givenName: 'first_name', familyName: 'last_name', phone: 'phone' }, expectedVersion: 2 });
  for (const body of [null, [], { ...ok, extra: 1 }, { ...ok, accountId: 'a b' }, { ...ok, pipelineId: 'x' }, { ...ok, status: 'ON' }, { ...ok, expectedVersion: 0 },
    { ...ok, fieldMap: { email: 'email' } }, { ...ok, fieldMap: { fullName: 'full_name' } }, { ...ok, fieldMap: { fullName: 'full_name', email: 'email', note: 'n' } },
    { ...ok, fieldMap: { fullName: 'full name', email: 'email' } }]) {
    assert.equal(parseZernioLeadFormInput(body), null, JSON.stringify(body));
  }
});

test('Zernio webhook controller: created and replayed answer 200, unmapped 422 (no retry), rate limit 429, database trouble 503', async () => {
  const outcomes = [];
  const store = (outcome) => ({ isConfigured: () => true, recordZernioLead: async (lead) => { outcomes.push(lead); if (outcome instanceof Error) throw outcome; return { outcome, leadId: null }; } });
  const run = async (outcome, value = event()) => {
    const controller = new CommunicationWebhookController(store(outcome), new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => env()));
    const body = raw(value);
    try { return { status: 200, body: await controller.zernioLead({ body }, sign(body)) }; } catch (error) { return { status: error.getStatus() }; }
  };
  assert.deepEqual(await run('CREATED'), { status: 200, body: { received: true } });
  assert.equal((await run('REPLAYED')).status, 200);
  assert.equal((await run('INVALID_CONTACT')).status, 200);
  assert.equal((await run('SCHOOL_INACTIVE')).status, 200);
  assert.equal((await run('UNROUTED')).status, 422);
  assert.equal((await run('RATE_LIMITED')).status, 429);
  assert.equal((await run(new Error('connection lost'))).status, 503);
  assert.equal((await run(Object.assign(new Error('bad'), { code: '22023' }))).status, 422);
  const before = outcomes.length;
  assert.equal((await run('CREATED', event({ event: 'comment.received' }))).status, 200);
  assert.equal(outcomes.length, before, 'an ignored event never reaches the database');
  const unconfigured = new CommunicationWebhookController(store('CREATED'), new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => ({})));
  const body = raw(event());
  await assert.rejects(unconfigured.zernioLead({ body }, sign(body)), (e) => e.getStatus() === 503);
});
