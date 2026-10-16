import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const source = async (path) => readFile(new URL(path, root), 'utf8');
const employees = [
  {
    name: 'Marcus', agent: 'marcus', workType: 'AI_DRAFT_MARKETING', taskClass: 'DRAFT_MARKETING', action: 'marketing.draft.save',
    service: 'apps/api/src/marketing/marketing-assistant.service.ts', migration: 'packages/database/migrations/0089_marketing_assistant_runtime.sql',
    test: 'packages/database/scripts/test-marketing-assistant-integrity.mjs', invocation: 'marketing_ai_invocations', drafts: 'marketing_ai_drafts', inbox: 'list_my_marketing_invocations',
  },
  {
    name: 'Claire', agent: 'claire', workType: 'AI_DRAFT_TEACHING', taskClass: 'DRAFT_TEACHING', action: 'teaching.draft.save',
    service: 'apps/api/src/teaching-assistant/teaching-assistant.service.ts', migration: 'packages/database/migrations/0100_claire_teaching_assistant.sql',
    test: 'packages/database/scripts/test-teaching-assistant-integrity.mjs', invocation: 'teaching_ai_invocations', drafts: 'teaching_ai_drafts', inbox: 'list_my_teaching_invocations',
  },
  {
    name: 'Chad', agent: 'chad', workType: 'AI_DRAFT_FOLLOW_UP', taskClass: 'DRAFT_FOLLOW_UP', action: 'crm.follow_up_draft.propose',
    service: 'apps/api/src/chad-follow-up-assistant/chad-follow-up-assistant.service.ts', migration: 'packages/database/migrations/0107_chad_follow_up_draft_assistant.sql',
    test: 'packages/database/scripts/test-chad-follow-up-assistant-integrity.mjs', invocation: 'chad_follow_up_invocations', drafts: 'chad_follow_up_drafts', inbox: 'list_my_chad_follow_up_invocations',
  },
];

let groups = 0;
for (const employee of employees) {
  const [service, migration, test] = await Promise.all([source(employee.service), source(employee.migration), source(employee.test)]);
  // The service is only a composition layer: typed input -> shared planner ->
  // provider-neutral runtime -> existing Action Engine proposal. It has no
  // employee-specific tool/executor or provider credential escape hatch.
  for (const token of ['this.plans.plan(', 'this.actions.proposeInTransaction(', 'this.provider.generate(', employee.action]) {
    assert(service.includes(token), `${employee.name} service is missing shared governed path: ${token}`);
  }
  assert.match(service, /effectiveAuthorityMode\s*!==\s*'CONFIRM'/, `${employee.name} service must require CONFIRM authority for a draft proposal`);
  assert.doesNotMatch(service, /\bfetch\s*\(|process\.env|from ['"](?:node:https?|openai|@anthropic|axios)/, `${employee.name} service must not own transport or credentials`);
  assert(service.includes('listMine('), `${employee.name} service must expose only a governed own-work projection.`);
  assert(test.includes('listMine('), `${employee.name} proof must verify requester-only durable work visibility.`);
  for (const token of [employee.invocation, employee.drafts, employee.workType, employee.taskClass, `agent_key='${employee.agent}'`, 'hon.ai_invocation_plans', 'hon.ai_usage_ledger', 'WAITING_FOR_APPROVAL', 'PROVIDER_UNKNOWN']) {
    assert(migration.includes(token), `${employee.name} durable boundary is missing ${token}`);
  }
  assert(migration.includes(employee.action), `${employee.name} proposal binding must use the registered Action Engine action`);
  for (const token of ['AWAITING_APPROVAL', 'UNKNOWN', 'COMPLETE', 'ai_usage_ledger']) {
    assert(test.includes(token), `${employee.name} focused proof is missing ${token}`);
  }
  assert.match(test, /(?:NO EXTERNAL NETWORK PERMITTED|EXTERNAL_NETWORK_FORBIDDEN)/, `${employee.name} focused proof must install a rejecting transport sentinel`);
  groups++;
}

const actionEngine = await source('apps/api/src/action/action-engine.service.ts');
for (const action of employees.map((employee) => employee.action)) {
  assert(actionEngine.includes(`'${action}'`), `Shared Action Engine must know the registered ${action} proposal.`);
}
assert(actionEngine.includes("request.action_code === 'crm.follow_up_draft.propose'"));
assert(actionEngine.includes('approval never permits Action Engine execution'));
assert(actionEngine.includes('executionTriggered:false'));
groups++;

const chadTest = await source('packages/database/scripts/test-chad-follow-up-assistant-integrity.mjs');
assert(chadTest.includes('actions.beginExecution(context(), first.actionRequestId)'));
assert(chadTest.includes("'NOT_CREATED_OR_SENT'"));
assert(chadTest.includes("'communication_messages'"));
groups++;

console.log(`AI employee shared verifier passed: ${groups} groups; all three slices use typed durable work, HQ-planned metadata, shared Action Engine CONFIRM proposals, usage evidence and mock-only network sentinels; Chad's approved proposal remains explicitly non-executable.`);
