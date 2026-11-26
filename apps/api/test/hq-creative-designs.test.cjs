const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { HqCreativeDesignsService } = require('../dist/hq-creative/hq-creative-designs.service.js');
const { HqCreativeDesignsController } = require('../dist/hq-creative/hq-creative-designs.controller.js');
const contracts = require('@hon/contracts');

// 0678 HQ Creative designs: one fixed subject-only call per operation; the same contract as the school editor checks
// every input and answer; refusals keep the editor's codes; photos are stripped before the database sees them.
const T = '2026-11-24T10:00:00.000Z';
const design = (patch = {}) => ({ designId: randomUUID(), name: 'HON OS launch', sizeCode: 'SOCIAL_SQUARE', status: 'ACTIVE', version: 1, createdAt: T, updatedAt: T,
  document: contracts.blankCreativeDesignDocument('SOCIAL_SQUARE'), ...patch });
const db = (answer) => { const calls = []; return { calls, callSaasBilling: async (op, params) => { calls.push([op, params]); return typeof answer === 'function' ? answer(op, params) : answer; } }; };
const fail = (code, message) => Object.assign(new Error(message), { code });
// 1x1 PNG (critical chunks only).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('reads go to the HQ read functions with the subject and a closed input', async () => {
  const d = design();
  const fake = db((op) => op === 'readHqCreativeDesigns' ? { designs: [] } : d);
  const s = new HqCreativeDesignsService(fake);
  assert.deepEqual(await s.list('auth0|hq', {}), { designs: [] });
  assert.equal((await s.get('auth0|hq', d.designId)).designId, d.designId);
  assert.deepEqual(fake.calls.map(c => c[0]), ['readHqCreativeDesigns', 'readHqCreativeDesign']);
  assert.deepEqual(fake.calls[1][1], ['auth0|hq', JSON.stringify({ designId: d.designId })]);
  await assert.rejects(s.list('auth0|hq', { status: 'DELETED' }), e => e.getResponse().code === 'VALIDATION_FAILED');
  await assert.rejects(s.get('auth0|hq', 'nope'), e => e.getResponse().code === 'VALIDATION_FAILED');
  // An answer for another design is never shown.
  await assert.rejects(new HqCreativeDesignsService(db(design())).get('auth0|hq', d.designId), e => e.getResponse().code === 'SAAS_UNAVAILABLE');
});

test('save needs a UUID key and a receipt matching the request', async () => {
  const input = { designId: null, expectedVersion: 0, name: 'HON OS launch', sizeCode: 'SOCIAL_SQUARE', document: contracts.blankCreativeDesignDocument('SOCIAL_SQUARE') };
  const key = randomUUID();
  const fake = db({ design: design(), replayed: false });
  const r = await new HqCreativeDesignsService(fake).save('auth0|hq', input, key);
  assert.equal(r.replayed, false);
  assert.deepEqual(fake.calls[0], ['saveHqCreativeDesign', ['auth0|hq', JSON.stringify(input), key]]);
  await assert.rejects(new HqCreativeDesignsService(fake).save('auth0|hq', input, 'not-a-uuid'), e => e.getResponse().code === 'VALIDATION_FAILED');
  await assert.rejects(new HqCreativeDesignsService(db({ design: design({ version: 2 }), replayed: false })).save('auth0|hq', input, key), e => e.getResponse().code === 'SAAS_UNAVAILABLE');
});

test('database refusals keep the editor codes; anything unknown is unavailable', async () => {
  const input = { designId: randomUUID(), expectedVersion: 1, status: 'ARCHIVED' };
  const cases = [[fail('23514', 'CREATIVE_DESIGN_NAME_TAKEN'), 'CREATIVE_DESIGN_NAME_TAKEN'], [fail('23514', 'CREATIVE_DESIGN_LIMIT'), 'CREATIVE_DESIGN_LIMIT'],
    [fail('23514', 'CREATIVE_DESIGN_STATUS_UNCHANGED'), 'CREATIVE_DESIGN_STATUS_UNCHANGED'], [fail('40001', 'SAAS_VERSION_CONFLICT'), 'VERSION_CONFLICT'],
    [fail('P0002', 'CREATIVE_DESIGN_NOT_FOUND'), 'CREATIVE_DESIGN_NOT_FOUND'], [fail('42501', 'SAAS_FORBIDDEN'), 'SAAS_FORBIDDEN'],
    [fail('23505', 'SAAS_KEY_REUSED'), 'IDEMPOTENCY_KEY_REUSED'], [fail('55P03', 'x'), 'SAAS_OUTCOME_UNKNOWN'], [fail('XX000', 'boom'), 'SAAS_UNAVAILABLE']];
  for (const [error, code] of cases) {
    const s = new HqCreativeDesignsService(db(() => { throw error; }));
    await assert.rejects(s.setStatus('auth0|hq', input, randomUUID()), e => e.getResponse().code === code, code);
  }
});

test('a photo is stripped of metadata before the database call and refused if it is not the declared type', async () => {
  const fake = db((op, params) => ({ photo: { photoId: randomUUID(), mediaType: 'image/png', bytes: Buffer.from(JSON.parse(params[1]).data, 'base64').length,
    checksum: 'a'.repeat(64), createdAt: T }, replayed: false }));
  const r = await new HqCreativeDesignsService(fake).addPhoto('auth0|hq', { mediaType: 'image/png', data: PNG }, randomUUID());
  assert.equal(r.photo.mediaType, 'image/png');
  assert.equal(fake.calls[0][0], 'addHqCreativeDesignPhoto');
  await assert.rejects(new HqCreativeDesignsService(fake).addPhoto('auth0|hq', { mediaType: 'image/jpeg', data: PNG }, randomUUID()),
    e => e.getResponse().code === 'CREATIVE_DESIGN_PHOTO_REFUSED');
  assert.equal(fake.calls.length, 1);
});

test('routes are HQ-only and every command carries its own HQ command name', () => {
  assert.equal(Reflect.getMetadata('path', HqCreativeDesignsController), 'hq/marketing/creative/designs');
  const names = ['save', 'addPhoto', 'setStatus'].map(m => Reflect.getMetadata('hon:saas-command', HqCreativeDesignsController.prototype[m]));
  assert.deepEqual(names, [contracts.SAAS_COMMANDS.saveHqCreativeDesign, contracts.SAAS_COMMANDS.addHqCreativeDesignPhoto, contracts.SAAS_COMMANDS.setHqCreativeDesignStatus]);
});
