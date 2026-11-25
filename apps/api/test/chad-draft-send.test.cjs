const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { validateHumanActionDecision } = require('@hon/contracts');
const { ChadFollowUpAssistantService } = require('../dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');

// 0647 (P7): approving a Chad draft with a send plan queues one message; how it was approved is recorded.
const id = '11111111-1111-4111-8111-111111111111', turn = '33333333-3333-4333-8333-333333333333';
const binding = { actionRequestId: id, actionCode: 'crm.follow_up_draft.propose', requestedByPrincipalId: id, payloadHash: 'a'.repeat(64), policyVersion: 1, approvalExpiresAt: '2026-11-23T00:00:00.000Z', effectiveAuthorityMode: 'CONFIRM' };
const ctx = (patch = {}) => ({ organizationId: id, schoolId: id, principalId: id, externalSubject: 'unit', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: 'plan-key-1', ...patch });

test('a decision may say how it was approved: BUTTON by default, VOICE only with a voice turn id and only to approve', () => {
  validateHumanActionDecision({ decision: 'APPROVED', binding });
  validateHumanActionDecision({ decision: 'APPROVED', binding, approvalMethod: 'BUTTON' });
  validateHumanActionDecision({ decision: 'APPROVED', binding, approvalMethod: 'VOICE', voiceTurnId: turn });
  validateHumanActionDecision({ decision: 'DENIED', binding, approvalMethod: 'BUTTON' });
  for (const bad of [{ approvalMethod: 'VOICE' }, { approvalMethod: 'VOICE', voiceTurnId: 'nope' }, { approvalMethod: 'BUTTON', voiceTurnId: turn }, { voiceTurnId: turn },
    { approvalMethod: 'PHONE' }, { decision: 'DENIED', approvalMethod: 'VOICE', voiceTurnId: turn }, { approvalMethod: 'VOICE', voiceTurnId: turn, extra: true }]) {
    assert.throws(() => validateHumanActionDecision({ decision: 'APPROVED', binding, ...bad }), /INVALID_ACTION_REVIEW_BINDING/, JSON.stringify(bad));
  }
});

test('the action engine passes the approval method to the Chad transition for that decision only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/action/action-engine.service.ts'), 'utf8');
  const at = src.indexOf("set_config('app.hon_approval_method'");
  assert.ok(at > 0 && at < src.indexOf('SELECT hon.transition_chad_follow_up_draft'), 'method is set just before the transition');
  assert.match(src.slice(at, at + 200), /set_config\('app\.hon_voice_turn_id',\$2,true\)/, 'transaction-local settings only');
});

test('the send plan is refused before the database without a request key or with any other shape', async () => {
  let queries = 0;
  const db = { withTenantTransaction: async () => { queries++; throw new Error('unexpected'); } };
  const svc = new ChadFollowUpAssistantService(db, {}, {}, { readiness: () => 'READY' });
  await assert.rejects(svc.setSendPlan(ctx({ idempotencyKey: '' }), id, { channel: 'EMAIL', sendAt: null }), (e) => e.getResponse().code === 'IDEMPOTENCY_KEY_REQUIRED');
  for (const bad of [null, [], { channel: 'EMAIL' }, { channel: 'EMAIL', sendAt: null, to: 'x' }]) {
    await assert.rejects(svc.setSendPlan(ctx(), id, bad), (e) => e.getResponse().code === 'CHAD_SEND_PLAN_INVALID', JSON.stringify(bad));
  }
  await assert.rejects(svc.setSendPlan(ctx(), 'not-a-uuid', { channel: 'EMAIL', sendAt: null }));
  assert.equal(queries, 0);
});

test('database refusals become plain answers the person can act on', async () => {
  const fail = (message, code) => ({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const cases = [['CHAD_SEND_PLAN_NO_CONSENT', '22023', 409], ['CHAD_SEND_PLAN_NO_ADDRESS', '22023', 409], ['CHAD_SEND_PLAN_CLOSED', '40001', 409],
    ['CHAD_SEND_PLAN_INVALID', '22023', 400], ['CHAD_SEND_NOT_CANCELLABLE', '40001', 409], ['CHAD_FOLLOW_UP_NOT_FOUND', 'P0002', 404], ['IDEMPOTENCY_KEY_REUSED', '23505', 409]];
  for (const [message, code, status] of cases) {
    const svc = new ChadFollowUpAssistantService(fail(message, code), {}, {}, { readiness: () => 'READY' });
    await assert.rejects(svc.setSendPlan(ctx(), id, { channel: 'EMAIL', sendAt: null }), (e) => e.getStatus() === status && (e.getResponse().code === message || message === 'CHAD_FOLLOW_UP_NOT_FOUND'), message);
  }
});
