const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { SchoolAnnouncementsService, translateSchoolAnnouncementError } = require('../dist/announcements/school-announcements.service.js');

// 0576 school announcements: closed inputs, verified projections, and the service refuses before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-11-20T17:00:00.000Z', T2 = '2026-11-20T18:00:00.000Z';
const family = (patch = {}) => ({ announcementId: A, title: 'Closed Monday', body: 'No classes.\nSee you Tuesday!', publishedAt: T1, ...patch });
const staffRow = (patch = {}) => ({ ...family(), status: 'PUBLISHED', withdrawnAt: null, version: 1, ...patch });

test('0576 inputs are closed', () => {
  assert.deepEqual(contracts.validatePublishSchoolAnnouncementInput({ title: 'Belt test', body: 'Saturday\t10am\r\n' }), { title: 'Belt test', body: 'Saturday\t10am\r\n' });
  for (const value of [{ title: '', body: 'x' }, { title: '  ', body: 'x' }, { title: 'x'.repeat(121), body: 'x' }, { title: 'a\nb', body: 'x' }, { title: 'T', body: '' },
    { title: 'T', body: ' \n ' }, { title: 'T', body: 'x'.repeat(2001) }, { title: 'T', body: 'bell\u0007' }, { title: 'T', body: 'x', schoolId: A }, { title: 'T' }, null, []]) {
    assert.throws(() => contracts.validatePublishSchoolAnnouncementInput(value), undefined, JSON.stringify(value));
  }
  assert.equal(contracts.isSchoolAnnouncementTitle('x'.repeat(120)), true);
  assert.deepEqual(contracts.validateWithdrawSchoolAnnouncementInput({ announcementId: A, expectedVersion: 1 }), { announcementId: A, expectedVersion: 1 });
  for (const value of [{ announcementId: 'nope', expectedVersion: 1 }, { announcementId: A, expectedVersion: 0 }, { announcementId: A, expectedVersion: 1.5 }, { announcementId: A }]) {
    assert.throws(() => contracts.validateWithdrawSchoolAnnouncementInput(value), undefined, JSON.stringify(value));
  }
});

test('0576 projections are verified exactly', () => {
  const view = { schoolName: 'Dojo', announcements: [family({ announcementId: B, publishedAt: T2 }), family()] };
  assert.deepEqual(contracts.verifyParentSchoolAnnouncements(view), view);
  assert.throws(() => contracts.verifyParentSchoolAnnouncements({ ...view, announcements: [...view.announcements].reverse() }), undefined, 'newest first');
  assert.throws(() => contracts.verifyParentSchoolAnnouncements({ ...view, announcements: [family({ author: 'Coach' })] }), undefined, 'no author');
  assert.throws(() => contracts.verifyParentSchoolAnnouncements({ ...view, announcements: [family(), family()] }), undefined, 'no duplicates');
  assert.throws(() => contracts.verifyParentSchoolAnnouncements({ schoolName: 'Dojo', announcements: Array.from({ length: 21 }, (_, i) => family({ announcementId: `${A.slice(0, -2)}${String(i).padStart(2, '0')}` })) }), undefined, 'at most 20');
  assert.deepEqual(contracts.verifySchoolAnnouncements({ announcements: [staffRow()] }), { announcements: [staffRow()] });
  assert.throws(() => contracts.verifySchoolAnnouncement(staffRow({ status: 'WITHDRAWN' })), undefined, 'withdrawn needs a time');
  assert.throws(() => contracts.verifySchoolAnnouncement(staffRow({ version: 2 })), undefined, 'a live announcement is version 1');
  const down = staffRow({ status: 'WITHDRAWN', withdrawnAt: T2, version: 2 });
  assert.equal(contracts.verifySchoolAnnouncementReceipt({ announcement: down }, { announcementId: A, status: 'WITHDRAWN' }).announcement.version, 2);
  assert.throws(() => contracts.verifySchoolAnnouncementReceipt({ announcement: down }, { announcementId: B, status: 'WITHDRAWN' }), undefined, 'bound to the announcement');
  assert.throws(() => contracts.verifySchoolAnnouncementReceipt({ announcement: staffRow() }, { title: 'Other', status: 'PUBLISHED' }), undefined, 'bound to the posted title');
});

test('0576 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new SchoolAnnouncementsService(database);
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  await assert.rejects(() => service.parentRead(''), (e) => e.response.code === 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN');
  await assert.rejects(() => service.list({ ...staff, source: 'AI_AGENT' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.list({ ...staff, delegatedByPrincipalId: A }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.list({ ...staff, idempotencyKey: 'k' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.publish(staff, { title: 'T', body: 'x' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.publish({ ...staff, idempotencyKey: 'k' }, { title: '', body: 'x' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.withdraw({ ...staff, idempotencyKey: 'k' }, 'nope', { expectedVersion: 1 }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.withdraw({ ...staff, idempotencyKey: 'k' }, A, { expectedVersion: 1, title: 'x' }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
});

test('0576 database errors map to closed codes', () => {
  const code = (message, sqlState) => { try { translateSchoolAnnouncementError(Object.assign(new Error(message), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(code('SCHOOL_ANNOUNCEMENTS_RATE_LIMITED', '53400'), [429, 'SCHOOL_ANNOUNCEMENTS_RATE_LIMITED']);
  assert.deepEqual(code('VERSION_CONFLICT', '40001'), [409, 'VERSION_CONFLICT']);
  assert.deepEqual(code('SCHOOL_ANNOUNCEMENTS_NOT_FOUND', 'P0002'), [404, 'SCHOOL_ANNOUNCEMENTS_NOT_FOUND']);
  assert.deepEqual(code('anything', '42501'), [403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN']);
  assert.deepEqual(code('connection lost', '08006'), [503, 'SCHOOL_ANNOUNCEMENTS_UNAVAILABLE']);
});
