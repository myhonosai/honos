import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HQ goes inside a school (0696) integrity proof, TEST MODE, disposable database only. It proves: runtime holds only the three
// entry points and no table access; only a current HQ owner or an hq.onboarding.manage operator goes inside (view-only operators,
// HQ support, plain school owners, ended HQ grants and unknown subjects refused); Go inside makes the organization's SUPPORT_VISIT
// system role (OWNER permissions minus school_pay.connection.manage and billing.hon.purchase) and a 4-hour grant, with HQ and
// school logs; an HQ person is refused by school features before the visit, let through during it (contacts actor, staff
// eligibility) and refused again after Leave or expiry; money settings stay refused during the visit; replay, key reuse, extend,
// leave-twice, paused school, own-visits read and immutable evidence; every lifted function carries the visit check.
await import('./test-champions-proof-target.mjs');
const targets = championsProofTargets(process.env);
if (Object.keys(process.env).some(key => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('Provider credentials/execution switches are forbidden.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { HqSchoolVisitService } = await import('../../../apps/api/dist/hq/hq-school-visit.js');
const database = new RuntimeDatabaseService(), visits = new HqSchoolVisitService(database);
const admin = new pg.Client(targets.owner), restricted = new pg.Client(targets.runtime);
const http = (n, code) => e => { assert.equal(e.getStatus?.(), n, e.stack); if (code) assert.equal(e.getResponse().code, code); return true; };
const deny = (p, n, code) => assert.rejects(p, http(n, code));
const ORG = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), OWNER_ROLE = randomUUID();
const humans = Object.fromEntries(['hq', 'onboarder', 'viewer', 'support', 'schoolOwner', 'ended'].map(k => [k, { id: randomUUID(), user: randomUUID(), subject: `hqv-${k}-${randomUUID()}` }]));
const H = k => humans[k].subject, P = k => humans[k].id;
const q = (sql, params) => admin.query(sql, params);
const row = async (sql, params) => (await q(sql, params)).rows[0];
const evidence = ['hq_school_visit_outbox', 'hq_school_visit_audit', 'hq_school_visits', 'hq_school_visit_requests'];
async function cleanup() {
  await q('ROLLBACK').catch(() => {});
  await q('BEGIN');
  try {
    const ps = Object.values(humans).map(h => h.id), us = Object.values(humans).map(h => h.user);
    for (const t of evidence) await q(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    await q('DELETE FROM hon.hq_school_visit_outbox WHERE audit_id IN (SELECT id FROM hon.hq_school_visit_audit WHERE organization_id=$1)', [ORG]);
    await q('DELETE FROM hon.hq_school_visit_audit WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.hq_school_visits WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.hq_school_visit_requests WHERE actor_principal_id=ANY($1::uuid[])', [ps]);
    for (const t of evidence) await q(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await q('DELETE FROM hon.audit_events WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.principal_role_grants WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.role_permissions WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.roles WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.organization_entitlements WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.schools WHERE organization_id=$1', [ORG]);
    await q('DELETE FROM hon.organizations WHERE id=$1', [ORG]);
    await q('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await q('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await q('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await q('COMMIT');
  } catch (e) { await q('ROLLBACK'); throw e; }
}
const enter = (who, school, body = {}, key = randomUUID()) => visits.enter(H(who), school, body, key);
const leave = (who, school, key = randomUUID()) => visits.leave(H(who), school, {}, key);
/** The contacts feature's own actor check, run with the same session settings the API sets for a school request. */
async function contactsActor(who, school) {
  await q('BEGIN');
  try {
    for (const [k, v] of [['app.hon_external_subject', H(who)], ['app.hon_principal_id', P(who)], ['app.hon_principal_type', 'HUMAN_USER'],
      ['app.hon_source', 'HUMAN_UI'], ['app.hon_organization_id', ORG], ['app.hon_school_id', school]]) await q('SELECT set_config($1,$2,true)', [k, v]);
    return (await row('SELECT hon.require_school_contacts_actor($1) a', [H(who)])).a;
  } catch (e) { if (e.code === '42501') return null; throw e; }
  finally { await q('ROLLBACK'); }
}
const eligible = async (who, school) => (await row('SELECT hon.staff_member_eligible($1,$2,$3) e', [P(who), ORG, school])).e;
const can = async (who, school, perm) => (await row('SELECT hon.principal_has_school_permission($1,$2,$3,$4) c', [P(who), ORG, school, perm])).c;

await Promise.all([admin.connect(), restricted.connect()]);
await verifyChampionsProofConnection(admin, CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted, CHAMPIONS_RUNTIME_ROLE);
try {
  // ---------- 0. posture ----------
  for (const [sig, allowed] of [['enter_school_as_hq(text,uuid,text,uuid,uuid,uuid)', true], ['leave_school_as_hq(text,uuid,uuid,uuid,uuid)', true],
    ['read_my_hq_school_visits(text)', true], ['hq_visit_active(uuid)', false], ['ensure_hq_support_role(uuid)', false],
    ['require_hq_school_visit_actor(text)', false], ['guard_hq_school_visit_evidence()', false]]) {
    assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).rows[0].a, allowed, sig);
  }
  for (const t of evidence) {
    assert.equal((await restricted.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') a", ['hon.' + t])).rows[0].a, false, t);
    assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass", ['hon.' + t]), { r: true, f: true });
  }
  // Every lifted check carries the visit test; the kept HQ-only, invitation, sign-up and service checks do not.
  assert.equal((await row("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND prosrc LIKE '%hon.hq_visit_active(%'")).n, 63);
  for (const kept of ['accept_school_owner_invitation', 'resolve_staff_role_target', 'require_support_request_actor', 'submit_public_form', 'hq_message_owner_recipients']) {
    assert.equal((await row("SELECT bool_or(prosrc LIKE '%hq_visit_active%') v FROM pg_proc WHERE proname=$1", [kept])).v, false, kept);
  }
  await cleanup();

  // ---------- fixture ----------
  for (const k of Object.keys(humans)) {
    await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [humans[k].user, H(k), `${k}-${humans[k].user}@example.test`, `PRIVATE_${k}`]);
    await q("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [P(k), humans[k].user, `PRIVATE_${k}`]);
  }
  await q(`INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES
    (gen_random_uuid(),$1,'HON_HQ_OWNER','{}',now()-interval '1 day',NULL),
    (gen_random_uuid(),$2,'HON_HQ_OPERATOR',ARRAY['hq.onboarding.manage'],now()-interval '1 day',NULL),
    (gen_random_uuid(),$3,'HON_HQ_OPERATOR',ARRAY['hq.dashboard.view'],now()-interval '1 day',NULL),
    (gen_random_uuid(),$4,'HON_HQ_SUPPORT',ARRAY['hq.dashboard.view'],now()-interval '1 day',NULL),
    (gen_random_uuid(),$5,'HON_HQ_OWNER','{}',now()-interval '2 days',now()-interval '1 day')`, [P('hq'), P('onboarder'), P('viewer'), P('support'), P('ended')]);
  await q("INSERT INTO hon.organizations(id,legal_name,display_name,status) VALUES($1,'PRIVATE_LEGAL','Harbor Org','ACTIVE')", [ORG]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug,status) VALUES($1,$2,'Harbor North',$4,'ACTIVE'),($3,$2,'Harbor South',$5,'ACTIVE')", [S1, ORG, S2, `hqv-n-${S1.slice(0, 8)}`, `hqv-s-${S2.slice(0, 8)}`]);
  await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','ACTIVE')", [ORG]);
  await q("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [OWNER_ROLE, ORG]);
  await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [OWNER_ROLE, ORG]);
  await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [ORG, S1, P('schoolOwner'), OWNER_ROLE]);
  // The HQ person is also an owner of Harbor South (like an HQ owner who runs a school of their own).
  await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [ORG, S2, P('hq'), OWNER_ROLE]);

  // ---------- 1. before any visit: HQ logins are refused by school features, school owners are not ----------
  assert.equal(await contactsActor('schoolOwner', S1), P('schoolOwner'));
  assert.equal(await contactsActor('hq', S2), null, 'HQ owner refused at their own school without a visit');
  assert.equal(await eligible('hq', S2), false);
  assert.equal(await contactsActor('hq', S1), null);

  // ---------- 2. authority ----------
  for (const who of ['viewer', 'support', 'schoolOwner', 'ended']) await deny(enter(who, S1), 403, 'HQ_SCHOOL_VISIT_FORBIDDEN');
  await deny(visits.enter('hqv-unknown-subject', S1, {}, randomUUID()), 403, 'HQ_SCHOOL_VISIT_FORBIDDEN');
  await deny(enter('hq', randomUUID()), 404, 'HQ_SCHOOL_VISIT_UNAVAILABLE');
  await deny(enter('hq', S1, { reason: 'x'.repeat(301) }), 400);
  await deny(enter('hq', S1, { extra: 1 }), 400);
  assert.equal((await row('SELECT count(*)::int n FROM hon.hq_school_visit_requests WHERE actor_principal_id=ANY($1::uuid[])', [Object.values(humans).map(h => h.id)])).n, 0);

  // ---------- 3. Go inside ----------
  const key = randomUUID();
  const first = await enter('hq', S1, { reason: 'Help with class setup' }, key);
  assert.equal(first.action, 'ENTER'); assert.equal(first.schoolId, S1); assert.equal(first.organizationId, ORG); assert.equal(first.replayed, false);
  const hours = (Date.parse(first.endsAt) - Date.parse(first.startedAt)) / 3600000;
  assert.ok(Math.abs(hours - 4) < 0.001, `4 hours, got ${hours}`);
  const role = await row("SELECT id,name,is_system_role s,management_school_id m FROM hon.roles WHERE organization_id=$1 AND code='SUPPORT_VISIT'", [ORG]);
  assert.deepEqual({ name: role.name, s: role.s, m: role.m }, { name: 'HON HQ support', s: true, m: null });
  const missing = (await q('SELECT o.permission_code c FROM hon.role_permissions o WHERE o.role_id=$1 AND NOT EXISTS (SELECT 1 FROM hon.role_permissions r WHERE r.role_id=$2 AND r.permission_code=o.permission_code) ORDER BY 1', [OWNER_ROLE, role.id])).rows.map(r => r.c);
  assert.deepEqual(missing, ['billing.hon.purchase', 'school_pay.connection.manage']);
  const grant = await row('SELECT g.* FROM hon.principal_role_grants g JOIN hon.hq_school_visits v ON v.role_grant_id=g.id WHERE v.id=$1', [first.visitId]);
  assert.equal(grant.principal_id, P('hq')); assert.equal(grant.role_id, role.id); assert.equal(grant.school_id, S1); assert.equal(grant.revoked_at, null);
  assert.deepEqual(await row("SELECT action_code a,reason r FROM hon.hq_school_visit_audit WHERE visit_id=$1", [first.visitId]), { a: 'ENTER', r: 'Help with class setup' });
  assert.equal((await row("SELECT count(*)::int n FROM hon.hq_school_visit_outbox o JOIN hon.hq_school_visit_audit a ON a.id=o.audit_id WHERE a.visit_id=$1", [first.visitId])).n, 1);
  assert.deepEqual(await row("SELECT source s,action_code a,entity_type t,actor_principal_id p FROM hon.audit_events WHERE organization_id=$1 AND school_id=$2", [ORG, S1]),
    { s: 'HON_HQ', a: 'hq.school.visit.entered', t: 'HQ_SCHOOL_VISIT', p: P('hq') });
  // Replay and key reuse.
  const again = await enter('hq', S1, { reason: 'Help with class setup' }, key);
  assert.equal(again.replayed, true); assert.equal(again.visitId, first.visitId);
  await deny(enter('hq', S1, { reason: 'Something else' }, key), 409, 'IDEMPOTENCY_KEY_REUSED');

  // ---------- 4. during the visit: features let HQ through, money settings stay with the owner ----------
  assert.equal(await contactsActor('hq', S1), P('hq'));
  assert.equal(await eligible('hq', S1), true);
  assert.equal(await contactsActor('hq', S2), P('hq'), 'the HQ person\'s own school works while they have a live visit');
  for (const perm of ['people.read', 'school.view', 'billing.invoice.issue']) assert.equal(await can('hq', S1, perm), true, perm);
  for (const perm of ['school_pay.connection.manage', 'billing.hon.purchase']) assert.equal(await can('hq', S1, perm), false, perm);
  // The visit grants nothing at another school of the organization.
  assert.equal((await row("SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id=$1 AND school_id=$2 AND role_id=$3", [P('hq'), S2, role.id])).n, 0);
  // A second HQ person's visit is their own.
  const other = await enter('onboarder', S1);
  assert.notEqual(other.visitId, first.visitId);
  const mine = await visits.mine(H('hq'));
  assert.deepEqual(mine.visits.map(v => [v.visitId, v.schoolId, v.schoolName]), [[first.visitId, S1, 'Harbor North']]);
  assert.deepEqual((await visits.mine(H('schoolOwner'))).visits, []);

  // ---------- 5. stay longer ----------
  await q("UPDATE hon.principal_role_grants SET effective_from=effective_from-interval '1 hour', effective_until=effective_until-interval '1 hour', created_at=created_at-interval '1 hour' WHERE id=$1", [grant.id]);
  const extended = await enter('hq', S1);
  assert.equal(extended.action, 'EXTEND'); assert.equal(extended.visitId, first.visitId);
  assert.ok(Date.parse(extended.endsAt) > Date.parse(first.endsAt) - 3600000 + 1000);
  assert.equal((await row('SELECT count(*)::int n FROM hon.hq_school_visits WHERE hq_principal_id=$1 AND school_id=$2', [P('hq'), S1])).n, 1);

  // ---------- 6. Leave ----------
  const left = await leave('hq', S1);
  assert.equal(left.left, true); assert.equal(left.visitId, first.visitId);
  assert.notEqual((await row('SELECT revoked_at FROM hon.principal_role_grants WHERE id=$1', [grant.id])).revoked_at, null);
  assert.equal(await contactsActor('hq', S1), null);
  assert.equal(await contactsActor('hq', S2), null, 'back to refused at their own school once no visit is live');
  assert.equal(await eligible('hq', S1), false);
  const before = await row('SELECT (SELECT count(*) FROM hon.hq_school_visit_audit)::int a,(SELECT count(*) FROM hon.audit_events)::int e');
  assert.deepEqual(await leave('hq', S1), { schoolId: S1, left: false, replayed: false });
  assert.deepEqual(await row('SELECT (SELECT count(*) FROM hon.hq_school_visit_audit)::int a,(SELECT count(*) FROM hon.audit_events)::int e'), before);
  assert.equal(await row("SELECT action_code a FROM hon.audit_events WHERE school_id=$1 ORDER BY occurred_at DESC LIMIT 1", [S1]).then(r => r.a), 'hq.school.visit.left');

  // ---------- 7. expiry: an ended grant lets nothing through, and Go inside starts a fresh visit ----------
  const fresh = await enter('hq', S1);
  assert.equal(fresh.action, 'ENTER'); assert.notEqual(fresh.visitId, first.visitId);
  await q("UPDATE hon.principal_role_grants SET effective_from=now()-interval '5 hours', effective_until=now()-interval '1 hour' WHERE id=(SELECT role_grant_id FROM hon.hq_school_visits WHERE id=$1)", [fresh.visitId]);
  assert.equal(await contactsActor('hq', S1), null);
  assert.equal((await row('SELECT hon.hq_visit_active($1) a', [P('hq')])).a, false);
  const after = await enter('hq', S1);
  assert.equal(after.action, 'ENTER'); assert.notEqual(after.visitId, fresh.visitId);
  assert.notEqual((await row('SELECT left_at FROM hon.hq_school_visits WHERE id=$1', [fresh.visitId])).left_at, null);
  await leave('hq', S1); await leave('onboarder', S1);

  // ---------- 8. paused school, money permission re-sync ----------
  await q("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [S1]);
  await deny(enter('hq', S1), 404, 'HQ_SCHOOL_VISIT_UNAVAILABLE');
  await q("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [S1]);
  await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'school_pay.connection.manage')", [role.id, ORG]);
  await enter('hq', S1);
  assert.equal(await can('hq', S1, 'school_pay.connection.manage'), false, 're-synced on entry');
  await leave('hq', S1);

  // ---------- 9. evidence is immutable ----------
  for (const sql of ["UPDATE hon.hq_school_visit_audit SET reason='x' WHERE organization_id=$1", 'DELETE FROM hon.hq_school_visit_outbox WHERE audit_id IN (SELECT id FROM hon.hq_school_visit_audit WHERE organization_id=$1)',
    "UPDATE hon.hq_school_visits SET reason='x' WHERE organization_id=$1", "UPDATE hon.hq_school_visits SET left_at=now() WHERE organization_id=$1 AND left_at IS NOT NULL"]) {
    await assert.rejects(q(sql, [ORG]), e => e.code === '42501' && /IMMUTABLE_HQ_SCHOOL_VISIT_EVIDENCE/.test(e.message), sql);
  }
  console.log('PASS: HQ school visits (0696): runtime entry points only; HQ owner/onboarding operators go inside; 4-hour SUPPORT_VISIT grant without money settings; school features refuse HQ logins outside a live visit and let them through during one; extend, leave, expiry, replay, key reuse, paused school, own-visits read and immutable evidence.');
} finally {
  await cleanup().catch(e => console.error('cleanup failed', e.message));
  await Promise.all([admin.end(), restricted.end(), database.onModuleDestroy?.()].map(p => Promise.resolve(p).catch(() => {})));
}
