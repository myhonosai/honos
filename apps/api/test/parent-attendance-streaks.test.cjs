const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentAttendanceStreaksService, translateParentAttendanceStreaksError } = require('../dist/attendance-streaks/parent-attendance-streaks.service.js');

// 0602 weekly attendance streaks: the projection is verified exactly and the service refuses before any database call.
test('0602 projection is name and whole weeks only, verified exactly', () => {
  const view = { children: [{ name: 'Mia Kim', weeks: 3 }, { name: 'Leo Kim', weeks: 0 }] };
  assert.deepEqual(contracts.verifyParentAttendanceStreaks(view), view);
  assert.deepEqual(contracts.verifyParentAttendanceStreaks({ children: [] }), { children: [] });
  assert.equal(contracts.verifyParentAttendanceStreaks({ children: [{ name: 'A', weeks: 104 }] }).children[0].weeks, 104);
  for (const [label, bad] of [
    ['extra child key', { children: [{ name: 'Mia', weeks: 1, studentProfileId: '00000000-0000-4000-8000-000000000000' }] }],
    ['extra top key', { children: [], schoolName: 'Dojo' }],
    ['fraction', { children: [{ name: 'Mia', weeks: 1.5 }] }],
    ['negative', { children: [{ name: 'Mia', weeks: -1 }] }],
    ['over the cap', { children: [{ name: 'Mia', weeks: 105 }] }],
    ['string number', { children: [{ name: 'Mia', weeks: '3' }] }],
    ['blank name', { children: [{ name: ' ', weeks: 1 }] }],
    ['control in name', { children: [{ name: 'Mi\u0007a', weeks: 1 }] }],
    ['too many', { children: Array.from({ length: 21 }, (_, i) => ({ name: `C${i}`, weeks: 1 })) }],
    ['not a list', { children: {} }],
  ]) assert.throws(() => contracts.verifyParentAttendanceStreaks(bad), undefined, label);
});

test('0602 service refuses before any database call and maps errors to closed codes', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentAttendanceStreaksService(database);
  await assert.rejects(() => service.read(''), (e) => e.response.code === 'ATTENDANCE_STREAKS_FORBIDDEN');
  await assert.rejects(() => service.read(' x'), (e) => e.response.code === 'ATTENDANCE_STREAKS_FORBIDDEN');
  assert.equal(calls, 0);
  const code = (sqlState) => { try { translateParentAttendanceStreaksError(Object.assign(new Error('x'), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(code('42501'), [403, 'ATTENDANCE_STREAKS_FORBIDDEN']);
  assert.deepEqual(code('22023'), [503, 'ATTENDANCE_STREAKS_UNAVAILABLE']);
  assert.deepEqual(code('08006'), [503, 'ATTENDANCE_STREAKS_UNAVAILABLE']);
});
