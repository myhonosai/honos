import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';

// Disposable-localhost proof for 0642 membership plan payment options. Plans with options are published and revised
// through the real API service and runtime role; option 1 is proven to be the 0175 version's own price, frequency and
// term; refusals are proven in the service and inside PostgreSQL; nothing outside the catalog changes.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'role', 'deskRole', 'otherSchoolRole', 'program'].map((key) => [key, randomUUID()]));
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;
const CONFIRM = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE';

await admin.connect(); await restricted.connect();
const database = new RuntimeDatabaseService();
const plans = new MembershipPlanService(database);
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });

  // ---------- 1. posture: exact 0642 bodies, three runtime entry points, private helpers and tables ----------
  const migration = await readFile(new URL('../migrations/0642_membership_plan_payment_options.sql', import.meta.url), 'utf8');
  const runtimeFns = ['read_school_membership_plan_setups(text)', 'create_school_membership_plan_with_options(text,jsonb,uuid,uuid,uuid)',
    'revise_school_membership_plan_with_options(text,uuid,jsonb,uuid,uuid,uuid)'];
  const privateFns = [['guard_membership_plan_setup()', false, 'search_path=pg_catalog, hon'], ['membership_plan_setup_int(jsonb,integer,integer,boolean)', false, 'search_path=pg_catalog'],
    ['membership_plan_validated_setup(jsonb)', false, 'search_path=pg_catalog, hon'], ['membership_plan_setup_summary(uuid,integer)', true, 'search_path=pg_catalog, hon'],
    ['membership_plan_setup_terms(jsonb,jsonb)', false, 'search_path=pg_catalog'], ['membership_plan_insert_setup(uuid,integer,jsonb,uuid)', true, 'search_path=pg_catalog, hon']];
  for (const [signature, definer, config] of [...runtimeFns.map((s) => [s, true, 'search_path=pg_catalog, hon']), ...privateFns]) {
    const name = signature.replace(/\(.*$/, '');
    const body = migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
    assert.ok(body, `0642 defines ${name}`);
    const row = (await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,p.proconfig config,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,(SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)::int overloads
      FROM pg_proc p WHERE p.oid=$3::regprocedure`, [runtimeUrl.username, body, `hon.${signature}`])).rows[0];
    assert.deepEqual(row, { exact: true, definer, config: [config], runtime_execute: runtimeFns.includes(signature), public_execute: false, overloads: 1 }, signature);
    assertions++;
  }
  assert.doesNotMatch(migration.match(/CREATE FUNCTION hon\.read_school_membership_plan_setups\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)[1], /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/i, 'setup read is read-only');
  for (const table of ['membership_plan_version_setups', 'membership_plan_payment_options']) {
    assert.deepEqual((await admin.query('SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid=$1::regclass', [`hon.${table}`])).rows[0],
      { r: true, f: true, policies: 0 }, `${table} forced RLS, private`);
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table}`);
    assertions += 2;
  }
  assert.doesNotMatch(migration.replace(/AS \$\$[\s\S]*?\$\$;/g, ''), /INSERT\s+INTO\s+hon\./i, 'nothing is seeded');
  assertions++;

  // ---------- fixture ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_OPTIONS_ORG','PRIVATE_OPTIONS_ORG')", [ids.org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_OPTIONS_SCHOOL',$3),($4,$2,'PRIVATE_OPTIONS_OTHER_SCHOOL',$5)",
    [ids.school, ids.org, `opt-${ids.school}`, ids.otherSchool, `opt-${ids.otherSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [ids.org]);
  for (const [role, permissions] of [[ids.role, ['billing.membership_plan.manage']], [ids.deskRole, ['billing.membership.create']], [ids.otherSchoolRole, ['billing.membership_plan.manage']]]) {
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'PRIVATE_OPTIONS_ROLE')", [role, ids.org, `FRONT_DESK_${role.slice(0, 8)}`]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, ids.org, permission]);
  }
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Little Tigers','SCHEDULED')", [ids.program, ids.org, ids.school]);
  async function staff(role, school = ids.school) {
    const user = randomUUID(), principal = randomUUID(), subject = `options-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_OPTIONS_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_OPTIONS_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
      [randomUUID(), ids.org, school, principal, role]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: ids.org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { principal, subject, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  const M = await staff(ids.role), D = await staff(ids.deskRole), U = await staff(ids.otherSchoolRole, ids.otherSchool);
  const effectTables = ['memberships', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'membership_plan_selections', 'communication_messages', 'action_requests', 'ai_usage_ledger'];
  const snapshot = async () => Object.fromEntries(await Promise.all(effectTables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h,count(*)::int n FROM hon.${table} t`)).rows[0]])));
  const moneyBefore = await snapshot();
  const catalogTables = async () => (await sql(`SELECT (SELECT count(*) FROM hon.membership_plans WHERE school_id=$1)::int plans,(SELECT count(*) FROM hon.membership_plan_versions WHERE school_id=$1)::int versions,
    (SELECT count(*) FROM hon.membership_plan_version_setups WHERE school_id=$1)::int setups,(SELECT count(*) FROM hon.membership_plan_payment_options WHERE school_id=$1)::int options`, [ids.school]))[0];

  const kids = { planCode: 'LITTLE-TIGERS', displayName: 'Little Tigers', description: 'Ages 4 to 6', programId: ids.program, availability: 'AVAILABLE', currency: 'USD',
    classesPerWeek: 2, features: ['2 classes a week', 'Belt testing included'], confirmation: CONFIRM,
    paymentOptions: [{ label: 'Monthly', priceMinor: 15900, billingFrequency: 'MONTHLY', checkoutEnabled: true },
      { label: '6 monthly payments', priceMinor: 14900, billingFrequency: 'MONTHLY', payments: 6, termMonths: 6, downPaymentMinor: 9900, checkoutEnabled: true },
      { label: 'Quarterly', priceMinor: 44000, billingFrequency: 'QUARTERLY', termMonths: 12, checkoutEnabled: false },
      { label: '1 year paid in full', priceMinor: 159000, billingFrequency: 'PAID_IN_FULL', termMonths: 12, checkoutEnabled: true }] };

  // ---------- 2. create with options ----------
  const key = randomUUID();
  const created = await plans.createWithOptions(M.context({ idempotencyKey: key }), kids);
  assert.equal(created.replayed, false);
  assert.deepEqual({ ...created.plan, planId: undefined, publishedAt: undefined }, { planId: undefined, planCode: 'LITTLE-TIGERS', version: 1, displayName: 'Little Tigers', description: 'Ages 4 to 6',
    programId: ids.program, availability: 'AVAILABLE', currency: 'USD', priceMinor: 15900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, publishedAt: undefined },
    'option 1 is the 0175 price, frequency and term');
  assert.deepEqual(created.setup, { planId: created.plan.planId, version: 1, derived: false, classesPerWeek: 2, features: ['2 classes a week', 'Belt testing included'], paymentOptions: [
    { optionNo: 1, label: 'Monthly', priceMinor: 15900, billingFrequency: 'MONTHLY', payments: null, termMonths: null, downPaymentMinor: null, checkoutEnabled: true },
    { optionNo: 2, label: '6 monthly payments', priceMinor: 14900, billingFrequency: 'MONTHLY', payments: 6, termMonths: 6, downPaymentMinor: 9900, checkoutEnabled: true },
    { optionNo: 3, label: 'Quarterly', priceMinor: 44000, billingFrequency: 'QUARTERLY', payments: null, termMonths: 12, downPaymentMinor: null, checkoutEnabled: false },
    { optionNo: 4, label: '1 year paid in full', priceMinor: 159000, billingFrequency: 'PAID_IN_FULL', payments: null, termMonths: 12, downPaymentMinor: null, checkoutEnabled: true }] });
  const replay = await plans.createWithOptions(M.context({ idempotencyKey: key }), kids);
  assert.deepEqual(replay, { ...created, replayed: true }, 'same key replays');
  await assert.rejects(plans.createWithOptions(M.context({ idempotencyKey: key }), { ...kids, classesPerWeek: 3 }), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(plans.createWithOptions(M.context(), kids), code(409, 'MEMBERSHIP_PLAN_CODE_TAKEN'));
  const catalog = await plans.catalog(M.read());
  assert.deepEqual(catalog.plans.map((p) => [p.planCode, p.priceMinor, p.billingFrequency, p.programName]), [['LITTLE-TIGERS', 15900, 'MONTHLY', 'Little Tigers']], 'the unchanged 0175 catalog reads option 1');
  const audit = await sql("SELECT action_code,next_state FROM hon.audit_events WHERE entity_id=$1", [created.plan.planId]);
  assert.deepEqual(audit, [{ action_code: 'billing.membership_plan.create', next_state: { ...created.plan, setup: created.setup } }], 'one audited human publish');
  assert.deepEqual(await catalogTables(), { plans: 1, versions: 1, setups: 1, options: 4 });
  assertions += 9;

  // ---------- 3. refusals in the service and inside PostgreSQL ----------
  const opt = (patch) => ({ ...kids, planCode: 'BAD-OPTIONS', paymentOptions: [{ label: 'Monthly', priceMinor: 100, billingFrequency: 'MONTHLY', checkoutEnabled: true, ...patch }] });
  const bad = [opt({ billingFrequency: 'QUARTERLY' }), opt({ billingFrequency: 'PAID_IN_FULL' }), opt({ billingFrequency: 'PAID_IN_FULL', termMonths: 12, payments: 1 }),
    opt({ billingFrequency: 'ANNUAL', termMonths: 18 }), opt({ termMonths: 61 }), opt({ payments: 0 }), opt({ payments: 121 }), opt({ downPaymentMinor: 0 }), opt({ priceMinor: -1 }),
    opt({ priceMinor: 1.5 }), opt({ label: '' }), opt({ label: ' padded' }), opt({ label: '<b>' }), opt({ checkoutEnabled: 'yes' }), opt({ discount: 5 }),
    { ...kids, planCode: 'BAD-OPTIONS', paymentOptions: [] }, { ...kids, planCode: 'BAD-OPTIONS', paymentOptions: Array.from({ length: 7 }, (_, i) => ({ label: `O${i}`, priceMinor: 1, billingFrequency: 'MONTHLY', checkoutEnabled: true })) },
    { ...kids, planCode: 'BAD-OPTIONS', paymentOptions: [kids.paymentOptions[0], { ...kids.paymentOptions[1], label: 'MONTHLY' }] },
    { ...kids, planCode: 'BAD-OPTIONS', paymentOptions: [kids.paymentOptions[0], { ...kids.paymentOptions[2], termMonths: 4 }] },
    { ...kids, planCode: 'BAD-OPTIONS', classesPerWeek: 15 }, { ...kids, planCode: 'BAD-OPTIONS', features: Array(13).fill('x') }, { ...kids, planCode: 'BAD-OPTIONS', features: [' x'] },
    { ...kids, planCode: 'BAD-OPTIONS', priceMinor: 100 }, { ...kids, planCode: 'BAD-OPTIONS', confirmation: 'yes' }];
  async function raw(actor, statement, values) {
    await restricted.query('BEGIN');
    try {
      const requestId = randomUUID();
      await restricted.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
        set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
        set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [ids.org, actor.school, actor.principal, requestId, actor.subject]);
      return (await restricted.query(statement, [actor.subject, ...values(requestId)])).rows[0].data;
    } finally { await restricted.query('ROLLBACK'); }
  }
  const rawCreate = (p) => raw(M, 'SELECT hon.create_school_membership_plan_with_options($1,$2::jsonb,$3::uuid,$4::uuid,$4::uuid) data', (request) => [JSON.stringify(p), randomUUID(), request]);
  for (const input of bad) {
    await assert.rejects(plans.createWithOptions(M.context(), input), code(400, 'INVALID_MEMBERSHIP_PLAN_INPUT'), JSON.stringify(input.paymentOptions?.[0] ?? input));
    await assert.rejects(rawCreate(input), (error) => error.code === '22023', `PostgreSQL refuses ${JSON.stringify(input).slice(0, 160)}`);
    assertions += 2;
  }
  assert.equal((await rawCreate({ ...kids, planCode: 'RAW-OK' })).plan.planCode, 'RAW-OK', 'runtime reaches only the fixed function (rolled back)');
  await assert.rejects(plans.createWithOptions(D.context(), { ...kids, planCode: 'DESK' }), code(403, 'MEMBERSHIP_PLAN_FORBIDDEN'), 'no plan permission');
  await assert.rejects(plans.setups(D.read()), code(403, 'MEMBERSHIP_PLAN_FORBIDDEN'));
  assert.deepEqual(await plans.setups(U.read()), { setups: [] }, 'another school sees none of these setups');
  await assert.rejects(admin.query("UPDATE hon.membership_plan_payment_options SET price_minor=1 WHERE plan_id=$1", [created.plan.planId]), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_PLAN_SETUP');
  await assert.rejects(admin.query("DELETE FROM hon.membership_plan_version_setups WHERE plan_id=$1", [created.plan.planId]), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_PLAN_SETUP');
  await assert.rejects(admin.query("TRUNCATE hon.membership_plan_payment_options"), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_PLAN_SETUP');
  assert.deepEqual(await catalogTables(), { plans: 1, versions: 1, setups: 1, options: 4 }, 'refusals wrote nothing');
  assertions += 8;

  // ---------- 4. revise with options: new version, history kept, stale and unchanged refused ----------
  const { planCode: _code, ...reviseBase } = kids;
  const revised = await plans.reviseWithOptions(M.context(), created.plan.planId, { ...reviseBase, expectedVersion: 1,
    paymentOptions: [{ ...kids.paymentOptions[3], label: '1 year paid in full' }, kids.paymentOptions[0]] });
  assert.equal(revised.plan.version, 2);
  assert.deepEqual([revised.plan.priceMinor, revised.plan.billingFrequency, revised.plan.termKind, revised.plan.termMonths], [159000, 'PAID_IN_FULL', 'FIXED_MONTHS', 12], 'new option 1 is the new version terms');
  assert.deepEqual(revised.setup.paymentOptions.map((o) => [o.optionNo, o.label]), [[1, '1 year paid in full'], [2, 'Monthly']]);
  assert.deepEqual((await plans.setups(M.read())).setups, [revised.setup], 'the read shows the current version');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_plan_payment_options WHERE plan_id=$1 AND version=1', [created.plan.planId]))[0].n, 4, 'version 1 options kept');
  await assert.rejects(plans.reviseWithOptions(M.context(), created.plan.planId, { ...reviseBase, expectedVersion: 1 }), code(409, 'MEMBERSHIP_PLAN_VERSION_STALE'));
  await assert.rejects(plans.reviseWithOptions(M.context(), created.plan.planId, { ...reviseBase, expectedVersion: 2, paymentOptions: [{ ...kids.paymentOptions[3] }, kids.paymentOptions[0]] }),
    code(400, 'MEMBERSHIP_PLAN_UNCHANGED'));
  const featureOnly = await plans.reviseWithOptions(M.context(), created.plan.planId, { ...reviseBase, expectedVersion: 2, features: ['Uniform included'],
    paymentOptions: [{ ...kids.paymentOptions[3] }, kids.paymentOptions[0]] });
  assert.deepEqual([featureOnly.plan.version, featureOnly.setup.features], [3, ['Uniform included']], 'a features-only change publishes a version (the 0175 terms are unchanged)');
  const race = await Promise.allSettled([1, 2, 3].map((i) => plans.reviseWithOptions(M.context(), created.plan.planId, { ...reviseBase, expectedVersion: 3, classesPerWeek: i,
    paymentOptions: [{ ...kids.paymentOptions[3] }, kids.paymentOptions[0]] })));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'one of three concurrent revisions wins');
  assert.ok(race.filter((r) => r.status === 'rejected').every((r) => code(409, 'MEMBERSHIP_PLAN_VERSION_STALE')(r.reason) || code(409, 'MEMBERSHIP_PLAN_CONFLICT')(r.reason)));
  assertions += 9;

  // ---------- 5. a plan published by the 0175 command reads as one derived option and can take options later ----------
  const legacy = (await plans.create(M.context(), { planCode: 'ADULT-LEGACY', displayName: 'Adult legacy', availability: 'AVAILABLE', currency: 'USD', priceMinor: 12000,
    billingFrequency: 'ANNUAL', termKind: 'FIXED_MONTHS', termMonths: 24, confirmation: CONFIRM })).plan;
  const derived = (await plans.setups(M.read())).setups.find((s) => s.planId === legacy.planId);
  assert.deepEqual(derived, { planId: legacy.planId, version: 1, derived: true, classesPerWeek: null, features: [], paymentOptions: [
    { optionNo: 1, label: null, priceMinor: 12000, billingFrequency: 'ANNUAL', payments: null, termMonths: 24, downPaymentMinor: null, checkoutEnabled: true }] });
  const upgraded = await plans.reviseWithOptions(M.context(), legacy.planId, { displayName: 'Adult legacy', availability: 'AVAILABLE', currency: 'USD', expectedVersion: 1, confirmation: CONFIRM,
    paymentOptions: [{ label: 'Two years, yearly', priceMinor: 12000, billingFrequency: 'ANNUAL', termMonths: 24, checkoutEnabled: true }] });
  assert.deepEqual([upgraded.plan.version, upgraded.setup.derived], [2, false], 'same terms but now with a labelled option is a change');
  assertions += 2;

  assert.deepEqual(await snapshot(), moneyBefore, 'no membership, schedule, invoice, payment, message, action or AI effect');
  assertions++;
  console.log(`PASS: Membership plan payment options (${assertions} assertions): exact 0642 posture with three runtime entry points and private immutable tables; publish with 1-6 options where option 1 is the 0175 price, frequency and term; replay, key reuse and duplicate code; closed option rules in the service and in PostgreSQL; permission and school refusals; revisions keep history and refuse stale or unchanged input; concurrent revisions publish once; 0175-published plans read as one derived option; no money effect.`);
} finally {
  await database.onModuleDestroy();
  await restricted.end().catch(() => {});
  await admin.end();
}
