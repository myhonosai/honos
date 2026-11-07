const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const context = { organizationId:id, schoolId:id, principalId:id, externalSubject:'verified-human-subject', principalType:'HUMAN_USER', source:'HUMAN_UI', requestId:id, correlationId:id, idempotencyKey:id };
const status = (expected) => (error) => error?.getStatus?.() === expected;

function databaseReturning(data, calls = []) {
  return { withTenantTransaction: async (received, work) => {
    assert.equal(received.externalSubject, context.externalSubject);
    return work({ query: async (sql, params) => {
      if (sql.includes("set_config('app.hon_source'") || sql.includes('SET LOCAL statement_timeout')) return { rows:[] };
      calls.push([sql, params]);
      return { rows:[{ data }] };
    }});
  }};
}

test('Kai curriculum picker uses only the fixed database read and returns the closed projection', async () => {
  const { TeachingAssistantService } = require('../dist/teaching-assistant/teaching-assistant.service.js');
  const calls = [];
  const items = [{ id, name:'Adult fundamentals', version:3 }, { id:other, name:'Little ninjas', version:1 }];
  const service = new TeachingAssistantService(databaseReturning({ items }, calls), {}, {}, {});
  assert.deepEqual(await service.listCurricula(context), { items });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'SELECT hon.list_teaching_assistant_curricula($1) data');
  assert.deepEqual(calls[0][1], [context.externalSubject]);
  for (const patch of [{source:'AI'},{source:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{delegatedByPrincipalId:id},{actionRequestId:id},{externalSubject:''}]) {
    await assert.rejects(new TeachingAssistantService(databaseReturning({ items }), {}, {}, {}).listCurricula({...context,...patch}), status(403));
  }
});

test('Kai curriculum picker refuses an unverified database projection instead of passing it on', async () => {
  const { TeachingAssistantService } = require('../dist/teaching-assistant/teaching-assistant.service.js');
  for (const bad of [null, [], { items:null }, { items:[{ id, name:'A', version:1, description:'private' }] }, { items:[{ id:'nope', name:'A', version:1 }] },
    { items:[{ id, name:'', version:1 }] }, { items:[{ id, name:'A', version:0 }] }, { items:[{ id, name:'A', version:1 }, { id, name:'B', version:1 }] }, { items:[], extra:true }]) {
    await assert.rejects(new TeachingAssistantService(databaseReturning(bad), {}, {}, {}).listCurricula(context), status(500));
  }
});

test('Kai curriculum picker route is a GET declared before the :invocationId read and reuses the teaching-assistant guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/teaching-assistant/teaching-assistant.controller.ts'), 'utf8');
  assert.match(source, /@UseGuards\(HonIdentityGuard, TeachingAssistantHumanUiGuard\)/);
  const picker = source.indexOf("@Get('curricula')");
  assert(picker > 0 && picker < source.indexOf("@Get(':invocationId')"), 'The static curricula route must be matched before the UUID invocation route.');
  assert.match(source, /async curricula\(@Req\(\) req: HonRequest, @Query\(\) query: Record<string, unknown>\) \{ this\.noQuery\(query\); return \{ data: await this\.assistant\.listCurricula\(await this\.context\(req\)\) \}; \}/);
});
