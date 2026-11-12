const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqContactController } = require('../dist/hq-communications/hq-contact.controller.js');
const { HqContactService } = require('../dist/hq-communications/hq-contact.service.js');
const { HqMessageWorkerDatabase } = require('../dist/hq-communications/hq-message-dispatcher.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const contact = (patch = {}) => ({ status: 'REMOVED', phone: null, codeExpiresAt: null, codeExpired: false, wrongCodes: 0, codesLeftToday: 5, confirmedAt: null,
  textingOn: false, version: 0, hqNumber: { ready: true, a2pState: 'REGISTERED_SERVICE' }, ...patch });
const pending = (patch = {}) => contact({ status: 'PENDING', phone: '+15550100001', codeExpiresAt: T2, codesLeftToday: 4, version: 2, ...patch });
const confirmed = (patch = {}) => contact({ status: 'CONFIRMED', phone: '+15550100001', confirmedAt: T, textingOn: true, version: 3, ...patch });

test('contracts: own-phone inputs are closed; answers are consistent and show the code only once', () => {
  assert.equal(contracts.normalizeHqContactPhone('(555) 010-0001'), '+15550100001');
  assert.equal(contracts.normalizeHqContactPhone('1 555 010 0001'), '+15550100001');
  assert.equal(contracts.normalizeHqContactPhone('+82 10 1234 5678'), '+821012345678');
  for (const bad of ['555-0100', 'call me', '+0123456789']) assert.equal(contracts.normalizeHqContactPhone(bad), null, bad);
  assert.deepEqual(contracts.validateHqContactPhoneStartInput({ phone: '+15550100001', expectedVersion: 0 }), { phone: '+15550100001', expectedVersion: 0 });
  for (const bad of [{ phone: '5550100001', expectedVersion: 0 }, { phone: '+15550100001' }, { phone: '+15550100001', expectedVersion: 0, x: 1 }])
    assert.throws(() => contracts.validateHqContactPhoneStartInput(bad));
  assert.throws(() => contracts.validateHqContactTextingInput({ enabled: 'yes', expectedVersion: 1 }));
  assert.equal(contracts.validateHqContactView({ contact: contact(), asOf: T2 }).contact.status, 'REMOVED');
  for (const bad of [contact({ phone: '+15550100001' }), contact({ textingOn: true }), pending({ codeExpiresAt: null }), confirmed({ confirmedAt: null }),
    contact({ hqNumber: { ready: true, a2pState: 'PENDING', smsServiceSid: 'MG' } }), contact({ codeExpired: true })])
    assert.throws(() => contracts.validateHqContactView({ contact: bad, asOf: T2 }), JSON.stringify(bad));
  assert.equal(contracts.validateHqContactReceipt({ operation: 'PHONE_START', contact: pending(), code: '123456', replayed: false }).code, '123456');
  assert.equal(contracts.validateHqContactReceipt({ operation: 'PHONE_START', contact: pending(), code: null, replayed: true }).code, null);
  for (const bad of [{ operation: 'PHONE_START', contact: pending(), code: '123456', replayed: true }, { operation: 'PHONE_START', contact: pending(), code: null, replayed: false },
    { operation: 'PHONE_START', contact: pending(), replayed: false }, { operation: 'PHONE_REMOVE', contact: pending(), replayed: false },
    { operation: 'TEXTING', contact: confirmed(), code: '1', replayed: false }])
    assert.throws(() => contracts.validateHqContactReceipt(bad), JSON.stringify(bad));
  assert.deepEqual(Object.values(contracts.HQ_CONTACT_COMMANDS), [contracts.SAAS_COMMANDS.startMyHqPhone, contracts.SAAS_COMMANDS.setMyHqTexting, contracts.SAAS_COMMANDS.removeMyHqPhone]);
  for (const text of Object.values(contracts.HQ_INBOUND_REPLIES)) assert.ok(text.startsWith('HON OS:') && text.length <= 160, text);
  assert.match(contracts.HQ_INBOUND_REPLIES.HELP, /STOP/);
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: only the verified subject and the validated body reach the database; refusals map to stable codes', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => ({ contact: contact(), asOf: T2 });
  const module = await Test.createTestingModule({ controllers: [HqContactController],
    providers: [HqContactService, SaasBillingService, SaasReadGuard, SaasCommandGuard,
      { provide: RuntimeDatabaseService, useValue: { callSaasBilling: async (op, params) => { calls.push([op, params]); return reply(); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/me/hq-contact`;
  try {
    assert.equal((await send(base)).status, 200);
    assert.deepEqual(calls.at(-1), ['readMyHqContact', ['verified-human']]);
    const n = calls.length;
    assert.equal((await send(`${base}?userId=${U()}`)).status, 400, 'no query, so no other user can be named');
    assert.equal(calls.length, n);
    const key = U(), input = { phone: '+15550100001', expectedVersion: 0 };
    reply = () => ({ operation: 'PHONE_START', contact: pending(), code: '482913', replayed: false });
    const started = await send(`${base}/phone`, { method: 'POST', headers: command('hq-contact-phone-start', key), body: JSON.stringify(input) });
    assert.equal(started.status, 200, started.body); assert.equal(JSON.parse(started.body).data.code, '482913');
    assert.deepEqual(calls.at(-1), ['startMyHqPhone', ['verified-human', JSON.stringify(input), key]]);
    reply = () => ({ operation: 'PHONE_START', contact: pending({ phone: '+15550100002' }), code: '482913', replayed: false });
    assert.equal((await send(`${base}/phone`, { method: 'POST', headers: command('hq-contact-phone-start'), body: JSON.stringify(input) })).status, 503, 'an answer about another number is never shown');
    const k = calls.length;
    assert.equal((await send(`${base}/phone`, { method: 'POST', headers: command('hq-contact-texting'), body: JSON.stringify(input) })).status, 403, 'wrong marker');
    assert.equal((await send(`${base}/phone`, { method: 'POST', headers: command('hq-contact-phone-start'), body: JSON.stringify({ ...input, phone: '555' }) })).status, 400);
    assert.equal((await send(`${base}/texting`, { method: 'POST', headers: command('hq-contact-texting'), body: JSON.stringify({ enabled: true, expectedVersion: 1, userId: U() }) })).status, 400);
    assert.equal(calls.length, k);
    reply = () => ({ operation: 'TEXTING', contact: confirmed({ textingOn: false, version: 4 }), replayed: false });
    assert.equal((await send(`${base}/texting`, { method: 'POST', headers: command('hq-contact-texting', key), body: JSON.stringify({ enabled: false, expectedVersion: 3 }) })).status, 200);
    reply = () => ({ operation: 'TEXTING', contact: confirmed(), replayed: false });
    assert.equal((await send(`${base}/texting`, { method: 'POST', headers: command('hq-contact-texting'), body: JSON.stringify({ enabled: false, expectedVersion: 3 }) })).status, 503, 'switch must match');
    reply = () => ({ operation: 'PHONE_REMOVE', contact: contact({ version: 5 }), replayed: false });
    assert.equal((await send(`${base}/phone/remove`, { method: 'POST', headers: command('hq-contact-phone-remove', key), body: JSON.stringify({ expectedVersion: 4 }) })).status, 200);
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'HQ_TEXTING_UNAVAILABLE', 422, 'HQ_TEXTING_UNAVAILABLE'], ['23514', 'HQ_PHONE_IN_USE', 422, 'HQ_PHONE_IN_USE'], ['23514', 'HQ_PHONE_CODE_LIMIT', 422, 'HQ_PHONE_CODE_LIMIT'],
      ['23514', 'HQ_PHONE_ALREADY_CONFIRMED', 422, 'HQ_PHONE_ALREADY_CONFIRMED'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/phone`, { method: 'POST', headers: command('hq-contact-phone-start'), body: JSON.stringify(input) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

test('worker seam: inbound texts return only the fixed reply for a known reply kind', async () => {
  const db = new HqMessageWorkerDatabase();
  const seen = [];
  db.query = async (sql, values) => { seen.push([sql, values]); return [db.next]; };
  db.next = { outcome: 'CONFIRMED', reply: 'CONFIRMED', replayed: false };
  const text = { provider: 'FAKE', eventId: 'ev-1', from: '+15550100001', toService: 'MG' + '0'.repeat(32), body: 'HON 482913', receivedAt: T };
  assert.deepEqual(await db.recordInbound(text), { outcome: 'CONFIRMED', reply: 'CONFIRMED', replyText: contracts.HQ_INBOUND_REPLIES.CONFIRMED, replayed: false });
  assert.match(seen[0][0], /record_hq_inbound_text/); assert.deepEqual(seen[0][1], ['FAKE', 'ev-1', '+15550100001', text.toService, 'HON 482913', T]);
  db.next = { outcome: 'NOT_HQ', reply: null, replayed: false };
  assert.deepEqual(await db.recordInbound(text), { outcome: 'NOT_HQ', reply: null, replyText: null, replayed: false });
  db.next = { outcome: 'X', reply: 'SOMETHING_ELSE', replayed: false };
  assert.equal((await db.recordInbound(text)).replyText, null, 'an unknown reply kind is never sent');
});
