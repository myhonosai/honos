import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';

// Disposable-localhost proof for 0175 school membership plan catalog. Plans are published and revised through the
// real service; the adult CRM workflow is driven through the real registration, billing-account and DRAFT services;
// the plan-bound DRAFT is then read back through the unchanged 0163 confirmation and 0174 recovery. Effects outside
// the catalog, the DRAFT and its evidence are proven absent with an organization-wide table snapshot.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { LeadRegistrationRecoveryService } = await import('../../../apps/api/dist/crm/lead-registration-recovery.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const blocker = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'otherOrg', 'otherOrgSchool', 'role', 'deskRole', 'readOnlyRole', 'otherSchoolRole', 'otherOrgRole',
  'pipeline', 'stage', 'program', 'cancelledProgram', 'otherSchoolProgram'].map((key) => [key, randomUUID()]));
const deskPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create', 'billing.account.create', 'billing.membership.activate'];
const managerPermissions = [...deskPermissions, 'billing.membership_plan.manage'];
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;
const CONFIRM = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE';
const DRAFT_CONFIRM = 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN';

await admin.connect(); await restricted.connect(); await blocker.connect();
const database = new RuntimeDatabaseService();
const services = { plans: new MembershipPlanService(database), accounts: new BillingAccountService(database), drafts: new CrmAdultMembershipDraftService(database),
  registrations: new LeadRegistrationService(database), recovery: new LeadRegistrationRecoveryService(database) };
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });

  // ---------- 1. posture: exact 0175 bodies, definers, fixed search path, five runtime entry points, private tables ----------
  const migration = await readFile(new URL('../migrations/0175_school_membership_plan_catalog.sql', import.meta.url), 'utf8');
  const runtimeFns = ['read_school_membership_plan_catalog(text)', 'create_school_membership_plan(text,jsonb,uuid,uuid,uuid)', 'revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid)',
    'read_crm_adult_membership_plan_options(text)', 'draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid)'];
  const privateFns = ['require_membership_plan_manager(text)', 'membership_plan_validated_terms(jsonb)', 'membership_plan_version_summary(uuid,integer)',
    'guard_membership_plan()', 'guard_membership_plan_version()', 'guard_membership_plan_selection()'];
  for (const signature of [...runtimeFns, ...privateFns]) {
    const name = signature.replace(/\(.*$/, '');
    const body = migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
    assert.ok(body, `0175 defines ${name}`);
    const row = (await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,p.proconfig config,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,(SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)::int overloads
      FROM pg_proc p WHERE p.oid=$3::regprocedure`, [runtimeUrl.username, body, `hon.${signature}`])).rows[0];
    const runtime = runtimeFns.includes(signature), trigger = name.startsWith('guard_');
    assert.deepEqual(row, { exact: true, definer: !trigger, config: ['search_path=pg_catalog, hon'], runtime_execute: runtime, public_execute: false, overloads: 1 }, signature);
    assertions++;
  }
  for (const name of ['read_school_membership_plan_catalog', 'read_crm_adult_membership_plan_options']) {
    assert.doesNotMatch(migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))[1], /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/i, `${name} is read-only`);
  }
  for (const table of ['membership_plans', 'membership_plan_versions', 'membership_plan_selections']) {
    assert.deepEqual((await admin.query(`SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid=$1::regclass`, [`hon.${table}`])).rows[0],
      { r: true, f: true, policies: 0 }, `${table} forced RLS, private`);
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table}`);
    assertions += 2;
  }
  assert.deepEqual((await admin.query("SELECT is_sensitive,is_staff_assignable FROM hon.permissions WHERE code='billing.membership_plan.manage'")).rows, [{ is_sensitive: true, is_staff_assignable: true }]);
  // Other proofs share this database and may already have published plans, so "nothing seeded" is checked as: the migration has no top-level plan
  // insert, and every existing plan and version came from an audited direct-human command.
  assert.doesNotMatch(migration.replace(/AS \$\$[\s\S]*?\$\$;/g, ''), /INSERT\s+INTO\s+hon\.membership_plan/i, 'no school policy or plan is seeded');
  assert.deepEqual((await admin.query(`SELECT
      (SELECT count(*)::int FROM hon.membership_plans p WHERE NOT EXISTS (SELECT 1 FROM hon.audit_events a WHERE a.action_code='billing.membership_plan.create'
        AND a.entity_type='MEMBERSHIP_PLAN' AND a.entity_id=p.id AND a.source='HUMAN_UI')) unaudited_plans,
      (SELECT count(*)::int FROM hon.membership_plan_versions v WHERE v.version>1 AND NOT EXISTS (SELECT 1 FROM hon.audit_events a WHERE a.action_code='billing.membership_plan.revise'
        AND a.entity_id=v.plan_id AND (a.next_state->>'version')::int=v.version)) unaudited_versions`)).rows[0],
    { unaudited_plans: 0, unaudited_versions: 0 }, 'every plan and version was published by an audited human command');
  assertions += 5;

  // ---------- fixture: org A school 1 (home) and school 2, org B ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_PLAN_ORG','PRIVATE_PLAN_ORG'),($2,'PRIVATE_PLAN_OTHER_ORG','PRIVATE_PLAN_OTHER_ORG')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_PLAN_SCHOOL',$3),($4,$2,'PRIVATE_PLAN_OTHER_SCHOOL',$5),($6,$7,'PRIVATE_PLAN_OTHER_ORG_SCHOOL',$8)",
    [ids.school, ids.org, `plan-${ids.school}`, ids.otherSchool, `plan-${ids.otherSchool}`, ids.otherOrgSchool, ids.otherOrg, `plan-${ids.otherOrgSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  for (const [role, org, permissions] of [[ids.role, ids.org, managerPermissions], [ids.deskRole, ids.org, deskPermissions], [ids.readOnlyRole, ids.org, ['crm.lead.read']],
    [ids.otherSchoolRole, ids.org, managerPermissions], [ids.otherOrgRole, ids.otherOrg, managerPermissions]]) {
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'PRIVATE_PLAN_ROLE')", [role, org, `FRONT_DESK_${role.slice(0, 8)}`]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  }
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PLAN_PIPELINE')", [ids.pipeline, ids.org, ids.school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [ids.stage, ids.org, ids.school, ids.pipeline]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Kickboxing','SCHEDULED'),($4,$2,$3,'Retired Program','CANCELLED'),($5,$2,$6,'Other School Program','SCHEDULED')",
    [ids.program, ids.org, ids.school, ids.cancelledProgram, ids.otherSchoolProgram, ids.otherSchool]);
  async function staff(role = ids.role, org = ids.org, school = ids.school) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `plan-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PLAN_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_PLAN_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, role]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  const M = await staff(), D = await staff(ids.deskRole), R = await staff(ids.readOnlyRole), U = await staff(ids.otherSchoolRole, ids.org, ids.otherSchool), V = await staff(ids.otherOrgRole, ids.otherOrg, ids.otherOrgSchool);
  async function adultReady(currency = 'USD') {
    const lead = randomUUID(), person = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Plan',$4)", [person, ids.org, ids.school, `Adult-${person.slice(0, 8)}`]);
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, ids.school, person, ids.pipeline, ids.stage]);
    const registration = await services.registrations.register(D.context(), lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    assert.equal(registration.result.outcome, 'REGISTERED');
    await services.accounts.create(D.context(), { responsiblePersonId: person, currency });
    return { lead, person, student: registration.result.studentProfileId };
  }
  const effectTables = ['memberships', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'audit_events', 'outbox_events', 'idempotency_records',
    'membership_plans', 'membership_plan_versions', 'membership_plan_selections', 'crm_adult_membership_draft_sources', 'communication_messages', 'action_requests', 'ai_usage_ledger'];
  const snapshot = async () => Object.fromEntries(await Promise.all(effectTables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h,count(*)::int n FROM hon.${table} t`)).rows[0]])));
  async function unchanged(work) { const before = await snapshot(); try { return await work(); } finally { assert.deepEqual(await snapshot(), before, 'no tracked effect'); assertions++; } }
  const monthly = { planCode: 'ADULT-MONTHLY', displayName: 'Adult Unlimited Monthly', description: 'Unlimited adult classes', programId: ids.program, availability: 'AVAILABLE',
    currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: CONFIRM };
  const annual = { planCode: 'ADULT-12-PIF', displayName: 'Adult 12 Months Paid in Full', availability: 'AVAILABLE', currency: 'USD', priceMinor: 150000,
    billingFrequency: 'PAID_IN_FULL', termKind: 'FIXED_MONTHS', termMonths: 12, confirmation: CONFIRM };
  const hidden = { planCode: 'STAFF-ONLY', displayName: 'Staff family plan', availability: 'UNAVAILABLE', currency: 'USD', priceMinor: 0, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: CONFIRM };
  const terms = ({ planCode, confirmation, ...rest }) => rest;

  // ---------- 2. catalog publication: empty start, create, replay, key reuse, duplicate codes, programs ----------
  assert.deepEqual(await unchanged(() => services.plans.catalog(M.read())), { plans: [], programs: [{ programId: ids.program, name: 'Adult Kickboxing' }] }, 'cancelled and other-school programs are not offered');
  const createKey = randomUUID();
  const created = await services.plans.create(M.context({ idempotencyKey: createKey }), monthly);
  assert.equal(created.replayed, false);
  assert.deepEqual({ ...created.plan, planId: undefined, publishedAt: undefined }, { planId: undefined, planCode: 'ADULT-MONTHLY', version: 1, displayName: 'Adult Unlimited Monthly', description: 'Unlimited adult classes',
    programId: ids.program, availability: 'AVAILABLE', currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, publishedAt: undefined });
  const replay = await unchanged(() => services.plans.create(M.context({ idempotencyKey: createKey }), monthly));
  assert.deepEqual(replay, { plan: created.plan, replayed: true }, 'same key and input replays the stored publication');
  await assert.rejects(unchanged(() => services.plans.create(M.context({ idempotencyKey: createKey }), { ...monthly, priceMinor: 1 })), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(unchanged(() => services.plans.create(M.context(), monthly)), code(409, 'MEMBERSHIP_PLAN_CODE_TAKEN'));
  const yearly = (await services.plans.create(M.context(), annual)).plan;
  const staffOnly = (await services.plans.create(M.context(), hidden)).plan;
  const evidence = await sql("SELECT a.action_code,a.entity_type,a.next_state,o.event_type,o.payload->>'executionAllowed' execution FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id AND o.causation_id=a.request_id WHERE a.entity_id=$1", [created.plan.planId]);
  assert.deepEqual(evidence, [{ action_code: 'billing.membership_plan.create', entity_type: 'MEMBERSHIP_PLAN', next_state: created.plan, event_type: 'billing.membership_plan.published', execution: 'false' }]);
  const catalog = await services.plans.catalog(M.read());
  assert.deepEqual(catalog.plans.map((p) => [p.planCode, p.version, p.programName]), [['ADULT-12-PIF', 1, null], ['ADULT-MONTHLY', 1, 'Adult Kickboxing'], ['STAFF-ONLY', 1, null]]);
  // Concurrent creation of one code with distinct keys: exactly one publication.
  const race = await Promise.allSettled([1, 2, 3].map(() => services.plans.create(M.context(), { ...monthly, planCode: 'TEEN-MONTHLY', displayName: 'Teen Monthly' })));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(race.filter((r) => r.status === 'rejected').every((r) => code(409, 'MEMBERSHIP_PLAN_CODE_TAKEN')(r.reason)));
  assert.equal((await sql("SELECT count(*)::int n FROM hon.membership_plans WHERE school_id=$1 AND plan_code='TEEN-MONTHLY'", [ids.school]))[0].n, 1);
  assertions += 10;

  // ---------- 3. closed term rules at the service and inside PostgreSQL ----------
  const badTerms = [{ planCode: 'lower' }, { planCode: 'X'.repeat(41) }, { priceMinor: -1 }, { priceMinor: 100000001 }, { priceMinor: 10.5 }, { currency: 'usd' },
    { billingFrequency: 'QUARTERLY' }, { billingFrequency: 'PAID_IN_FULL' }, { termKind: 'FIXED_MONTHS' }, { termKind: 'FIXED_MONTHS', termMonths: 61 },
    { termMonths: 12 }, { billingFrequency: 'ANNUAL', termKind: 'FIXED_MONTHS', termMonths: 18 }, { displayName: ' padded' }, { displayName: '<b>x</b>' },
    { discountMinor: 100 }, { agreementRequired: true }, { paymentStartsAt: '2026-11-01T00:00:00.000Z' }, { organizationId: ids.otherOrg }, { confirmation: 'yes' }];
  for (const patch of badTerms) {
    await assert.rejects(unchanged(() => services.plans.create(M.context(), { ...monthly, planCode: 'BAD-INPUT', ...patch })), code(400, 'INVALID_MEMBERSHIP_PLAN_INPUT'), JSON.stringify(patch));
  }
  async function raw(actor, statement, values, setup) {
    await restricted.query('BEGIN');
    try {
      const requestId = randomUUID();
      await restricted.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
        set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
        set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [actor.org, actor.school, actor.principal, requestId, actor.subject]);
      if (setup) await restricted.query(`SELECT ${setup}`);
      return (await restricted.query(statement, [actor.subject, ...values(requestId)])).rows[0].data;
    } finally { await restricted.query('ROLLBACK'); }
  }
  const rawCreate = (p) => raw(M, 'SELECT hon.create_school_membership_plan($1,$2::jsonb,$3::uuid,$4::uuid,$4::uuid) data', (request) => [JSON.stringify(p), randomUUID(), request]);
  for (const patch of badTerms) {
    await assert.rejects(rawCreate({ ...monthly, planCode: 'BAD-INPUT', ...patch }), (error) => ['22023', '22P02'].includes(error.code), `PostgreSQL refuses ${JSON.stringify(patch)}`);
  }
  await assert.rejects(rawCreate({ ...monthly, planCode: 'OTHER-PROGRAM', programId: ids.otherSchoolProgram }), (error) => error.message === 'MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE');
  await assert.rejects(rawCreate({ ...monthly, planCode: 'OLD-PROGRAM', programId: ids.cancelledProgram }), (error) => error.message === 'MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE');
  assert.equal((await rawCreate({ ...monthly, planCode: 'RAW-OK' })).plan.planCode, 'RAW-OK', 'the runtime role reaches only the fixed function (rolled back)');
  assertions += badTerms.length * 2 + 3;

  // ---------- 4. authority: permission, school, organization, identity and entitlement ----------
  const denied = code(403, 'MEMBERSHIP_PLAN_FORBIDDEN');
  await assert.rejects(unchanged(() => services.plans.catalog(D.read())), denied, 'enrollment staff without billing.membership_plan.manage cannot manage the catalog');
  await assert.rejects(unchanged(() => services.plans.create(D.context(), { ...monthly, planCode: 'DESK' })), denied);
  await assert.rejects(unchanged(() => services.plans.catalog(M.read({ schoolId: ids.otherSchool }))), denied, 'a manager at school 1 presenting school 2');
  assert.deepEqual((await services.plans.catalog(U.read())).plans, [], 'school 2 has its own empty catalog');
  assert.deepEqual((await services.plans.catalog(V.read())).plans, [], 'another organization sees nothing');
  await assert.rejects(unchanged(() => services.plans.revise(U.context(), created.plan.planId, { ...terms(monthly), expectedVersion: 1, priceMinor: 1, confirmation: CONFIRM })), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'), 'another school cannot revise this plan');
  await assert.rejects(services.plans.catalog({ ...M.read(), source: 'AI_ACTION' }), denied);
  await assert.rejects(services.plans.catalog({ ...M.read(), actionRequestId: randomUUID() }), denied);
  await assert.rejects(unchanged(() => services.plans.catalog(M.read({ principalId: D.principal }))), denied, 'subject of one staff with the principal of another');
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  try {
    await assert.rejects(services.plans.catalog(M.read()), denied, 'suspended entitlement');
    await assert.rejects(services.plans.adultDraftPlanOptions(D.read()), code(403, 'CRM_ADULT_MEMBERSHIP_FORBIDDEN'));
  } finally { await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]); }
  for (const forged of ["set_config('app.hon_source','AI',true)", "set_config('app.hon_action_request_id',gen_random_uuid()::text,true)", "set_config('app.hon_principal_type','SERVICE',true)"]) {
    await assert.rejects(raw(M, 'SELECT hon.read_school_membership_plan_catalog($1) data', () => [], forged), (error) => error.code === '42501', forged);
  }
  assertions += 15;

  // ---------- 5. revisions: new immutable versions, stale and unchanged refusals, history kept ----------
  const v1 = (await sql('SELECT * FROM hon.membership_plan_versions WHERE plan_id=$1 AND version=1', [created.plan.planId]))[0];
  const reviseKey = randomUUID();
  const v2 = await services.plans.revise(M.context({ idempotencyKey: reviseKey }), created.plan.planId, { ...terms(monthly), expectedVersion: 1, priceMinor: 15900, confirmation: CONFIRM });
  assert.deepEqual([v2.plan.version, v2.plan.priceMinor, v2.replayed], [2, 15900, false]);
  assert.deepEqual(await unchanged(() => services.plans.revise(M.context({ idempotencyKey: reviseKey }), created.plan.planId, { ...terms(monthly), expectedVersion: 1, priceMinor: 15900, confirmation: CONFIRM })), { plan: v2.plan, replayed: true });
  await assert.rejects(unchanged(() => services.plans.revise(M.context(), created.plan.planId, { ...terms(monthly), expectedVersion: 1, priceMinor: 16900, confirmation: CONFIRM })), code(409, 'MEMBERSHIP_PLAN_VERSION_STALE'));
  await assert.rejects(unchanged(() => services.plans.revise(M.context(), created.plan.planId, { ...terms(monthly), expectedVersion: 2, priceMinor: 15900, confirmation: CONFIRM })), code(400, 'MEMBERSHIP_PLAN_UNCHANGED'));
  await assert.rejects(unchanged(() => services.plans.revise(M.context(), randomUUID(), { ...terms(monthly), expectedVersion: 1, confirmation: CONFIRM })), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'));
  assert.deepEqual((await sql('SELECT * FROM hon.membership_plan_versions WHERE plan_id=$1 AND version=1', [created.plan.planId]))[0], v1, 'version 1 terms are unchanged after the revision');
  assert.deepEqual((await sql("SELECT prior_state,next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership_plan.revise'", [created.plan.planId])),
    [{ prior_state: created.plan, next_state: v2.plan }]);
  assertions += 8;

  // ---------- 6. immutability below the functions ----------
  for (const [statement, message] of [
    ['UPDATE hon.membership_plan_versions SET price_minor=1 WHERE plan_id=$1', 'IMMUTABLE_MEMBERSHIP_PLAN_VERSION'],
    ['DELETE FROM hon.membership_plan_versions WHERE plan_id=$1', 'IMMUTABLE_MEMBERSHIP_PLAN_VERSION'],
    ["UPDATE hon.membership_plans SET plan_code='RENAMED' WHERE id=$1", 'IMMUTABLE_MEMBERSHIP_PLAN'],
    ['UPDATE hon.membership_plans SET current_version=1 WHERE id=$1', 'IMMUTABLE_MEMBERSHIP_PLAN'],
    ['UPDATE hon.membership_plans SET current_version=3 WHERE id=$1', 'IMMUTABLE_MEMBERSHIP_PLAN'],
    ['DELETE FROM hon.membership_plans WHERE id=$1', 'IMMUTABLE_MEMBERSHIP_PLAN'],
    ["INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id) SELECT id,5,organization_id,school_id,'Gap','AVAILABLE','USD',1,'MONTHLY','OPEN_ENDED',created_by_principal_id FROM hon.membership_plans WHERE id=$1", 'IMMUTABLE_MEMBERSHIP_PLAN_VERSION'],
  ]) {
    await assert.rejects(admin.query(statement, [created.plan.planId]), (error) => error.message === message, statement);
  }
  await assert.rejects(admin.query('TRUNCATE hon.membership_plan_versions CASCADE'), (error) => /IMMUTABLE_MEMBERSHIP_PLAN/.test(error.message));
  assertions += 8;

  // ---------- 7. staff plan options and the plan-bound adult DRAFT ----------
  const options = await unchanged(() => services.plans.adultDraftPlanOptions(D.read()));
  assert.deepEqual(options.plans.map((p) => [p.planCode, p.version]), [['ADULT-12-PIF', 1], ['ADULT-MONTHLY', 2], ['TEEN-MONTHLY', 1]], 'only AVAILABLE plans at their current version');
  assert.equal(JSON.stringify(options).includes(staffOnly.planId), false, 'an unavailable plan is not disclosed to enrollment staff');
  await assert.rejects(services.plans.adultDraftPlanOptions(R.read()), code(403, 'CRM_ADULT_MEMBERSHIP_FORBIDDEN'), 'staff without billing.membership.create');
  assert.deepEqual((await services.plans.adultDraftPlanOptions(U.read())).plans, [], 'school 2 enrollment sees only school 2 plans');
  const drafter = (student, plan, patch = {}) => ({ studentProfileId: student, membershipPlanId: plan.planId, membershipPlanVersion: plan.version, confirmation: DRAFT_CONFIRM, ...patch });

  const adult = await adultReady();
  const draftKey = randomUUID();
  const start = '2026-01-31T15:00:00.000Z';
  const draft = await services.plans.draftAdultMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(adult.student, yearly, { termStartedAt: start }));
  assert.equal(draft.replayed, false);
  assert.deepEqual({ ...draft.receipt, membershipId: undefined, recordedAt: undefined }, { membershipId: undefined, state: 'DRAFT', planCode: 'ADULT-12-PIF', termStartedAt: start, termEndsAt: '2027-01-31T15:00:00.000Z', recordedAt: undefined });
  assert.deepEqual(draft.plan, yearly, 'the response carries the exact version used');
  assert.deepEqual(await sql('SELECT plan_id,plan_version,actor_principal_id FROM hon.membership_plan_selections WHERE membership_id=$1', [draft.receipt.membershipId]), [{ plan_id: yearly.planId, plan_version: 1, actor_principal_id: D.principal }]);
  assert.deepEqual(await sql('SELECT state,plan_code,version FROM hon.memberships WHERE id=$1', [draft.receipt.membershipId]), [{ state: 'DRAFT', plan_code: 'ADULT-12-PIF', version: 1 }]);
  for (const table of ['membership_payment_schedules', 'invoices']) assert.equal((await sql(`SELECT count(*)::int n FROM hon.${table} WHERE membership_id=$1`, [draft.receipt.membershipId]))[0].n, 0, `no ${table}`);
  assert.equal((await sql('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=$1', [ids.org]))[0].n, 0, 'no payment attempt');
  const draftEvidence = await sql("SELECT a.next_state,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id AND o.event_type='billing.membership.drafted' WHERE a.entity_id=$1", [draft.receipt.membershipId]);
  assert.deepEqual(draftEvidence, [{ next_state: { ...draft.receipt, membershipPlanId: yearly.planId, membershipPlanVersion: 1 },
    payload: { ...draft.receipt, membershipPlanId: yearly.planId, membershipPlanVersion: 1, executionAllowed: false, humanOnly: true } }]);
  // The unchanged 0163 confirmation and 0174 recovery read it as an ordinary current DRAFT.
  assert.deepEqual(await services.drafts.confirmCurrentDraft(D.read(), { studentProfileId: adult.student }), { state: 'RECORDED_DRAFT', receipt: draft.receipt });
  assert.equal((await services.recovery.recover(D.read(), adult.lead)).workflowState, 'CURRENT_DRAFT');
  // Same key replays the historical creation; a fresh key cannot draft twice; the free-text path cannot either.
  assert.deepEqual(await unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(adult.student, yearly, { termStartedAt: start }))), { ...draft, replayed: true });
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(adult.student, yearly))), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(adult.student, yearly))), code(404, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
  await assert.rejects(unchanged(() => services.drafts.draft(D.context(), { studentProfileId: adult.student, planCode: 'FREE-TEXT', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' })), code(404, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
  assertions += 16;

  // ---------- 8. historical terms survive a published price change ----------
  const yearly2 = (await services.plans.revise(M.context(), yearly.planId, { ...terms(annual), expectedVersion: 1, priceMinor: 165000, confirmation: CONFIRM })).plan;
  assert.deepEqual([yearly2.version, yearly2.priceMinor], [2, 165000]);
  assert.deepEqual(await sql('SELECT plan_version FROM hon.membership_plan_selections WHERE membership_id=$1', [draft.receipt.membershipId]), [{ plan_version: 1 }], 'the DRAFT stays bound to version 1');
  assert.deepEqual(await services.plans.draftAdultMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(adult.student, yearly, { termStartedAt: start })), { ...draft, replayed: true },
    'its replay still returns the version 1 terms it was created from');
  assert.deepEqual(await services.drafts.confirmCurrentDraft(D.read(), { studentProfileId: adult.student }), { state: 'RECORDED_DRAFT', receipt: draft.receipt }, 'a plan revision does not disturb a current DRAFT');
  assertions += 4;

  // ---------- 9. server verification of the chosen plan ----------
  const next = await adultReady();
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, yearly))), code(409, 'MEMBERSHIP_PLAN_VERSION_STALE'), 'a version the staff member reviewed before the revision');
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, staffOnly))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'), 'an UNAVAILABLE plan');
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, { planId: randomUUID(), version: 1 }))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'), 'an unknown plan');
  const otherSchoolPlan = (await services.plans.create(U.context(), { ...monthly, programId: ids.otherSchoolProgram })).plan;
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, otherSchoolPlan))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'), 'another school\'s plan');
  const euro = (await services.plans.create(M.context(), { ...monthly, planCode: 'EURO-MONTHLY', programId: null, currency: 'EUR' })).plan;
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, euro))), code(409, 'MEMBERSHIP_PLAN_CURRENCY_MISMATCH'), 'plan currency differs from the payer account');
  await sql("UPDATE hon.programs SET status='CANCELLED' WHERE id=$1", [ids.program]);
  try {
    const monthlyNow = (await services.plans.adultDraftPlanOptions(D.read())).plans;
    assert.equal(monthlyNow.some((p) => p.planCode === 'ADULT-MONTHLY'), false, 'a plan of a cancelled program is not offered');
    await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, v2.plan))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'));
  } finally { await sql("UPDATE hon.programs SET status='SCHEDULED' WHERE id=$1", [ids.program]); }
  for (const patch of [{ membershipPlanVersion: '2' }, { membershipPlanVersion: 0 }, { membershipPlanId: 'ADULT-MONTHLY' }, { planCode: 'ADULT-MONTHLY' }, { termEndsAt: '2027-01-01T00:00:00.000Z' },
    { priceMinor: 1 }, { confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' }, { termStartedAt: '2026-01-31' }]) {
    await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, v2.plan, patch))), code(400, 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT'), JSON.stringify(patch));
  }
  await assert.rejects(unchanged(() => services.plans.draftAdultMembershipFromPlan(R.context(), drafter(next.student, v2.plan))), code(403, 'CRM_ADULT_MEMBERSHIP_FORBIDDEN'));
  // Open-ended plan without a start: both ends unset.
  const open = await services.plans.draftAdultMembershipFromPlan(D.context(), drafter(next.student, v2.plan));
  assert.deepEqual([open.receipt.planCode, open.receipt.termStartedAt, open.receipt.termEndsAt, open.plan.priceMinor], ['ADULT-MONTHLY', null, null, 15900]);
  assertions += 17;

  // ---------- 10. concurrency: a revision racing a DRAFT that reviewed the previous version ----------
  for (const order of ['revision-first', 'draft-first']) {
    const racer = await adultReady();
    const current = (await services.plans.adultDraftPlanOptions(D.read())).plans.find((p) => p.planCode === 'TEEN-MONTHLY');
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE hon.membership_plans IN ACCESS EXCLUSIVE MODE');
    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
    const revise = () => services.plans.revise(M.context(), current.planId, { ...terms(monthly), displayName: 'Teen Monthly', expectedVersion: current.version, priceMinor: current.priceMinor + 100, confirmation: CONFIRM });
    const drafting = () => services.plans.draftAdultMembershipFromPlan(D.context(), drafter(racer.student, current));
    // Both queue behind the blocker in a fixed order: the revision for SHARE ROW EXCLUSIVE, the DRAFT for SHARE.
    const first = order === 'revision-first' ? revise() : drafting(); first.catch(() => {}); await pause();
    const second = order === 'revision-first' ? drafting() : revise(); second.catch(() => {}); await pause();
    await blocker.query('COMMIT');
    const [r, d] = order === 'revision-first' ? await Promise.allSettled([first, second]) : (await Promise.allSettled([second, first]));
    assert.equal(r.status, 'fulfilled', `${order}: the revision publishes`);
    if (order === 'draft-first') {
      assert.equal(d.status, 'fulfilled', 'a DRAFT that reached the catalog first commits');
      assert.deepEqual((await sql('SELECT plan_version FROM hon.membership_plan_selections WHERE membership_id=$1', [d.value.receipt.membershipId]))[0].plan_version, current.version, 'bound to the version it reviewed');
      assert.equal(r.value.plan.version, current.version + 1);
    } else {
      assert.ok(d.status === 'rejected' && code(409, 'MEMBERSHIP_PLAN_VERSION_STALE')(d.reason), 'a DRAFT behind the revision is stale, never bound to unreviewed terms');
      assert.equal((await sql('SELECT count(*)::int n FROM hon.memberships WHERE participant_person_id=$1', [racer.person]))[0].n, 0);
      assert.equal(r.value.plan.version, current.version + 1);
    }
    assertions += 3;
  }
  assert.equal((await sql("SELECT count(*)::int n FROM hon.idempotency_records WHERE organization_id=$1 AND status='IN_PROGRESS'", [ids.org]))[0].n, 0, 'no unfinished reservation');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_payment_schedules WHERE organization_id=$1', [ids.org]))[0].n, 0, 'no payment schedule anywhere');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.invoices WHERE organization_id=$1', [ids.org]))[0].n, 0, 'no invoice anywhere');
  assertions += 3;

  // ---------- 11. ablation: a DRAFT without the exact-version check binds terms the human never reviewed ----------
  const exactDraft = migration.match(/CREATE FUNCTION hon\.draft_crm_adult_membership_from_plan\([\s\S]*?\nEND \$\$;\n/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const trusting = exactDraft.replace("IF plan.current_version<>selected_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;", '')
    .replace('AND x.current_version=selected_version', '').replace('AND x.plan_version=selected_version', '');
  assert.notEqual(trusting, exactDraft);
  const ablated = await adultReady();
  try {
    await admin.query(trusting);
    const reviewed = (await services.plans.adultDraftPlanOptions(D.read())).plans.find((p) => p.planCode === 'TEEN-MONTHLY');
    await services.plans.revise(M.context(), reviewed.planId, { ...terms(monthly), displayName: 'Teen Monthly', expectedVersion: reviewed.version, priceMinor: reviewed.priceMinor + 500, confirmation: CONFIRM });
    // Directly, the ablated body binds the newer, unreviewed version (rolled back).
    const unreviewed = await raw(D, 'SELECT hon.draft_crm_adult_membership_from_plan($1,$2::jsonb,$3::uuid,$4::uuid,$4::uuid) data', (request) => [JSON.stringify(drafter(ablated.student, reviewed)), randomUUID(), request]);
    assert.equal(unreviewed.plan.version, reviewed.version + 1, 'the ablation is observable: the DRAFT used terms the human never reviewed');
    // The contract verifier still refuses to report it as the reviewed version.
    await assert.rejects(services.plans.draftAdultMembershipFromPlan(D.context(), drafter(ablated.student, reviewed)), code(503, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
    await admin.query('SELECT 1');
    const bound = await sql('SELECT s.plan_version FROM hon.membership_plan_selections s JOIN hon.memberships m ON m.id=s.membership_id WHERE m.participant_person_id=$1', [ablated.person]);
    assert.deepEqual(bound, [], 'the verifier failure rolled the whole DRAFT back');
  } finally { await admin.query(exactDraft); }
  const restoredBody = migration.match(/CREATE FUNCTION hon\.draft_crm_adult_membership_from_plan\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)[1];
  assert.equal((await admin.query("SELECT prosrc=$1 exact FROM pg_proc WHERE oid='hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid)'::regprocedure", [restoredBody])).rows[0].exact, true, 'exact 0175 body restored');
  const current = (await services.plans.adultDraftPlanOptions(D.read())).plans.find((p) => p.planCode === 'TEEN-MONTHLY');
  await assert.rejects(services.plans.draftAdultMembershipFromPlan(D.context(), drafter(ablated.student, { ...current, version: current.version - 1 })), code(409, 'MEMBERSHIP_PLAN_VERSION_STALE'), 'restored body refuses again');
  assertions += 6;

  console.log(`PASS: School membership plan catalog (${assertions} assertions): exact 0175 posture with five runtime entry points and private tables; per-school catalog publication, replay, key reuse and duplicate-code races; closed term rules in the service and in PostgreSQL; permission, school, organization, identity and entitlement refusals; immutable versions with stale/unchanged refusals and kept history; AVAILABLE-only staff options; plan-bound adult DRAFT with derived fixed term, exact version binding, unchanged 0163 confirmation and 0174 recovery; historical terms after a price change; stale/unavailable/foreign/currency/cancelled-program refusals; revision vs DRAFT races; no schedule, invoice or payment effect.`);
} finally {
  await blocker.query('ROLLBACK').catch(() => {});
  await database.onModuleDestroy();
  await restricted.end().catch(() => {});
  await blocker.end().catch(() => {});
  await admin.end();
}
