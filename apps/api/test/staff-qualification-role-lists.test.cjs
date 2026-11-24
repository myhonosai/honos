require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { InstructorQualificationsService } = require('../dist/instructor-qualifications/instructor-qualifications.service.js');
const { InstructorQualificationsController } = require('../dist/instructor-qualifications/instructor-qualifications.controller.js');
const { StaffRoleService, parseStaffRoleLists } = require('../dist/staff-roles/staff-role.service.js');
const { StaffRoleController } = require('../dist/staff-roles/staff-role.controller.js');

// 0406 (owner 2026-11-16): staff pick qualifications, evidence, roles and grants from lists instead of typing UUIDs.
const id = () => randomUUID();
const staffId = id(), qualificationId = id();
const qContext = (patch = {}) => ({ organizationId: id(), schoolId: id(), principalId: id(), externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id(), correlationId: id(), idempotencyKey: 'read-key', ...patch });
const definition = (patch = {}) => ({ id: qualificationId, code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: null, version: 1, status: 'ACTIVE', humanRecordedOnly: true, qualificationOnly: true, ...patch });
const evidence = (patch = {}) => ({ id: id(), staffPrincipalId: staffId, qualificationId, qualificationVersion: 1, courseProgramId: null, kind: 'QUALIFICATION', attainedOn: '2026-01-10', expiresOn: null, evidenceRecordedAt: '2026-01-10T00:00:00.000Z', evidenceRecorded: true, reviewVersion: 1, reviewStatus: 'RECORDED', reviewedAt: '2026-01-10T00:00:00.000Z', expiredOnRead: false, humanRecordedOnly: true, qualificationOnly: true, notEligibility: true, ...patch });
function qDatabase(data, calls = []) {
  const run = async (_c, work) => work({ query: async (sql, args) => { calls.push([sql, args]); return sql.startsWith('SELECT hon.list_instructor_qualifications') ? { rows: [{ data: data(sql) }] } : { rows: [] }; } });
  return { withTenantReadOnlyTransaction: run, withTenantTransaction: run, resolveInstructorQualificationScope: async () => ({ organizationId: id(), schoolId: id(), principalId: id() }) };
}

test('qualification lists read the fixed 0406 boundary read-only and accept only closed, bounded, unique rows', async () => {
  const calls = [], rows = { DEFINITIONS: [definition()], STAFF: [{ principalId: staffId, displayName: 'Coach Rae', evidenceCount: 2 }], EVIDENCE: [evidence(), evidence()] };
  const service = new InstructorQualificationsService(qDatabase((sql) => ({ items: rows[/'(\w+)'/.exec(sql)[1]] }), calls));
  assert.deepEqual(await service.definitions(qContext()), rows.DEFINITIONS);
  assert.deepEqual(await service.staff(qContext()), rows.STAFF);
  assert.equal((await service.evidenceList(qContext(), staffId.toUpperCase())).length, 2);
  const sql = calls.filter(([s]) => s.startsWith('SELECT hon.list')).map(([s, a]) => [s, a.length]);
  assert.deepEqual(sql, [["SELECT hon.list_instructor_qualifications($1,'DEFINITIONS',NULL) data", 1], ["SELECT hon.list_instructor_qualifications($1,'STAFF',NULL) data", 1], ["SELECT hon.list_instructor_qualifications($1,'EVIDENCE',$2::uuid) data", 2]]);
  assert.equal(calls.find(([s]) => s.includes("'EVIDENCE'"))[1][1], staffId, 'staff id is passed lower-case');
  for (const bad of [
    { DEFINITIONS: [definition({ actorPrincipalId: id() })] }, { DEFINITIONS: [definition(), definition()] }, { DEFINITIONS: Array.from({ length: 201 }, () => definition({ id: id() })) },
    { STAFF: [{ principalId: staffId, displayName: 'Coach Rae', evidenceCount: 1, email: 'x@example.test' }] }, { STAFF: [{ principalId: 'nope', displayName: 'x', evidenceCount: 0 }] },
    { EVIDENCE: [evidence({ staffPrincipalId: id() })] }, { EVIDENCE: [evidence({ evidenceReference: 'private' })] }, { EVIDENCE: Array.from({ length: 101 }, () => evidence()) },
  ]) {
    const [mode, list] = Object.entries(bad)[0];
    const s = new InstructorQualificationsService(qDatabase(() => ({ items: list })));
    await assert.rejects(() => mode === 'DEFINITIONS' ? s.definitions(qContext()) : mode === 'STAFF' ? s.staff(qContext()) : s.evidenceList(qContext(), staffId), /Unsafe/);
  }
  await assert.rejects(() => new InstructorQualificationsService(qDatabase(() => ({ items: [], extra: 1 }))).definitions(qContext()), /Unsafe/);
  const blocked = new InstructorQualificationsService({ withTenantReadOnlyTransaction: () => { throw new Error('must not reach SQL'); } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { actionRequestId: id() }, { delegatedByPrincipalId: id() }]) await assert.rejects(() => blocked.definitions(qContext(patch)), (e) => e.getStatus() === 403);
  await assert.rejects(() => new InstructorQualificationsService({ withTenantReadOnlyTransaction: async () => { throw { code: '42501' }; } }).staff(qContext()), (e) => e.getStatus() === 403);
});

test('qualification list routes derive scope from the session and validate the staff id', async () => {
  const controller = new InstructorQualificationsController(qDatabase(() => ({ items: [] })), new InstructorQualificationsService(qDatabase(() => ({ items: [] }))));
  const request = { honIdentity: { externalSubject: 'verified-human' } };
  assert.deepEqual((await controller.definitions(request)).data, []);
  assert.deepEqual((await controller.staff(request)).data, []);
  assert.deepEqual((await controller.evidenceList(staffId, request)).data, []);
  await assert.rejects(() => controller.evidenceList('not-a-uuid', request), (e) => e.getStatus() === 400);
  await assert.rejects(() => controller.definitions({}), (e) => e.getStatus() === 403);
});

const role = (patch = {}) => ({ id: id(), code: 'CUSTOM_DESK', name: 'Front desk', version: 1, permissionCodes: ['school.view'], ...patch });
const grant = (patch = {}) => ({ id: id(), roleId: id(), roleName: 'Front desk', principalId: id(), displayName: 'Coach Rae', version: 1, effectiveFrom: '2026-11-01T00:00:00+00:00', effectiveUntil: null, ...patch });
test('staff role lists accept only custom roles and current grants in closed, bounded shapes', async () => {
  const lists = { roles: [role()], grants: [grant(), grant({ effectiveUntil: '2026-12-01T00:00:00+00:00' })] };
  assert.deepEqual(parseStaffRoleLists(lists), lists);
  for (const bad of [{ ...lists, extra: [] }, { roles: [role({ code: 'OWNER' })], grants: [] }, { roles: [role({ code: 'HQ_SUPPORT' })], grants: [] }, { roles: [role({ isSystemRole: true })], grants: [] },
    { roles: [], grants: [grant({ externalSubject: 'subject' })] }, { roles: [], grants: [grant({ effectiveFrom: 'soon' })] }, { roles: Array.from({ length: 201 }, () => role()), grants: [] }, { roles: [], grants: (() => { const g = grant(); return [g, g]; })() }])
    assert.throws(() => parseStaffRoleLists(bad), /Unsafe/);
  const calls = [], c = qContext({ idempotencyKey: 'read' });
  const service = new StaffRoleService({ withTenantTransaction: async (ctx, work) => { assert.equal(ctx, c); return work({ query: async (sql, args) => { calls.push([sql, args]); return { rows: [{ data: lists }] }; } }); } });
  assert.deepEqual(await service.lists(c), lists);
  assert.match(calls[0][0], /set_config\('app.hon_source','HUMAN_UI'/); assert.deepEqual(calls.at(-1), ['SELECT hon.list_staff_roles($1) AS data', [c.externalSubject]]);
  await assert.rejects(() => new StaffRoleService({ withTenantTransaction: () => { throw new Error('no'); } }).lists({ ...c, source: 'AI' }), (e) => e.getStatus() === 403);
});

test('staff role lists route requires iam.staff_role.manage at the exact path school', async () => {
  const c = qContext(); let asked;
  const db = { resolveAuthorizedScope: async (subject, school, permission) => { asked = permission; return school === c.schoolId ? { organizationId: c.organizationId, schoolId: c.schoolId, principalId: c.principalId } : undefined; } };
  const controller = new StaffRoleController(db, { lists: async () => ({ roles: [], grants: [] }) });
  const request = { honIdentity: { externalSubject: 'verified-human' } };
  assert.deepEqual((await controller.lists(c.organizationId, c.schoolId, request)).data, { roles: [], grants: [] });
  assert.equal(asked, 'iam.staff_role.manage');
  await assert.rejects(() => controller.lists(id(), c.schoolId, request), (e) => e.getStatus() === 403);
  await assert.rejects(() => controller.lists(c.organizationId, id(), request), (e) => e.getStatus() === 403);
});
