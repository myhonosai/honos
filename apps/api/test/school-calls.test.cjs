const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { SchoolCallsService } = require('../dist/calls/school-calls.service.js');
const { SchoolCallsController, schoolCallListQuery } = require('../dist/calls/school-calls.controller.js');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
const cmd = { ...staff, idempotencyKey: 'call-key-1' };
const at = '2026-11-19T05:00:00.000Z';
const call = (over = {}) => ({
  callId: A, direction: 'OUT', status: 'INITIATED', remoteE164: '+15125551001', personId: null, contactName: null, staffName: 'Coach', startedAt: at,
  answeredAt: null, endedAt: null, durationSeconds: null, recorded: false, voicemail: false, recordingAvailable: false, recordingSeconds: null,
  heard: false, outcome: null, note: null, doNotCall: false, version: 1, ...over,
});
/** A database stand-in that returns one row of data and keeps every statement and value it was given. */
function db(data) {
  const seen = [];
  const client = { query: async (sql, values) => { seen.push({ sql, values }); return /^SELECT hon\./.test(sql) ? { rows: [{ data: typeof data === 'function' ? data(sql, values) : data }] } : { rows: [] }; } };
  return { seen, withTenantTransaction: async (_c, fn) => fn(client), withTenantReadOnlyTransaction: async (_c, fn) => { seen.push({ readOnly: true }); return fn(client); } };
}

test('CL3a dialing rule: US and Canada only, no premium, offshore, personal, reserved or N11 codes; typed numbers normalised', () => {
  for (const ok of ['+15125551001', '+14165551234', '+18005551234', '+12125550000']) assert.equal(contracts.schoolCallNumberOk(ok), true, ok);
  for (const bad of ['+442071234567', '+19005551234', '+15129765555', '+14115551234', '+15124111234', '+18765551234', '+18095551234', '+17875551234',
    '+12685551234', '+15005551234', '+12925551234', '+11235551234', '+15121235555', '15125551001', '+1512555100', null, 5125551001]) {
    assert.equal(contracts.schoolCallNumberOk(bad), false, String(bad));
  }
  assert.equal(contracts.normalizeSchoolCallNumber('(512) 555-1001'), '+15125551001');
  assert.equal(contracts.normalizeSchoolCallNumber('1-512-555-1001'), '+15125551001');
  assert.equal(contracts.normalizeSchoolCallNumber('+1 512 555 1001'), '+15125551001');
  for (const bad of ['+44 20 7123 4567', '555-1001', 'call me', '512 555 1001 ext 4', '+5125551001']) assert.equal(contracts.normalizeSchoolCallNumber(bad), null, bad);
});

test('CL3a inputs are closed: settings, Ring me, start, list, after-call update and do-not-call', () => {
  const settings = { callingOn: true, voicemailGreeting: 'Thanks for calling Tiger Dojo.', recordingOn: false, recordingConsentAccepted: false, expectedVersion: 0 };
  assert.deepEqual(contracts.validateSetSchoolCallingSettingsInput(settings), settings);
  for (const voicemailGreeting of ['', ' padded', 'x'.repeat(301), '<Say>hi</Say>', 'bad\u0007']) {
    assert.throws(() => contracts.validateSetSchoolCallingSettingsInput({ ...settings, voicemailGreeting }), undefined, voicemailGreeting);
  }
  assert.throws(() => contracts.validateSetSchoolCallingSettingsInput({ ...settings, expectedVersion: -1 }));
  assert.throws(() => contracts.validateSetSchoolCallingSettingsInput({ ...settings, extra: true }));
  assert.throws(() => contracts.validateSchoolCallRingingInput({ ringMe: 'yes' }));
  assert.deepEqual(contracts.validateStartSchoolCallInput({ toE164: '+15125551001', personId: A }), { toE164: '+15125551001', personId: A });
  assert.throws(() => contracts.validateStartSchoolCallInput({ toE164: '+18765551234' }));
  assert.throws(() => contracts.validateStartSchoolCallInput({ toE164: '+15125551001', fromE164: '+15125550000' }), undefined, 'the caller id is never a browser value');
  assert.deepEqual(contracts.validateSchoolCallListQuery({ filter: 'MISSED', before: { at, id: A } }), { filter: 'MISSED', before: { at, id: A } });
  assert.throws(() => contracts.validateSchoolCallListQuery({ filter: 'RECORDED' }));
  assert.throws(() => contracts.validateUpdateSchoolCallInput({ callId: A, expectedVersion: 1 }), undefined, 'an update changes something');
  assert.throws(() => contracts.validateUpdateSchoolCallInput({ callId: A, expectedVersion: 1, heard: false }));
  assert.throws(() => contracts.validateUpdateSchoolCallInput({ callId: A, expectedVersion: 1, outcome: 'SOLD' }));
  assert.throws(() => contracts.validateUpdateSchoolCallInput({ callId: A, expectedVersion: 1, note: 'x'.repeat(1001) }));
  assert.deepEqual(contracts.validateUpdateSchoolCallInput({ callId: A, expectedVersion: 2, outcome: null, note: 'Call back Tuesday\nafter 5' }),
    { callId: A, expectedVersion: 2, outcome: null, note: 'Call back Tuesday\nafter 5' });
  assert.throws(() => contracts.validateSchoolDoNotCallInput({ phoneE164: '5125551001', doNotCall: true }));
});

test('CL3a verified results: call rows, overview, list order and cursor, started call bound to what was asked', () => {
  assert.deepEqual(contracts.verifySchoolCall(call()), call());
  assert.throws(() => contracts.verifySchoolCall({ ...call(), accountSid: 'AC' }), undefined, 'no provider ids leave the database');
  assert.throws(() => contracts.verifySchoolCall(call({ voicemail: true })), undefined, 'outgoing calls have no voicemail');
  assert.throws(() => contracts.verifySchoolCall(call({ heard: true })));
  assert.throws(() => contracts.verifySchoolCall(call({ recordingSeconds: 4 })));
  const started = { ...call(), connectBy: '2026-11-19T05:02:00.000Z', replayed: false };
  assert.equal(contracts.verifyStartedSchoolCall(started, { toE164: '+15125551001' }).call.callId, A);
  assert.throws(() => contracts.verifyStartedSchoolCall(started, { toE164: '+15125551002' }), undefined, 'another number');
  assert.throws(() => contracts.verifyStartedSchoolCall(started, { toE164: '+15125551001', personId: B }), undefined, 'another contact');
  const rows = Array.from({ length: 50 }, (_, i) => call({ callId: `00000000-0000-4000-8000-${String(99 - i).padStart(12, '0')}` }));
  assert.equal(contracts.verifySchoolCallList({ calls: rows, nextCursor: { at, id: rows[49].callId } }).calls.length, 50);
  assert.throws(() => contracts.verifySchoolCallList({ calls: rows, nextCursor: { at, id: rows[0].callId } }), undefined, 'cursor must be the last row');
  assert.throws(() => contracts.verifySchoolCallList({ calls: [...rows].reverse(), nextCursor: null }), undefined, 'newest first');
  const overview = { callingOn: true, voicemailGreeting: null, recordingOn: true, recordingConsentAt: at, version: 2, schoolNumber: '+15125550000', numberReady: true,
    forwardingPhoneSet: false, missedCallTextBack: true, ringMe: true, canManage: false, unheardVoicemails: 1, missedToday: 2, staff: null };
  assert.equal(contracts.verifySchoolCallingOverview(overview).recordingOn, true);
  assert.throws(() => contracts.verifySchoolCallingOverview({ ...overview, staff: [] }), undefined, 'only managers see the staff list');
  assert.throws(() => contracts.verifySchoolCallingOverview({ ...overview, recordingConsentAt: null }), undefined, 'recording needs a consent time');
  assert.throws(() => contracts.verifySchoolCallingOverview({ ...overview, numberReady: false }));
  assert.equal(contracts.verifySchoolCallingOverview({ ...overview, canManage: true, staff: [{ principalId: C, name: 'Coach', ringMe: true }] }).staff.length, 1);
  const token = { ready: true, reason: 'READY', identity: 'u' + 'a'.repeat(32), token: 'aaa.bbb.ccc', expiresAt: at, incoming: true };
  assert.equal(contracts.verifySchoolPhoneToken(token).ready, true);
  assert.throws(() => contracts.verifySchoolPhoneToken({ ...token, reason: 'CALLING_OFF' }));
  assert.throws(() => contracts.verifySchoolPhoneToken({ ready: false, reason: 'CALLING_OFF', identity: null, token: null, expiresAt: null, incoming: true }));
});

test('CL3a service and controller refuse before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new SchoolCallsService(database);
  await assert.rejects(() => service.overview({ ...staff, source: 'AI_AGENT' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.overview({ ...staff, actionRequestId: A }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.overview({ ...staff, idempotencyKey: 'k' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.start(staff, { toE164: '+15125551001' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.start(cmd, { toE164: '+18765551234' }), (e) => e.getStatus() === 422 && e.response.code === 'CALL_NUMBER_NOT_ALLOWED');
  await assert.rejects(() => service.start(cmd, { toE164: '512-555-1001' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.start(cmd, { toE164: '+15125551001', fromE164: '+15125550000' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.update(staff, A, { callId: B, expectedVersion: 1, heard: true }), (e) => e.response.code === 'VALIDATION_FAILED', 'the body never names a call');
  await assert.rejects(() => service.list(staff, { filter: 'ALL', schoolId: B }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.setSettings(staff, { callingOn: true }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);

  const controller = new SchoolCallsController(database, service);
  const req = { honIdentity: { externalSubject: 'subject' }, originalUrl: '/x' };
  const res = { status: () => res };
  await assert.rejects(() => controller.overview(A, B, {}, 'k', req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.overview(A, B, { schoolId: C }, undefined, req), (e) => e.response.code === 'CALL_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.start(A, B, {}, undefined, { toE164: '+15125551001' }, req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.start(A, B, {}, 'short', { toE164: '+15125551001' }, req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.start(A, B, {}, 'call-key-1', {}, { ...req, originalUrl: '/x?to=1' }, res), (e) => e.response.code === 'CALL_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.settings(A, B, {}, 'k', {}, req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.list(A, B, {}, undefined, { originalUrl: '/x' }), (e) => e.response.code === 'IDENTITY_REQUIRED');
  assert.throws(() => schoolCallListQuery({ beforeAt: at }), (e) => e.response.code === 'VALIDATION_FAILED', 'half a cursor');
  assert.throws(() => schoolCallListQuery({ filter: ['ALL', 'MISSED'] }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.throws(() => schoolCallListQuery({ schoolId: B }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.deepEqual(schoolCallListQuery({ filter: 'MISSED', beforeAt: at, beforeId: A }), { filter: 'MISSED', before: { at, id: A } });
  assert.equal(calls, 0);
  // A scope resolved for another school or organization is refused; settings ask for call.manage, everything else call.use.
  const asked = [];
  const scoped = new SchoolCallsController({ resolveAuthorizedScope: async (_s, _school, permission) => { asked.push(permission); return { organizationId: A, schoolId: C, principalId: C }; } }, service);
  await assert.rejects(() => scoped.overview(A, B, {}, undefined, req), (e) => e.response.code === 'CALLING_FORBIDDEN');
  await assert.rejects(() => scoped.settings(A, B, {}, undefined, {}, req), (e) => e.response.code === 'CALLING_FORBIDDEN');
  assert.deepEqual(asked, ['communication.call.use', 'communication.call.manage']);
});

test('CL3a service: reads run read-only, writes pass only validated JSON, results are verified and refusals explained', async () => {
  let database = db(call());
  const service = () => new SchoolCallsService(database);
  database = db({ calls: [call()], nextCursor: null });
  assert.equal((await service().list(staff, { filter: 'OUTGOING' })).calls.length, 1);
  assert.equal(database.seen[0].readOnly, true);
  assert.deepEqual(JSON.parse(database.seen.find((s) => s.sql?.startsWith('SELECT hon.read_school_calls')).values[1]), { filter: 'OUTGOING' });
  database = db({ calls: [call({ direction: 'IN', status: 'MISSED' })], nextCursor: null });
  await assert.rejects(() => service().list(staff, { filter: 'OUTGOING' }), (e) => e.response.code === 'CALLING_UNAVAILABLE', 'a row outside the filter is not trusted');

  database = db({ ...call(), connectBy: '2026-11-19T05:02:00.000Z', replayed: false });
  const started = await service().start(cmd, { toE164: '+15125551001' });
  assert.equal(started.call.status, 'INITIATED');
  const sent = database.seen.find((s) => s.sql?.startsWith('SELECT hon.start_school_call'));
  assert.deepEqual([JSON.parse(sent.values[1]), sent.values[2]], [{ toE164: '+15125551001' }, 'call-key-1']);
  database = db({ ...call({ remoteE164: '+15125551999' }), connectBy: '2026-11-19T05:02:00.000Z', replayed: false });
  await assert.rejects(() => service().start(cmd, { toE164: '+15125551001' }), (e) => e.response.code === 'CALLING_UNAVAILABLE', 'another number is never accepted');

  database = db(call({ version: 3, outcome: 'CALL_BACK' }));
  assert.equal((await service().update(staff, A, { expectedVersion: 2, outcome: 'CALL_BACK' })).outcome, 'CALL_BACK');
  database = db(call({ version: 2 }));
  await assert.rejects(() => service().update(staff, A, { expectedVersion: 2, outcome: 'CALL_BACK' }), (e) => e.response.code === 'CALLING_UNAVAILABLE');

  database = db({ callingOn: true, voicemailGreeting: null, recordingOn: true, recordingConsentAt: at, version: 1 });
  assert.equal((await service().setSettings(staff, { callingOn: true, voicemailGreeting: null, recordingOn: true, recordingConsentAccepted: true, expectedVersion: 0 })).version, 1);
  database = db({ phoneE164: '+15125551001', doNotCall: false });
  await assert.rejects(() => service().setDoNotCall(staff, { phoneE164: '+15125551001', doNotCall: true }), (e) => e.response.code === 'CALLING_UNAVAILABLE');

  const refuse = (message, code) => new SchoolCallsService({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); },
    withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  await assert.rejects(() => refuse('CALLING_OFF', '55000').start(cmd, { toE164: '+15125551001' }), (e) => e.getStatus() === 422 && /switched off/.test(e.response.detail));
  await assert.rejects(() => refuse('CALL_DO_NOT_CALL', '22023').start(cmd, { toE164: '+15125551001' }), (e) => e.getStatus() === 422 && /Do not call/.test(e.response.detail));
  await assert.rejects(() => refuse('CALL_RATE_LIMITED', '54000').start(cmd, { toE164: '+15125551001' }), (e) => e.getStatus() === 429);
  await assert.rejects(() => refuse('RECORDING_CONSENT_REQUIRED', '22023').setSettings(staff, { callingOn: true, voicemailGreeting: null, recordingOn: true, recordingConsentAccepted: false, expectedVersion: 0 }),
    (e) => e.getStatus() === 422 && /recording statement/.test(e.response.detail));
  await assert.rejects(() => refuse('CALLING_FORBIDDEN', '42501').overview(staff), (e) => e.getStatus() === 403);
  await assert.rejects(() => refuse('CALL_NOT_FOUND', 'P0002').update(staff, A, { expectedVersion: 1, heard: true }), (e) => e.getStatus() === 404);
  await assert.rejects(() => refuse('CALLING_OFF', 'XX000').overview(staff), (e) => e.getStatus() === 503, 'a known word with the wrong SQLSTATE is not trusted');
  await assert.rejects(() => refuse('boom +15125551001', 'XX000').list(staff, {}), (e) => e.response.code === 'CALLING_UNAVAILABLE' && !JSON.stringify(e.response).includes('+1512'));
});

test('CL3a recording consent statement names the notice, the 90-day deletion and the owner duty', () => {
  assert.match(contracts.SCHOOL_CALL_RECORDING_CONSENT, /This call may be recorded/);
  assert.match(contracts.SCHOOL_CALL_RECORDING_CONSENT, /90 days/);
  assert.match(contracts.SCHOOL_CALL_RECORDING_CONSENT, /responsible/);
});
