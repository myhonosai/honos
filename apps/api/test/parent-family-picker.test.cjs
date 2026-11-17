const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentFamilyPickerService } = require('../dist/families/parent-family-picker.service.js');

// 0456 parent family picker: closed input, verified list and selection, and the service refuses before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const kim = { schoolId: A, schoolName: 'Alpha Dojo', familyId: B, familyName: 'Kim Family', accessLevel: 'PRIMARY_GUARDIAN', current: false };
const beta = { schoolId: C, schoolName: 'Beta Academy', familyId: D, familyName: 'Kim Family B', accessLevel: 'VIEWER', current: false };

test('0456 input is closed: one school and one family id, nothing else', () => {
  assert.deepEqual(contracts.validateSelectParentFamilyInput({ schoolId: A, familyId: B }), { schoolId: A, familyId: B });
  for (const value of [{ schoolId: A }, { schoolId: A, familyId: B, principalId: C }, { schoolId: 'x', familyId: B }, { schoolId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', familyId: B }, null, [A, B]]) {
    assert.throws(() => contracts.validateSelectParentFamilyInput(value), undefined, JSON.stringify(value));
  }
});

test('0456 list and selection are verified exactly', () => {
  assert.deepEqual(contracts.verifyParentFamilyChoices({ choices: [kim, beta], needsChoice: true }).choices.length, 2);
  assert.equal(contracts.verifyParentFamilyChoices({ choices: [{ ...kim, current: true }], needsChoice: false }).choices[0].current, true);
  assert.equal(contracts.verifyParentFamilyChoices({ choices: [], needsChoice: false }).choices.length, 0);
  for (const [label, value] of [
    ['two current', { choices: [{ ...kim, current: true }, { ...beta, current: true }], needsChoice: false }],
    ['needs a choice while one is current', { choices: [{ ...kim, current: true }, beta], needsChoice: true }],
    ['several and none current without asking', { choices: [kim, beta], needsChoice: false }],
    ['one family that is not current', { choices: [kim], needsChoice: false }],
    ['duplicate family', { choices: [kim, kim], needsChoice: true }],
    ['extra key', { choices: [{ ...kim, students: [] }, beta], needsChoice: true }],
    ['unknown level', { choices: [{ ...kim, accessLevel: 'OWNER' }, beta], needsChoice: true }],
    ['blank name', { choices: [{ ...kim, familyName: ' ' }, beta], needsChoice: true }],
    ['too many', { choices: Array.from({ length: 21 }, (_, i) => ({ ...kim, familyId: `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222` })), needsChoice: true }],
  ]) assert.throws(() => contracts.verifyParentFamilyChoices(value), undefined, label);
  assert.equal(contracts.verifyParentFamilySelection({ choices: [kim, { ...beta, current: true }], needsChoice: false }, { schoolId: C, familyId: D }).choices[1].current, true);
  assert.throws(() => contracts.verifyParentFamilySelection({ choices: [{ ...kim, current: true }, beta], needsChoice: false }, { schoolId: C, familyId: D }), undefined, 'bound to the chosen family');
});

test('0456 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentFamilyPickerService(database);
  await assert.rejects(() => service.choices(''), (e) => e.response.code === 'PARENT_FAMILY_FORBIDDEN');
  await assert.rejects(() => service.choices(' padded'), (e) => e.response.code === 'PARENT_FAMILY_FORBIDDEN');
  await assert.rejects(() => service.select('parent', { schoolId: A }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.select('', { schoolId: A, familyId: B }), (e) => e.response.code === 'PARENT_FAMILY_FORBIDDEN');
  assert.equal(calls, 0);
});

test('0456 database errors map to fixed answers and an unverified answer is never passed on', async () => {
  const fail = (code, message) => ({ readParentFamilyChoices: async () => { throw Object.assign(new Error(message), { code }); }, selectParentFamily: async () => { throw Object.assign(new Error(message), { code }); } });
  await assert.rejects(() => new ParentFamilyPickerService(fail('P0002', 'PARENT_FAMILY_NOT_AVAILABLE')).select('parent', { schoolId: A, familyId: B }), (e) => e.getStatus() === 404 && e.response.code === 'PARENT_FAMILY_NOT_AVAILABLE');
  await assert.rejects(() => new ParentFamilyPickerService(fail('42501', 'PARENT_FAMILY_FORBIDDEN')).select('parent', { schoolId: A, familyId: B }), (e) => e.getStatus() === 403);
  await assert.rejects(() => new ParentFamilyPickerService(fail('XX000', 'boom')).choices('parent'), (e) => e.getStatus() === 503 && !JSON.stringify(e.response).includes('boom'));
  const wrong = { selectParentFamily: async () => ({ choices: [{ ...kim, current: true }, beta], needsChoice: false }) };
  await assert.rejects(() => new ParentFamilyPickerService(wrong).select('parent', { schoolId: C, familyId: D }), (e) => e.getStatus() === 503);
});
