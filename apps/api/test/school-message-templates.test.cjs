const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { SchoolMessageTemplatesService } = require('../dist/communication/school-message-templates.service.js');

// 0586 (TE2) school text and email templates: closed inputs, verified answers, error mapping, refusals before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444', N = '55555555-5555-4555-8555-555555555555';
const T = '2026-11-20T17:00:00.000Z';
const refused = (fn) => { try { fn(); return false; } catch { return true; } };
const input = (patch = {}) => ({ templateId: null, expectedVersion: 0, channel: 'SMS', name: 'Reminder', subject: null, body: 'Hi {{first_name}}', ...patch });
const tpl = (patch = {}) => ({ templateId: M, channel: 'SMS', name: 'Reminder', subject: null, body: 'Hi {{first_name}}', status: 'ACTIVE', version: 1, createdAt: T, updatedAt: T, ...patch });
const staff = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: 'key-1' };

test('save input is closed: names, subjects, bodies, merge tags, versions', () => {
  assert.deepEqual(contracts.validateSaveSchoolTemplateInput(input()), input());
  assert.equal(contracts.validateSaveSchoolTemplateInput(input({ channel: 'EMAIL', subject: 'Hello {{ first_name }}', body: 'Line 1\n\n🥋👨‍👩‍👧 {{school_name}}' })).channel, 'EMAIL');
  assert.equal(contracts.validateSaveSchoolTemplateInput(input({ body: '🥋'.repeat(1000) })).body.length, 2000, 'emoji count once, as in the database');
  for (const bad of [input({ name: '' }), input({ name: ' x' }), input({ name: 'x'.repeat(81) }), input({ name: 'a‮b' }), input({ body: ' \n' }), input({ body: 'x'.repeat(1001) }),
    input({ body: 'a\tb' }), input({ body: 'Hi {{phone}}' }), input({ body: '{{First_Name}}' }), input({ subject: 'x' }), input({ channel: 'EMAIL' }),
    input({ channel: 'EMAIL', subject: 'x'.repeat(151) }), input({ channel: 'EMAIL', subject: 'S', body: 'x'.repeat(3501) }), input({ expectedVersion: 1 }),
    input({ templateId: M }), input({ templateId: M, expectedVersion: 1.5 }), input({ channel: 'PUSH' }), { ...input(), schoolId: B }])
    assert.ok(refused(() => contracts.validateSaveSchoolTemplateInput(bad)), JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(contracts.schoolTemplateUnknownTags('Hi {{first_name}} {{ phone }} {{Last_Name}}'), ['{{ phone }}', '{{Last_Name}}']);
  assert.deepEqual(contracts.validateSetSchoolTemplateStatusInput({ templateId: M, expectedVersion: 2, status: 'ARCHIVED' }), { templateId: M, expectedVersion: 2, status: 'ARCHIVED' });
  for (const bad of [{ templateId: M, expectedVersion: 0, status: 'ARCHIVED' }, { templateId: M, expectedVersion: 1, status: 'DELETED' }, { templateId: 'x', expectedVersion: 1, status: 'ACTIVE' }])
    assert.ok(refused(() => contracts.validateSetSchoolTemplateStatusInput(bad)), JSON.stringify(bad));
  assert.deepEqual(contracts.validateSchoolTemplatesQuery({ channel: 'EMAIL', status: 'ARCHIVED' }), { channel: 'EMAIL', status: 'ARCHIVED' });
  assert.ok(refused(() => contracts.validateSchoolTemplatesQuery({ limit: '5' })));
});

test('answers are verified: shape, channel and status filters, duplicates, receipt version and identity', () => {
  assert.equal(contracts.verifySchoolTemplateList({ templates: [tpl(), tpl({ templateId: N, channel: 'EMAIL', subject: 'S' })] }).templates.length, 2);
  assert.ok(refused(() => contracts.verifySchoolTemplateList({ templates: [tpl(), tpl()] })), 'duplicate');
  assert.ok(refused(() => contracts.verifySchoolTemplateList({ templates: [tpl()] }, { channel: 'EMAIL' })), 'channel filter');
  assert.ok(refused(() => contracts.verifySchoolTemplateList({ templates: [tpl()] }, { status: 'ARCHIVED' })), 'status filter');
  for (const bad of [tpl({ subject: 'S' }), tpl({ channel: 'EMAIL' }), tpl({ version: 0 }), tpl({ updatedAt: '2026-11-19T00:00:00.000Z' }), tpl({ body: '{{x}}' }), tpl({ extra: 1 })])
    assert.ok(refused(() => contracts.verifySchoolTemplate(bad)), JSON.stringify(bad).slice(0, 80));
  assert.equal(contracts.verifySchoolTemplateReceipt({ template: tpl({ version: 2 }), replayed: false }, { version: 2, templateId: M }).template.version, 2);
  assert.ok(refused(() => contracts.verifySchoolTemplateReceipt({ template: tpl(), replayed: false }, { version: 2 })), 'wrong version');
  assert.ok(refused(() => contracts.verifySchoolTemplateReceipt({ template: tpl({ version: 2 }), replayed: false }, { version: 2, templateId: N })), 'another template');
  assert.ok(refused(() => contracts.verifySchoolTemplateReceipt({ template: tpl(), replayed: 'no' }, { version: 1 })));
});

test('the service refuses before any database call and maps database errors exactly', async () => {
  let calls = 0;
  const idle = new SchoolMessageTemplatesService({ withTenantTransaction: async () => { calls++; }, withTenantReadOnlyTransaction: async () => { calls++; } });
  await assert.rejects(idle.save({ ...staff, source: 'AI_AGENT' }, input()), e => e.getStatus() === 403);
  await assert.rejects(idle.save({ ...staff, actionRequestId: A }, input()), e => e.getStatus() === 403);
  await assert.rejects(idle.save({ ...staff, idempotencyKey: '' }, input()), e => e.getResponse().code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(idle.list(staff, {}), e => e.getResponse().code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(idle.save(staff, input({ body: '{{phone}}' })), e => e.getStatus() === 400);
  await assert.rejects(idle.setStatus(staff, { templateId: M, expectedVersion: 1, status: 'GONE' }), e => e.getStatus() === 400);
  assert.equal(calls, 0);
  const failing = (code, message) => new SchoolMessageTemplatesService({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  for (const [code, message, status, out] of [['23505', 'MESSAGE_TEMPLATE_NAME_TAKEN', 409, 'MESSAGE_TEMPLATE_NAME_TAKEN'], ['23505', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['54000', 'MESSAGE_TEMPLATE_LIMIT', 413, 'MESSAGE_TEMPLATE_LIMIT'], ['55000', 'MESSAGE_TEMPLATE_ARCHIVED', 409, 'MESSAGE_TEMPLATE_ARCHIVED'], ['40001', 'VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['P0002', 'MESSAGE_TEMPLATE_NOT_FOUND', 404, 'MESSAGE_TEMPLATE_NOT_FOUND'], ['42501', 'anything', 403, 'MESSAGE_TEMPLATE_FORBIDDEN'], ['XX000', 'boom', 503, 'MESSAGE_TEMPLATE_UNAVAILABLE'],
    ['23505', 'school_message_templates_active_name', 409, 'MESSAGE_TEMPLATE_CONFLICT']])
    await assert.rejects(failing(code, message).save(staff, input()), e => e.getStatus() === status && e.getResponse().code === out, message);
  // An answer for a different template or version is unavailable, never success.
  const wrong = new SchoolMessageTemplatesService({ withTenantTransaction: async (_c, fn) => fn({ query: async (sql) => (sql.startsWith('SELECT hon.') ? { rows: [{ data: { template: tpl({ templateId: N, version: 2 }), replayed: false } }] } : { rows: [] }) }) });
  await assert.rejects(wrong.setStatus(staff, { templateId: M, expectedVersion: 1, status: 'ACTIVE' }), e => e.getStatus() === 503);
  const right = new SchoolMessageTemplatesService({ withTenantTransaction: async (_c, fn) => fn({ query: async (sql, args) => {
    if (sql.startsWith('SELECT hon.save')) { assert.deepEqual(JSON.parse(args[1]), input()); assert.equal(args[2], 'key-1'); return { rows: [{ data: { template: tpl(), replayed: false } }] }; }
    return { rows: [] }; } }) });
  assert.equal((await right.save(staff, input())).template.templateId, M);
});
