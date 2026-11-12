const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CommunicationDispatcher } = require('../dist/communication/delivery/communication-dispatcher.js');
const { CommunicationProviderError, fakeProviderEnabled } = require('../dist/communication/delivery/communication-provider.js');
const { FakeCommunicationProvider } = require('../dist/communication/delivery/fake-communication-provider.js');
const { validateDeploymentConfiguration } = require('../dist/foundation/production-config.js');

const lease = (over = {}) => ({
  deliveryId: '11111111-1111-4111-8111-111111111111', leaseToken: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333', schoolId: '44444444-4444-4444-8444-444444444444',
  messageId: '55555555-5555-4555-8555-555555555555', channel: 'EMAIL', recipientAddress: 'ada@example.test',
  content: 'Welcome', schoolName: 'Day School', attempt: 1, ...over,
});

function store(claims, status = (result) => ({ ACCEPTED: 'ACCEPTED', RETRYABLE: 'PENDING', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN' })[result.outcome]) {
  const calls = { claim: [], results: [] };
  return {
    calls,
    isConfigured: () => true,
    claim: async (channels, limit, leaseSeconds) => { calls.claim.push({ channels, limit, leaseSeconds }); return claims.splice(0, limit); },
    recordResult: async (id, token, result) => { calls.results.push({ id, token, result }); return { status: status(result), accepted: true }; },
    recordReceipt: async () => { throw new Error('not used'); },
  };
}
const adapter = (channel, send, readiness = 'READY', provider = 'SENDGRID') => ({ provider, channel, readiness: () => readiness, send });

test('dispatcher claims only channels with a READY adapter and never claims when none is ready', async () => {
  const none = store([]);
  const summary = await new CommunicationDispatcher(none, [adapter('EMAIL', async () => ({}), 'CONFIGURATION_REQUIRED')]).runOnce();
  assert.equal(none.calls.claim.length, 0);
  assert.deepEqual(summary.readyChannels, []);
  const some = store([]);
  await new CommunicationDispatcher(some, [adapter('EMAIL', async () => ({})), adapter('SMS', async () => ({}), 'CONFIGURATION_REQUIRED')]).runOnce(10);
  assert.deepEqual(some.calls.claim, [{ channels: ['EMAIL'], limit: 2, leaseSeconds: 60 }]);
  // Batches of two keep every send (20 s timeout each) inside the 60 s lease.
  const many = store([1, 2, 3, 4, 5].map(() => lease()));
  const batched = await new CommunicationDispatcher(many, [adapter('EMAIL', async () => ({ providerMessageId: 'sg', sentAs: 'EMAIL' }))]).runOnce(4);
  assert.deepEqual(many.calls.claim.map((c) => c.limit), [2, 2]);
  assert.equal(batched.claimed, 4);
});

test('dispatcher records accepted sends with the provider measurements and the exact lease', async () => {
  const s = store([lease()]);
  let seen;
  const summary = await new CommunicationDispatcher(s, [adapter('EMAIL', async (request) => { seen = request; return { providerMessageId: 'sg-1', sentAs: 'EMAIL' }; })]).runOnce();
  assert.equal(seen.recipientAddress, 'ada@example.test');
  assert.equal(seen.content, 'Welcome');
  assert.deepEqual(s.calls.results, [{ id: lease().deliveryId, token: lease().leaseToken, result: { outcome: 'ACCEPTED', provider: 'SENDGRID', providerMessageId: 'sg-1', sentAs: 'EMAIL' } }]);
  assert.equal(summary.accepted, 1);
});

test('dispatcher maps provider errors: retryable with bounded delay, permanent failure code, unknown and unexpected errors', async () => {
  const cases = [
    [new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 5), { outcome: 'RETRYABLE', provider: 'SENDGRID', retryAfterSeconds: 30 }],
    [new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 999999), { outcome: 'RETRYABLE', provider: 'SENDGRID', retryAfterSeconds: 86400 }],
    [new CommunicationProviderError('FAILED', 'INVALID_ADDRESS'), { outcome: 'FAILED', provider: 'SENDGRID', failureCode: 'INVALID_ADDRESS' }],
    [new CommunicationProviderError('UNKNOWN'), { outcome: 'UNKNOWN', provider: 'SENDGRID' }],
    [new Error('socket hang up'), { outcome: 'UNKNOWN', provider: 'SENDGRID' }],
  ];
  for (const [error, expected] of cases) {
    const s = store([lease()]);
    await new CommunicationDispatcher(s, [adapter('EMAIL', async () => { throw error; })]).runOnce();
    assert.deepEqual(s.calls.results[0].result, expected);
  }
});

test('a late result the database refuses is counted, not reported as success', async () => {
  const s = store([lease()], () => 'UNKNOWN');
  s.recordResult = async (id, token, result) => { s.calls.results.push({ id, token, result }); return { status: 'UNKNOWN', accepted: false }; };
  const summary = await new CommunicationDispatcher(s, [adapter('EMAIL', async () => ({ providerMessageId: 'x', sentAs: 'EMAIL' }))]).runOnce();
  assert.equal(summary.accepted, 0);
  assert.equal(summary.lateResults, 1);
  assert.equal(summary.unknown, 1);
});

test('the first READY adapter for a channel wins, so an approved real provider takes precedence over the fake', async () => {
  const s = store([lease()]);
  const used = [];
  await new CommunicationDispatcher(s, [
    adapter('EMAIL', async () => { used.push('sendgrid'); return { providerMessageId: 'a', sentAs: 'EMAIL' }; }),
    adapter('EMAIL', async () => { used.push('fake'); return { providerMessageId: 'b', sentAs: 'EMAIL' }; }, 'READY', 'FAKE'),
  ]).runOnce();
  assert.deepEqual(used, ['sendgrid']);
});

test('the fake provider is READY only with the flag and outside production and staging, and keeps no address', async () => {
  assert.equal(fakeProviderEnabled({}), false);
  assert.equal(fakeProviderEnabled({ HON_COMMUNICATION_FAKE_PROVIDER: 'true' }), false);
  assert.equal(fakeProviderEnabled({ HON_COMMUNICATION_FAKE_PROVIDER: '1' }), true);
  assert.equal(fakeProviderEnabled({ HON_COMMUNICATION_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' }), false);
  assert.equal(fakeProviderEnabled({ HON_COMMUNICATION_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'staging' }), false);
  assert.equal(fakeProviderEnabled({ HON_COMMUNICATION_FAKE_PROVIDER: '1', NODE_ENV: 'production' }), false);
  const fake = new FakeCommunicationProvider('SMS', () => ({ HON_COMMUNICATION_FAKE_PROVIDER: '1' }));
  assert.equal(fake.readiness(), 'READY');
  const accepted = await fake.send(lease({ channel: 'SMS', recipientAddress: '+15555550101' }));
  assert.deepEqual(accepted, { providerMessageId: `fake-${lease().deliveryId}-1`, sentAs: 'SMS', segments: 1, encoding: 'GSM7' });
  assert.equal(JSON.stringify(fake.sent).includes('+15555550101'), false);
});

test('production configuration refuses the fake provider and a worker login reused from the runtime role', () => {
  const base = { NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_AUTH_MODE: 'OIDC',
    HON_RUNTIME_DATABASE_URL: 'postgresql://runtime:x@db.example.test:5432/postgres?sslmode=verify-full' };
  const fake = validateDeploymentConfiguration({ ...base, HON_COMMUNICATION_FAKE_PROVIDER: '1' });
  assert.ok(fake.failures.includes('COMMUNICATION_FAKE_PROVIDER_FORBIDDEN'));
  const reused = validateDeploymentConfiguration({ ...base, HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgresql://runtime:y@db.example.test:5432/postgres?sslmode=verify-full' });
  assert.ok(reused.failures.includes('COMMUNICATION_WORKER_ROLE_REUSED'));
  const dev = validateDeploymentConfiguration({ HON_COMMUNICATION_FAKE_PROVIDER: '1' });
  assert.equal(dev.failures.includes('COMMUNICATION_FAKE_PROVIDER_FORBIDDEN'), false);
});
