const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { WalkInKioskService, walkInTokenDigest } = require('../dist/walk-in-kiosk/walk-in-kiosk.service.js');
const { walkInKioskTransport } = require('../dist/walk-in-kiosk/walk-in-kiosk-transport.js');

// 0414 walk-in kiosk: the shared validators match the database rules, the service refuses before any database call, the
// tablet only ever sends the token digest, public failures never leak detail, and the tablet transport is strict.

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(43);
const TODAY = '2026-11-16';
const settings = {
  expectedVersion: 0, enabled: true, waiver: { en: 'I accept the risks of training.\nSigned below.', ko: '동의합니다.' }, emergencyRequired: false,
  pipelineId: ID, pipelineStageId: ID, thankYou: { en: 'Welcome to the mat!' },
  offers: [{ key: 'trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0 },
    { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass', es: 'Pase de día' }, description: { en: 'Train all day.' }, priceMinor: 2500 }],
};
const visit = (patch = {}) => ({
  settingsVersion: 1, language: 'en',
  contact: { givenName: 'Kim', familyName: 'Rivera', email: 'Kim@Example.test', mobile: '', birthDate: null, isParticipant: false, adultConfirmed: true },
  children: [{ givenName: 'Sam', familyName: 'Rivera', birthDate: '2018-03-04' }], relationship: 'PARENT', emergency: { name: '', phone: '' },
  heardFrom: 'FRIEND', marketingOptIn: false, offerKey: 'trial', waiver: { accepted: true, signerName: 'Kim Rivera', strokes: [[[10, 10], [200, 80]]] }, website: '',
  ...patch,
});

test('0414 settings input: closed shape, English required, 1-6 unique offers, plain text', () => {
  assert.deepEqual(contracts.validateWalkInSettingsInput(settings), settings);
  for (const patch of [{ waiver: { en: '' } }, { waiver: { ko: 'x' } }, { waiver: { en: 'x', fr: 'x' } }, { offers: [] }, { offers: Array(7).fill(settings.offers[0]) },
    { offers: [settings.offers[0], settings.offers[0]] }, { offers: [{ ...settings.offers[0], kind: 'MEMBERSHIP' }] }, { offers: [{ ...settings.offers[0], priceMinor: -1 }] },
    { offers: [{ ...settings.offers[0], priceMinor: 1.5 }] }, { offers: [{ ...settings.offers[0], key: 'Trial' }] }, { offers: [{ ...settings.offers[0], name: { en: '<b>Trial</b>' } }] },
    { thankYou: { en: 'x'.repeat(301) } }, { pipelineId: 'nope' }, { enabled: 'yes' }, { extra: 1 }]) {
    assert.throws(() => contracts.validateWalkInSettingsInput({ ...settings, ...patch }), undefined, JSON.stringify(patch));
  }
  assert.deepEqual(contracts.validateStartWalkInDeviceInput({ label: 'Front desk', hours: 12 }), { label: 'Front desk', hours: 12 });
  for (const bad of [{ label: '', hours: 1 }, { label: 'x', hours: 13 }, { label: 'x', hours: 0 }, { label: 'x', hours: 1, tokenDigest: 'a'.repeat(64) }]) {
    assert.throws(() => contracts.validateStartWalkInDeviceInput(bad), undefined, 'the browser never chooses the token');
  }
  assert.throws(() => contracts.validateWalkInDeskPaidInput({ expectedVersion: 1, method: 'STRIPE' }), undefined, 'desk paid is never a card charge in HON');
});

test('0414 visit input: who trains, minors, contact, waiver signature', () => {
  assert.equal(contracts.validateWalkInVisitInput(visit(), TODAY).contact.email, 'kim@example.test');
  const adult = visit({ contact: { ...visit().contact, isParticipant: true, birthDate: '1990-01-01' }, children: [], relationship: null });
  assert.equal(contracts.validateWalkInVisitInput(adult, TODAY).children.length, 0);
  for (const patch of [{ children: [], relationship: null }, { relationship: null }, { children: [{ givenName: 'Big', familyName: 'R', birthDate: '2008-11-16' }] },
    { children: Array(4).fill(visit().children[0]) }, { children: [{ givenName: 'Sam', familyName: 'R', birthDate: '2020-02-30' }] },
    { contact: { ...visit().contact, email: '', mobile: '' } }, { contact: { ...visit().contact, mobile: '5555550101' } }, { contact: { ...visit().contact, adultConfirmed: false } },
    { contact: { ...visit().contact, givenName: '<b>' } }, { emergency: { name: 'Jo', phone: '' } }, { language: 'fr' }, { website: 'spam' }, { notes: 'x' },
    { waiver: { ...visit().waiver, accepted: false } }, { waiver: { ...visit().waiver, strokes: [] } }, { waiver: { ...visit().waiver, strokes: [[[1, 1]]] } },
    { waiver: { ...visit().waiver, strokes: [[[1, 1], [1001, 5]]] } }, { waiver: { ...visit().waiver, signerName: '' } }]) {
    assert.throws(() => contracts.validateWalkInVisitInput(visit(patch), TODAY), undefined, JSON.stringify(patch));
  }
  assert.throws(() => contracts.validateWalkInVisitInput(visit({ contact: { ...visit().contact, isParticipant: true, birthDate: '2010-01-01' }, children: [], relationship: null }), TODAY),
    undefined, 'a minor is never the contact');
  assert.equal(contracts.walkInAge('2008-11-16', TODAY), 18);
  assert.equal(contracts.walkInAge('2008-11-17', TODAY), 17);
  assert.deepEqual(contracts.walkInText({ en: 'Hello', ko: '' }, 'ko'), { text: 'Hello', fallback: true });
  assert.deepEqual(contracts.walkInText({ en: 'Hello', es: 'Hola' }, 'es'), { text: 'Hola', fallback: false });
});

test('0414 visit outcome carries no visitor data beyond the first name', () => {
  assert.deepEqual(contracts.verifyWalkInVisitOutcome({ result: 'CLOSED' }), { result: 'CLOSED' });
  assert.throws(() => contracts.verifyWalkInVisitOutcome({ result: 'CLOSED', firstName: 'Kim' }), undefined, 'a refusal carries nothing');
  assert.throws(() => contracts.verifyWalkInVisitOutcome({ result: 'RECORDED', firstName: 'Kim', paymentState: 'FREE', priceMinor: 0, thankYou: null, leadId: ID }));
});

test('0414 service refuses before any database call and the tablet only sends the digest', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new WalkInKioskService(database);
  const human = { organizationId: ID, schoolId: ID, principalId: ID, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: ID, correlationId: ID, idempotencyKey: 'key-1' };
  await assert.rejects(() => service.saveSettings({ ...human, source: 'AI_AGENT' }, settings), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.startDevice({ ...human, actionRequestId: ID }, { label: 'Desk', hours: 2 }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.startDevice({ ...human, delegatedByPrincipalId: ID }, { label: 'Desk', hours: 2 }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.startDevice({ ...human, idempotencyKey: '' }, { label: 'Desk', hours: 2 }), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.saveSettings(human, { ...settings, offers: [] }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.overview(human), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.visit({ ...human, idempotencyKey: '' }, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.endDevice(human, 'nope', { expectedVersion: 1 }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(await service.terminal({ device: 'short' }), null);
  assert.equal(await service.terminal({ device: TOKEN, school: ID }), null, 'the tablet never names a school');
  assert.deepEqual(await service.submit({ device: TOKEN, visit: visit() }, 'short'), { result: 'INVALID' });
  assert.deepEqual(await service.submit({ device: TOKEN, visit: [] }, 'k'.repeat(20)), { result: 'INVALID' });
  assert.deepEqual(await service.submit({ device: TOKEN }, 'k'.repeat(20)), { result: 'INVALID' });
  assert.equal(calls, 0);

  const seen = [];
  const recording = new WalkInKioskService({ runPublicEventCall: async (statement, values) => { seen.push(values); return { result: 'CLOSED' }; } });
  assert.deepEqual(await recording.submit({ device: TOKEN, visit: visit() }, 'k'.repeat(20)), { result: 'CLOSED' });
  assert.equal(seen[0][0], walkInTokenDigest(TOKEN));
  assert.match(seen[0][0], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(seen).includes(TOKEN), 'the raw token never reaches the database');

  const failing = new WalkInKioskService({ runPublicEventCall: async () => { throw Object.assign(new Error('boom kim@example.test'), { code: 'XX000' }); } });
  assert.deepEqual(await failing.submit({ device: TOKEN, visit: visit() }, 'k'.repeat(20)), { result: 'UNAVAILABLE' });
  await assert.rejects(() => failing.terminal({ device: TOKEN }), (e) => JSON.stringify(e.response) === '{"result":"UNAVAILABLE"}');
});

test('0414 device start: token minted in the API, shown once, never on replay', async () => {
  const sent = [];
  const make = (replayed) => new WalkInKioskService({
    withTenantTransaction: async (_context, run) => run({ query: async (statement, values) => {
      if (!statement.startsWith('SELECT hon.start_walkin_kiosk_device')) return { rows: [] };
      sent.push(JSON.parse(values[1]));
      return { rows: [{ data: { replayed, receipt: { device: { deviceId: ID, label: 'Desk', startedAt: '2026-11-16T17:00:00.000Z', endsAt: '2026-11-16T19:00:00.000Z',
        endedAt: null, live: true, version: 1, startedBy: 'Desk Staff' } } } }] };
    } }),
  });
  const human = { organizationId: ID, schoolId: ID, principalId: ID, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: ID, correlationId: ID, idempotencyKey: 'key-1' };
  const first = await make(false).startDevice(human, { label: 'Desk', hours: 2 });
  assert.match(first.receipt.token, contracts.WALKIN_TOKEN);
  assert.equal(sent[0].tokenDigest, walkInTokenDigest(first.receipt.token));
  assert.ok(!JSON.stringify(sent[0]).includes(first.receipt.token));
  const again = await make(true).startDevice(human, { label: 'Desk', hours: 2 });
  assert.equal(again.receipt.token, null, 'a replay never shows a token');
  assert.notEqual(sent[1].tokenDigest, sent[0].tokenDigest, 'every call mints a fresh token');
});

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); }, on() {}, once() {}, emit() {} };
    middleware({ headers: {}, originalUrl: req.path, ...req }, res, () => resolve({ next: true, headers: res.headers }));
  });
}
test('0414 tablet transport: two POST paths, no session, same origin, JSON only', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';
  try {
    const mw = walkInKioskTransport();
    assert.equal((await run(mw, { method: 'GET', path: '/v1/other' })).next, true, 'other paths pass through untouched');
    const json = { 'content-type': 'application/json' };
    for (const req of [{ method: 'GET', path: '/v1/walk-in-kiosk/terminal' }, { method: 'POST', path: '/v1/walk-in-kiosk/devices', headers: json },
      { method: 'POST', path: '/v1/walk-in-kiosk/terminal', originalUrl: '/v1/walk-in-kiosk/terminal?school=1', headers: json },
      { method: 'POST', path: '/v1/walk-in-kiosk/terminal', headers: { ...json, cookie: 'hon_session=x' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/terminal', headers: { ...json, authorization: 'Bearer x' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { ...json, 'x-hon-school-id': ID } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { ...json, referer: 'https://app.example.test/kiosk' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { ...json, origin: 'https://evil.example.test' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { ...json, 'sec-fetch-site': 'cross-site' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { 'content-type': 'text/plain' } },
      { method: 'POST', path: '/v1/walk-in-kiosk/visits', headers: { ...json, 'content-encoding': 'gzip' } }]) {
      const out = await run(mw, req);
      assert.equal(out.status, 400, JSON.stringify(req)); assert.deepEqual(out.body, { result: 'INVALID' });
      assert.equal(out.headers['cache-control'], 'private, no-store');
    }
  } finally {
    if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous;
  }
});
