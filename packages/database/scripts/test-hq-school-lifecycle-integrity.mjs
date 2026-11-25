import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// HQ school lifecycle (0675) integrity proof, TEST MODE, disposable database only. It proves: runtime holds only the two
// entry points and no table access; only a current HQ owner or an hq.onboarding.manage operator changes a school (support,
// view-only operators, school owners, revoked and unknown subjects refused); pause/resume/archive/restore move the school and
// the organization follows its most-open school; archive needs the exact typed name and records a 30-day erase date; stale
// expected status conflicts; idempotent replay and key reuse; a paid in-service subscription blocks removing the last school;
// evidence is immutable; the archive read shows erase dates to HQ readers only; nothing else is written.
await import('./test-champions-proof-target.mjs');
const targets = championsProofTargets(process.env);
if (Object.keys(process.env).some(key => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('Provider credentials/execution switches are forbidden.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { HqSchoolLifecycleService } = await import('../../../apps/api/dist/hq/hq-school-lifecycle.js');
const database = new RuntimeDatabaseService(), lifecycle = new HqSchoolLifecycleService(database);
const admin = new pg.Client(targets.owner), restricted = new pg.Client(targets.runtime);
const http = (n, code) => e => { assert.equal(e.getStatus?.(), n, e.stack); if (code) assert.equal(e.getResponse().code, code); return true; };
const deny = (p, n, code) => assert.rejects(p, http(n, code));
const ORG = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), ORG2 = randomUUID(), S3 = randomUUID();
const humans = Object.fromEntries(['owner', 'onboarder', 'viewer', 'support', 'schoolOwner', 'revoked'].map(k => [k, { id: randomUUID(), user: randomUUID(), subject: `hqsl-${k}-${randomUUID()}` }]));
const H = k => humans[k].subject, P = k => humans[k].id;
const q = (sql, params) => admin.query(sql, params);
const row = async (sql, params) => (await q(sql, params)).rows[0];
const status = async () => row('SELECT (SELECT status::text FROM hon.organizations WHERE id=$1) o,(SELECT status::text FROM hon.schools WHERE id=$2) s1,(SELECT status::text FROM hon.schools WHERE id=$3) s2', [ORG, S1, S2]);
const evidence = ['hq_school_lifecycle_outbox', 'hq_school_lifecycle_audit', 'hq_school_lifecycle_requests'];
async function cleanup() {
  await q('ROLLBACK').catch(() => {});
  await q('BEGIN');
  try {
    for (const t of evidence) await q(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    const ps = Object.values(humans).map(h => h.id), us = Object.values(humans).map(h => h.user);
    await q('DELETE FROM hon.hq_school_lifecycle_outbox WHERE audit_id IN (SELECT id FROM hon.hq_school_lifecycle_audit WHERE organization_id=ANY($1::uuid[]))', [[ORG, ORG2]]);
    await q('DELETE FROM hon.hq_school_lifecycle_audit WHERE organization_id=ANY($1::uuid[])', [[ORG, ORG2]]);
    await q('DELETE FROM hon.hq_school_lifecycle_requests WHERE actor_principal_id=ANY($1::uuid[])', [ps]);
    for (const t of evidence) await q(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await q('DELETE FROM hon.saas_subscriptions WHERE organization_id=ANY($1::uuid[])', [[ORG, ORG2]]).catch(() => {});
    await q('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])', [[ORG, ORG2]]);
    await q('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])', [[ORG, ORG2]]);
    await q('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await q('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await q('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await q('COMMIT');
  } catch (e) { await q('ROLLBACK'); throw e; }
}
const go = (who, school, body, key = randomUUID()) => lifecycle.transition(H(who), school, body, key);

await Promise.all([admin.connect(), restricted.connect()]);
await verifyChampionsProofConnection(admin, CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted, CHAMPIONS_RUNTIME_ROLE);
try {
  // ---------- 0. posture ----------
  for (const [sig, allowed] of [['transition_school_lifecycle_from_hq(text,uuid,text,text,text,uuid,uuid,uuid)', true], ['read_hq_school_archive_dates(text)', true],
    ['require_hq_school_lifecycle_actor(text)', false], ['guard_hq_school_lifecycle_evidence()', false]]) {
    assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).rows[0].a, allowed, sig);
  }
  for (const t of evidence) {
    assert.equal((await restricted.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') a", ['hon.' + t])).rows[0].a, false, t);
    assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass", ['hon.' + t]), { r: true, f: true });
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
    (gen_random_uuid(),$5,'HON_HQ_OWNER','{}',now()-interval '2 days',now()-interval '1 day')`, [P('owner'), P('onboarder'), P('viewer'), P('support'), P('revoked')]);
  await q("INSERT INTO hon.organizations(id,legal_name,display_name,status) VALUES($1,'PRIVATE_LEGAL','Harbor Org','ACTIVE'),($2,'PRIVATE_LEGAL2','Paid Org','ACTIVE')", [ORG, ORG2]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug,status) VALUES($1,$2,'Harbor North',$6,'ACTIVE'),($3,$2,'Harbor South',$7,'ACTIVE'),($4,$5,'Paid School',$8,'ACTIVE')", [S1, ORG, S2, S3, ORG2, `hqsl-n-${S1.slice(0, 8)}`, `hqsl-s-${S2.slice(0, 8)}`, `hqsl-p-${S3.slice(0, 8)}`]);
  const untouched = async () => row('SELECT (SELECT count(*) FROM hon.audit_events)::int a,(SELECT count(*) FROM hon.outbox_events)::int o,(SELECT count(*) FROM hon.organization_entitlements)::int e,(SELECT count(*) FROM hon.principal_role_grants)::int g');
  const baseline = await untouched();

  // ---------- 1. authority ----------
  for (const who of ['viewer', 'support', 'schoolOwner', 'revoked']) await deny(go(who, S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }), 403, 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN');
  await deny(lifecycle.transition(`unknown-${randomUUID()}`, S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, randomUUID()), 403);
  await deny(go('owner', randomUUID(), { action: 'PAUSE', expectedStatus: 'ACTIVE' }), 404);
  assert.deepEqual(await status(), { o: 'ACTIVE', s1: 'ACTIVE', s2: 'ACTIVE' });

  // ---------- 2. pause one school: org stays active while a sibling is active ----------
  const key = randomUUID();
  const paused = await go('onboarder', S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key);
  assert.deepEqual(paused, { schoolId: S1, action: 'PAUSE', schoolStatus: 'SUSPENDED', organizationStatus: 'ACTIVE', eraseAfter: null, replayed: false });
  assert.deepEqual(await go('onboarder', S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key), { ...paused, replayed: true }, 'exact replay');
  await deny(go('onboarder', S1, { action: 'RESUME', expectedStatus: 'SUSPENDED' }, key), 409, 'IDEMPOTENCY_KEY_REUSED');
  await deny(go('owner', S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }), 409, 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT');
  await go('owner', S2, { action: 'PAUSE', expectedStatus: 'ACTIVE' });
  assert.deepEqual(await status(), { o: 'SUSPENDED', s1: 'SUSPENDED', s2: 'SUSPENDED' }, 'org follows when every school is paused');

  // ---------- 3. archive needs the exact name and records a 30-day erase date ----------
  await deny(go('owner', S1, { action: 'ARCHIVE', expectedStatus: 'SUSPENDED', confirmName: 'harbor north' }), 400, 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH');
  await deny(go('owner', S1, { action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: 'Harbor North' }), 409, 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT');
  const archived = await go('owner', S1, { action: 'ARCHIVE', expectedStatus: 'SUSPENDED', confirmName: 'Harbor North' });
  assert.equal(archived.schoolStatus, 'ARCHIVED'); assert.equal(archived.organizationStatus, 'SUSPENDED');
  const days = (Date.parse(archived.eraseAfter) - Date.now()) / 86400000;
  assert(days > 29.99 && days <= 30, `erase in 30 days, got ${days}`);
  await go('owner', S2, { action: 'ARCHIVE', expectedStatus: 'SUSPENDED', confirmName: 'Harbor South' });
  assert.deepEqual(await status(), { o: 'ARCHIVED', s1: 'ARCHIVED', s2: 'ARCHIVED' });

  // ---------- 4. archive read: HQ readers only, latest archive per archived school ----------
  const archives = await lifecycle.readArchives(H('viewer'));
  const mine = archives.archives.filter(a => [S1, S2].includes(a.schoolId));
  assert.equal(mine.length, 2); assert.equal(mine.find(a => a.schoolId === S1).eraseAfter, archived.eraseAfter);
  await deny(lifecycle.readArchives(H('schoolOwner')), 403);
  await deny(lifecycle.readArchives(H('revoked')), 403);

  // ---------- 5. restore brings the school and its organization back ----------
  const restored = await go('owner', S1, { action: 'RESTORE', expectedStatus: 'ARCHIVED' });
  assert.deepEqual(restored, { schoolId: S1, action: 'RESTORE', schoolStatus: 'ACTIVE', organizationStatus: 'ACTIVE', eraseAfter: null, replayed: false });
  assert.deepEqual(await status(), { o: 'ACTIVE', s1: 'ACTIVE', s2: 'ARCHIVED' });
  assert(!(await lifecycle.readArchives(H('owner'))).archives.some(a => a.schoolId === S1), 'restored school leaves the archive list');
  await go('owner', S1, { action: 'PAUSE', expectedStatus: 'ACTIVE' }); await go('owner', S1, { action: 'RESUME', expectedStatus: 'SUSPENDED' });
  assert.deepEqual(await status(), { o: 'ACTIVE', s1: 'ACTIVE', s2: 'ARCHIVED' });

  // ---------- 6. paid in-service subscription blocks removing the last school ----------
  // The paid row is written inside one rolled-back transaction with saas_subscriptions foreign keys and guard triggers
  // lifted (the billing write paths are proven elsewhere; every CHECK still holds); the function is called in it directly.
  await q('BEGIN');
  for (const { conname } of (await q("SELECT conname FROM pg_constraint WHERE conrelid='hon.saas_subscriptions'::regclass AND contype='f'")).rows) await q(`ALTER TABLE hon.saas_subscriptions DROP CONSTRAINT ${conname}`);
  await q('ALTER TABLE hon.saas_subscriptions DISABLE TRIGGER USER');
  await q("INSERT INTO hon.saas_subscriptions(catalog_id,offer_id,organization_id,source,plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,entitlement_version_at_record,status,status_reason,version,service_started_at,period_anchor_at,period_index,current_period_start,current_period_end,created_by_principal_id,created_at,updated_at) VALUES(gen_random_uuid(),gen_random_uuid(),$1,'CATALOG_OFFER','CORE','CORE','REGULAR_MONTHLY','MONTHLY',14900,1,'IN_SERVICE','SERVICE_STARTED',1,now(),now(),0,now(),now()+interval '1 month',$2,now(),now())", [ORG2, P('owner')]);
  await assert.rejects(q("SELECT hon.transition_school_lifecycle_from_hq($1,$2,'ARCHIVE','ACTIVE','Paid School',gen_random_uuid(),gen_random_uuid(),gen_random_uuid())", [H('owner'), S3]),
    e => e.code === '40001' && /BILLING_ACTIVE/.test(e.message));
  await q('ROLLBACK');
  assert.equal((await row("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='hon.saas_subscriptions'::regclass AND contype='f'")).n > 0, true, 'constraints restored');
  const pausedPaid = await go('owner', S3, { action: 'PAUSE', expectedStatus: 'ACTIVE' });
  assert.equal(pausedPaid.organizationStatus, 'SUSPENDED');

  // ---------- 7. evidence is immutable; nothing else written ----------
  const audits = await row('SELECT count(*)::int n FROM hon.hq_school_lifecycle_audit WHERE organization_id=ANY($1::uuid[])', [[ORG, ORG2]]);
  assert.equal(audits.n, 8);
  assert.equal((await row('SELECT count(*)::int n FROM hon.hq_school_lifecycle_outbox o JOIN hon.hq_school_lifecycle_audit a ON a.id=o.audit_id WHERE a.organization_id=$1', [ORG])).n, 7);
  for (const sql of ['UPDATE hon.hq_school_lifecycle_audit SET action_code=action_code WHERE organization_id=$1', 'DELETE FROM hon.hq_school_lifecycle_audit WHERE organization_id=$1']) {
    await assert.rejects(q(sql, [ORG]), e => e.code === '42501');
  }
  await assert.rejects(restricted.query('SELECT * FROM hon.hq_school_lifecycle_audit'), e => e.code === '42501');
  assert.deepEqual(await untouched(), baseline, 'no school audit, outbox, entitlement or role-grant effect');
  console.log('HQ school lifecycle proof passed (posture, authority, pause/resume/archive/restore with org follow, typed name, 30-day erase date, conflicts, replay, billing guard, immutable evidence, no other writes).');
} finally {
  try { await cleanup(); } finally { await Promise.allSettled([admin.end(), restricted.end(), database.onModuleDestroy?.()]); }
}
