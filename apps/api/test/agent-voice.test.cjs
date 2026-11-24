require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateSync } = require('class-validator');
const { AgentVoiceController } = require('../dist/preferences/agent-voice.controller.js');
const { UpdateAgentVoiceDto } = require('../dist/preferences/agent-voice.dto.js');
const { agentVoiceChoices } = require('../dist/preferences/agent-voice.service.js');

const id = (n) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const organizationId = id('1');
const schoolId = id('2');
const principalId = id('3');
const request = { honIdentity: { externalSubject: 'verified-current-user' } };
const ALL_ONE = { hon: 1, claire: 1, alex: 1, jordan: 1, lena: 1, marcus: 1, chad: 1, maya: 1, kai: 1 };

test('agent voice controller reads and saves only the verified person\'s own choices, with the interface-preference permissions', async () => {
  const resolved = []; const calls = [];
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { resolved.push([subject, school, permission]); return { organizationId, schoolId, principalId }; } };
  const service = {
    get: async (context) => { calls.push(['get', context]); return { choices: ALL_ONE }; },
    save: async (context, input) => { calls.push(['save', context, input]); return { choices: { ...ALL_ONE, [input.agentKey]: input.voiceChoice } }; },
  };
  const controller = new AgentVoiceController(database, service);
  assert.deepEqual((await controller.get(organizationId, schoolId, request)).data, { choices: ALL_ONE });
  const saved = await controller.save(organizationId, schoolId, id('4'), { agentKey: 'jordan', voiceChoice: 3 }, request);
  assert.equal(saved.data.choices.jordan, 3);
  assert.equal(saved.meta.replayed, false);
  assert.deepEqual(resolved, [['verified-current-user', schoolId, 'settings.interface_theme.read'], ['verified-current-user', schoolId, 'settings.interface_theme.update']]);
  assert.deepEqual([calls[1][1].organizationId, calls[1][1].schoolId, calls[1][1].principalId, calls[1][1].principalType, calls[1][1].source, calls[1][1].idempotencyKey],
    [organizationId, schoolId, principalId, 'HUMAN_USER', 'HUMAN_UI', id('4')]);
  assert.deepEqual(calls[1][2], { agentKey: 'jordan', voiceChoice: 3 });
});

test('agent voice controller refuses another school\'s scope, a missing identity and a missing retry key', async () => {
  const other = new AgentVoiceController({ resolveAuthorizedScope: async () => ({ organizationId: id('9'), schoolId, principalId }) }, {});
  await assert.rejects(other.get(organizationId, schoolId, request), { status: 403 });
  const none = new AgentVoiceController({ resolveAuthorizedScope: async () => null }, {});
  await assert.rejects(none.save(organizationId, schoolId, id('4'), { agentKey: 'hon', voiceChoice: 2 }, request), { status: 403 });
  await assert.rejects(none.get(organizationId, schoolId, {}), { status: 403 });
  await assert.rejects(none.save(organizationId, schoolId, undefined, { agentKey: 'hon', voiceChoice: 2 }, request), { status: 409 });
});

test('agent voice DTO accepts the nine teammates and choices 1-3 only', () => {
  for (const agentKey of Object.keys(ALL_ONE)) for (const voiceChoice of [1, 2, 3]) assert.equal(validateSync(Object.assign(new UpdateAgentVoiceDto(), { agentKey, voiceChoice })).length, 0);
  for (const patch of [{ agentKey: 'bob', voiceChoice: 1 }, { agentKey: 'hon', voiceChoice: 4 }, { agentKey: 'hon', voiceChoice: 0 }, { agentKey: 'hon', voiceChoice: '2' },
    { agentKey: 'hon', voiceChoice: 2, provider: 'elevenlabs' }]) {
    assert.notEqual(validateSync(Object.assign(new UpdateAgentVoiceDto(), patch), { whitelist: true, forbidNonWhitelisted: true }).length, 0, JSON.stringify(patch));
  }
});

test('missing teammates default to their original voice (1); unknown rows are ignored', () => {
  assert.deepEqual(agentVoiceChoices([]), ALL_ONE);
  assert.deepEqual(agentVoiceChoices([{ agent_key: 'lena', voice_choice: 2 }, { agent_key: 'zed', voice_choice: 3 }]), { ...ALL_ONE, lena: 2 });
});
