const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolPickersService, SchoolPickersController, ENROLLMENT_PURPOSES, CANDIDATE_PURPOSES, STUDENT_PURPOSES, RANK_PURPOSES } = require('../dist/school-pickers/school-pickers.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const request = { honIdentity: { externalSubject: 'verified-human' } };
const response = () => { const headers = {}; return { headers, setHeader: (k, v) => { headers[k] = v; } }; };
const status = (expected) => (e) => typeof e.getStatus === 'function' && e.getStatus() === expected;

/** A fake database that records every statement; the first query is the in-transaction authority re-check. */
function fakeDb({ grant = () => scope, again = () => scope, rows = [], entitled = true } = {}) {
  const calls = { resolve: [], sql: [] };
  return { calls, db: {
    resolveAuthorizedScope: async (subject, school, permission) => { calls.resolve.push({ subject, school, permission }); return grant(permission); },
    withTenantTransaction: async (context, work) => work({ query: async (sql, values) => {
      calls.sql.push({ sql, values });
      if (sql.includes('resolve_authorized_scope')) { const s = again(values[2]); return { rows: s ? [{ principal_id: s.principalId, organization_id: s.organizationId, school_id: s.schoolId }] : [] }; }
      if (sql.includes('read_current_organization_entitlement')) return { rows: entitled ? [{ tier: entitled === true ? 'CORE' : entitled }] : [] };
      if (sql.startsWith('SET LOCAL') || sql.includes("set_config('app.hon_source'")) return { rows: [] };
      return { rows };
    } }),
  } };
}
const controller = (f) => new SchoolPickersController(f.db, new SchoolPickersService(f.db));

test('each list is checked against the permission of the screen it feeds, before and inside the read', async () => {
  for (const [purpose, permission] of Object.entries(ENROLLMENT_PURPOSES)) {
    const f = fakeDb(); await controller(f).enrollments(scope.organizationId, scope.schoolId, purpose, undefined, undefined, request, response());
    assert.equal(f.calls.resolve[0].permission, permission);
    assert.deepEqual(f.calls.sql[0].values, ['verified-human', scope.schoolId, permission]);
  }
  for (const [purpose, permission] of Object.entries(CANDIDATE_PURPOSES)) {
    const f = fakeDb(); await controller(f).candidates(scope.organizationId, scope.schoolId, purpose, undefined, request, response());
    assert.equal(f.calls.resolve[0].permission, permission); assert.equal(f.calls.sql[0].values[2], permission);
  }
  const f = fakeDb(); await controller(f).testingEvents(scope.organizationId, scope.schoolId, request, response());
  assert.equal(f.calls.resolve[0].permission, 'testing.manage');
  assert.deepEqual(ENROLLMENT_PURPOSES, { progress: 'curriculum.progress.record', readiness: 'testing.promotion.readiness.read', testing: 'testing.manage' });
  assert.deepEqual(CANDIDATE_PURPOSES, { grade: 'testing.manage', decision: 'testing.promotion.decide' });
});

test('a missing, other-school or revoked grant reads nothing, and an unknown purpose or bad input is refused before any read', async () => {
  const other = { ...scope, organizationId: randomUUID() };
  for (const f of [fakeDb({ grant: () => undefined }), fakeDb({ grant: () => other })]) {
    await assert.rejects(controller(f).enrollments(scope.organizationId, scope.schoolId, 'progress', undefined, undefined, request, response()), status(403));
    assert.equal(f.calls.sql.length, 0);
  }
  const revoked = fakeDb({ again: () => undefined, rows: [{ enrollmentId: randomUUID() }] });
  await assert.rejects(controller(revoked).candidates(scope.organizationId, scope.schoolId, 'grade', undefined, request, response()), status(403));
  assert.equal(revoked.calls.sql.length, 1, 'only the re-check ran');
  await assert.rejects(controller(fakeDb()).enrollments(scope.organizationId, scope.schoolId, 'progress', undefined, undefined, { }, response()), status(403));
  for (const bad of [undefined, 'admin', 'toString', ['progress']]) {
    const f = fakeDb(); await assert.rejects(controller(f).enrollments(scope.organizationId, scope.schoolId, bad, undefined, undefined, request, response()), status(400)); assert.equal(f.calls.resolve.length, 0);
  }
  for (const bad of [undefined, 'decide', '__proto__']) await assert.rejects(controller(fakeDb()).candidates(scope.organizationId, scope.schoolId, bad, undefined, request, response()), status(400));
  for (const [curriculum, search] of [['not-a-uuid', undefined], [undefined, 'x'.repeat(121)], [undefined, 'a\u0000b'], [undefined, ['a']]]) {
    const f = fakeDb(); await assert.rejects(controller(f).enrollments(scope.organizationId, scope.schoolId, 'progress', curriculum, search, request, response()), status(400)); assert.equal(f.calls.resolve.length, 0);
  }
});

test('reads are exact-school, active-only, bounded, private, and treat search as plain text', async () => {
  const curriculum = randomUUID().toUpperCase();
  const f = fakeDb({ rows: [{ enrollmentId: 'e' }] }); const res = response();
  const body = await controller(f).enrollments(scope.organizationId, scope.schoolId, 'testing', curriculum, '  Kim_%  ', request, res);
  assert.deepEqual(body.data, [{ enrollmentId: 'e' }]); assert.equal(body.meta.limit, 50); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  const read = f.calls.sql.find((c) => c.sql.includes('student_curriculum_enrollments'));
  assert.deepEqual(read.values, [scope.organizationId, scope.schoolId, 'Kim_%', curriculum.toLowerCase()]);
  assert.match(read.sql, /e\.organization_id = \$1 AND e\.school_id = \$2 AND e\.status = 'ACTIVE' AND s\.status = 'ACTIVE'/);
  assert.match(read.sql, /LIMIT 50/); assert.match(read.sql, /replace\(replace\(replace\(\$3::text/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(f.calls.sql.map((c) => c.sql).join('\n')), 'read-only');
  const g = fakeDb(); await controller(g).candidates(scope.organizationId, scope.schoolId, 'grade', '', request, response());
  const grade = g.calls.sql.find((c) => c.sql.includes('testing_candidates'));
  assert.match(grade.sql, /k\.result = 'PENDING'/); assert.equal(grade.values[2], null);
  const d = fakeDb(); await controller(d).candidates(scope.organizationId, scope.schoolId, 'decision', undefined, request, response());
  const decision = d.calls.sql.find((c) => c.sql.includes('testing_candidates')).sql;
  assert.match(decision, /NOT EXISTS \(SELECT 1 FROM hon\.promotion_decisions/);
  assert.ok(!decision.includes('PENDING_INSTRUCTOR_DECISION'), 'any decision row hides the candidate, as the decide command refuses it');
  const t = fakeDb(); await controller(t).testingEvents(scope.organizationId, scope.schoolId, request, response());
  assert.match(t.calls.sql.find((c) => c.sql.includes('testing_events')).sql, /t\.status IN \('DRAFT', 'OPEN', 'CLOSED'\)/);
});

test('a school without an active, in-window entitlement lists nothing on every endpoint', async () => {
  const calls = [
    (c) => c.enrollments(scope.organizationId, scope.schoolId, 'progress', undefined, undefined, request, response()),
    (c) => c.enrollments(scope.organizationId, scope.schoolId, 'readiness', undefined, undefined, request, response()),
    (c) => c.testingEvents(scope.organizationId, scope.schoolId, request, response()),
    (c) => c.candidates(scope.organizationId, scope.schoolId, 'grade', undefined, request, response()),
    (c) => c.candidates(scope.organizationId, scope.schoolId, 'decision', undefined, request, response()),
    (c) => c.students(scope.organizationId, scope.schoolId, 'teaching', undefined, request, response()),
    (c) => c.ranks(scope.organizationId, scope.schoolId, 'teaching', request, response()),
  ];
  for (const call of calls) {
    for (const entitled of [false, 'UNKNOWN_TIER']) {
      const f = fakeDb({ entitled, rows: [{ enrollmentId: randomUUID() }] });
      await assert.rejects(call(controller(f)), (e) => status(403)(e) && e.getResponse().code === 'TIER_ENTITLEMENT_REQUIRED');
      assert.equal(f.calls.sql.length, 2, 'only the authority and entitlement checks ran');
      assert.equal(f.calls.sql[1].sql, 'SELECT tier FROM hon.read_current_organization_entitlement()');
      assert.deepEqual(f.calls.sql[1].values, [], 'the boundary takes no organization, school, tier or time selector');
    }
    for (const tier of ['ESSENTIAL', 'CORE', 'COMPLETE']) await call(controller(fakeDb({ entitled: tier })));
  }
});

test('Teaching studio lists: students and ranks by name, checked against teaching.studio.read before and inside the read', async () => {
  assert.deepEqual(STUDENT_PURPOSES, { teaching: 'teaching.studio.read' });
  assert.deepEqual(RANK_PURPOSES, { teaching: 'teaching.studio.read' });
  const f = fakeDb({ rows: [{ studentProfileId: 's' }] }); const res = response();
  const body = await controller(f).students(scope.organizationId, scope.schoolId, 'teaching', '  Kim_%  ', request, res);
  assert.deepEqual(body.data, [{ studentProfileId: 's' }]); assert.equal(body.meta.limit, 50); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.calls.resolve[0].permission, 'teaching.studio.read'); assert.deepEqual(f.calls.sql[0].values, ['verified-human', scope.schoolId, 'teaching.studio.read']);
  const read = f.calls.sql.find((c) => c.sql.includes('hon.student_profiles'));
  assert.deepEqual(read.values, [scope.organizationId, scope.schoolId, 'Kim_%']);
  assert.match(read.sql, /s\.organization_id = \$1 AND s\.school_id = \$2 AND s\.status = 'ACTIVE'/);
  assert.match(read.sql, /LIMIT 50/); assert.match(read.sql, /replace\(replace\(replace\(\$3::text/);
  const r = fakeDb({ rows: [{ rankId: 'r' }] });
  const ranks = await controller(r).ranks(scope.organizationId, scope.schoolId, 'teaching', request, response());
  assert.deepEqual(ranks.data, [{ rankId: 'r' }]); assert.equal(ranks.meta.limit, 200); assert.equal(r.calls.resolve[0].permission, 'teaching.studio.read');
  const rankRead = r.calls.sql.find((c) => c.sql.includes('hon.curriculum_ranks'));
  assert.deepEqual(rankRead.values, [scope.organizationId, scope.schoolId]); assert.match(rankRead.sql, /LIMIT 200/);
  assert.match(rankRead.sql, /c\.organization_id = \$1 AND c\.school_id = \$2 AND c\.lifecycle <> 'ARCHIVED'/);
  assert.match(rankRead.sql, /r\.curriculum_id = c\.id AND r\.organization_id = c\.organization_id AND r\.school_id = c\.school_id/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test([...f.calls.sql, ...r.calls.sql].map((c) => c.sql).join('\n')), 'read-only');
  for (const bad of [undefined, 'progress', 'toString', ['teaching']]) {
    const g = fakeDb(); await assert.rejects(controller(g).students(scope.organizationId, scope.schoolId, bad, undefined, request, response()), status(400)); assert.equal(g.calls.resolve.length, 0);
    const h = fakeDb(); await assert.rejects(controller(h).ranks(scope.organizationId, scope.schoolId, bad, request, response()), status(400)); assert.equal(h.calls.resolve.length, 0);
  }
  for (const f2 of [fakeDb({ grant: () => undefined }), fakeDb({ again: () => undefined })]) {
    await assert.rejects(controller(f2).students(scope.organizationId, scope.schoolId, 'teaching', undefined, request, response()), status(403));
    assert.ok(!f2.calls.sql.some((c) => c.sql.includes('hon.student_profiles')));
  }
});

test('staff list: teammates by name through the fixed 0404 boundary, checked against each screen permission', async () => {
  const { STAFF_PURPOSES } = require('../dist/school-pickers/school-pickers.js');
  assert.deepEqual(STAFF_PURPOSES, { followups: 'crm.follow_up.manage', work: 'work_item.manage', qualifications: 'staff.instructor_qualification.manage',
    roles: 'iam.staff_role.grant', availability: 'staff.availability.manage' });
  for (const [purpose, permission] of Object.entries(STAFF_PURPOSES)) {
    const items = [{ principalId: randomUUID(), displayName: 'Coach Kim' }];
    const f = fakeDb({ rows: [{ data: { items } }] }); const res = response();
    const body = await controller(f).staff(scope.organizationId, scope.schoolId, purpose, request, res);
    assert.deepEqual(body.data, items); assert.equal(body.meta.limit, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(f.calls.resolve[0].permission, permission); assert.equal(f.calls.sql[0].values[2], permission);
    const read = f.calls.sql.find((c) => c.sql.includes('list_school_staff_for_picker'));
    assert.equal(read.sql, 'SELECT hon.list_school_staff_for_picker($1, $2) AS data'); assert.deepEqual(read.values, ['verified-human', permission]);
  }
  for (const bad of [undefined, 'teaching', 'toString', ['work']]) {
    const g = fakeDb(); await assert.rejects(controller(g).staff(scope.organizationId, scope.schoolId, bad, request, response()), status(400)); assert.equal(g.calls.resolve.length, 0);
  }
  const revoked = fakeDb({ again: () => undefined });
  await assert.rejects(controller(revoked).staff(scope.organizationId, scope.schoolId, 'work', request, response()), status(403));
  assert.ok(!revoked.calls.sql.some((c) => c.sql.includes('list_school_staff_for_picker')));
  const lapsed = fakeDb({ entitled: false });
  await assert.rejects(controller(lapsed).staff(scope.organizationId, scope.schoolId, 'work', request, response()), status(403));
  for (const data of [null, { items: 'x' }, { items: [{ principalId: 'x', displayName: 'A' }] }, { items: [{ principalId: randomUUID(), displayName: '' }] }, { items: [{ principalId: randomUUID(), displayName: 'A', email: 'a@b' }] }]) {
    await assert.rejects(controller(fakeDb({ rows: [{ data }] })).staff(scope.organizationId, scope.schoolId, 'work', request, response()));
  }
});
