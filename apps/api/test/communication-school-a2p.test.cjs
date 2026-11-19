// T3a (0553, docs/architecture/SCHOOL_OWN_SENDERS.md §4.3 step 6-7, §5): school A2P registration, HQ decision, worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { validateSchoolA2pRegistrationRequest, verifySchoolA2pRegistration, A2P_FACT_CONFIRMATION } = require('@hon/contracts');
const { SchoolA2pWorker, FakeTwilioA2pClient, UnavailableTwilioA2pClient, a2pSubmitApproved, A2P_REVIEW_WAIT_SECONDS } = require('../dist/communication/delivery/school-a2p.js');
const { SchoolA2pService } = require('../dist/communication/delivery/school-a2p.service.js');
const { SchoolA2pHqController, validateA2pDecision } = require('../dist/communication/delivery/school-a2p.controller.js');
const { TwilioSubaccountVault, TwilioProvisioningError } = require('../dist/communication/delivery/twilio-subaccounts.js');

const org = '33333333-3333-4333-8333-333333333333';
const school = '44444444-4444-4444-8444-444444444444';
const registrationId = '66666666-6666-4666-8666-666666666666';
const lease = '77777777-7777-4777-8777-777777777777';
const account = `AC${'a'.repeat(32)}`;
const service = `MG${'1'.repeat(32)}`;
const digest = 'd'.repeat(64);

const business = { legalName: 'Austin Dojo LLC', ein: '12-3456789', businessType: 'LLC', street: '100 Main St', city: 'Austin', region: 'TX', postalCode: '78701',
  contactFirstName: 'Pat', contactLastName: 'Lee', contactTitle: 'Owner', contactEmail: 'owner@dojo.example', contactPhone: '+15125550100' };
const draftInput = { facts: { businessName: 'Austin Dojo', websiteUrl: null, privacyUrl: null, termsUrl: null, optInUrl: null, supportContact: null, messageFlow: null,
  messageFrequency: null }, purpose: 'SERVICE_NOTIFICATIONS', templates: ['TRIAL_CONFIRMATION'], marketingConsent: 'NOT_APPLICABLE', ownerConfirmation: A2P_FACT_CONFIRMATION };
const draft = { engineVersion: 'A2P_PREPARATION_V1', language: 'en', state: 'DRAFT_FOR_OWNER_REVIEW', missingFields: [], warnings: [],
  answers: { campaignUseCase: 'Service', campaignDescription: 'Reminders', messageFlow: 'Form', websiteUrl: 'https://d.example', privacyPolicyUrl: 'https://d.example/p',
    termsAndConditionsUrl: 'https://d.example/t', optInUrl: 'https://d.example/o' },
  sampleMessages: [{ template: 'CLASS_REMINDER', content: 'Class at 5. Reply STOP to opt out.' }], helpResponseSample: 'Help', stopResponseSample: 'Stopped',
  copyPreparationAvailable: true, factsProvenance: 'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED', consentRecorded: false, saved: false, submitted: false, messagesSent: 0 };
const view = (over = {}) => {
  const { ein, ...rest } = business;
  return { registrationId, schoolId: school, status: 'REQUESTED', brandType: 'LOW_VOLUME_STANDARD', useCase: 'ACCOUNT_NOTIFICATION', draftDigest: digest,
    answers: draft.answers, sampleMessages: draft.sampleMessages, helpResponse: 'Help', stopResponse: 'Stopped', business: { ...rest, einLast4: ein.slice(-4) },
    decisionNote: null, decidedAt: null, failureCode: null, outcomeUnknown: false, brandRegistered: false, campaignRegistered: false, version: 1,
    createdAt: '2026-11-15T09:00:00Z', updatedAt: '2026-11-15T09:00:00Z', ...over };
};
const context = (over = {}) => ({ organizationId: org, schoolId: school, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI',
  externalSubject: 'owner-subject', requestId: 'r', correlationId: 'r', idempotencyKey: 'a2p-key-01', ...over });
const body = (over = {}) => ({ draftInput, expectedDigest: digest, brandType: 'LOW_VOLUME_STANDARD', business, ...over });

function fakeDatabase(answer = (input) => view({ draftDigest: input.draftDigest })) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('request_school_a2p_registration')) return { rows: [{ data: answer(JSON.parse(values[1])) }] };
      if (sql.includes('read_school_a2p_registrations')) return { rows: [{ data: { registrations: [view()] } }] };
      return { rows: [] };
    },
  };
  return { calls, withTenantTransaction: async (_context, fn) => fn(client) };
}
const preparation = (over = {}) => ({ calls: 0, async draft() { this.calls += 1; return { draft: { ...draft, ...over.draft }, computationDigest: over.digest ?? digest }; } });

test('contracts: the submission is exact; sole proprietors, bad EINs and padded values are refused; reads never carry the EIN', () => {
  assert.equal(validateSchoolA2pRegistrationRequest(body()).business.ein, '12-3456789');
  for (const bad of [null, body({ extra: 1 }), body({ brandType: 'SOLE_PROPRIETOR' }), body({ expectedDigest: 'x' }), body({ draftInput: 'x' }),
    body({ business: { ...business, businessType: 'SOLE_PROPRIETOR' } }), body({ business: { ...business, ein: '999999999' } }), body({ business: { ...business, ein: '12345' } }),
    body({ business: { ...business, legalName: ' Dojo' } }), body({ business: { ...business, region: 'tx' } }), body({ business: { ...business, contactPhone: '5125550100' } }),
    body({ business: { ...business, extra: 'x' } })]) assert.throws(() => validateSchoolA2pRegistrationRequest(bad), /INVALID_A2P_REGISTRATION/);
  assert.equal(verifySchoolA2pRegistration(view()).business.einLast4, '6789');
  assert.throws(() => verifySchoolA2pRegistration(view({ business: { ...business, einLast4: '6789' } })), /Unverified/);
  assert.throws(() => verifySchoolA2pRegistration({ ...view(), providerSid: 'x' }), /Unverified/);
});

test('school service: the draft is regenerated by the 0190 engine; a changed digest or incomplete draft is refused before the database', async () => {
  const database = fakeDatabase();
  const prep = preparation();
  const saved = await new SchoolA2pService(database, prep).request(context(), body());
  assert.equal(saved.status, 'REQUESTED');
  const sent = JSON.parse(database.calls.find((c) => c.sql.includes('request_school_a2p_registration')).values[1]);
  assert.deepEqual(Object.keys(sent).sort(), ['brandType', 'business', 'draft', 'draftDigest', 'draftInput']);
  assert.deepEqual(Object.keys(sent.draft).sort(), ['answers', 'copyPreparationAvailable', 'engineVersion', 'helpResponseSample', 'sampleMessages', 'stopResponseSample', 'warnings']);
  assert.equal(sent.draftDigest, digest);
  assert.equal(database.calls.find((c) => c.sql.includes('request_school_a2p_registration')).values[2], 'a2p-key-01');

  for (const [prep2, code] of [[preparation({ digest: 'e'.repeat(64) }), 'A2P_DRAFT_CHANGED'], [preparation({ draft: { copyPreparationAvailable: false } }), 'A2P_DRAFT_INCOMPLETE'],
    [preparation({ draft: { answers: null } }), 'A2P_DRAFT_INCOMPLETE']]) {
    const db = fakeDatabase();
    await assert.rejects(new SchoolA2pService(db, prep2).request(context(), body()), (e) => e.getResponse().code === code);
    assert.equal(db.calls.length, 0);
  }
  const unconfirmed = preparation();
  await assert.rejects(new SchoolA2pService(fakeDatabase(), unconfirmed).request(context(), body({ draftInput: { ...draftInput, ownerConfirmation: 'NOT_CONFIRMED' } })),
    (e) => e.getStatus() === 400);
  assert.equal(unconfirmed.calls, 0);
  await assert.rejects(new SchoolA2pService(fakeDatabase(), preparation()).request(context({ idempotencyKey: '' }), body()), (e) => e.getStatus() === 403);
  await assert.rejects(new SchoolA2pService(fakeDatabase(), preparation()).request(context({ source: 'AI_AGENT' }), body()), (e) => e.getStatus() === 403);
  // A database answer for another school is not trusted.
  await assert.rejects(new SchoolA2pService(fakeDatabase(() => view({ schoolId: org })), preparation()).request(context(), body()), (e) => e.getStatus() === 503);
  const refused = fakeDatabase(() => { throw Object.assign(new Error('A2P_OWNER_REQUIRED'), { code: '42501' }); });
  await assert.rejects(new SchoolA2pService(refused, preparation()).request(context(), body()), (e) => e.getResponse().code === 'A2P_OWNER_REQUIRED');
  const list = await new SchoolA2pService(fakeDatabase(), preparation()).list(context({ idempotencyKey: '' }));
  assert.equal(list[0].business.einLast4, '6789');
});

test('HQ decision: approve or reject with a reason and the seen version, passed to the 0553 function', async () => {
  assert.deepEqual(validateA2pDecision({ decision: 'APPROVE', expectedVersion: 2 }), { decision: 'APPROVE', expectedVersion: 2 });
  for (const bad of [null, { decision: 'REJECT', expectedVersion: 1 }, { decision: 'MAYBE', expectedVersion: 1 }, { decision: 'APPROVE', expectedVersion: 0 },
    { decision: 'APPROVE', note: ' padded', expectedVersion: 1 }, { decision: 'APPROVE', expectedVersion: 1, schoolId: school }]) assert.throws(() => validateA2pDecision(bad));
  const calls = [];
  const database = { callSaasBilling: async (name, params) => { calls.push([name, params]); if (params[1] === lease) throw Object.assign(new Error('A2P_REGISTRATION_NOT_PENDING'), { code: '55000' }); return { ok: true }; } };
  const controller = new SchoolA2pHqController(database);
  const req = { honIdentity: { externalSubject: 'hq-subject' } };
  await controller.decide(req, registrationId, { decision: 'REJECT', note: 'No privacy page', expectedVersion: 3 });
  assert.deepEqual(calls[0], ['decideSchoolA2pRegistration', ['hq-subject', registrationId, 'REJECT', 'No privacy page', '3']]);
  await assert.rejects(controller.decide(req, lease, { decision: 'APPROVE', expectedVersion: 1 }), (e) => e.getResponse().code === 'A2P_REGISTRATION_NOT_PENDING');
  await assert.rejects(controller.decide(req, 'nope', { decision: 'APPROVE', expectedVersion: 1 }), (e) => e.getStatus() === 400);
  await assert.rejects(controller.list(req, 'SOMETHING'), (e) => e.getStatus() === 400);
  await controller.list(req, 'REQUESTED');
  assert.deepEqual(calls.at(-1), ['readHqSchoolA2pRegistrations', ['hq-subject', 'REQUESTED']]);
});

function workerStore(claims, vault) {
  const recorded = [];
  return {
    recorded,
    isConfigured: () => true,
    async readTwilioWebhookAccount(accountSid) {
      return accountSid === account ? { schoolId: school, organizationId: org, sealedAuthToken: vault.seal({ schoolId: school, accountSid }, 'sub-token'), vaultKeyId: vault.keyId } : null;
    },
    async claimSchoolA2pRegistrations() { return claims.splice(0); },
    async recordSchoolA2pProgress(result) { recorded.push(result); return { status: result.outcome, version: 2 }; },
  };
}
const claim = (over = {}) => ({ registrationId, leaseToken: lease, schoolId: school, organizationId: org, stage: 'SUBMITTING', attempt: 1, outcomeUnknown: false,
  accountSid: account, brandType: 'LOW_VOLUME_STANDARD', useCase: 'ACCOUNT_NOTIFICATION', draft, business, customerProfileSid: null, a2pProfileSid: null,
  brandSid: null, campaignSid: null, messagingServiceSid: service, ...over });
const vaultFor = () => new TwilioSubaccountVault(randomBytes(32), 'test-1');
const on = (vault) => ({ vault: () => vault, approved: () => true });

test('switch: only HON_TWILIO_A2P_SUBMIT_APPROVED exactly "true" with a READY client and a vault; otherwise nothing is claimed', async () => {
  assert.equal(a2pSubmitApproved({ HON_TWILIO_A2P_SUBMIT_APPROVED: 'true' }), true);
  for (const value of [undefined, '', 'TRUE', '1', 'yes']) assert.equal(a2pSubmitApproved({ HON_TWILIO_A2P_SUBMIT_APPROVED: value }), false);
  const vault = vaultFor();
  for (const [client, setup] of [[new FakeTwilioA2pClient(), { vault: () => vault, approved: () => false }], [new FakeTwilioA2pClient({ ready: false }), on(vault)],
    [new FakeTwilioA2pClient(), { vault: () => null, approved: () => true }], [new UnavailableTwilioA2pClient(), on(vault)]]) {
    const claims = [claim()];
    const store = workerStore(claims, vault);
    assert.equal((await new SchoolA2pWorker(store, client, setup).runOnce()).claimed, 0);
    assert.equal(claims.length, 1, 'nothing was claimed');
    assert.deepEqual(client.calls ?? [], []);
  }
  // With the switch unset in the environment the default check is off.
  const store = workerStore([claim()], vault);
  assert.equal((await new SchoolA2pWorker(store, new FakeTwilioA2pClient(), { vault: () => vault }).runOnce()).claimed, 0);
});

test('worker: profile, brand and campaign are created once each and approved in order; the next attempt finds them', async () => {
  const vault = vaultFor();
  const client = new FakeTwilioA2pClient({ reviews: { customerProfile: ['PENDING', 'APPROVED'], brand: ['PENDING', 'APPROVED'], campaign: ['PENDING', 'APPROVED'] } });
  const claims = [claim()];
  const store = workerStore(claims, vault);
  const worker = new SchoolA2pWorker(store, client, on(vault));
  await worker.runOnce();
  assert.equal(store.recorded[0].outcome, 'BRAND_PENDING');
  assert.equal(store.recorded[0].waitSeconds, A2P_REVIEW_WAIT_SECONDS);
  assert.match(store.recorded[0].sids.customerProfileSid, /^BU[0-9a-f]{32}$/);
  claims.push(claim({ stage: 'BRAND_PENDING' })); await worker.runOnce();
  assert.equal(store.recorded[1].outcome, 'BRAND_PENDING');
  assert.match(store.recorded[1].sids.brandSid, /^BN[0-9a-f]{32}$/);
  claims.push(claim({ stage: 'BRAND_PENDING' })); await worker.runOnce();
  assert.equal(store.recorded[2].outcome, 'CAMPAIGN_PENDING');
  assert.match(store.recorded[2].sids.campaignSid, /^QE[0-9a-f]{32}$/);
  assert.equal(store.recorded[2].sids.messagingServiceSid, service);
  claims.push(claim({ stage: 'CAMPAIGN_PENDING' })); await worker.runOnce();
  assert.equal(store.recorded[3].outcome, 'APPROVED');
  assert.equal(client.calls.filter((c) => c.startsWith('create:')).length, 4, 'each Twilio object was created exactly once');
  assert.ok(client.calls.includes(`create:campaign:ACCOUNT_NOTIFICATION:${store.recorded[3].sids.brandSid}:${service}`), 'the campaign uses the draft use case, the brand and the school service');
});

test('worker: a lost create is UNKNOWN and found next time; a refusal is FAILED with its code; no number yet waits; Twilio down retries', async () => {
  const vault = vaultFor();
  const client = new FakeTwilioA2pClient({ lose: ['brand'] });
  const claims = [claim()];
  const store = workerStore(claims, vault);
  const worker = new SchoolA2pWorker(store, client, on(vault));
  await worker.runOnce();
  assert.deepEqual([store.recorded[0].outcome, store.recorded[0].failureCode], ['UNKNOWN', 'OUTCOME_UNKNOWN']);
  assert.ok(store.recorded[0].sids.a2pProfileSid && !store.recorded[0].sids.brandSid, 'the SIDs seen before the lost step are kept');
  claims.push(claim({ outcomeUnknown: true, attempt: 2 })); await worker.runOnce();
  assert.equal(store.recorded[1].outcome, 'APPROVED');
  assert.equal(client.calls.filter((c) => c.startsWith('create:brand')).length, 1, 'the lost brand was found, never registered twice');

  const rejected = workerStore([claim()], vault);
  await new SchoolA2pWorker(rejected, new FakeTwilioA2pClient({ reviews: { campaign: ['REJECTED'] } }), on(vault)).runOnce();
  assert.deepEqual([rejected.recorded[0].outcome, rejected.recorded[0].failureCode], ['FAILED', 'CAMPAIGN_REJECTED']);
  const noNumber = workerStore([claim({ messagingServiceSid: null })], vault);
  const waiting = new FakeTwilioA2pClient();
  await new SchoolA2pWorker(noNumber, waiting, on(vault)).runOnce();
  assert.deepEqual([noNumber.recorded[0].outcome, noNumber.recorded[0].failureCode], ['BRAND_PENDING', 'WAITING_FOR_NUMBER']);
  assert.ok(!waiting.calls.some((c) => c.includes('campaign')), 'no campaign without the school\'s own service');
  const down = new FakeTwilioA2pClient();
  down.customerProfile = async () => { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_UNREACHABLE'); };
  const retry = workerStore([claim()], vault);
  await new SchoolA2pWorker(retry, down, on(vault)).runOnce();
  assert.deepEqual([retry.recorded[0].outcome, retry.recorded[0].failureCode, retry.recorded[0].waitSeconds], ['RETRY', 'PROVIDER_UNREACHABLE', 300]);
  const other = workerStore([claim({ accountSid: `AC${'b'.repeat(32)}` })], vault);
  await new SchoolA2pWorker(other, new FakeTwilioA2pClient(), on(vault)).runOnce();
  assert.deepEqual([other.recorded[0].outcome, other.recorded[0].failureCode], ['FAILED', 'TWILIO_ACCOUNT_MISMATCH']);
  // A lost lease is counted, never re-recorded.
  const lost = workerStore([claim()], vault);
  lost.recordSchoolA2pProgress = async () => { throw new Error('A2P_LEASE_LOST'); };
  assert.equal((await new SchoolA2pWorker(lost, new FakeTwilioA2pClient(), on(vault)).runOnce()).leaseLost, 1);
});

test('the fake A2P client is refused in production and staging; the wired client never submits', async () => {
  assert.throws(() => new FakeTwilioA2pClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'production' }), /FAKE_TWILIO_A2P_REFUSED/);
  assert.throws(() => new FakeTwilioA2pClient({}, { HON_DEPLOYMENT_ENVIRONMENT: 'staging' }), /FAKE_TWILIO_A2P_REFUSED/);
  assert.throws(() => new FakeTwilioA2pClient({}, { NODE_ENV: 'production' }), /FAKE_TWILIO_A2P_REFUSED/);
  const wired = new UnavailableTwilioA2pClient();
  assert.equal(wired.readiness(), 'CONFIGURATION_REQUIRED');
  await assert.rejects(wired.brand(), (e) => e.code === 'A2P_CLIENT_NOT_AVAILABLE');
});
