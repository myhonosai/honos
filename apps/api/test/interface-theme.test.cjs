require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateSync } = require('class-validator');
const { InterfaceThemeController } = require('../dist/preferences/interface-theme.controller.js');
const { UpdateInterfaceThemeDto } = require('../dist/preferences/interface-theme.dto.js');

const id = (n) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const organizationId = id('1');
const schoolId = id('2');
const principalId = id('3');
const request = { honIdentity: { externalSubject: 'verified-current-user' } };

test('interface theme preference controller preserves the existing principal-scoped read/save transport', async () => {
  const resolved = [];
  const contexts = [];
  const database = {
    resolveAuthorizedScope: async (subject, school, permission) => {
      resolved.push([subject, school, permission]);
      return { organizationId, schoolId, principalId };
    },
  };
  const preferences = {
    get: async (context) => {
      contexts.push(['get', context]);
      return { interfaceTheme: 'modern', selectedVia: 'DEFAULT' };
    },
    save: async (context, input) => {
      contexts.push(['save', context, input]);
      return { interfaceTheme: input.interfaceTheme, selectedVia: input.selectedVia, updatedAt: '2026-10-16T00:00:00.000Z' };
    },
  };
  const controller = new InterfaceThemeController(database, preferences);
  const loaded = await controller.get(organizationId, schoolId, request);
  assert.deepEqual(loaded.data, { interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
  assert.equal(typeof loaded.meta.requestId, 'string');
  assert.equal(typeof loaded.meta.correlationId, 'string');
  const saved = await controller.save(organizationId, schoolId, id('4'), { interfaceTheme: 'classic', selectedVia: 'ONBOARDING' }, request);
  assert.deepEqual(saved.data, { interfaceTheme: 'classic', selectedVia: 'ONBOARDING', updatedAt: '2026-10-16T00:00:00.000Z' });
  assert.deepEqual(resolved, [
    ['verified-current-user', schoolId, 'settings.interface_theme.read'],
    ['verified-current-user', schoolId, 'settings.interface_theme.update'],
  ]);
  assert.equal(contexts[0][1].organizationId, organizationId);
  assert.equal(contexts[0][1].schoolId, schoolId);
  assert.equal(contexts[0][1].principalId, principalId);
  assert.equal(contexts[0][1].principalType, 'HUMAN_USER');
  assert.equal(contexts[0][1].source, 'HUMAN_UI');
  assert.deepEqual(contexts[1][2], { interfaceTheme: 'classic', selectedVia: 'ONBOARDING' });
  assert.deepEqual(Object.keys(contexts[1][2]).sort(), ['interfaceTheme', 'selectedVia']);
});

test('interface theme DTO accepts only the three shared presentation choices and onboarding/settings provenance', () => {
  for (const interfaceTheme of ['big-button', 'modern', 'classic']) {
    for (const selectedVia of ['ONBOARDING', 'SETTINGS']) {
      const value = Object.assign(new UpdateInterfaceThemeDto(), { interfaceTheme, selectedVia });
      assert.equal(validateSync(value).length, 0);
    }
  }
  for (const patch of [{ interfaceTheme: 'COMPLETE', selectedVia: 'ONBOARDING' }, { interfaceTheme: 'modern', selectedVia: 'ROLE' }, { interfaceTheme: 'modern', selectedVia: 'ONBOARDING', tier: 'CORE' }]) {
    const value = Object.assign(new UpdateInterfaceThemeDto(), patch);
    assert.notEqual(validateSync(value, { whitelist: true, forbidNonWhitelisted: true }).length, 0);
  }
});
