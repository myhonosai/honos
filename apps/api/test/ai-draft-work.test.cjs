const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const id = '11111111-1111-4111-8111-111111111111';
const context = { organizationId:id, schoolId:id, principalId:id, externalSubject:'verified-human-subject', principalType:'HUMAN_USER', source:'HUMAN_UI', requestId:id, correlationId:id, idempotencyKey:id };

function status(expected) { return (error) => error?.getStatus?.() === expected; }
function databaseFor(signature) {
  return { withTenantTransaction: async (received, work) => {
    assert.equal(received.externalSubject, context.externalSubject);
    return work({ query: async (sql) => {
      if (sql.includes("set_config('app.hon_source'") || sql.includes('SET LOCAL statement_timeout')) return { rows:[] };
      assert.match(sql, new RegExp(signature));
      return { rows:[{data:[]}] };
    }});
  }};
}

test('AI draft inbox services accept only direct human context and use fixed own-work functions', async () => {
  const { MarketingAssistantService } = require('../dist/marketing/marketing-assistant.service.js');
  const { TeachingAssistantService } = require('../dist/teaching-assistant/teaching-assistant.service.js');
  const { ChadFollowUpAssistantService } = require('../dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');
  const cases = [
    [new MarketingAssistantService(databaseFor('list_my_marketing_invocations'), {}, {}, {}), 'list_my_marketing_invocations'],
    [new TeachingAssistantService(databaseFor('list_my_teaching_invocations'), {}, {}, {}), 'list_my_teaching_invocations'],
    [new ChadFollowUpAssistantService(databaseFor('list_my_chad_follow_up_invocations'), {}, {}, {}), 'list_my_chad_follow_up_invocations'],
  ];
  for (const [service] of cases) {
    assert.deepEqual(await service.listMine(context), []);
    for (const patch of [{source:'AI'},{source:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{delegatedByPrincipalId:id},{actionRequestId:id},{externalSubject:''}]) {
      await assert.rejects(service.listMine({...context,...patch}), status(403));
    }
  }
});

test('AI draft inbox controllers expose only fixed human read endpoints', () => {
  const files = [
    'src/marketing/marketing-assistant.controller.ts',
    'src/teaching-assistant/teaching-assistant.controller.ts',
    'src/chad-follow-up-assistant/chad-follow-up-assistant.controller.ts',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /@Get\('mine'\)/);
    assert.match(source, /listMine\(/);
    assert.match(source, /HumanUiGuard/);
    assert.match(source, /async mine\([\s\S]{0,400}@Query\(\) query[\s\S]{0,400}this\.noQuery\(query\);/);
    assert.doesNotMatch(source, /@Get\('mine\/[^']/);
    assert.doesNotMatch(source, /@Query\(['"](?:schoolId|organizationId|providerId|modelId)/);
  }
});

test('draft inbox source preserves no provider transport, no raw SQL, and no status mutation', () => {
  for (const file of [
    'src/marketing/marketing-assistant.service.ts',
    'src/teaching-assistant/teaching-assistant.service.ts',
    'src/chad-follow-up-assistant/chad-follow-up-assistant.service.ts',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /listMine\(/);
    assert.doesNotMatch(source, /listMine[\s\S]{0,600}(?:fetch\s*\(|INSERT |UPDATE |DELETE |provider\.generate)/);
  }
});
