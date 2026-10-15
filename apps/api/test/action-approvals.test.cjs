const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const { ActionEngineService } = require('../dist/action/action-engine.service.js');
const { ActionApprovalWorkbenchController } = require('../dist/action/action-review.controller.js');
const { ActionReviewHumanUiGuard } = require('../dist/action/action-decision.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { actionReviewFingerprint } = require('@hon/contracts');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, externalSubject: 'verified-action-reviewer', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const hash = (value) => createHash('sha256').update(actionReviewFingerprint(value)).digest('hex');
const payload = { pipelineId: randomUUID(), pipelineStageId: randomUUID(), primaryContact: { givenName: 'Exact', familyName: 'Proposal', email: 'exact@example.test' } };
const proposal = (patch = {}) => ({ id: randomUUID(), action_code: 'crm.lead.create', normalized_payload: payload, payload_hash: hash(payload), required_permission: 'crm.lead.create', requested_by_principal_id: randomUUID(), delegated_by_principal_id: null, effective_authority_mode: 'CONFIRM', policy_version: 1, status: 'APPROVED', approval_expires_at: new Date(Date.now() + 60_000), created_at: new Date(), ...patch });
const binding = (row) => ({ actionRequestId: row.id, actionCode: row.action_code, requestedByPrincipalId: row.requested_by_principal_id, payloadHash: row.payload_hash, policyVersion: row.policy_version, approvalExpiresAt: row.approval_expires_at.toISOString(), effectiveAuthorityMode: row.effective_authority_mode });
const denied = (work, status) => assert.rejects(work, (error) => error.getStatus?.() === status);

test('decision replay rechecks fixed reviewer authority after an idempotency lock wait', async () => {
  const row = proposal(); const c = context(); let fingerprint = ''; let replayLocked = false; let reviewerChecks = 0; let recheckedAfterReplay = false;
  const receipt = { actionRequestId: row.id, status: 'APPROVED', actionCode: row.action_code, reviewedAt: new Date().toISOString(), payloadHash: row.payload_hash, policyVersion: row.policy_version, executionTriggered: false };
  const client = { query: async (sql, args = []) => {
    if (sql.includes('FROM hon.action_requests') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
    if (sql.includes("set_config('app.hon_source'" ) || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (sql.includes('require_human_action_review')) { reviewerChecks += 1; if (replayLocked) recheckedAfterReplay = true; return { rows: [], rowCount: 0 }; }
    if (sql.includes('FROM hon.action_policies')) return { rows: [{ authority_mode: 'CONFIRM', policy_version: 1 }], rowCount: 1 };
    if (sql.includes('FROM hon.organization_entitlements')) return { rows: [{ tier: 'ESSENTIAL' }], rowCount: 1 };
    if (sql.includes('principal_has_school_permission')) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.includes('crm_lead_target_is_current')) return { rows: [{ current: true }], rowCount: 1 };
    if (sql.includes('INSERT INTO hon.idempotency_records')) { fingerprint = args[4]; return { rows: [], rowCount: 0 }; }
    if (sql.includes('SELECT request_fingerprint,status,response_body FROM hon.idempotency_records')) { replayLocked = true; return { rows: [{ request_fingerprint: fingerprint, status: 'COMPLETED', response_body: receipt }], rowCount: 1 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const service = new ActionEngineService({ withTenantTransaction: async (_context, work) => work(client) });
  assert.deepEqual(await service.decide(c, { actionRequestId: row.id, decision: 'APPROVED', binding: binding(row), reason: 'Exact human review' }), receipt);
  assert.equal(reviewerChecks, 2, 'reviewer check runs before and after the replay lock');
  assert.equal(recheckedAfterReplay, true, 'receipt cannot be returned from a replay without a second current reviewer check');
});

test('exact DENIED receipt replays after resolution and expiry without target eligibility or effects', async () => {
  const row = proposal({ action_code: 'marketing.draft.save', required_permission: 'marketing.assistant.use', status: 'DENIED', approval_expires_at: new Date(Date.now() - 60_000) });
  const c = context(); const input = { actionRequestId: row.id, decision: 'DENIED', binding: binding(row), reason: 'Exact denial' };
  const receipt = { actionRequestId: row.id, status: 'DENIED', actionCode: row.action_code, reviewedAt: new Date(Date.now() - 120_000).toISOString(), payloadHash: row.payload_hash, policyVersion: row.policy_version, executionTriggered: false };
  let reviewerChecks = 0; let receiptLocked = false;
  const client = { query: async (sql, args = []) => {
    if (sql.includes('FROM hon.action_requests') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
    if (sql.includes("set_config('app.hon_source'") || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (sql.includes('require_human_action_review')) { reviewerChecks++; if (reviewerChecks === 2) assert.equal(receiptLocked, true); assert.deepEqual(args, [c.externalSubject, row.requested_by_principal_id]); return { rows: [], rowCount: 0 }; }
    if (sql.includes('INSERT INTO hon.idempotency_records')) { assert.deepEqual(args, [c.organizationId, c.schoolId, c.principalId, c.idempotencyKey, hash({ operation: 'action.request.decide', ...input })]); return { rows: [], rowCount: 0 }; }
    if (sql.includes('SELECT request_fingerprint,status,response_body FROM hon.idempotency_records')) { receiptLocked = true; assert.deepEqual(args, [c.organizationId, c.schoolId, c.principalId, c.idempotencyKey]); return { rows: [{ request_fingerprint: hash({ operation: 'action.request.decide', ...input }), status: 'COMPLETED', response_body: receipt }], rowCount: 1 }; }
    throw new Error(`Replay must not revalidate target/state or write effects: ${sql}`);
  }};
  const service = new ActionEngineService({ withTenantTransaction: async (_context, work) => work(client) });
  assert.deepEqual(await service.decide(c, input), receipt);
  assert.equal(reviewerChecks, 2);
});

test('denial receipt replay fails closed for changed binding, key, authorized context, receipt or post-wait reviewer', async () => {
  const row = proposal({ action_code: 'marketing.draft.save', required_permission: 'marketing.assistant.use', status: 'DENIED' });
  const c = context(); const input = { actionRequestId: row.id, decision: 'DENIED', binding: binding(row), reason: 'Exact denial' };
  const receipt = { actionRequestId: row.id, status: 'DENIED', actionCode: row.action_code, reviewedAt: new Date().toISOString(), payloadHash: row.payload_hash, policyVersion: row.policy_version, executionTriggered: false };
  for (const probe of [
    { input: { ...input, binding: { ...input.binding, payloadHash: 'a'.repeat(64) } }, status: 409 },
    { input: { ...input, reason: 'Different denial' }, status: 409 },
    { input: { ...input, decision: 'APPROVED' }, status: 409 },
    { context: { ...c, idempotencyKey: randomUUID() }, status: 409 },
    { context: { ...c, principalId: randomUUID(), externalSubject: 'other-reviewer' }, status: 409 },
    { context: { ...c, schoolId: randomUUID() }, status: 409 },
    { context: { ...c, organizationId: randomUUID() }, status: 409 },
    { context: { ...c, source: 'AI' }, status: 403 },
    { context: { ...c, delegatedByPrincipalId: randomUUID() }, status: 403 },
    { receipt: { ...receipt, actionRequestId: randomUUID() }, status: 409 },
    { receipt: { ...receipt, executionTriggered: true }, status: 409 },
    { revokeAfterWait: true, status: 403 },
  ]) {
    let reviewerChecks = 0;
    const client = { query: async (sql, args = []) => {
      if (sql.includes('FROM hon.action_requests') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
      if (sql.includes("set_config('app.hon_source'") || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
      if (sql.includes('require_human_action_review')) { if (++reviewerChecks === 2 && probe.revokeAfterWait) throw Object.assign(new Error('HUMAN_REVIEW_FORBIDDEN'), { code: '42501' }); return { rows: [], rowCount: 0 }; }
      if (sql.includes('INSERT INTO hon.idempotency_records')) { const sameContext = [c.organizationId, c.schoolId, c.principalId, c.idempotencyKey].every((value, index) => value === args[index]); return { rows: sameContext ? [] : [{ id: randomUUID() }], rowCount: sameContext ? 0 : 1 }; }
      if (sql.includes('SELECT request_fingerprint,status,response_body FROM hon.idempotency_records')) return { rows: [{ request_fingerprint: hash({ operation: 'action.request.decide', ...input }), status: 'COMPLETED', response_body: probe.receipt ?? receipt }], rowCount: 1 };
      throw new Error(`Rejected replay must not reach target/state or effects: ${sql}`);
    }};
    const service = new ActionEngineService({ withTenantTransaction: async (_context, work) => work(client) });
    await denied(() => service.decide(probe.context ?? c, probe.input ?? input), probe.status);
  }
});

test('beginExecution rejects an APPROVED CONFIRM row that lacks a timed approval binding without invoking an executor', async () => {
  const row = proposal({ approval_expires_at: null }); const queries = [];
  const service = new ActionEngineService({ withTenantTransaction: async (_context, work) => work({ query: async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM hon.action_requests') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
    throw new Error(`Unexpected SQL after validity rejection: ${sql}`);
  }}) });
  await denied(() => service.beginExecution(context({ principalId: row.requested_by_principal_id, source: 'AI', principalType: 'AI_EMPLOYEE' }), row.id), 409);
  assert.equal(queries.some((sql) => sql.includes("SET status='EXECUTING'")), false);
  assert.equal(queries.some((sql) => /CrmLeadActionTool|LeadService|fetch\(/.test(sql)), false);
});

test('Action Center HTTP derives the scope from verified identity and accepts only same-origin human decisions', async () => {
  const row = proposal(); const db = { resolveAuthorizedScope: async (subject, school, permission) => subject === 'verified-action-reviewer' && school === scope.schoolId && permission === 'action.approve' ? scope : undefined };
  const queue = { organizationId: scope.organizationId, schoolId: scope.schoolId, reviewerPrincipalId: scope.principalId, reviewerPermission: 'action.approve', status: 'AWAITING_APPROVAL', items: [], nextAfter: null, executionTriggered: false };
  let calls = 0;
  const actions = { listForReview: async (c, status, after) => { calls += 1; assert.equal(c.source, 'HUMAN_UI'); assert.equal(c.principalId, scope.principalId); assert.equal(status, 'AWAITING_APPROVAL'); assert.equal(after, null); return queue; }, getForReview: async () => ({ ...row }), decide: async (c, input) => { calls += 1; assert.equal(c.idempotencyKey, 'retained-action-key'); assert.equal(input.actionRequestId, row.id); return { actionRequestId: row.id, status: input.decision, actionCode: row.action_code, reviewedAt: new Date().toISOString(), payloadHash: row.payload_hash, policyVersion: 1, executionTriggered: false }; } };
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const mod = await Test.createTestingModule({ controllers: [ActionApprovalWorkbenchController], providers: [ActionReviewHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }, { provide: ActionEngineService, useValue: actions }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(ctx) { const request = ctx.switchToHttp().getRequest(); if (request.headers['x-test-human'] !== 'verified') throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' }); request.honIdentity = { externalSubject: 'verified-action-reviewer' }; return true; } }).compile();
  const app = mod.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/action-center/approvals/${scope.schoolId}`;
  const headers = { 'x-test-human': 'verified', origin: 'https://hon.test', 'content-type': 'application/json', 'x-hon-human-command': 'action-approvals', 'idempotency-key': 'retained-action-key', 'sec-fetch-site': 'same-origin' };
  try {
    const listed = await fetch(`${base}?status=AWAITING_APPROVAL`, { headers }); assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'private, no-store'); assert.equal(calls, 1);
    assert.equal((await fetch(`${base}?organizationId=${scope.organizationId}`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/${row.id}/decision`, { method: 'POST', headers, body: JSON.stringify({ decision: 'APPROVED', binding: binding(row), reason: 'Exact human review' }) })).status, 200); assert.equal(calls, 2);
    for (const patch of [{ origin: 'https://evil.test' }, { 'x-hon-human-command': 'not-action-approvals' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await fetch(`${base}/${row.id}/decision`, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify({ decision: 'APPROVED', binding: binding(row) }) })).status, 403);
    assert.equal((await fetch(`${base}/${row.id}/execute`, { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { await app.close(); if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});
