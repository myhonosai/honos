const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ExpoPushClient, EXPO_SEND_URL, EXPO_RECEIPTS_URL } = require('../dist/parent-push/expo-push-client.js');
const { ParentPushWorker, ParentPushScheduler } = require('../dist/parent-push/parent-push-worker.js');
const { ParentPushService } = require('../dist/parent-push/parent-push.service.js');

// 0601 parent announcement push: closed inputs, an Expo client that sends nothing unless approved and never guesses an
// outcome, and a worker that never resends a send whose answer was lost. No network is used.
const A = '11111111-1111-4111-8111-111111111111', L = '22222222-2222-4222-8222-222222222222', D = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'ExponentPushToken[abcdefghij1234567890]';
const message = { to: TOKEN, title: 'Dojo', body: 'Closed Monday', data: { type: 'school_announcement', announcementId: A } };

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const out = fn(); if (out && typeof out.then === 'function') return out.finally(restore); restore(); return out; } catch (e) { restore(); throw e; }
}
function client(answer) {
  const c = new ExpoPushClient();
  c.calls = [];
  c.fetcher = async (url, init) => { c.calls.push({ url, init }); if (answer instanceof Error) throw answer; return { status: answer.status, json: async () => { if (answer.bad) throw new Error('bad json'); return answer.body; } }; };
  return c;
}

test('0601 inputs and data are closed', () => {
  assert.deepEqual(contracts.validateRegisterParentPushDeviceInput({ expoPushToken: TOKEN, platform: 'ios' }), { expoPushToken: TOKEN, platform: 'ios' });
  assert.equal(contracts.isParentPushToken('ExpoPushToken[abcdefghij_-12]'), true);
  for (const value of [{ expoPushToken: TOKEN }, { expoPushToken: 'abc', platform: 'ios' }, { expoPushToken: TOKEN, platform: 'web' }, { expoPushToken: TOKEN, platform: 'ios', schoolId: A },
    { expoPushToken: 'ExponentPushToken[short]', platform: 'ios' }, { expoPushToken: `${TOKEN} `, platform: 'ios' }, null, []]) {
    assert.throws(() => contracts.validateRegisterParentPushDeviceInput(value), undefined, JSON.stringify(value));
  }
  assert.throws(() => contracts.validateUnregisterParentPushDeviceInput({ expoPushToken: TOKEN, platform: 'ios' }));
  assert.deepEqual(contracts.verifyParentPushDeviceReceipt({ device: { deviceId: A, platform: 'ios' }, replayed: false }, 'ios'), { device: { deviceId: A, platform: 'ios' }, replayed: false });
  assert.throws(() => contracts.verifyParentPushDeviceReceipt({ device: { deviceId: A, platform: 'android' }, replayed: false }, 'ios'), undefined, 'bound to the platform');
  assert.throws(() => contracts.verifyParentPushDeviceReceipt({ device: { deviceId: A, platform: 'ios', token: TOKEN }, replayed: false }), undefined, 'closed');
  assert.deepEqual(contracts.readParentPushData({ type: 'school_announcement', announcementId: A }), { type: 'school_announcement', announcementId: A });
  for (const value of [null, {}, { type: 'other', announcementId: A }, { type: 'school_announcement', announcementId: 'x' }, { type: 'school_announcement', announcementId: A, url: 'https://x' }]) {
    assert.equal(contracts.readParentPushData(value), null, JSON.stringify(value));
  }
});

test('0601 Expo client sends nothing unless the owner approved sends', async () => {
  await withEnv({ HON_PARENT_PUSH_APPROVED: undefined }, async () => {
    const c = client({ status: 200, body: { data: [{ status: 'ok', id: 't1' }] } });
    assert.equal(c.readiness(), 'NOT_APPROVED');
    await assert.rejects(c.send([message]), /NOT_APPROVED/);
    await assert.rejects(c.receipts(['t1']), /NOT_APPROVED/);
    assert.equal(c.calls.length, 0);
  });
  await withEnv({ HON_PARENT_PUSH_APPROVED: 'yes' }, async () => assert.equal(new ExpoPushClient().readiness(), 'NOT_APPROVED'));
});

test('0601 Expo client maps every answer without guessing', async () => {
  await withEnv({ HON_PARENT_PUSH_APPROVED: 'true', EXPO_ACCESS_TOKEN: 'secret-token' }, async () => {
    const ok = client({ status: 200, body: { data: [{ status: 'ok', id: 'ticket-1' }, { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }, { status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'weird' }, { status: 'error', details: { error: 'bad code!' } }] } });
    const out = await ok.send([message, message, message, message, message]);
    assert.deepEqual(out, [{ outcome: 'SENT', ticketId: 'ticket-1' }, { outcome: 'FAILED', failureCode: 'DeviceNotRegistered' }, { outcome: 'RETRYABLE', failureCode: 'MessageRateExceeded' },
      { outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' }, { outcome: 'FAILED', failureCode: 'PROVIDER_ERROR' }]);
    assert.equal(ok.calls[0].url, EXPO_SEND_URL);
    assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer secret-token');
    const sentBody = JSON.parse(ok.calls[0].init.body);
    assert.deepEqual(Object.keys(sentBody[0]).sort(), ['body', 'data', 'priority', 'sound', 'title', 'to']);
    assert.deepEqual(await client(new Error('timeout')).send([message]), [{ outcome: 'UNKNOWN', failureCode: 'NO_ANSWER' }]);
    assert.deepEqual(await client({ status: 429 }).send([message]), [{ outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' }]);
    assert.deepEqual(await client({ status: 400 }).send([message]), [{ outcome: 'FAILED', failureCode: 'REQUEST_REJECTED' }]);
    assert.deepEqual(await client({ status: 502 }).send([message]), [{ outcome: 'UNKNOWN', failureCode: 'PROVIDER_ERROR' }]);
    assert.deepEqual(await client({ status: 200, bad: true }).send([message]), [{ outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' }]);
    assert.deepEqual(await client({ status: 200, body: { data: [] } }).send([message]), [{ outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' }], 'count mismatch');
    await assert.rejects(client({ status: 200 }).send([]), /BATCH/);
    await assert.rejects(client({ status: 200 }).send(Array(101).fill(message)), /BATCH/);
    const rc = client({ status: 200, body: { data: { t1: { status: 'ok' }, t2: { status: 'error', details: { error: 'DeviceNotRegistered' } } } } });
    const receipts = await rc.receipts(['t1', 't2', 't3']);
    assert.equal(rc.calls[0].url, EXPO_RECEIPTS_URL);
    assert.deepEqual([...receipts], [['t1', { outcome: 'DELIVERED' }], ['t2', { outcome: 'FAILED', failureCode: 'DeviceNotRegistered' }]], 't3 missing means not ready');
    assert.equal((await client(new Error('down')).receipts(['t1'])).size, 0, 'a lost receipt answer is checked again later');
    await assert.rejects(client({ status: 200 }).receipts(['bad id!']), /BATCH/);
  });
  await withEnv({ HON_PARENT_PUSH_APPROVED: 'true', EXPO_ACCESS_TOKEN: undefined }, async () => {
    const c = client({ status: 200, body: { data: [{ status: 'ok', id: 't' }] } });
    await c.send([message]);
    assert.equal('Authorization' in c.calls[0].init.headers, false);
  });
});

function store(claimed = [], receipts = []) {
  const s = { recorded: [], receiptsRecorded: [], claims: 0, isConfigured: () => true,
    claim: async () => { s.claims += 1; return claimed; },
    recordSend: async (id, lease, outcome) => { s.recorded.push({ id, lease, outcome }); return { recorded: true }; },
    claimReceipts: async () => receipts,
    recordReceipt: async (id, lease, outcome) => { s.receiptsRecorded.push({ id, outcome }); return { recorded: true }; } };
  return s;
}
const claimRow = (patch = {}) => ({ deliveryId: D, leaseToken: L, expoToken: TOKEN, title: 'Dojo', body: 'Closed Monday', announcementId: A, attempts: 1, ...patch });

test('0601 worker: off until approved, and never claims while off', async () => {
  const s = store([claimRow()]);
  const summary = await new ParentPushWorker(s, { readiness: () => 'NOT_APPROVED' }).runOnce();
  assert.equal(s.claims, 0); assert.equal(summary.claimed, 0);
  const unconfigured = { ...store([claimRow()]), isConfigured: () => false };
  await new ParentPushWorker(unconfigured, { readiness: () => 'READY' }).runOnce();
  assert.equal(unconfigured.claims, 0);
});

test('0601 worker: sends, records each outcome, and turns a lost answer into UNKNOWN', async () => {
  const sent = [];
  const s = store([claimRow(), claimRow({ deliveryId: A, expoToken: 'not-a-token' })], [{ deliveryId: D, leaseToken: L, ticketId: 'tk' }, { deliveryId: A, leaseToken: L, ticketId: 'tk2' }]);
  const expo = { readiness: () => 'READY', send: async (m) => { sent.push(...m); return [{ outcome: 'SENT', ticketId: 'tk' }]; },
    receipts: async () => new Map([['tk', { outcome: 'DELIVERED' }]]) };
  const summary = await new ParentPushWorker(s, expo).runOnce();
  assert.equal(sent.length, 1, 'an unverified claim is never sent');
  assert.deepEqual(sent[0].data, { type: 'school_announcement', announcementId: A });
  assert.deepEqual(s.recorded.map(r => r.outcome), [{ outcome: 'FAILED', failureCode: 'UNVERIFIED_CLAIM' }, { outcome: 'SENT', ticketId: 'tk' }]);
  assert.deepEqual(s.receiptsRecorded.map(r => r.outcome), [{ outcome: 'DELIVERED' }, { outcome: 'PENDING' }]);
  assert.equal(summary.sent, 1); assert.equal(summary.failed, 1); assert.equal(summary.delivered, 1);
  const s2 = store([claimRow()]);
  await new ParentPushWorker(s2, { readiness: () => 'READY', send: async () => { throw new Error('socket'); }, receipts: async () => new Map() }).runOnce();
  assert.deepEqual(s2.recorded[0].outcome, { outcome: 'UNKNOWN', failureCode: 'NO_ANSWER' });
  const s3 = store([claimRow(), claimRow({ deliveryId: A })]);
  await new ParentPushWorker(s3, { readiness: () => 'READY', send: async () => [{ outcome: 'SENT', ticketId: 'x' }], receipts: async () => new Map() }).runOnce();
  assert.ok(s3.recorded.every(r => r.outcome.outcome === 'UNKNOWN'), 'an answer of the wrong length is UNKNOWN for all');
  const s4 = { ...store([claimRow()]), recordSend: async () => { throw new Error('db down'); } };
  const lost = await new ParentPushWorker(s4, { readiness: () => 'READY', send: async () => [{ outcome: 'SENT', ticketId: 'x' }], receipts: async () => new Map() }).runOnce();
  assert.equal(lost.errors, 1, 'counted; the lease runs out and the database records UNKNOWN');
});

test('0601 worker pauses claiming for a minute after Expo says too many', async () => {
  const s = store([claimRow()]);
  const worker = new ParentPushWorker(s, { readiness: () => 'READY', send: async () => [{ outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' }], receipts: async () => new Map() });
  const first = await worker.runOnce();
  assert.equal(first.retrying, 1);
  assert.equal((await worker.runOnce()).claimed, 0);
  assert.equal(s.claims, 1, 'no claim during the pause');
  worker.pausedUntil = Date.now() - 1;
  await worker.runOnce();
  assert.equal(s.claims, 2, 'claims again after the pause');
  assert.equal(ParentPushWorker.RATE_LIMIT_PAUSE_MS, 60000);
});

test('0601 status says only whether sends are approved', () => {
  const service = new ParentPushService({});
  withEnv({ HON_PARENT_PUSH_APPROVED: undefined }, () => assert.deepEqual(service.status(), { sending: false }));
  withEnv({ HON_PARENT_PUSH_APPROVED: 'true' }, () => assert.deepEqual(service.status(), { sending: true }));
  assert.deepEqual(contracts.verifyParentPushStatus({ sending: true }), { sending: true });
  assert.throws(() => contracts.verifyParentPushStatus({ sending: 'yes' }));
  assert.throws(() => contracts.verifyParentPushStatus({ sending: true, schools: 1 }));
});

test('0601 scheduler starts only with approval, a worker login and a valid interval', () => {
  const cases = [
    [{ HON_PARENT_PUSH_APPROVED: undefined, HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgres://w', HON_PARENT_PUSH_INTERVAL_SECONDS: '30' }, false],
    [{ HON_PARENT_PUSH_APPROVED: 'true', HON_COMMUNICATION_WORKER_DATABASE_URL: undefined, HON_PARENT_PUSH_INTERVAL_SECONDS: '30' }, false],
    [{ HON_PARENT_PUSH_APPROVED: 'true', HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgres://w', HON_PARENT_PUSH_INTERVAL_SECONDS: '5' }, false],
    [{ HON_PARENT_PUSH_APPROVED: 'true', HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgres://w', HON_PARENT_PUSH_INTERVAL_SECONDS: '30' }, true],
  ];
  for (const [env, started] of cases) {
    withEnv(env, () => {
      const scheduler = new ParentPushScheduler({ runOnce: async () => ({}) });
      scheduler.onModuleInit();
      assert.equal(Boolean(scheduler.timer), started, JSON.stringify(env));
      scheduler.onModuleDestroy();
    });
  }
});

test('0601 service refuses before any database call', async () => {
  let touched = 0;
  const database = new Proxy({}, { get: () => () => { touched += 1; throw new Error('no database'); } });
  const service = new ParentPushService(database);
  await assert.rejects(service.register('subject', { expoPushToken: 'bad', platform: 'ios' }, 'k'), e => e.response?.code === 'VALIDATION_FAILED');
  await assert.rejects(service.register('subject', { expoPushToken: TOKEN, platform: 'ios' }, ''), e => e.response?.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(service.register(' bad', { expoPushToken: TOKEN, platform: 'ios' }, 'k'), e => e.response?.code === 'PARENT_PUSH_FORBIDDEN');
  await assert.rejects(service.unregister('subject', { expoPushToken: TOKEN, extra: 1 }, 'k'), e => e.response?.code === 'VALIDATION_FAILED');
  assert.equal(touched, 0);
  const one = { resolveParentJourneyScopes: async () => [{}, {}] };
  await assert.rejects(new ParentPushService(one).register('subject', { expoPushToken: TOKEN, platform: 'ios' }, 'k'), e => e.response?.code === 'PARENT_PUSH_FORBIDDEN', 'two families are ambiguous');
  const broken = { resolveParentJourneyScopes: async () => [{ organizationId: A, schoolId: A, principalId: A }], withTenantTransaction: async () => { throw Object.assign(new Error('x'), { code: 'XX000' }); } };
  await assert.rejects(new ParentPushService(broken).register('subject', { expoPushToken: TOKEN, platform: 'ios' }, 'k'), e => e.response?.code === 'PARENT_PUSH_UNAVAILABLE');
});
