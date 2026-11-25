const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { MAYA_CHECK_IN_TEXT_PROFILE, MAYA_CHECK_IN_SYSTEM_PROMPT } = require('../dist/maya-check-in/maya-check-in-provider.js');
const { MAYA_RENEWAL_SYSTEM_PROMPT } = require('../dist/maya-renewal/maya-renewal-provider.js');
const { MayaCheckInService } = require('../dist/maya-check-in/maya-check-in.service.js');
const { validateMayaCheckInBrief, validateMayaCheckInProposal, validateMayaCheckInApproval, mayaCheckInProblems, verifyMayaCheckInView, verifyMayaCheckInList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { membershipId: id, channel: 'SMS', note: '' };
const sms = { summary: 'Attendance dropped after the class time moved.', message: 'Hi [First name], we miss you on the mat!\nIs the new class time working for you?', subject: '' };
const email = { ...sms, subject: 'We miss you at the dojo' };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief: { channel: 'SMS', note: '' }, schoolName: 'Test Dojo', localToday: '2026-11-22', student: {} }), inputBudget: 6000, outputBudget: 2000, maxCostMicrounits: 60000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 200, cost: 0.0006 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, MAYA_CHECK_IN_TEXT_PROFILE);
const approval = { recipient: 'STUDENT', message: sms.message, subject: '', sendAt: null, approvalMethod: 'BUTTON', voiceTurnId: null };

test('the check-in runtime sends one fixed request with its own prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; const body = JSON.parse(o.body); assert.equal(body.max_tokens, 2000); assert.equal(body.temperature, 0.4); assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, MAYA_CHECK_IN_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, MAYA_RENEWAL_SYSTEM_PROMPT);
    return response(ok(JSON.stringify(sms)));
  });
  assert.deepEqual(await rt.generate(input), { proposal: sms, inputTokens: 900, outputTokens: 200, providerCostMicrounits: 600 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 7000 }, { outputBudget: 2500 }, { maxCostMicrounits: 90000 }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND'); assert.equal(sent, 0);
  }
});

test('the prompt forbids money promises, links, invented facts and talk of risk scores', () => {
  assert.match(MAYA_CHECK_IN_SYSTEM_PROMPT, /never offer a discount, a free month or a refund/); assert.match(MAYA_CHECK_IN_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
  assert.match(MAYA_CHECK_IN_SYSTEM_PROMPT, /Never mention scores, risk, levels, tracking, data or money/); assert.match(MAYA_CHECK_IN_SYSTEM_PROMPT, /never invent a name/);
  assert(Buffer.byteLength(MAYA_CHECK_IN_SYSTEM_PROMPT) < 2500);
});

test('the brief, the draft and the approval are closed and channel-specific', () => {
  assert.deepEqual(validateMayaCheckInBrief(brief), brief);
  for (const bad of [{}, { ...brief, channel: 'PUSH' }, { ...brief, membershipId: 'x' }, { ...brief, note: ' padded' }, { ...brief, note: 'see www.example.test' }, { ...brief, extra: 1 }]) assert.throws(() => validateMayaCheckInBrief(bad), JSON.stringify(bad));
  assert.deepEqual(validateMayaCheckInProposal(sms, 'SMS'), sms); assert.deepEqual(validateMayaCheckInProposal(email, 'EMAIL'), email);
  for (const [bad, ch] of [[email, 'SMS'], [sms, 'EMAIL'], [{ ...sms, message: 'x'.repeat(481) }, 'SMS'], [{ ...sms, message: 'Visit https://example.test' }, 'SMS'],
    [{ ...sms, message: 'a\n\n\nb' }, 'SMS'], [{ ...sms, summary: 'two\nlines' }, 'SMS'], [{ ...sms, extra: 1 }, 'SMS'], [{ ...email, subject: 'x'.repeat(121) }, 'EMAIL']]) {
    assert.throws(() => validateMayaCheckInProposal(bad, ch), JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(validateMayaCheckInProposal({ ...email, message: 'x'.repeat(2000) }, 'EMAIL').message.length, 2000);
  assert.deepEqual(validateMayaCheckInApproval(approval, 'SMS'), approval);
  assert.equal(validateMayaCheckInApproval({ ...approval, approvalMethod: 'VOICE', voiceTurnId: key }, 'SMS').voiceTurnId, key);
  for (const bad of [{ ...approval, approvalMethod: 'VOICE' }, { ...approval, voiceTurnId: key }, { ...approval, recipient: 'ANYONE' }, { ...approval, subject: 'x' },
    { ...approval, sendAt: 'tomorrow' }, { ...approval, message: '' }, { ...approval, extra: 1 }]) assert.throws(() => validateMayaCheckInApproval(bad, 'SMS'), JSON.stringify(bad).slice(0, 100));
  assert.throws(() => validateMayaCheckInApproval(approval, 'EMAIL'), 'an email needs a subject');
});

test('a draft that offers money is a problem', () => {
  assert.deepEqual(mayaCheckInProblems(sms), []);
  for (const message of ['Come back for a free month!', 'Get 20% off next term', 'We can offer a discount']) assert.equal(mayaCheckInProblems({ ...sms, message }).length, 1, message);
});

test('a view shows a send exactly once approved', () => {
  const T = '2026-11-22T00:00:00.000Z';
  const base = { id, status: 'PENDING', reason: null, brief, studentName: 'Sample Student', level: 'HIGH', summary: null, message: null, subject: null, recipients: [], send: null, problems: [], createdAt: T, updatedAt: T };
  assert.equal(verifyMayaCheckInView(base).message, null);
  const send = { recipient: 'STUDENT', channel: 'SMS', scheduledAt: T, approvedAt: T, approvalMethod: 'VOICE', edited: true, cancelled: false, delivery: null };
  assert.equal(verifyMayaCheckInView({ ...base, status: 'APPLIED', ...sms, send }).send.approvalMethod, 'VOICE');
  assert.throws(() => verifyMayaCheckInView({ ...base, status: 'RESULT_RECORDED', ...sms, send }));
  assert.throws(() => verifyMayaCheckInView({ ...base, status: 'APPLIED', ...sms }));
  assert.throws(() => verifyMayaCheckInView({ ...base, status: 'RESULT_REJECTED', ...sms }));
  assert.throws(() => verifyMayaCheckInView({ ...base, recipients: [{ recipient: 'STUDENT', name: 'x', reachable: 'yes' }] }));
  assert.throws(() => verifyMayaCheckInView({ ...base, extra: 1 }));
  assert.throws(() => verifyMayaCheckInList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask, approve, cancel or dismiss', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new MayaCheckInService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.approve({ ...ctx, ...patch }, id, approval), e => e.getStatus?.() === 403);
    await assert.rejects(svc.cancel({ ...ctx, ...patch }, id), e => e.getStatus?.() === 403);
    await assert.rejects(svc.dismiss({ ...ctx, ...patch }, id), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'x\n' }, brief), e => e.getStatus?.() === 409);
  await assert.rejects(svc.approve({ ...ctx, idempotencyKey: 'k'.repeat(161) }, id, approval), e => e.getStatus?.() === 409);
  await assert.rejects(svc.approve({ ...ctx, idempotencyKey: '' }, id, approval), e => e.getStatus?.() === 409);
  await assert.rejects(svc.request(ctx, { ...brief, channel: 'PUSH' }), e => e.getStatus?.() === 400 && e.getResponse().code === 'MAYA_CHECK_IN_INVALID');
  await assert.rejects(svc.approve(ctx, 'not-a-uuid', approval), e => e.getStatus?.() === 400);
  await assert.rejects(svc.cancel(ctx, 'not-a-uuid'), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('database refusals map to plain answers that say nothing was sent', async () => {
  const fail = (code, message) => ({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const cases = [['22023', 'MAYA_CHECK_IN_NO_CONSENT', 409, 'MAYA_CHECK_IN_NO_CONSENT'], ['22023', 'MAYA_CHECK_IN_NO_ADDRESS', 409, 'MAYA_CHECK_IN_NO_ADDRESS'],
    ['40001', 'MAYA_CHECK_IN_DAILY_CAP', 409, 'MAYA_CHECK_IN_DAILY_CAP'], ['40001', 'MAYA_CHECK_IN_NOT_CANCELLABLE', 409, 'MAYA_CHECK_IN_NOT_CANCELLABLE'],
    ['P0002', 'MAYA_CHECK_IN_NOT_AT_RISK', 404, 'MAYA_CHECK_IN_NOT_AT_RISK'], ['42501', 'MAYA_AT_RISK_FORBIDDEN', 403, 'MAYA_CHECK_IN_FORBIDDEN'],
    ['42501', 'AI_SCHOOL_CEILING_REACHED', 403, 'MAYA_CHECK_IN_SPEND_STOPPED'], ['40001', 'AI_TEXT_PROPOSAL_NOT_OPEN', 409, 'MAYA_CHECK_IN_NOT_OPEN'], ['XX000', 'boom', 503, 'MAYA_CHECK_IN_UNAVAILABLE']];
  for (const [code, message, status, out] of cases) {
    const svc = new MayaCheckInService(fail(code, message), {}, { readiness: () => 'READY' });
    await assert.rejects(svc.cancel(ctx, id), e => e.getStatus?.() === status && e.getResponse().code === out, message);
  }
});

test('the live module gives the check-in its own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: MAYA_CHECK_IN_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, MAYA_CHECK_IN_TEXT_PROFILE\)/);
  assert.match(module, /MayaCheckInController,/); assert.match(module, /MayaCheckInService,/);
  for (const file of ['src/maya-check-in/maya-check-in.service.ts', 'src/maya-check-in/maya-check-in.controller.ts', 'src/maya-check-in/maya-check-in-provider.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(src)); assert(!/invokeLLM|generateText|@openrouter/.test(src));
  }
});
