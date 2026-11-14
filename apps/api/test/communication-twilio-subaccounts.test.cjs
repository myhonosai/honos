// T1 (0351, docs/architecture/SCHOOL_OWN_SENDERS.md §4): per-school Twilio subaccounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { TwilioTextProvider, TwilioWebhookVerifier, TwilioWebhookError } = require('../dist/communication/delivery/twilio-text-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const {
  TwilioSubaccountVault, twilioSubaccountVaultFromEnvironment, WorkerTwilioSubaccountDirectory, FakeTwilioProvisioningClient,
  TwilioRestProvisioningClient, TwilioProvisioningError, SchoolTwilioAccounts, subaccountFriendlyName,
} = require('../dist/communication/delivery/twilio-subaccounts.js');

const parent = `AC${'c'.repeat(32)}`;
const subA = `AC${'a'.repeat(32)}`;
const subB = `AC${'b'.repeat(32)}`;
const schoolA = '44444444-4444-4444-8444-444444444444';
const schoolB = '55555555-5555-4555-8555-555555555555';
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: parent, TWILIO_AUTH_TOKEN: 'parent-token', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_SMS_SEND_APPROVED: 'true', ...over });
function signed(path, fields, token) {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof TwilioWebhookError ? error.reason : error.message; } };
const STATUS = '/v1/communications/webhooks/twilio/status';
const INBOUND = '/v1/communications/webhooks/twilio/inbound';
const VOICE = '/v1/communications/webhooks/twilio/voice';
const HQ_STATUS = '/v1/communications/webhooks/twilio/hq-status';
const msg = `SM${'d'.repeat(32)}`;
const vaultKey = randomBytes(32);

test('subaccount vault: sealed token opens only for the same school, account and key id', () => {
  const vault = new TwilioSubaccountVault(vaultKey, 'staging-1');
  const sealed = vault.seal({ schoolId: schoolA, accountSid: subA }, 'sub-a-token');
  assert.equal(sealed.includes('sub-a-token'), false);
  assert.equal(vault.open({ schoolId: schoolA, accountSid: subA }, 'staging-1', sealed), 'sub-a-token');
  assert.throws(() => vault.open({ schoolId: schoolB, accountSid: subA }, 'staging-1', sealed));
  assert.throws(() => vault.open({ schoolId: schoolA, accountSid: subB }, 'staging-1', sealed));
  assert.throws(() => vault.open({ schoolId: schoolA, accountSid: subA }, 'other-1', sealed));
  assert.throws(() => new TwilioSubaccountVault(randomBytes(32), 'staging-1').open({ schoolId: schoolA, accountSid: subA }, 'staging-1', sealed));
  assert.throws(() => vault.seal({ schoolId: schoolA, accountSid: 'AC1' }, 'x'));
  assert.throws(() => vault.seal({ schoolId: schoolA, accountSid: subA }, ''));
  // A school-payment sealed credential is not a Twilio token (different authenticated label).
  const { SchoolPaymentVault } = require('../dist/school-payments/school-payment-vault.js');
  const pay = new SchoolPaymentVault(vaultKey, 'staging-1').seal({ connectionId: schoolA, providerCode: 'TWILIO', accountRef: subA },
    { accessToken: 'a', refreshToken: 'b', accessExpiresAt: '2030-01-01T00:00:00.000Z' });
  assert.throws(() => vault.open({ schoolId: schoolA, accountSid: subA }, 'staging-1', pay));
  assert.equal(twilioSubaccountVaultFromEnvironment({}), null);
  assert.ok(twilioSubaccountVaultFromEnvironment({ HON_SCHOOL_PAY_VAULT_KEY: vaultKey.toString('base64'), HON_SCHOOL_PAY_VAULT_KEY_ID: 'staging-1' }));
});

test('verifier: a subaccount webhook verifies only with that subaccount token; parent stays as before', () => {
  const verifier = new TwilioWebhookVerifier(() => env(), () => 1_800_000_000_000);
  const fields = { AccountSid: subA, MessageSid: msg, MessageStatus: 'delivered', From: '+15555559001' };
  const ok = signed(STATUS, fields, 'sub-a-token');
  assert.equal(verifier.accountSidOf(ok.body), subA);
  assert.equal(verifier.accountSidOf(Buffer.from('MessageSid=1')), null);
  assert.equal(verifier.isParentAccount(parent), true);
  assert.equal(verifier.isParentAccount(subA), false);
  assert.equal(verifier.status(ok.body, ok.signature, { accountSid: subA, authToken: 'sub-a-token' }).eventType, 'DELIVERED');
  // No credential, the wrong subaccount's credential, or the parent token: refused.
  assert.equal(reason(() => verifier.status(ok.body, ok.signature)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.status(ok.body, ok.signature, { accountSid: subB, authToken: 'sub-a-token' })), 'SIGNATURE_INVALID');
  const parentSigned = signed(STATUS, fields, 'parent-token');
  assert.equal(reason(() => verifier.status(parentSigned.body, parentSigned.signature, { accountSid: subA, authToken: 'sub-a-token' })), 'SIGNATURE_INVALID');
  // Signed by school B's token while claiming school A's account.
  const crossed = signed(STATUS, fields, 'sub-b-token');
  assert.equal(reason(() => verifier.status(crossed.body, crossed.signature, { accountSid: subA, authToken: 'sub-a-token' })), 'SIGNATURE_INVALID');
  // A parent event offered with a subaccount credential still verifies with the parent token only.
  const parentEvent = signed(STATUS, { ...fields, AccountSid: parent }, 'parent-token');
  assert.equal(verifier.status(parentEvent.body, parentEvent.signature).eventType, 'DELIVERED');
  assert.equal(reason(() => verifier.status(parentEvent.body, parentEvent.signature, { accountSid: subA, authToken: 'sub-a-token' })), 'SIGNATURE_INVALID');
  // HQ status is parent-only.
  const hq = signed(HQ_STATUS, fields, 'sub-a-token');
  assert.equal(reason(() => verifier.hqStatus(hq.body, hq.signature)), 'SIGNATURE_INVALID');
  // Not configured without the parent credentials, even with a subaccount credential.
  assert.equal(reason(() => new TwilioWebhookVerifier(() => ({})).status(ok.body, ok.signature, { accountSid: subA, authToken: 'sub-a-token' })), 'NOT_CONFIGURED');
});

function directoryStore() {
  const vault = new TwilioSubaccountVault(vaultKey, 'staging-1');
  const accounts = new Map([
    [subA, { schoolId: schoolA, organizationId: '33333333-3333-4333-8333-333333333333', sealedAuthToken: vault.seal({ schoolId: schoolA, accountSid: subA }, 'sub-a-token'), vaultKeyId: 'staging-1' }],
    [subB, { schoolId: schoolB, organizationId: '33333333-3333-4333-8333-333333333334', sealedAuthToken: vault.seal({ schoolId: schoolB, accountSid: subB }, 'sub-b-token'), vaultKeyId: 'staging-1' }],
  ]);
  const numbers = new Map([['+15555559001', subA], ['+15555559002', subB]]);
  const services = new Map([[`MG${'a'.repeat(32)}`, { accountSid: subA, status: 'ACTIVE' }], [`MG${'e'.repeat(32)}`, { accountSid: subB, status: 'SUSPENDED' }]]);
  const store = {
    isConfigured: () => true,
    readTwilioWebhookAccount: async (sid) => accounts.get(sid) ?? null,
    readTwilioSendAccount: async (service) => services.get(service) ?? null,
    twilioNumberInAccount: async (sid, phone) => numbers.get(phone) === sid,
  };
  return { store, directory: new WorkerTwilioSubaccountDirectory(store, () => vault) };
}

test('directory: opens the token for an ACTIVE subaccount, refuses tampered or unknown ones', async () => {
  const { store, directory } = directoryStore();
  assert.deepEqual(await directory.webhookCredential(subA), { accountSid: subA, authToken: 'sub-a-token', schoolId: schoolA });
  assert.equal(await directory.webhookCredential(`AC${'f'.repeat(32)}`), null);
  assert.equal(await directory.webhookCredential('not-a-sid'), null);
  // A row whose sealed token belongs to another school never opens.
  const swapped = { ...(await store.readTwilioWebhookAccount(subB)), schoolId: schoolA };
  const tampered = new WorkerTwilioSubaccountDirectory({ ...store, readTwilioWebhookAccount: async () => swapped }, () => new TwilioSubaccountVault(vaultKey, 'staging-1'));
  assert.equal(await tampered.webhookCredential(subB), null);
  // No vault configured: nothing opens.
  assert.equal(await new WorkerTwilioSubaccountDirectory(store, () => null).webhookCredential(subA), null);
  assert.equal(await directory.numberInAccount(subA, '+15555559001'), true);
  assert.equal(await directory.numberInAccount(subA, '+15555559002'), false);
});

test('webhook controller: subaccount events need a known account and a number of that account', async () => {
  const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
  const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
  const { directory } = directoryStore();
  const verifier = new TwilioWebhookVerifier(() => env(), () => 1_800_000_000_000);
  const receipts = [];
  const keywords = [];
  const hqInbound = [];
  const store = {
    isConfigured: () => true,
    recordReceipt: async (r) => { receipts.push(r); return { outcome: 'RECORDED', deliveryStatus: 'DELIVERED' }; },
    recordInboundKeyword: async (k) => { keywords.push(k); return { outcome: 'RECORDED', schoolName: 'A', consentsChanged: 1 }; },
    readMissedCallRoute: async () => ({ routed: true, forwardPhoneE164: '+15555550199' }),
    recordMissedCall: async () => ({ outcome: 'RECORDED', textBackStatus: null }),
  };
  const hqStore = { isConfigured: () => true, recordInbound: async (t) => { hqInbound.push(t); return { outcome: 'NOT_HQ' }; }, recordReceipt: async () => ({ outcome: 'RECORDED' }) };
  const controller = new CommunicationWebhookController(store, new SendGridEventWebhookVerifier(() => ({})), verifier, undefined, hqStore, directory);
  const status = (from, token, account = subA) => signed(STATUS, { AccountSid: account, MessageSid: msg, MessageStatus: 'delivered', From: from }, token);

  const ok = status('+15555559001', 'sub-a-token');
  assert.deepEqual(await controller.twilioStatus({ body: ok.body }, ok.signature), { received: true, recorded: 1, replayed: 0, ignored: 0 });
  // School A's account reporting a message from school B's number: refused, nothing recorded.
  const foreign = status('+15555559002', 'sub-a-token');
  await assert.rejects(controller.twilioStatus({ body: foreign.body }, foreign.signature), (e) => e.getStatus() === 400);
  // Unknown subaccount and wrong token.
  const unknown = status('+15555559001', 'x', `AC${'f'.repeat(32)}`);
  await assert.rejects(controller.twilioStatus({ body: unknown.body }, unknown.signature), (e) => e.getStatus() === 400);
  const wrongToken = status('+15555559001', 'sub-b-token');
  await assert.rejects(controller.twilioStatus({ body: wrongToken.body }, wrongToken.signature), (e) => e.getStatus() === 400);
  assert.equal(receipts.length, 1);

  // Inbound STOP on school A's subaccount: the To number must be school A's; the HQ check is skipped.
  const stop = (to, token) => signed(INBOUND, { AccountSid: subA, MessageSid: msg, From: '+15555550101', To: to, Body: 'STOP', MessagingServiceSid: `MG${'a'.repeat(32)}` }, token);
  const okStop = stop('+15555559001', 'sub-a-token');
  await controller.twilioInbound({ body: okStop.body }, okStop.signature);
  assert.deepEqual([keywords.length, hqInbound.length], [1, 0]);
  const otherStop = stop('+15555559002', 'sub-a-token');
  await assert.rejects(controller.twilioInbound({ body: otherStop.body }, otherStop.signature), (e) => e.getStatus() === 400);
  assert.equal(keywords.length, 1);

  // Voice to a number outside the subaccount is refused.
  const call = (to) => signed(VOICE, { AccountSid: subA, CallSid: `CA${'1'.repeat(32)}`, From: '+15555550101', To: to }, 'sub-a-token');
  process.env.HON_PUBLIC_API_ORIGIN = 'https://api.hon.example';
  const okCall = call('+15555559001');
  assert.match(await controller.twilioVoice({ body: okCall.body }, okCall.signature), /Dial/);
  const badCall = call('+15555559002');
  await assert.rejects(controller.twilioVoice({ body: badCall.body }, badCall.signature), (e) => e.getStatus() === 400);

  // HQ status never accepts a subaccount event.
  const hq = signed(HQ_STATUS, { AccountSid: subA, MessageSid: msg, MessageStatus: 'delivered', From: '+15555559001' }, 'sub-a-token');
  await assert.rejects(controller.twilioHqStatus({ body: hq.body }, hq.signature), (e) => e.getStatus() === 400);

  // Without a directory, a subaccount event is refused (parent-only, as before).
  const bare = new CommunicationWebhookController(store, new SendGridEventWebhookVerifier(() => ({})), verifier, undefined, hqStore);
  await assert.rejects(bare.twilioStatus({ body: ok.body }, ok.signature), (e) => e.getStatus() === 400);
  // Directory trouble is a retry, not a refusal.
  const broken = { webhookCredential: async () => { throw new Error('db'); }, numberInAccount: async () => true, sendAccount: async () => null };
  const flaky = new CommunicationWebhookController(store, new SendGridEventWebhookVerifier(() => ({})), verifier, undefined, hqStore, broken);
  await assert.rejects(flaky.twilioStatus({ body: ok.body }, ok.signature), (e) => e.getStatus() === 503);
  // Parent-account events still work through a controller with a directory.
  const parentOk = signed(STATUS, { AccountSid: parent, MessageSid: msg, MessageStatus: 'delivered' }, 'parent-token');
  assert.equal((await controller.twilioStatus({ body: parentOk.body }, parentOk.signature)).recorded, 1);
});

test('send: a school service on a subaccount posts to that subaccount with parent credentials; suspended or lookup failure retries', async () => {
  const { directory } = directoryStore();
  const urls = [];
  const transport = async (url, init) => { urls.push([url, init.headers.authorization]); return { status: 201, json: async () => ({ sid: msg, num_segments: '1' }) }; };
  const adapter = new TwilioTextProvider(() => env(), transport, directory);
  const request = (over = {}) => ({ deliveryId: '11111111-1111-4111-8111-111111111111', messageId: '66666666-6666-4666-8666-666666666666',
    organizationId: '33333333-3333-4333-8333-333333333333', schoolId: schoolA, channel: 'SMS', recipientAddress: '+15555550101',
    content: 'Class at 5', schoolName: 'A', attempt: 1, senderAddress: '+15555559001', senderServiceId: `MG${'a'.repeat(32)}`, ...over });
  const parentAuth = `Basic ${Buffer.from(`${parent}:parent-token`).toString('base64')}`;
  await adapter.send(request());
  assert.deepEqual(urls.pop(), [`https://api.twilio.com/2010-04-01/Accounts/${subA}/Messages.json`, parentAuth]);
  // A service with no subaccount (hand-entered 0248 sender) and HQ sends use the parent account.
  await adapter.send(request({ senderServiceId: `MG${'9'.repeat(32)}` }));
  assert.equal(urls.pop()[0], `https://api.twilio.com/2010-04-01/Accounts/${parent}/Messages.json`);
  await adapter.send(request({ origin: 'HQ', senderServiceId: `MG${'a'.repeat(32)}` }));
  assert.equal(urls.pop()[0], `https://api.twilio.com/2010-04-01/Accounts/${parent}/Messages.json`);
  // Suspended subaccount: never sent, never falls back to the parent.
  await assert.rejects(adapter.send(request({ senderServiceId: `MG${'e'.repeat(32)}` })), (e) => e instanceof CommunicationProviderError && e.outcome === 'RETRYABLE');
  const failing = new TwilioTextProvider(() => env(), transport, { ...directory, sendAccount: async () => { throw new Error('db'); } });
  await assert.rejects(failing.send(request()), (e) => e instanceof CommunicationProviderError && e.outcome === 'RETRYABLE');
  assert.equal(urls.length, 0);
});

test('provisioning: REST client is READY only with parent credentials and the provisioning switch; switch off means no call', async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return { status: 201, json: async () => ({ sid: subA, auth_token: 'tok' }) }; };
  for (const e of [{}, env(), env({ HON_TWILIO_PROVISIONING_APPROVED: 'yes' }), env({ HON_TWILIO_PROVISIONING_APPROVED: 'true', TWILIO_AUTH_TOKEN: '' })]) {
    const client = new TwilioRestProvisioningClient(() => e, transport);
    assert.equal(client.readiness(), 'CONFIGURATION_REQUIRED');
    await assert.rejects(client.createSubaccount(subaccountFriendlyName(schoolA)), (err) => err instanceof TwilioProvisioningError && err.outcome === 'RETRYABLE');
    await assert.rejects(client.findSubaccount(subaccountFriendlyName(schoolA)), (err) => err instanceof TwilioProvisioningError);
  }
  assert.equal(calls, 0);
  const seen = [];
  const ready = new TwilioRestProvisioningClient(() => env({ HON_TWILIO_PROVISIONING_APPROVED: 'true' }), async (url, init) => {
    seen.push([url, init.method, init.body?.toString() ?? null]);
    if (init.method === 'GET') return { status: 200, json: async () => ({ accounts: [] }) };
    return { status: 201, json: async () => ({ sid: subA, auth_token: 'sub-a-token', status: 'active' }) };
  });
  assert.equal(ready.readiness(), 'READY');
  assert.equal(await ready.findSubaccount(subaccountFriendlyName(schoolA)), null);
  assert.deepEqual(await ready.createSubaccount(subaccountFriendlyName(schoolA)), { accountSid: subA, authToken: 'sub-a-token' });
  assert.deepEqual(seen, [
    [`https://api.twilio.com/2010-04-01/Accounts.json?FriendlyName=hon-school-${schoolA}&Status=active`, 'GET', null],
    ['https://api.twilio.com/2010-04-01/Accounts.json', 'POST', `FriendlyName=hon-school-${schoolA}`],
  ]);
  assert.throws(() => subaccountFriendlyName('not-a-uuid'));
  // A lost create response is UNKNOWN; a 5xx too; a 4xx is FAILED.
  const lost = new TwilioRestProvisioningClient(() => env({ HON_TWILIO_PROVISIONING_APPROVED: 'true' }), async () => { throw new Error('timeout'); });
  await assert.rejects(lost.createSubaccount(subaccountFriendlyName(schoolA)), (err) => err.outcome === 'UNKNOWN');
  const bad = new TwilioRestProvisioningClient(() => env({ HON_TWILIO_PROVISIONING_APPROVED: 'true' }), async () => ({ status: 400, json: async () => ({}) }));
  await assert.rejects(bad.createSubaccount(subaccountFriendlyName(schoolA)), (err) => err.outcome === 'FAILED');
});

function accountsStore() {
  const rows = new Map();
  let now = 0;
  return {
    rows, tick: (s) => { now += s; },
    isConfigured: () => true,
    beginSchoolTwilioAccount: async (school, lease) => {
      const row = rows.get(school);
      if (row?.status === 'ACTIVE') return { state: 'ACTIVE', accountSid: row.accountSid };
      if (row && row.expires > now) return { state: 'BUSY' };
      const claimToken = `claim-${rows.size}-${now}`;
      rows.set(school, { status: 'PENDING', claimToken, expires: now + lease });
      return { state: 'CLAIMED', claimToken };
    },
    completeSchoolTwilioAccount: async (school, claim, sid, sealed, keyId) => {
      const row = rows.get(school);
      if (!row || row.claimToken !== claim || row.expires <= now) throw Object.assign(new Error('TWILIO_ACCOUNT_CLAIM_LOST'), { code: '40001' });
      rows.set(school, { status: 'ACTIVE', accountSid: sid, sealed, keyId });
      return { accountSid: sid };
    },
  };
}

test('ensure: creates one subaccount per school, idempotently, and recovers a lost create by name', async () => {
  const vault = new TwilioSubaccountVault(vaultKey, 'staging-1');
  const store = accountsStore();
  const fake = new FakeTwilioProvisioningClient();
  const accounts = new SchoolTwilioAccounts(store, fake, vault);
  const first = await accounts.ensure(schoolA);
  assert.equal(first.outcome, 'ACTIVE');
  assert.match(first.accountSid, /^AC[0-9a-f]{32}$/);
  assert.deepEqual(await accounts.ensure(schoolA), first);
  assert.equal(fake.created.length, 1);
  const row = store.rows.get(schoolA);
  assert.equal(row.sealed.includes(fake.tokenOf(first.accountSid)), false);
  assert.equal(vault.open({ schoolId: schoolA, accountSid: first.accountSid }, 'staging-1', row.sealed), fake.tokenOf(first.accountSid));
  // Another school gets a different account.
  assert.notEqual((await accounts.ensure(schoolB)).accountSid, first.accountSid);

  // A create whose response is lost: UNKNOWN now; after the claim lease ends the next ensure finds it by name.
  const school = '77777777-7777-4777-8777-777777777777';
  const lossy = new FakeTwilioProvisioningClient({ loseNextCreate: true });
  const lossyAccounts = new SchoolTwilioAccounts(store, lossy, vault);
  await assert.rejects(lossyAccounts.ensure(school), (e) => e instanceof TwilioProvisioningError && e.outcome === 'UNKNOWN');
  assert.deepEqual(await lossyAccounts.ensure(school), { outcome: 'BUSY' });
  store.tick(301);
  const recovered = await lossyAccounts.ensure(school);
  assert.equal(recovered.outcome, 'ACTIVE');
  assert.equal(lossy.created.length, 1, 'never a second subaccount');

  // Not ready (switch off) or no vault: nothing claimed, nothing created.
  const off = { readiness: () => 'CONFIGURATION_REQUIRED', findSubaccount: async () => { throw new Error('no'); }, createSubaccount: async () => { throw new Error('no'); } };
  const before = store.rows.size;
  assert.deepEqual(await new SchoolTwilioAccounts(store, off, vault).ensure('88888888-8888-4888-8888-888888888888'), { outcome: 'NOT_READY' });
  assert.deepEqual(await new SchoolTwilioAccounts(store, fake, null).ensure('88888888-8888-4888-8888-888888888888'), { outcome: 'NOT_READY' });
  assert.equal(store.rows.size, before);
});

test('fake provisioning client refuses production deployments', () => {
  assert.throws(() => new FakeTwilioProvisioningClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'production' }));
  assert.throws(() => new FakeTwilioProvisioningClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'staging' }));
  assert.throws(() => new FakeTwilioProvisioningClient({}, { NODE_ENV: 'production' }));
});
