const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BadRequestException, ConflictException, ServiceUnavailableException } = require('@nestjs/common');
const { ActionEngineService } = require('../dist/action/action-engine.service.js');
const { CrmLeadActionTool } = require('../dist/crm/crm-lead-action.tool.js');

// Review [21]: expiry evidence is durable, and a committed CRM lead is never labelled FAILED.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, externalSubject: 'verified-ai-runtime', principalType: 'AI_EMPLOYEE', source: 'AI', requestId: randomUUID(), correlationId: randomUUID(), ...patch });

/** A transaction double: the work's return commits, its throw rolls back, exactly like withTenantTransaction. */
function ledger(handle) {
  const committed = [], rolledBack = [];
  const database = { withTenantTransaction: async (_context, work) => {
    const writes = [];
    try { const value = await work({ query: async (sql, args = []) => { const r = handle(sql, args); if (/^\s*(UPDATE|INSERT)/.test(sql)) writes.push(sql); return r; } }); committed.push(...writes); return value; }
    catch (error) { rolledBack.push(...writes); throw error; }
  } };
  return { database, committed, rolledBack };
}

test('an expired approval commits EXPIRED, its audit row and its outbox event, and is still refused', async () => {
  const row = { id: randomUUID(), action_code: 'crm.lead.create', normalized_payload: {}, requested_by_principal_id: scope.principalId, required_permission: 'crm.lead.create',
    effective_authority_mode: 'CONFIRM', policy_version: 1, approval_expires_at: new Date(Date.now() - 1000), status: 'APPROVED' };
  const { database, committed, rolledBack } = ledger((sql) => {
    if (sql.includes('FROM hon.action_requests') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
    if (/^\s*(UPDATE|INSERT)/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL after expiry: ${sql}`);
  });
  const service = new ActionEngineService(database);
  await assert.rejects(() => service.beginExecution(context(), row.id), (error) => error instanceof ConflictException && error.getResponse().code === 'POLICY_BLOCKED');
  assert.equal(rolledBack.length, 0, 'the refusal must not roll the expiry evidence back');
  assert.equal(committed.length, 3);
  assert.match(committed[0], /SET status='EXPIRED'/);
  assert.match(committed[1], /action\.request\.expire/);
  assert.match(committed[2], /action\.request\.expired/);
  assert.equal(committed.some((sql) => sql.includes("SET status='EXECUTING'")), false, 'an expired approval never starts execution');
});

const input = { pipelineId: randomUUID(), pipelineStageId: randomUUID(), primaryContact: { givenName: 'Sample', familyName: 'Lead', email: 'sample@example.test' } };
const lead = { id: randomUUID(), version: 1 };
function tool({ create, record }) {
  const outcomes = [];
  const actions = {
    propose: async () => ({ id: randomUUID(), status: 'APPROVED' }),
    beginExecution: async (_c, id) => ({ id, actionCode: 'crm.lead.create' }),
    recordExecutionOutcome: async (_c, _id, outcome, details) => { outcomes.push({ outcome, details }); return record(outcome, outcomes.length); },
  };
  return { tool: new CrmLeadActionTool(actions, { create }), outcomes };
}

test('a committed lead whose success receipt cannot be written is reported unconfirmed, never FAILED', async () => {
  const { tool: t, outcomes } = tool({ create: async () => ({ lead, replayed: false }), record: async () => { throw new Error('receipt write lost'); } });
  const result = await t.invoke(context(), input);
  assert.equal(result.execution, 'RECEIPT_UNCONFIRMED');
  assert.equal(result.lead.id, lead.id);
  assert.deepEqual(outcomes.map((o) => o.outcome), ['SUCCEEDED', 'SUCCEEDED'], 'one retry of the same success receipt');
  assert.equal(outcomes.some((o) => o.outcome === 'FAILED'), false);
});

test('a receipt that lands on the retry reports SUCCEEDED', async () => {
  const { tool: t, outcomes } = tool({ create: async () => ({ lead, replayed: false }), record: async (_o, n) => { if (n === 1) throw new Error('lost once'); } });
  assert.equal((await t.invoke(context(), input)).execution, 'SUCCEEDED');
  assert.equal(outcomes.length, 2);
});

test('a domain refusal is FAILED; an unexplained failure is UNKNOWN; neither hides the domain error', async () => {
  const refused = new BadRequestException({ code: 'VALIDATION_FAILED' });
  let run = tool({ create: async () => { throw refused; }, record: async () => {} });
  await assert.rejects(() => run.tool.invoke(context(), input), (e) => e === refused);
  assert.deepEqual(run.outcomes.map((o) => o.outcome), ['FAILED']);
  const lost = new ServiceUnavailableException({ code: 'DATABASE_UNAVAILABLE' });
  run = tool({ create: async () => { throw lost; }, record: async () => { throw new Error('outcome write also lost'); } });
  await assert.rejects(() => run.tool.invoke(context(), input), (e) => e === lost);
  assert.deepEqual(run.outcomes.map((o) => o.outcome), ['UNKNOWN']);
  const network = new Error('connection reset after COMMIT');
  run = tool({ create: async () => { throw network; }, record: async () => {} });
  await assert.rejects(() => run.tool.invoke(context(), input), (e) => e === network);
  assert.deepEqual(run.outcomes.map((o) => o.outcome), ['UNKNOWN']);
});
