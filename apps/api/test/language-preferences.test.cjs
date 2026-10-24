const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { LanguageCommandGuard, LanguagePreferencesService, LanguageReadGuard, MyLanguagePreferenceController, SchoolLanguageDefaultController } =
  require('../dist/preferences/language-preferences.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-10-19T00:00:00.000Z';
const school = (patch = {}) => ({ schoolId: U(), organizationId: U(), defaultLanguage: 'es', source: 'SCHOOL', version: 1, updatedAt: T, ...patch });

test('contracts: closed inputs and the precedence rule', () => {
  assert.deepEqual(contracts.validateLanguageUpdateInput({ language: 'ko', expectedVersion: 0 }), { language: 'ko', expectedVersion: 0 });
  for (const bad of [{ language: 'fr', expectedVersion: 0 }, { language: 'ko' }, { language: 'ko', expectedVersion: -1 }, { language: 'ko', expectedVersion: 0, userId: U() }, null])
    assert.throws(() => contracts.validateLanguageUpdateInput(bad), JSON.stringify(bad));
  const id = U();
  assert.deepEqual(contracts.validateMyLanguageQuery({}), { schoolId: null });
  assert.deepEqual(contracts.validateMyLanguageQuery({ schoolId: id.toUpperCase() }), { schoolId: id });
  for (const bad of [{ schoolId: 'x' }, { userId: id }, { schoolId: [id] }]) assert.throws(() => contracts.validateMyLanguageQuery(bad));
  const view = (preference, schoolDefault, effective) => ({ preference, schoolDefault, effective, supportedLanguages: ['en','ko','es'] });
  const pref = { language: 'ko', version: 1, updatedAt: T };
  assert.ok(contracts.validateMyLanguagePreferenceView(view(pref, school(), { language: 'ko', source: 'PERSONAL' })));
  assert.ok(contracts.validateMyLanguagePreferenceView(view(null, school(), { language: 'es', source: 'SCHOOL_DEFAULT' })));
  assert.ok(contracts.validateMyLanguagePreferenceView(view(null, null, { language: 'en', source: 'SYSTEM_DEFAULT' })));
  // A view that breaks personal > school default > English is drift.
  assert.throws(() => contracts.validateMyLanguagePreferenceView(view(pref, school(), { language: 'es', source: 'SCHOOL_DEFAULT' })));
  assert.throws(() => contracts.validateMyLanguagePreferenceView(view(null, school(), { language: 'en', source: 'SYSTEM_DEFAULT' })));
  assert.throws(() => contracts.validateMyLanguagePreferenceView(view(null, school({ source: 'SYSTEM_DEFAULT', version: 0, updatedAt: null, defaultLanguage: 'ko' }), { language: 'ko', source: 'SCHOOL_DEFAULT' })));
  assert.throws(() => contracts.validateMyLanguagePreferenceView({ ...view(null, null, { language: 'en', source: 'SYSTEM_DEFAULT' }), userId: U() }));
  assert.equal(contracts.HON_DEFAULT_LANGUAGE, 'en');
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

test('HTTP: routes are bound to the verified subject; commands need the exact human-command header', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const callLanguage = async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readMine') return { preference: null, schoolDefault: null, effective: { language: 'en', source: 'SYSTEM_DEFAULT' }, supportedLanguages: ['en','ko','es'] };
    if (operation === 'updateMine') return { preference: { language: JSON.parse(params[1]).language, version: 1, updatedAt: T }, replayed: false };
    if (operation === 'readSchool') return { ...school({ schoolId: params[1] }), canManage: false, supportedLanguages: ['en','ko','es'] };
    const e = new Error('LANGUAGE_FORBIDDEN'); e.code = '42501'; throw e;
  };
  const module = await Test.createTestingModule({ controllers: [MyLanguagePreferenceController, SchoolLanguageDefaultController],
    providers: [LanguagePreferencesService, LanguageReadGuard, LanguageCommandGuard, { provide: RuntimeDatabaseService, useValue: { callLanguage } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`;
  try {
    const read = await send(`${base}/me/language-preference`);
    assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    const s = U();
    assert.equal((await send(`${base}/me/language-preference?schoolId=${s}`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readMine', ['verified-human', s]]);
    const up = await send(`${base}/me/language-preference`, { method: 'POST', headers: human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), body: JSON.stringify({ language: 'ko', expectedVersion: 0 }) });
    assert.equal(up.status, 200, up.body);
    assert.deepEqual([calls.at(-1)[0], calls.at(-1)[1][0], JSON.parse(calls.at(-1)[1][1])], ['updateMine', 'verified-human', { language: 'ko', expectedVersion: 0 }]);
    assert.equal((await send(`${base}/schools/${s}/language-default`)).status, 200);
    assert.equal((await send(`${base}/schools/${s}/language-default`, { method: 'POST', headers: human(contracts.LANGUAGE_COMMANDS.updateSchoolDefault), body: JSON.stringify({ language: 'es', expectedVersion: 0 }) })).status, 403);
    const n = calls.length;
    for (const [path, opts, status] of [
      ['me/language-preference?userId=x', {}, 400],
      ['me/language-preference?schoolId=nope', {}, 400],
      [`schools/${s}/language-default?x=1`, {}, 400],
      ['schools/not-a-uuid/language-default', {}, 400],
      ['me/language-preference', { method: 'POST', headers: human(contracts.LANGUAGE_COMMANDS.updateSchoolDefault), body: '{"language":"ko","expectedVersion":0}' }, 403],
      ['me/language-preference', { method: 'POST', headers: { ...human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), origin: 'https://evil.example' }, body: '{"language":"ko","expectedVersion":0}' }, 403],
      ['me/language-preference', { method: 'POST', headers: { ...human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), 'x-hon-user-id': U() }, body: '{"language":"ko","expectedVersion":0}' }, 403],
      ['me/language-preference', { method: 'POST', headers: human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), body: '{"language":"fr","expectedVersion":0}' }, 400],
      ['me/language-preference', { method: 'POST', headers: { ...human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), 'idempotency-key': 'x' }, body: '{"language":"ko","expectedVersion":0}' }, 400],
      ['me/language-preference?schoolId=' + s, { method: 'POST', headers: human(contracts.LANGUAGE_COMMANDS.updateMyLanguage), body: '{"language":"ko","expectedVersion":0}' }, 400],
      [`users/${U()}/language-preference`, {}, 404],
    ]) assert.equal((await send(`${base}/${path}`, opts)).status, status, path + JSON.stringify(opts.headers ?? {}));
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
