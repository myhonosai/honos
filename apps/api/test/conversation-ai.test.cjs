const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ConversationAiService, ConversationAiProgramService } = require('../dist/conversations/conversation-ai.service.js');
const { ConversationAiController, ConversationAiProgramHqController } = require('../dist/conversations/conversation-ai.controller.js');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const settings = (patch = {}) => ({ expectedVersion: 0, enabled: true, modes: { SMS: 'ASSIST', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: ['human', 'refund'],
  afterHoursText: null, smsMaxChars: 320, chatMaxChars: 800, languages: ['en', 'ko'], ...patch });
const refused = (fn) => { try { fn(); return false; } catch { return true; } };

test('0365 settings, upload, item and program inputs are closed', () => {
  assert.equal(contracts.validateConversationAiSettingsInput(settings()).expectedVersion, 0, 'first save uses version 0');
  for (const bad of [
    settings({ extra: 1 }), settings({ handoffWords: ['Human'] }), settings({ handoffWords: ['a', 'a'] }), settings({ handoffWords: Array.from({ length: 21 }, (_, i) => `w${i}`) }),
    settings({ languages: [] }), settings({ languages: ['fr'] }), settings({ languages: ['en', 'en'] }), settings({ smsMaxChars: 159 }), settings({ chatMaxChars: 1601 }),
    settings({ modes: { SMS: 'ASSIST', WEB_CHAT: 'OFF' } }), settings({ modes: { SMS: 'LIVE', WEB_CHAT: 'OFF', EMAIL: 'OFF' } }), settings({ afterHoursText: 'x'.repeat(321) }),
    settings({ expectedVersion: -1 }), settings({ enabled: 'yes' }),
  ]) assert.ok(refused(() => contracts.validateConversationAiSettingsInput(bad)), JSON.stringify(bad).slice(0, 80));

  const upload = { fileName: 'schedule.txt', mediaType: 'text/plain', contentBase64: Buffer.from('Mon 5pm kids').toString('base64') };
  assert.equal(contracts.validateConversationAiUploadInput(upload).fileName, 'schedule.txt');
  for (const bad of [{ ...upload, fileName: '../x' }, { ...upload, fileName: ' a' }, { ...upload, mediaType: 'text/html' }, { ...upload, contentBase64: 'abc' },
    { ...upload, contentBase64: 'a'.repeat(1_398_108) }, { ...upload, fileId: A }]) assert.ok(refused(() => contracts.validateConversationAiUploadInput(bad)));

  assert.equal(contracts.validateConversationAiItemInput({ kind: 'FAQ', title: 'Parking', question: 'Where do I park?', body: 'Behind the school.' }).kind, 'FAQ');
  assert.equal(contracts.validateConversationAiItemInput({ kind: 'COACHING', title: 'Price', question: 'How much?', body: 'Offer a free trial first.', staffNote: 'Never quote by text.' }).staffNote, 'Never quote by text.');
  for (const bad of [
    { kind: 'FAQ', title: 'No question', body: 'x' }, { kind: 'INSTRUCTION', title: 'Q', question: 'q', body: 'x' }, { kind: 'FAQ', title: 'N', question: 'q', body: 'x', staffNote: 'n' },
    { kind: 'INSTRUCTION', title: 'F', body: 'x', fileId: A }, { kind: 'INSTRUCTION', title: 'V', body: 'x', itemId: A }, { kind: 'SCRIPT', title: 'K', body: 'x' },
    { kind: 'INSTRUCTION', title: 'x'.repeat(121), body: 'x' }, { kind: 'INSTRUCTION', title: 'T', body: 'x', schoolId: B },
  ]) assert.ok(refused(() => contracts.validateConversationAiItemInput(bad)), JSON.stringify(bad));

  assert.equal(contracts.validateConversationAiItemStatusInput({ itemId: A, expectedVersion: 2, status: 'PAUSED' }).status, 'PAUSED');
  assert.ok(refused(() => contracts.validateConversationAiItemStatusInput({ itemId: A, expectedVersion: 0, status: 'PAUSED' })));
  assert.equal(contracts.validateConversationAiProgramInput({ status: 'TEST_MODE', expectedVersion: 1, reason: 'Start a staff test.' }).status, 'TEST_MODE');
  for (const bad of [{ status: 'TEST_MODE', expectedVersion: 1, reason: 'short' }, { status: 'ON', expectedVersion: 1, reason: 'Start a staff test.' },
    { status: 'LIVE', expectedVersion: 1, reason: 'Line\none two three' }, { status: 'LIVE', expectedVersion: 1, reason: 'Start a staff test.', organizationId: A }])
    assert.ok(refused(() => contracts.validateConversationAiProgramInput(bad)));
});

test('0365 receipts are verified: a file read must be the asked file and settings must say when AI was turned on', () => {
  const content = { fileId: A, fileName: 'a.txt', mediaType: 'text/plain', byteSize: 3, contentBase64: 'YWJj\n' };
  assert.equal(contracts.verifyConversationAiFileContent(content, A).contentBase64, 'YWJj', 'base64 line breaks are removed');
  assert.ok(refused(() => contracts.verifyConversationAiFileContent(content, B)));
  const stored = { enabled: true, modes: { SMS: 'ASSIST', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: [], afterHoursText: null, smsMaxChars: 320, chatMaxChars: 800,
    languages: ['en'], enabledAt: null, enabledBy: null, version: 1 };
  assert.ok(refused(() => contracts.verifyConversationAiSettings(stored)));
  assert.equal(contracts.verifyConversationAiSettings({ ...stored, enabledAt: '2026-11-15T00:00:00.000Z' }).enabled, true);
});

test('0365 service and controller refuse before any database call', async () => {
  let calls = 0;
  const database = { withTenantReadOnlyTransaction: async () => { calls++; }, withTenantTransaction: async () => { calls++; }, resolveAuthorizedScope: async () => { calls++; return null; } };
  const service = new ConversationAiService(database);
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const cmd = { ...staff, idempotencyKey: 'k1' };
  await assert.rejects(() => service.overview({ ...staff, source: 'AI_AGENT' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.overview({ ...staff, delegatedByPrincipalId: A }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.knowledge({ ...staff, idempotencyKey: 'k' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.file(staff, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.settings(staff, settings()), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.settings(cmd, settings({ schoolId: B })), (e) => e.response.code === 'VALIDATION_FAILED', 'the body never names a school');
  await assert.rejects(() => service.upload(cmd, { fileName: 'a.exe', mediaType: 'application/x-msdownload', contentBase64: 'AAAA' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.saveItem({ ...cmd, actionRequestId: A }, { kind: 'INSTRUCTION', title: 'T', body: 'x' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.setItemStatus(cmd, [1]), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);

  // Database refusals map to definite answers without echoing database text.
  const state = (message, code) => new ConversationAiService({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  await assert.rejects(() => state('CONVERSATION_AI_LIBRARY_FULL', '55000').saveItem(cmd, { kind: 'INSTRUCTION', title: 'T', body: 'x' }), (e) => e.getStatus() === 422 && e.response.code === 'CONVERSATION_AI_LIBRARY_FULL');
  await assert.rejects(() => state('CONVERSATION_AI_ITEM_NOT_FOUND', 'P0002').setItemStatus(cmd, { itemId: A, expectedVersion: 1, status: 'PAUSED' }), (e) => e.getStatus() === 404);
  await assert.rejects(() => state('CONVERSATION_VERSION_CONFLICT', '40001').settings(cmd, settings()), (e) => e.getStatus() === 409 && e.response.code === 'CONVERSATION_VERSION_CONFLICT');
  await assert.rejects(() => state('permission denied', '42501').settings(cmd, settings()), (e) => e.getStatus() === 403 && e.response.code === 'CONVERSATION_AI_FORBIDDEN');
  const failing = new ConversationAiService({ withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error('boom secret detail'), { code: 'XX000' }); } });
  await assert.rejects(() => failing.overview(staff), (e) => e.response.code === 'CONVERSATION_AI_UNAVAILABLE' && !JSON.stringify(e.response).includes('secret'));

  // Controller: commands need an Idempotency-Key, reads refuse one, and no query selectors are accepted.
  const controller = new ConversationAiController(database, service);
  const req = { honIdentity: { externalSubject: 'subject' }, originalUrl: '/x' };
  const res = { status: () => res };
  await assert.rejects(() => controller.overview(A, B, {}, 'k', req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.knowledge(A, B, { schoolId: B }, undefined, req), (e) => e.response.code === 'CONVERSATION_AI_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.file(A, B, A, {}, undefined, { ...req, originalUrl: '/x?download=1' }), (e) => e.response.code === 'CONVERSATION_AI_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.settings(A, B, {}, settings(), undefined, req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.upload(A, B, {}, {}, ' k', req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.saveItem(A, B, {}, {}, 'k'.repeat(201), req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.overview(A, B, {}, undefined, { originalUrl: '/x' }), (e) => e.response.code === 'IDENTITY_REQUIRED');
  assert.equal(calls, 0);
  // A scope resolved for another school is refused; so is no scope at all.
  await assert.rejects(() => controller.overview(A, B, {}, undefined, req), (e) => e.response.code === 'CONVERSATION_AI_FORBIDDEN');
  const scoped = new ConversationAiController({ resolveAuthorizedScope: async () => ({ organizationId: A, schoolId: C, principalId: C }) }, service);
  await assert.rejects(() => scoped.setItemStatus(A, B, {}, {}, 'k', req, res), (e) => e.response.code === 'CONVERSATION_AI_FORBIDDEN');
});

test('0365 HQ program switch: inputs and keys checked before the database, the subject comes only from the session', async () => {
  const seen = [];
  const billing = { call: async (name, args) => { seen.push([name, args]); return { status: 'TEST_MODE', version: 2, changedAt: '2026-11-15T00:00:00.000Z', replayed: false }; } };
  const program = new ConversationAiProgramService(billing);
  const body = { status: 'TEST_MODE', expectedVersion: 1, reason: 'Start a staff test.' };
  await assert.rejects(() => program.command('subject', body, 'not-a-uuid'), (e) => e.response.code === 'INVALID_SAAS_INPUT');
  await assert.rejects(() => program.command('subject', { ...body, status: 'ON' }, A), (e) => e.response.code === 'INVALID_SAAS_INPUT');
  assert.equal(seen.length, 0);
  await program.command('subject', body, A);
  assert.deepEqual(seen, [['commandConversationAiProgram', ['subject', JSON.stringify(body), A]]]);
  const hq = new ConversationAiProgramHqController(program);
  await assert.rejects(() => hq.read({}), (e) => e.response.code === 'SAAS_FORBIDDEN');
  await assert.rejects(() => hq.command({}, body, A), (e) => e.response.code === 'SAAS_FORBIDDEN');
  assert.equal(seen.length, 1);
  assert.equal(contracts.SAAS_COMMANDS.conversationAiProgram, 'conversation-ai-program');
});
