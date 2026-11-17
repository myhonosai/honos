require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { StaffRoleService, parseAssignableStaffPermissions } = require('../dist/staff-roles/staff-role.service.js');
const { StaffRoleController } = require('../dist/staff-roles/staff-role.controller.js');

// 0412 (owner 2026-11-16, "setting to give permission to staff"): the permissions a manager may put in a custom role, as a list.
const id = () => randomUUID();
const qContext = (patch = {}) => ({ organizationId: id(), schoolId: id(), principalId: id(), externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id(), correlationId: id(), idempotencyKey: 'read', ...patch });
const perm = (patch = {}) => ({ code: 'attendance.cards.manage', description: 'Choose how attendance cards look', sensitive: true, ...patch });

test('assignable permissions keep only closed, unique, staff-level rows and fail only on a bad envelope', async () => {
  const list = { permissions: [perm(), perm({ code: 'attendance.record', description: 'Record attendance', sensitive: false }), perm({ code: 'iam.staff_role.manage' })] };
  assert.deepEqual(parseAssignableStaffPermissions(list), list.permissions);
  assert.deepEqual(parseAssignableStaffPermissions({ permissions: [] }), []);
  // A bad envelope fails the read.
  for (const bad of [{ ...list, extra: 1 }, {}, { permissions: 'x' }, { permissions: Array.from({ length: 201 }, (_, i) => perm({ code: `area.p${i}` })) }])
    assert.throws(() => parseAssignableStaffPermissions(bad), /Unsafe/);
  // An odd row is left out (and reported by code), never guessed; the rest of the list still shows.
  const skipped = [];
  const rows = parseAssignableStaffPermissions({ permissions: [perm({ code: 'hq.billing.manage' }), perm({ code: 'platform.thing.read' }), perm({ code: 'system.x' }), perm({ code: 'NotACode' }),
    perm({ code: 'single' }), perm({ description: '' }), perm({ code: 'a.long', description: 'x'.repeat(301) }), perm({ code: 'a.flag', sensitive: 'yes' }), perm({ code: 'a.extra', roleId: id() }), perm(), perm(), 'junk',
    perm({ code: 'attendance.record', description: 'Record attendance', sensitive: false })] }, (code) => skipped.push(code));
  assert.deepEqual(rows.map((p) => p.code), ['attendance.cards.manage', 'attendance.record']);
  assert.deepEqual(skipped, ['hq.billing.manage', 'platform.thing.read', 'system.x', 'unreadable row', 'single', 'attendance.cards.manage', 'a.long', 'a.flag', 'a.extra', 'attendance.cards.manage', 'unreadable row']);
  const calls = [], c = qContext();
  const service = new StaffRoleService({ withTenantTransaction: async (ctx, work) => { assert.equal(ctx, c); return work({ query: async (sql, args) => { calls.push([sql, args]); return { rows: [{ data: list }] }; } }); } });
  assert.deepEqual(await service.assignablePermissions(c), list.permissions);
  assert.match(calls[0][0], /set_config\('app.hon_source','HUMAN_UI'/);
  assert.deepEqual(calls.at(-1), ['SELECT hon.list_assignable_staff_permissions($1) AS data', [c.externalSubject]]);
  await assert.rejects(() => new StaffRoleService({ withTenantTransaction: () => { throw new Error('no'); } }).assignablePermissions({ ...c, source: 'AI' }), (e) => e.getStatus() === 403);
});

test('assignable permissions route requires iam.staff_role.manage at the exact path school', async () => {
  const c = qContext(); let asked;
  const db = { resolveAuthorizedScope: async (subject, school, permission) => { asked = permission; return school === c.schoolId ? { organizationId: c.organizationId, schoolId: c.schoolId, principalId: c.principalId } : undefined; } };
  const controller = new StaffRoleController(db, { assignablePermissions: async () => [perm()] });
  const request = { honIdentity: { externalSubject: 'verified-human' } };
  assert.deepEqual((await controller.permissions(c.organizationId, c.schoolId, request)).data, [perm()]);
  assert.equal(asked, 'iam.staff_role.manage');
  await assert.rejects(() => controller.permissions(id(), c.schoolId, request), (e) => e.getStatus() === 403);
  await assert.rejects(() => controller.permissions(c.organizationId, id(), request), (e) => e.getStatus() === 403);
});
