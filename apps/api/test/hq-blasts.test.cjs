const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqBlastsController } = require('../dist/hq-communications/hq-blasts.controller.js');
const { HqBlastsService } = require('../dist/hq-communications/hq-blasts.service.js');
const { HqMessageDispatcher, HQ_BLAST_SMS_STOP_LINE } = require('../dist/hq-communications/hq-message-dispatcher.js');
const { SendGridEmailProvider, HQ_BLAST_EMAIL_REASON } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// HB1 (0712) HQ text and email blasts: closed inputs and responses, routes that forward only the verified subject, the path id,
// the declared query and the validated body; the HQ dispatcher passes the blast subject and adds the STOP line to blast texts;
// SendGrid adds the blast footer, never bypasses unsubscribe for a blast, and waits without HON_MAILING_ADDRESS.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = (n = 'HQ Owner') => ({ principalId: U(), displayName: n });
const res = () => ({ schools: { queued: 0, noOwners: 0, notReachable: 0, recentlySent: 0 },
  deliveries: { waiting: 0, pending: 0, sending: 0, accepted: 0, delivered: 0, bounced: 0, failed: 0, suppressed: 0, unknown: 0 } });
const blast = (patch = {}) => ({ blastId: U(), name: 'December news', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', subject: 'New in HON OS',
  body: 'Hi {{first_name}}, here is what is new for {{school_name}}.', audience: { statuses: ['ACTIVE'], trial: 'ON_TRIAL' }, status: 'DRAFT',
  sendAt: null, queuedAt: null, cancelledAt: null, schoolCount: null, recipientCount: null, createdBy: person(), createdAt: T, updatedAt: T, version: 1, ...patch });
const saveIn = (patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'December news', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', subject: 'New in HON OS',
  body: 'Hi {{first_name}}!', audience: { statuses: ['ACTIVE'], planNames: ['Core'], countries: ['US'], regions: ['CA'], joinedWithinDays: 30 }, ...patch });

test('contracts: blast command values match the SaaS command table', () => {
  assert.deepEqual(contracts.HQ_BLAST_COMMANDS, { save: contracts.SAAS_COMMANDS.saveHqBlast, send: contracts.SAAS_COMMANDS.sendHqBlast,
    cancel: contracts.SAAS_COMMANDS.cancelHqBlast });
});

test('contracts: save input is closed; blasts never use BILLING or ACCOUNT; texts have no subject; unknown tags are refused', () => {
  assert.deepEqual(contracts.validateHqBlastSaveInput(saveIn()), saveIn());
  assert.equal(contracts.validateHqBlastSaveInput(saveIn({ channel: 'SMS', subject: null, body: 'x'.repeat(1400) })).body.length, 1400);
  for (const bad of [saveIn({ purpose: 'BILLING' }), saveIn({ purpose: 'ACCOUNT' }), saveIn({ channel: 'SMS' }), saveIn({ subject: null }),
    saveIn({ channel: 'SMS', subject: null, body: 'x'.repeat(1401) }), saveIn({ body: 'x'.repeat(3501) }), saveIn({ body: 'Hi {{last_name}}' }),
    saveIn({ expectedVersion: 1 }), saveIn({ blastId: U(), expectedVersion: 0 }), saveIn({ audience: { statuses: ['ARCHIVED'] } }),
    saveIn({ audience: { joinedWithinDays: 30, joinedFrom: '2026-01-01' } }), saveIn({ audience: { joinedFrom: '2026-02-30' } }),
    saveIn({ audience: { anything: true } }), saveIn({ name: ' padded' }), { ...saveIn(), extra: 1 }])
    assert.throws(() => contracts.validateHqBlastSaveInput(bad), JSON.stringify(bad).slice(0, 120));
  assert.deepEqual(contracts.hqBlastTagsIn('Hi {{first_name}} at {{school_name}}, {{first_name}}'), ['first_name', 'school_name']);
});

test('contracts: responses are closed and consistent with their status', () => {
  const q = blast({ status: 'QUEUED', sendAt: T2, queuedAt: T, schoolCount: 3, recipientCount: 4, version: 2 });
  assert.equal(contracts.verifyHqBlastReceipt({ operation: 'SEND', blast: q, results: res(), replayed: false }, { operation: 'SEND', blastId: q.blastId, status: 'QUEUED' }).blast.status, 'QUEUED');
  for (const bad of [blast({ status: 'QUEUED' }), blast({ queuedAt: T }), blast({ status: 'CANCELLED', sendAt: T, queuedAt: T }), blast({ channel: 'SMS' }),
    blast({ purpose: 'BILLING' }), { ...blast(), recipientAddress: 'owner@example.test' }])
    assert.throws(() => contracts.verifyHqBlastList({ blasts: [{ ...bad, results: res() }], sentToday: 0, dailyLimit: 10, asOf: T2 }), JSON.stringify(bad).slice(0, 80));
  assert.throws(() => contracts.verifyHqBlastReceipt({ operation: 'SEND', blast: q, results: res(), replayed: false }, { operation: 'SEND', blastId: U(), status: 'QUEUED' }), 'another blast');
  assert.throws(() => contracts.verifyHqBlastList({ blasts: [], sentToday: 0, dailyLimit: 11, asOf: T2 }), 'the daily limit is fixed');
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, (r) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqBlastsController],
    providers: [HqBlastsService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('HTTP: blast reads and commands forward only the verified subject, the path id, the declared query and the validated body', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => ({ blasts: [], sentToday: 0, dailyLimit: 10, asOf: T2 });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const list = await send(`${base}/hq/communications/blasts`);
    assert.equal(list.status, 200, list.body); assert.equal(list.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqBlasts', ['verified-human']]);
    reply = () => ({ planNames: ['Core'], features: [], countries: ['US'], regions: [{ country: 'US', region: 'CA' }], schools: [], asOf: T2 });
    assert.equal((await send(`${base}/hq/communications/blasts/options`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqBlastOptions', ['verified-human', null]]);
    assert.equal((await send(`${base}/hq/communications/blasts/options?search=Dojo`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqBlastOptions', ['verified-human', 'Dojo']]);
    const n = calls.length;
    for (const url of ['?limit=5', '/options?search=x', '/options?search=%20Dojo', '/options?q=Dojo', '/not-an-id', '/not-an-id/audience'])
      assert.equal((await send(`${base}/hq/communications/blasts${url}`)).status, 400, url);
    assert.equal(calls.length, n, 'refused requests never reach the database');

    const b = blast();
    reply = () => ({ blast: b, results: res(), schools: [], asOf: T2 });
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqBlast', ['verified-human', b.blastId]]);
    assert.equal((await send(`${base}/hq/communications/blasts/${U()}`)).status, 503, 'an answer about another blast is never shown');
    reply = () => ({ blastId: b.blastId, channel: 'EMAIL', schoolsMatched: 2, schoolsReached: 1, ownersTotal: 3, ownersReached: 1,
      skipped: { noOwners: 1, notReachable: 0, recentlySent: 0, ownersNotReachable: 1 }, tooLarge: false,
      schools: [{ schoolId: U(), schoolDisplayName: 'Main', outcome: 'QUEUED', ownerCount: 2, reachableCount: 1 }],
      sample: { schoolDisplayName: 'Main', subject: 'New in HON OS', body: 'Hi Alex!' }, asOf: T2 });
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/audience`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqBlastAudience', ['verified-human', b.blastId]]);

    const key = U(); reply = () => ({ operation: 'SAVE', blast: b, replayed: false });
    const saved = await send(`${base}/hq/communications/blasts`, { method: 'POST', headers: command('hq-blast-save', key), body: JSON.stringify(saveIn()) });
    assert.equal(saved.status, 200, saved.body);
    const [op, params] = calls.at(-1);
    assert.deepEqual([op, params.slice(0, 3)], ['saveHqBlast', ['verified-human', JSON.stringify(saveIn()), key]]);
    assert.ok(UUID.test(params[3]) && UUID.test(params[4]) && params[3] !== params[4], 'fresh request and correlation ids');
    const k = calls.length;
    assert.equal((await send(`${base}/hq/communications/blasts`, { method: 'POST', headers: command('hq-blast-send'), body: JSON.stringify(saveIn()) })).status, 403, 'wrong marker');
    assert.equal((await send(`${base}/hq/communications/blasts`, { method: 'POST', headers: { ...command('hq-blast-save'), origin: 'https://evil.example' }, body: JSON.stringify(saveIn()) })).status, 403);
    assert.equal((await send(`${base}/hq/communications/blasts`, { method: 'POST', headers: command('hq-blast-save'), body: JSON.stringify(saveIn({ purpose: 'BILLING' })) })).status, 400);
    assert.equal((await send(`${base}/hq/communications/blasts`, { method: 'POST', headers: { ...command('hq-blast-save'), 'idempotency-key': 'nope' }, body: JSON.stringify(saveIn()) })).status, 400);
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/send`, { method: 'POST', headers: command('hq-blast-send'), body: JSON.stringify({ expectedVersion: 1, sendAt: null, blastId: U() }) })).status, 400, 'the id comes from the path only');
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/cancel`, { method: 'POST', headers: command('hq-blast-cancel'), body: JSON.stringify({ expectedVersion: 0 }) })).status, 400);
    assert.equal(calls.length, k);

    const q = blast({ blastId: b.blastId, status: 'QUEUED', sendAt: T2, queuedAt: T, schoolCount: 1, recipientCount: 1, version: 2 });
    reply = () => ({ operation: 'SEND', blast: q, results: res(), replayed: false });
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/send`, { method: 'POST', headers: command('hq-blast-send', key), body: JSON.stringify({ expectedVersion: 1, sendAt: T2 }) })).status, 200);
    assert.deepEqual(calls.at(-1)[1].slice(0, 3), ['verified-human', JSON.stringify({ blastId: b.blastId, expectedVersion: 1, sendAt: T2 }), key]);
    reply = () => ({ operation: 'SEND', blast: b, results: res(), replayed: false });
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/send`, { method: 'POST', headers: command('hq-blast-send'), body: JSON.stringify({ expectedVersion: 1, sendAt: null }) })).status, 503, 'a send that did not queue is never shown as sent');
    const c = blast({ blastId: b.blastId, status: 'CANCELLED', sendAt: T2, queuedAt: T, cancelledAt: T2, schoolCount: 1, recipientCount: 1, version: 3 });
    reply = () => ({ operation: 'CANCEL', blast: c, results: res(), replayed: false });
    assert.equal((await send(`${base}/hq/communications/blasts/${b.blastId}/cancel`, { method: 'POST', headers: command('hq-blast-cancel', key), body: JSON.stringify({ expectedVersion: 2 }) })).status, 200);
    assert.equal(calls.at(-1)[0], 'cancelHqBlast');

    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'HQ_BLAST_NOT_DRAFT', 422, 'HQ_BLAST_NOT_DRAFT'], ['23514', 'HQ_BLAST_NO_RECIPIENTS', 422, 'HQ_BLAST_NO_RECIPIENTS'],
      ['23514', 'HQ_BLAST_DAILY_LIMIT', 422, 'HQ_BLAST_DAILY_LIMIT'], ['23514', 'HQ_BLAST_AUDIENCE_TOO_LARGE', 422, 'HQ_BLAST_AUDIENCE_TOO_LARGE'],
      ['23514', 'HQ_BLAST_SEND_TIME', 422, 'HQ_BLAST_SEND_TIME'], ['23514', 'HQ_BLAST_TEXT_TOO_LONG', 422, 'HQ_BLAST_TEXT_TOO_LONG'],
      ['23514', 'HQ_BLAST_NOT_CANCELLABLE', 422, 'HQ_BLAST_NOT_CANCELLABLE'], ['P0002', 'HQ_BLAST_NOT_FOUND', 404, 'SAAS_UNAVAILABLE'],
      ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/communications/blasts/${b.blastId}/send`, { method: 'POST', headers: command('hq-blast-send'), body: JSON.stringify({ expectedVersion: 1, sendAt: null }) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

const lease = (over = {}) => ({ deliveryId: U(), leaseToken: U(), organizationId: U(), schoolId: U(), messageId: U(), channel: 'EMAIL',
  recipientAddress: 'owner@example.test', content: 'Hi Sam, news for Main.', senderRef: 'hello@hon.example', senderName: 'HON OS', attempt: 1,
  purpose: 'ANNOUNCEMENT', subject: 'New in HON OS', blastId: U(), ...over });
function store(claims) {
  const calls = { results: [] };
  return { calls, isConfigured: () => true, claim: async () => claims,
    recordResult: async (id, token, result) => { calls.results.push(result); return { status: result.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING', accepted: true }; } };
}
const spy = (channel, seen) => ({ provider: channel === 'SMS' ? 'TWILIO' : 'SENDGRID', hqSender: true, channel, readiness: () => 'READY',
  send: async (r) => { seen.push(r); return { providerMessageId: `p-${seen.length}`, sentAs: channel === 'SMS' ? 'SMS' : 'EMAIL' }; } });

test('HQ dispatcher: blast email carries its subject and blast mark; blast texts end with the STOP line; one-off messages are unchanged', async () => {
  const seen = [];
  const s = store([lease(), lease({ channel: 'SMS', recipientAddress: '+15555550101', senderRef: 'MG' + '0'.repeat(32), subject: null }),
    lease({ purpose: 'SUPPORT', subject: null, blastId: null }), lease({ channel: 'SMS', recipientAddress: '+15555550101', senderRef: 'MG' + '0'.repeat(32), subject: null, blastId: null })]);
  await new HqMessageDispatcher(s, [spy('EMAIL', seen), spy('SMS', seen)]).runOnce();
  const [email, sms, oneOffEmail, oneOffSms] = seen;
  assert.deepEqual([email.subject, email.hqBlast, email.hqPurpose, email.content], ['New in HON OS', true, 'ANNOUNCEMENT', 'Hi Sam, news for Main.']);
  assert.equal(sms.content, `Hi Sam, news for Main.\n\n${HQ_BLAST_SMS_STOP_LINE}`);
  assert.equal(sms.subject, undefined);
  assert.deepEqual([oneOffEmail.subject, oneOffEmail.hqBlast, oneOffSms.content], [undefined, undefined, 'Hi Sam, news for Main.']);
});

test('SendGrid: a blast email has HQ\'s subject, the footer with the mailing address, keeps unsubscribe, and waits without the address', () => {
  const env = { HON_MAILING_ADDRESS: '546 W. Las Tunas Dr. San Gabriel CA 91776' };
  const sg = new SendGridEmailProvider(() => env);
  const base = { deliveryId: U(), messageId: U(), organizationId: U(), schoolId: U(), channel: 'EMAIL', recipientAddress: 'owner@example.test', content: 'Hi Sam!',
    schoolName: 'HON OS', attempt: 1, origin: 'HQ', senderEmail: 'hello@hon.example', senderName: 'HON OS' };
  const body = sg.requestBody({ ...base, hqPurpose: 'ANNOUNCEMENT', hqBlast: true, subject: 'New in HON OS' });
  assert.equal(body.subject, 'New in HON OS');
  assert.deepEqual(body.content, [{ type: 'text/plain', value: `Hi Sam!\n\n--\n${HQ_BLAST_EMAIL_REASON}\nHON OS, 546 W. Las Tunas Dr. San Gabriel CA 91776` }]);
  assert.equal(body.tracking_settings.subscription_tracking.enable, true);
  assert.equal(body.mail_settings.bypass_unsubscribe_management, undefined);
  for (const purpose of ['BILLING', 'ACCOUNT'])
    assert.equal(sg.requestBody({ ...base, hqPurpose: purpose, hqBlast: true, subject: 'x' }).mail_settings.bypass_unsubscribe_management, undefined, 'a blast never bypasses unsubscribe');
  assert.equal(sg.requestBody({ ...base, hqPurpose: 'BILLING' }).mail_settings.bypass_unsubscribe_management.enable, true, 'a one-off BILLING notice still does');
  assert.equal(sg.requestBody({ ...base, hqPurpose: 'SUPPORT' }).subject, 'A message from HON OS', 'a one-off HQ message keeps the standard subject');
  assert.equal(sg.requestBody({ ...base, hqPurpose: 'SUPPORT', hqBlast: true, subject: 'bad\nline' }).subject, 'A message from HON OS');
  for (const address of [undefined, '', '   ', 'short', 'line\nbreak address here'] ) {
    const p = new SendGridEmailProvider(() => ({ HON_MAILING_ADDRESS: address }));
    assert.throws(() => p.requestBody({ ...base, hqPurpose: 'ANNOUNCEMENT', hqBlast: true, subject: 'x' }),
      (e) => e instanceof CommunicationProviderError && e.outcome === 'RETRYABLE', String(address));
    assert.doesNotThrow(() => p.requestBody({ ...base, hqPurpose: 'SUPPORT' }), 'a one-off HQ message needs no mailing address');
  }
});
