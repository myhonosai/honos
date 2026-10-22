import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { ACTIVATION_CONFIRMATION, ADULT_ATTESTATION, OVERRIDE_CONFIRMATION, confirmationFor, membershipFixtureQuery } from './membership-activation-test-support.mjs';

// Disposable-localhost proof for the 0177 membership activation gate (E1a). Every command runs through the real
// MembershipService against the restricted runtime role; the owner connection only builds fixtures and observes.
//  1. posture: D41 option C privileges, the settings-free transition trigger, private evidence, exact function bodies
//  2. D30a permissions: migration mapping, owner and delegated staff, override, revocation at every wait and replay
//  3. D29a identity-review override, D3 birth date and minor protections, staff reminders
//  4. D40/D40a school-local dates: suggestions, adjustments, inclusive end, DST, month end, leap day, scheduled status
//  5. two-step integrity: stale previews, exact acknowledgements, idempotency, concurrency, activation vs cancellation
//  6. cancellation contract and fingerprint compatibility
//  7. separation: no SaaS billing, entitlement, payment, schedule, invoice, refund, agreement, consent or AI effect
//  8. static benefit-path guard: every reader of hon.memberships is a reviewed path
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { GuardianChildEnrollmentService } = await import('../../../apps/api/dist/crm/guardian-child-enrollment.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const blocker = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'santiago', 'havana', 'badZone', 'otherOrg', 'otherOrgSchool', 'pipeline', 'stage', 'program']
  .map((key) => [key, randomUUID()]));
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;
const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
const LA = 'America/Los_Angeles';
const ACTIVATE = 'billing.membership.activate', OVERRIDE = 'billing.membership.activation.override', CANCEL = 'billing.membership.cancel';
const RULES = 'billing.membership.rules.manage', APPROVE = 'billing.membership.change.approve';
const NEW_PERMISSIONS = [OVERRIDE, RULES, APPROVE];
const BASE = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create',
  'billing.account.create', 'billing.membership_plan.manage'];

await admin.connect(); await blocker.connect(); await restricted.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), plans: new MembershipPlanService(database),
  drafts: new CrmAdultMembershipDraftService(database), registrations: new LeadRegistrationService(database), gc: new GuardianChildEnrollmentService(database) };
const ms = services.memberships;
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const migration = await readFile(new URL('../migrations/0177_membership_activation_gate.sql', import.meta.url), 'utf8');

  // ---------- 1. posture ----------
  const bodyOf = (name) => migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
  const entry = ['preview_school_membership_activation(text,uuid,jsonb)', 'activate_school_membership(text,uuid,jsonb,text,uuid,uuid)', 'cancel_school_membership(text,uuid,jsonb,text,uuid,uuid)'];
  const definers = ['membership_lifecycle_permission(uuid,uuid,uuid,text)', 'require_membership_lifecycle_actor(text,text)', 'evaluate_membership_activation(uuid,boolean,date,date)'];
  const plain = ['guard_membership_activation_evidence()', 'guard_membership_state_transition()', 'membership_local_date(timestamptz,text)', 'membership_local_day_start(date,text)',
    'membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz)', 'membership_activation_text_ok(text,integer)', 'membership_activation_date(jsonb)'];
  for (const signature of [...entry, ...definers, ...plain]) {
    const name = signature.replace(/\(.*$/, '');
    const body = bodyOf(name);
    assert.ok(body, `0177 defines ${name}`);
    const row = (await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,(SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)::int overloads,
      p.proconfig config FROM pg_proc p WHERE p.oid=$3::regprocedure`, [runtimeUrl.username, body, `hon.${signature}`])).rows[0];
    assert.deepEqual({ ...row, config: undefined }, { exact: true, definer: !plain.includes(signature), runtime_execute: entry.includes(signature), public_execute: false, overloads: 1, config: undefined }, signature);
    assert.ok(row.config?.every((setting) => /^search_path=pg_catalog(, hon)?$/.test(setting)) && row.config.length === 1, `${signature} fixed search path`);
    assertions += 2;
  }
  // The transition trigger reads no session, transaction or custom setting: nothing a caller sets authorizes a transition.
  assert.doesNotMatch(bodyOf('guard_membership_state_transition'), /current_setting|set_config|session_user|current_user|pg_has_role/i);
  assert.deepEqual((await admin.query(`SELECT tgname,tgenabled,pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal`)).rows,
    [{ tgname: 'membership_state_transition_guard', tgenabled: 'O', def: 'CREATE TRIGGER membership_state_transition_guard BEFORE INSERT OR UPDATE ON hon.memberships FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_state_transition()' }]);
  assert.doesNotMatch(bodyOf('preview_school_membership_activation') + bodyOf('evaluate_membership_activation'), /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/, 'preview and evaluation are DML- and lock-free');
  // rules.manage and change.approve are reserved for E1c: no function uses them.
  assert.equal((await sql(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND (prosrc LIKE '%${RULES}%' OR prosrc LIKE '%${APPROVE}%')`))[0].n, 0);
  assertions += 4;
  const evidence = ['membership_activation_decisions', 'membership_effective_periods', 'membership_activation_follow_ups'];
  for (const table of evidence) {
    assert.deepEqual((await admin.query(`SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid=$1::regclass`, [`hon.${table}`])).rows[0],
      { r: true, f: true, policies: 0 }, `${table} forced RLS, private`);
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table}`);
    assertions += 2;
  }
  // The deployment verifier's 0177 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = (await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8'))
      .split('-- Membership activation gate exact verification (0177)')[1]?.split('-- End membership activation gate exact verification.')[0];
    assert.ok(verify); await admin.query(verify.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', runtimeUrl.username)); assertions++; }
  // D41 option C: the runtime keeps SELECT, loses every UPDATE/DELETE/TRUNCATE and may INSERT only the seven DRAFT columns.
  const columns = (await sql("SELECT attname FROM pg_attribute WHERE attrelid='hon.memberships'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).map((row) => row.attname);
  const insertable = [];
  for (const column of columns) {
    const p = (await restricted.query(`SELECT has_column_privilege('hon.memberships',$1,'INSERT') i,has_column_privilege('hon.memberships',$1,'UPDATE') u`, [column])).rows[0];
    assert.equal(p.u, false, `no UPDATE on ${column}`);
    if (p.i) insertable.push(column);
  }
  assert.deepEqual(insertable.sort(), ['billing_account_id', 'organization_id', 'participant_person_id', 'plan_code', 'school_id', 'term_ends_at', 'term_started_at']);
  assert.deepEqual((await restricted.query(`SELECT has_table_privilege('hon.memberships','SELECT') s,has_table_privilege('hon.memberships','INSERT') i,
    has_table_privilege('hon.memberships','UPDATE') u,has_table_privilege('hon.memberships','DELETE') d,has_table_privilege('hon.memberships','TRUNCATE') t`)).rows[0],
  { s: true, i: false, u: false, d: false, t: false });
  assert.deepEqual((await sql("SELECT pg_get_expr(adbin,adrelid) def FROM pg_attrdef WHERE adrelid='hon.memberships'::regclass AND adnum IN (SELECT attnum FROM pg_attribute WHERE attrelid='hon.memberships'::regclass AND attname IN ('state','version')) ORDER BY adnum")).map((r) => r.def),
    ["'DRAFT'::hon.membership_state", '1']);
  for (const statement of ["UPDATE hon.memberships SET state='ACTIVE'", 'DELETE FROM hon.memberships', 'TRUNCATE hon.memberships',
    "INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'X','ACTIVE')",
    "INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,version) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'X',2)",
    'SELECT hon.evaluate_membership_activation(gen_random_uuid(),false,NULL,NULL)', "SELECT hon.require_membership_lifecycle_actor('x','billing.membership.activate')",
    "SELECT hon.membership_lifecycle_permission(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'billing.membership.activate')"]) {
    await assert.rejects(restricted.query(statement), (error) => error.code === '42501', statement);
  }
  assertions += 12;

  // ---------- fixture ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_GATE_ORG','PRIVATE_GATE_ORG'),($2,'PRIVATE_GATE_OTHER_ORG','PRIVATE_GATE_OTHER_ORG')", [ids.org, ids.otherOrg]);
  for (const [school, org, zone] of [[ids.school, ids.org, LA], [ids.otherSchool, ids.org, LA], [ids.santiago, ids.org, 'America/Santiago'], [ids.havana, ids.org, 'America/Havana'],
    [ids.badZone, ids.org, 'Mars/Olympus_Mons'], [ids.otherOrgSchool, ids.otherOrg, LA]]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'PRIVATE_GATE_SCHOOL',$3,$4)", [school, org, `gate-${school}`, zone]);
  }
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_GATE_PIPELINE')", [ids.pipeline, ids.org, ids.school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [ids.stage, ids.org, ids.school, ids.pipeline]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Karate','SCHEDULED')", [ids.program, ids.org, ids.school]);
  async function role(permissions, { org = ids.org, roleCode, system = false } = {}) {
    const id = randomUUID();
    await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,\'PRIVATE_GATE_ROLE\',$4)', [id, org, roleCode ?? `FRONT_DESK_${id.slice(0, 8)}`, system]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
    return id;
  }
  async function staff(roleId, { org = ids.org, school = ids.school, extraRole } = {}) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `gate-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_GATE_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_GATE_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    if (extraRole) await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, extraRole]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, role: roleId, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  // School owner (system OWNER role holding every permission, as HQ provisioning grants) and delegated staff roles.
  const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).map((row) => row.code);
  const ownerRole = await role(allPermissions, { roleCode: 'OWNER', system: true });
  const OWN = await staff(ownerRole);
  const OWNS = { [ids.santiago]: await staff(ownerRole, { school: ids.santiago }), [ids.havana]: await staff(ownerRole, { school: ids.havana }), [ids.badZone]: await staff(ownerRole, { school: ids.badZone }) };
  const actRole = await role([...BASE, ACTIVATE, CANCEL]), ovrRole = await role([...BASE, ACTIVATE, OVERRIDE, CANCEL]);
  const ACT = await staff(actRole), ACT2 = await staff(actRole), OVR = await staff(ovrRole);
  const OVRONLY = await staff(await role([...BASE, OVERRIDE])), NONE = await staff(await role(BASE));
  const NOCANCEL = await staff(await role([...BASE, ACTIVATE]));
  const PARENT = await staff(actRole, { extraRole: await role([...BASE, ACTIVATE], { roleCode: 'PARENT_PORTAL' }) });
  const OTHER_SCHOOL = await staff(await role(allPermissions), { school: ids.otherSchool });
  const OTHER_ORG = await staff(await role(allPermissions, { org: ids.otherOrg }), { org: ids.otherOrg, school: ids.otherOrgSchool });

  // Money, provider, agreement, consent and automation tables that activation must never touch (whole-table, every organization).
  const separated = (await sql(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' AND c.relname ~ $1 ORDER BY 1`,
    ['^(saas_|payment|invoice|refund|membership_payment|organization_entitlement|document_ack|agreement|consent|communication_|action_|ai_|crm_guardian_child_payer|school_payment|stripe|provider)'])).map((r) => r.relname);
  assert.ok(separated.length >= 15 && separated.includes('saas_invoices') && separated.includes('organization_entitlements') && separated.includes('payment_attempts'), separated.join(','));
  async function person({ school = ids.school, birthDate = 'NO_PROFILE', label = 'Member' } = {}) {
    const id = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)", [id, ids.org, school, label, `P${tag()}`]);
    if (birthDate !== 'NO_PROFILE') await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4)', [ids.org, school, id, birthDate]);
    return id;
  }
  // A generic (pre-CRM) DRAFT recorded through the real runtime insert path.
  async function generic({ by = OWN, birthDate = '1990-04-05', input = {} } = {}) {
    const participant = await person({ school: by.school, birthDate });
    const account = (await services.accounts.create(by.context(), { responsiblePersonId: participant, currency: 'USD' })).account.id;
    const { membership } = await ms.createDraft(by.context(), { billingAccountId: account, participantPersonId: participant, planCode: `GENERIC-${tag()}`, ...input });
    return { id: membership.id, participant, account };
  }
  async function wonLead() {
    const lead = randomUUID(), contact = await person({ label: 'Adult' });
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, ids.school, contact, ids.pipeline, ids.stage]);
    return { lead, person: contact };
  }
  async function crmAdult({ birthDate = '1990-01-02', plan } = {}) {
    const { lead, person: adult } = await wonLead();
    const registration = await services.registrations.register(OWN.context(), lead, { registrationPath: 'ADULT', birthDate, confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    assert.equal(registration.result.outcome, 'REGISTERED');
    const student = registration.result.studentProfileId;
    await services.accounts.create(OWN.context(), { responsiblePersonId: adult, currency: 'USD' });
    const draft = plan
      ? await services.plans.draftAdultMembershipFromPlan(OWN.context(), { studentProfileId: student, membershipPlanId: plan.planId, membershipPlanVersion: plan.version, confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' })
      : await services.drafts.draft(OWN.context(), { studentProfileId: student, planCode: `CRM-${tag()}`, confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });
    return { lead, person: adult, student, id: draft.receipt.membershipId };
  }
  const plan = async (patch = {}) => (await services.plans.create(OWN.context(), { planCode: `PLAN-${tag().toUpperCase()}`, displayName: 'Adult Plan', programId: ids.program, availability: 'AVAILABLE',
    currency: 'USD', priceMinor: 15900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE', ...patch })).plan;
  // Every lifecycle command is checked against the money/consent/automation tables; every preview against all of its
  // possible effects (it must write nothing anywhere).
  const effectTables = ['memberships', 'idempotency_records', 'audit_events', 'outbox_events', 'work_items', 'human_work_history', ...evidence];
  const hashTables = async (tables) => Object.fromEntries(await Promise.all(tables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h])));
  let guardedCommands = 0;
  async function guarded(work, tables = separated) {
    const before = await hashTables(tables);
    try { return await work(); } finally { assert.deepEqual(await hashTables(tables), before, 'no separated effect'); guardedCommands++; }
  }
  const previewWith = (context, id, dates = {}) => guarded(() => ms.previewActivation(context, id, dates), [...separated, ...effectTables]);
  const preview = (actor, id, dates = {}) => previewWith(actor.read(), id, dates);
  const act = (...args) => guarded(() => ms.activate(...args));
  const cxl = (...args) => guarded(() => ms.cancel(...args));
  const confirm = (actor, id, body, patch = {}) => act(actor.context(patch), id, body);
  async function activate(actor, id, { dates = {}, patch = {} } = {}) { const p = await preview(actor, id, dates); return { preview: p, ...(await confirm(actor, id, confirmationFor(p, patch))) }; }
  const localToday = async (school = ids.school) => (await sql('SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text d FROM hon.schools WHERE id=$1', [school]))[0].d;
  const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const row = async (id) => (await sql("SELECT state::text,version,to_char(term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') s,to_char(term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') e FROM hon.memberships WHERE id=$1", [id]))[0];
  const counts = async (id) => (await sql(`SELECT (SELECT count(*)::int FROM hon.membership_activation_decisions WHERE membership_id=$1) decisions,
    (SELECT count(*)::int FROM hon.membership_effective_periods WHERE membership_id=$1) periods,(SELECT count(*)::int FROM hon.membership_activation_follow_ups WHERE membership_id=$1) follow_ups,
    (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.activate') audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.activated') outbox`, [id]))[0];
  const none = { decisions: 0, periods: 0, follow_ups: 0, audits: 0, outbox: 0 };


  // Owner-level trigger proofs: even the BYPASSRLS table owner with forged settings cannot transition without evidence.
  { const m = await generic();
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_external_subject',$1,true),
        set_config('app.hon_principal_id',$2,true),set_config('app.hon_membership_activation','ALLOWED',true),set_config('app.hon_activation_decision',$3,true)`, [OWN.subject, OWN.principal, randomUUID()]);
      await assert.rejects(admin.query("UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [m.id]), (e) => e.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED' && e.code === '42501');
    } finally { await admin.query('ROLLBACK'); }
    for (const [statement, values] of [
      ["UPDATE hon.memberships SET state='ACTIVE' WHERE id=$1", [m.id]],
      ["UPDATE hon.memberships SET state='CANCELLED',version=version+1 WHERE id=$1", [m.id]],
      ["UPDATE hon.memberships SET school_id=$2 WHERE id=$1", [m.id, ids.otherSchool]],
      ["INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,'X','ACTIVE')", [ids.org, ids.school, m.account, m.participant]],
      ["INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,version) VALUES($1,$2,$3,$4,'X',3)", [ids.org, ids.school, m.account, m.participant]],
    ]) await assert.rejects(admin.query(statement, values), (e) => e.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED', statement);
    // A DRAFT stays editable by the trusted owner (CRM drift fixtures rely on it); the runtime cannot.
    await admin.query("UPDATE hon.memberships SET plan_code=plan_code WHERE id=$1", [m.id]);
    assert.deepEqual(await row(m.id), { state: 'DRAFT', version: 1, s: null, e: null });
    assertions += 7; }

  // ---------- 2. D30a permissions ----------
  for (const permission of NEW_PERMISSIONS) {
    assert.deepEqual((await sql('SELECT is_sensitive,is_staff_assignable FROM hon.permissions WHERE code=$1', [permission]))[0], { is_sensitive: true, is_staff_assignable: true }, permission);
  }
  // The migration's mapping, replayed in a rolled-back transaction: exactly the activate holders and system OWNER roles gain all three.
  { const seeding = migration.match(/INSERT INTO hon\.role_permissions\(role_id,organization_id,permission_code\)\nSELECT DISTINCT holder\.role_id[\s\S]*?ON CONFLICT DO NOTHING;/)?.[0];
    assert.ok(seeding, 'mapping statement');
    const holder = await role(['billing.membership.activate']), systemOwner = await role([], { org: ids.otherOrg, roleCode: 'OWNER', system: true }), customOwner = await role([], { roleCode: 'OWNER_DEPUTY' });
    const bystander = await role(['billing.membership.create', 'billing.membership.cancel']);
    await admin.query('BEGIN');
    try {
      await admin.query('DELETE FROM hon.role_permissions WHERE role_id = ANY($1::uuid[]) AND permission_code = ANY($2)', [[holder, systemOwner, customOwner, bystander], NEW_PERMISSIONS]);
      await admin.query(seeding); await admin.query(seeding);
      const granted = (await admin.query('SELECT role_id,array_agg(permission_code ORDER BY permission_code) codes FROM hon.role_permissions WHERE role_id = ANY($1::uuid[]) AND permission_code = ANY($2) GROUP BY role_id', [[holder, systemOwner, customOwner, bystander], NEW_PERMISSIONS])).rows;
      const sorted = [...NEW_PERMISSIONS].sort();
      assert.deepEqual(Object.fromEntries(granted.map((r) => [r.role_id, r.codes])), { [holder]: sorted, [systemOwner]: sorted });
    } finally { await admin.query('ROLLBACK'); }
    assertions += 5; }

  // Who may preview and confirm, at exactly one school.
  { const m = await generic();
    const p = await preview(OWN, m.id);
    assert.equal(p.canConfirm, true); assert.deepEqual(p.availableOverrides, []);
    assert.equal((await preview(ACT, m.id)).previewDigest, p.previewDigest, 'the digest is actor-independent');
    for (const denied of [NONE, OVRONLY, PARENT]) {
      await assert.rejects(preview(denied, m.id), code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
      await assert.rejects(confirm(denied, m.id, confirmationFor(p)), code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
    }
    await assert.rejects(preview(OTHER_SCHOOL, m.id), code(404, 'BILLING_MEMBERSHIP_NOT_FOUND'), 'another school sees nothing');
    await assert.rejects(preview(OTHER_ORG, m.id), code(404, 'BILLING_MEMBERSHIP_NOT_FOUND'), 'another organization sees nothing');
    await assert.rejects(previewWith(OTHER_SCHOOL.read({ schoolId: ids.school }), m.id), (e) => e.getStatus() === 403, 'a grant at another school is not a grant here');
    for (const patch of [{ source: 'AI' }, { source: 'HON_HQ' }, { delegatedByPrincipalId: OWN.principal }, { actionRequestId: randomUUID() }, { principalType: 'AI_AGENT' }, { externalSubject: ACT.subject }]) {
      await assert.rejects(previewWith(OWN.read(patch), m.id), (e) => e.getStatus() === 403, JSON.stringify(patch));
      await assert.rejects(act(OWN.context(patch), m.id, confirmationFor(p)), (e) => e.getStatus() === 403, JSON.stringify(patch));
    }
    // The database itself refuses forged transaction markers (the API is bypassed here entirely).
    async function raw(settings, fn = 'preview') {
      await restricted.query('BEGIN');
      try {
        const requestId = randomUUID();
        const s = { org: ids.org, school: ids.school, principal: OWN.principal, type: 'HUMAN_USER', request: requestId, source: 'HUMAN_UI', subject: OWN.subject, action: '', delegated: '', ...settings };
        await restricted.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
          set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),set_config('app.hon_source',$6,true),set_config('app.hon_external_subject',$7,true),
          set_config('app.hon_action_request_id',$8,true),set_config('app.hon_delegated_by_principal_id',$9,true)`, [s.org, s.school, s.principal, s.type, s.request, s.source, s.subject, s.action, s.delegated]);
        const argSubject = settings.argSubject ?? OWN.subject;
        if (fn === 'preview') return (await restricted.query('SELECT hon.preview_school_membership_activation($1,$2,$3::jsonb) d', [argSubject, m.id, '{}'])).rows[0].d;
        return (await restricted.query('SELECT hon.activate_school_membership($1,$2,$3::jsonb,$4,$5,$6) d', [argSubject, m.id, JSON.stringify(confirmationFor(p)), randomUUID(), settings.argRequest ?? requestId, requestId])).rows[0].d;
      } finally { await restricted.query('ROLLBACK'); }
    }
    assert.equal((await raw({})).previewDigest, p.previewDigest, 'the raw path is the same evaluation');
    for (const forged of [{ source: 'AI' }, { delegated: OWN.principal }, { action: randomUUID() }, { type: 'AI_AGENT' }, { argSubject: ACT.subject }, { subject: ACT.subject }, { principal: ACT.principal }]) {
      await assert.rejects(raw(forged), (e) => e.code === '42501', JSON.stringify(forged));
      await assert.rejects(raw(forged, 'activate'), (e) => e.code === '42501', JSON.stringify(forged));
    }
    await assert.rejects(raw({ argRequest: randomUUID() }, 'activate'), (e) => e.code === '22023', 'the request id is bound to the transaction');
    assert.deepEqual(await counts(m.id), none);
    // A suspended organization cannot preview or activate.
    await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
    try {
      await assert.rejects(preview(OWN, m.id), code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
      await assert.rejects(confirm(OWN, m.id, confirmationFor(p)), code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
    } finally { await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]); }
    // Delegated staff (activate without override) activate an ordinary DRAFT; the receipt names the authorizing permission.
    const done = await confirm(ACT, m.id, confirmationFor(p));
    assert.equal(done.replayed, false); assert.equal(done.membership.authorizingPermission, ACTIVATE); assert.equal(done.membership.overridePermission, null);
    assert.equal((await sql('SELECT actor_principal_id FROM hon.membership_activation_decisions WHERE membership_id=$1', [m.id]))[0].actor_principal_id, ACT.principal);
    assertions += 39; }

  // Revocation while the command waits on the IAM SHARE locks: the live re-check refuses and nothing is written.
  for (const [label, revoke, restore] of [
    ['permission removed', (actor) => blocker.query('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [actor.role, ACTIVATE]),
      (actor) => sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [actor.role, ids.org, ACTIVATE])],
    ['grant revoked', (actor) => blocker.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [actor.grant]),
      (actor) => sql('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [actor.grant])],
  ]) {
    const actor = await staff(await role([...BASE, ACTIVATE])), m = await generic(), p = await preview(actor, m.id);
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE hon.users IN EXCLUSIVE MODE');
    const pending = confirm(actor, m.id, confirmationFor(p)).then((value) => ({ value }), (error) => ({ error }));
    for (let attempt = 0; ; attempt++) {
      const waiting = (await sql("SELECT count(*)::int n FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE NOT l.granted AND c.relname='users'"))[0].n;
      if (waiting) break; assert.ok(attempt < 300, `${label}: activation waits on the IAM lock`); await sleep(10);
    }
    await revoke(actor); await blocker.query('COMMIT');
    const outcome = await pending;
    assert.ok(code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN')(outcome.error), `${label}: ${outcome.error?.getResponse?.()?.code ?? 'activated'}`);
    assert.deepEqual(await counts(m.id), none); assert.deepEqual(await row(m.id), { state: 'DRAFT', version: 1, s: null, e: null });
    assert.equal((await sql('SELECT count(*)::int n FROM hon.idempotency_records WHERE principal_id=$1', [actor.principal]))[0].n, 0, 'the key reservation rolled back');
    await restore(actor);
    assert.equal((await confirm(actor, m.id, confirmationFor(p))).membership.state, 'ACTIVE', `${label}: restored authority activates`);
    assertions += 5;
  }
  // Revocation before an exact replay: the stored receipt is never returned without live authority.
  { const actor = await staff(await role([...BASE, ACTIVATE])), m = await generic(), p = await preview(actor, m.id), context = actor.context(), body = confirmationFor(p);
    const first = await act(context, m.id, body);
    await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [actor.grant]);
    await assert.rejects(act({ ...context, requestId: randomUUID() }, m.id, body), code(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
    await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [actor.grant]);
    const again = await act({ ...context, requestId: randomUUID() }, m.id, body);
    assert.equal(again.replayed, true); assert.deepEqual(again.membership, first.membership);
    assertions += 3; }

  // ---------- 3. D29a identity review override, D3 birth date and minors ----------
  { const adult = await crmAdult();
    assert.equal((await preview(OWN, adult.id)).source, 'CRM_ADULT_FREE_TEXT');
    // A second (ADDITIONAL) account for the adult makes the CRM relation no longer exactly current: staff review.
    await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'USD','ADDITIONAL')", [ids.org, ids.school, adult.person]);
    const identityTables = ['people', 'student_profiles', 'families', 'family_members', 'billing_accounts', 'crm_leads', 'crm_lead_registration_conversions', 'crm_adult_membership_draft_sources',
      'crm_guardian_child_enrolled_children', 'crm_guardian_child_membership_draft_sources'];
    const identity = async () => Object.fromEntries(await Promise.all(identityTables.map(async (table) => [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h])));
    const p = await preview(ACT, adult.id);
    assert.deepEqual(p.warnings.map((w) => w.code), ['CRM_IDENTITY_REVIEW_PENDING', 'LEGACY_FREE_TEXT_PLAN']);
    assert.deepEqual(p.overridableWarnings, ['CRM_IDENTITY_REVIEW_PENDING']);
    assert.equal(p.canConfirm, false); assert.deepEqual(p.availableOverrides, []);
    const po = await preview(OVR, adult.id);
    assert.equal(po.canConfirm, true); assert.deepEqual(po.availableOverrides, ['CRM_IDENTITY_REVIEW_PENDING']); assert.equal(po.previewDigest, p.previewDigest);
    const before = await identity();
    // Without an override the warning blocks; staff without the override permission cannot document one.
    await assert.rejects(confirm(OVR, adult.id, confirmationFor(p, { overrides: [] })), code(422, 'ACTIVATION_OVERRIDE_REQUIRED'));
    await assert.rejects(confirm(ACT, adult.id, confirmationFor(p)), code(403, 'ACTIVATION_OVERRIDE_FORBIDDEN'));
    await assert.rejects(confirm(OVR, adult.id, confirmationFor(p, { acknowledgedWarnings: ['LEGACY_FREE_TEXT_PLAN'] })), code(422, 'ACTIVATION_ACKNOWLEDGEMENT_REQUIRED'));
    const override = (patch) => [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'Owner confirmed identity in person.', confirmation: OVERRIDE_CONFIRMATION, ...patch }];
    for (const overrides of [override({ reason: 'too short' }), override({ confirmation: 'YES' }), override({ reason: ' padded reason text ' }), [...override(), ...override()],
      override({ code: 'BIRTH_DATE_MISSING' }).map(({ confirmation, ...rest }) => rest), [{ ...override()[0], extra: true }]]) {
      await assert.rejects(confirm(OVR, adult.id, confirmationFor(p, { overrides })), (e) => e.getStatus() === 400 || code(422, 'ACTIVATION_OVERRIDE_REQUIRED')(e), JSON.stringify(overrides));
    }
    await assert.rejects(confirm(OVR, adult.id, confirmationFor(p, { overrides: override({ code: 'LEGACY_FREE_TEXT_PLAN' }) })), code(422, 'ACTIVATION_OVERRIDE_REQUIRED'), 'only listed overridable warnings');
    assert.deepEqual(await counts(adult.id), none);
    // Concurrent identical confirmations under one key: one decision, one reminder, the other an exact replay.
    const context = OVR.context(), body = confirmationFor(p);
    const results = await Promise.all([act(context, adult.id, body), act({ ...context, requestId: randomUUID() }, adult.id, body)]);
    assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]); assert.deepEqual(results[0].membership, results[1].membership);
    const receipt = results[0].membership;
    assert.equal(receipt.overridePermission, OVERRIDE); assert.deepEqual(receipt.overridesUsed, [{ code: 'CRM_IDENTITY_REVIEW_PENDING', resolved: false }]);
    assert.deepEqual(receipt.followUps.map((f) => f.kind), ['IDENTITY_REVIEW_UNRESOLVED']);
    assert.deepEqual(await counts(adult.id), { decisions: 1, periods: 1, follow_ups: 1, audits: 1, outbox: 1 });
    const work = (await sql('SELECT w.*,h.operation,h.version hv FROM hon.work_items w JOIN hon.human_work_history h ON h.work_item_id=w.id WHERE w.id=$1', [receipt.followUps[0].workItemId]))[0];
    assert.equal(work.status, 'READY'); assert.equal(work.priority, 'HIGH'); assert.equal(work.work_origin, 'HUMAN_UI'); assert.equal(work.operation, 'CREATE'); assert.equal(work.hv, 1);
    const names = (await sql('SELECT given_name,family_name FROM hon.people WHERE id=$1', [adult.person]))[0];
    for (const hidden of [names.family_name, adult.person, 'Owner confirmed']) assert.equal(`${work.title} ${work.description}`.includes(hidden), false, 'reminder carries no PII or reason');
    const decision = (await sql('SELECT * FROM hon.membership_activation_decisions WHERE membership_id=$1', [adult.id]))[0];
    assert.deepEqual(decision.overrides, [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'Owner reviewed the pending CRM identity question in person.', acknowledgedUnresolved: true, resolved: false }]);
    assert.equal(decision.override_permission, OVERRIDE); assert.equal(decision.preview_digest, p.previewDigest);
    assert.deepEqual(decision.requirements_not_evaluated, ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY']);
    // The review is never resolved and no identity record is merged, relinked or changed.
    assert.deepEqual(await identity(), before);
    assert.equal((await sql("SELECT count(*)::int n FROM hon.billing_accounts WHERE responsible_person_id=$1 AND account_classification='ADDITIONAL'", [adult.person]))[0].n, 1, 'the ambiguity remains for staff');
    // Override authority is re-proven on replay.
    await sql('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [ovrRole, OVERRIDE]);
    await assert.rejects(act({ ...context, requestId: randomUUID() }, adult.id, body), code(403, 'ACTIVATION_OVERRIDE_FORBIDDEN'));
    await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [ovrRole, ids.org, OVERRIDE]);
    assert.equal((await act({ ...context, requestId: randomUUID() }, adult.id, body)).replayed, true);
    // Evidence is immutable, even for the owner.
    for (const table of evidence) {
      await assert.rejects(admin.query(`UPDATE hon.${table} SET created_at=created_at WHERE membership_id=$1`, [adult.id]), (e) => e.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE');
      await assert.rejects(admin.query(`DELETE FROM hon.${table} WHERE membership_id=$1`, [adult.id]), (e) => e.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE');
      await assert.rejects(admin.query(`TRUNCATE hon.${table} CASCADE`), (e) => e.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE');
    }
    assertions += 44; }

  // D3: a missing birth date is a warning plus a staff reminder; the staff adult attestation is optional and only then allowed.
  { const m = await generic({ birthDate: null });
    const p = await preview(ACT, m.id);
    assert.deepEqual(p.warnings.map((w) => w.code), ['BIRTH_DATE_MISSING', 'LEGACY_FREE_TEXT_PLAN']); assert.equal(p.birthDateRecorded, false); assert.equal(p.knownMinor, false);
    for (const adultVerification of [{ method: 'GUESSED', attestation: ADULT_ATTESTATION }, { method: 'ID_CHECKED_IN_PERSON', attestation: 'YES' }, { method: 'ID_CHECKED_IN_PERSON' }]) {
      await assert.rejects(confirm(ACT, m.id, confirmationFor(p, { adultVerification })), (e) => e.getStatus() === 400);
    }
    const done = await confirm(ACT, m.id, confirmationFor(p, { adultVerification: { method: 'ID_CHECKED_IN_PERSON', attestation: ADULT_ATTESTATION } }));
    assert.deepEqual(done.membership.adultVerification, { kind: 'STAFF_ATTESTATION', method: 'ID_CHECKED_IN_PERSON' });
    assert.deepEqual(done.membership.followUps.map((f) => f.kind), ['BIRTH_DATE_MISSING']);
    const work = (await sql('SELECT * FROM hon.work_items WHERE id=$1', [done.membership.followUps[0].workItemId]))[0];
    assert.equal(work.title, 'Record birth date for an activated membership'); assert.equal(work.priority, 'NORMAL');
    assert.equal((await sql('SELECT birth_date FROM hon.student_profiles WHERE person_id=$1', [m.participant]))[0].birth_date, null, 'no birth date is invented');
    const known = await generic(), kp = await preview(ACT, known.id);
    await assert.rejects(confirm(ACT, known.id, confirmationFor(kp, { adultVerification: { method: 'DOCUMENT_REVIEWED', attestation: ADULT_ATTESTATION } })), code(422, 'ADULT_VERIFICATION_NOT_APPLICABLE'));
    // No student profile at all is the same missing-birth-date case.
    const bare = await generic({ birthDate: 'NO_PROFILE' });
    assert.ok((await preview(ACT, bare.id)).warnings.some((w) => w.code === 'BIRTH_DATE_MISSING'));
    assertions += 11; }
  // Known minors keep the guardian-of-record rule; the adult CRM path does not enforce 18+ (reported conflict), so such a DRAFT is blocked here.
  { const minor = await crmAdult({ birthDate: addDays(await localToday(), -365 * 10) });
    const p = await preview(OWN, minor.id);
    assert.equal(p.knownMinor, true); assert.deepEqual(p.blocks, [{ code: 'MINOR_GUARDIAN_OF_RECORD_REQUIRED' }]); assert.equal(p.canConfirm, false);
    await assert.rejects(confirm(OWN, minor.id, confirmationFor(p)), code(422, 'ACTIVATION_BLOCKED'));
    // A guardian/child DRAFT from the 0176 flow has its guardian of record and activates.
    const { lead, person: guardian } = await wonLead();
    const reg = await services.registrations.register(OWN.context(), lead, { registrationPath: 'GUARDIAN_CHILD', childGivenName: `Kid${tag()}`, childFamilyName: `F${tag()}`,
      childBirthDate: addDays(await localToday(), -365 * 8), confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    await services.accounts.create(OWN.context(), { responsiblePersonId: guardian, currency: 'USD' });
    await services.gc.designatePayer(OWN.context(), lead, { confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_PAYER_DESIGNATION' });
    const kids = await plan({ planCode: `KIDS-${tag().toUpperCase()}` });
    const gcDraft = await services.gc.draftMembershipFromPlan(OWN.context(), { studentProfileId: reg.result.studentProfileId, membershipPlanId: kids.planId, membershipPlanVersion: kids.version,
      confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN' });
    const gp = await preview(OWN, gcDraft.receipt.membershipId);
    assert.equal(gp.source, 'CRM_GUARDIAN_CHILD_PLAN'); assert.equal(gp.knownMinor, true); assert.deepEqual(gp.blocks, []); assert.deepEqual(gp.warnings, []);
    assert.equal((await confirm(OWN, gcDraft.receipt.membershipId, confirmationFor(gp))).membership.membershipSource, 'CRM_GUARDIAN_CHILD_PLAN');
    assertions += 8; }

  // ---------- 4. D40/D40a school-local dates ----------
  // Day starts in the school timezone, including 23- and 25-hour days, a skipped midnight and a 30-minute DST shift.
  for (const [day, zone, start] of [['2027-03-14', LA, '2027-03-14 08:00:00+00'], ['2027-03-15', LA, '2027-03-15 07:00:00+00'], ['2026-11-01', LA, '2026-11-01 07:00:00+00'],
    ['2026-11-02', LA, '2026-11-02 08:00:00+00'], ['2026-09-06', 'America/Santiago', '2026-09-06 04:00:00+00'], ['2026-04-05', 'America/Santiago', '2026-04-05 04:00:00+00'],
    ['2027-03-14', 'America/Havana', '2027-03-14 05:00:00+00'], ['2026-10-04', 'Australia/Lord_Howe', '2026-10-03 13:30:00+00']]) {
    const r = (await sql(`SELECT to_char(hon.membership_local_day_start($1::date,$2) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS+00') utc,(hon.membership_local_day_start($1::date,$2) AT TIME ZONE $2)::date::text local,
      ((hon.membership_local_day_start($1::date,$2)-interval '1 microsecond') AT TIME ZONE $2)::date::text prior`, [day, zone]))[0];
    assert.equal(r.utc, start, `${zone} ${day}`);
    assert.equal(r.local, day); assert.equal(r.prior, addDays(day, -1), `${zone} ${day} is the earliest instant of the day`);
    assertions += 3;
  }
  const lengths = (await sql(`SELECT extract(epoch FROM hon.membership_local_day_start('2027-03-15',$1)-hon.membership_local_day_start('2027-03-14',$1))/3600 spring,
    extract(epoch FROM hon.membership_local_day_start('2026-11-02',$1)-hon.membership_local_day_start('2026-11-01',$1))/3600 fall`, [LA]))[0];
  assert.deepEqual([Number(lengths.spring), Number(lengths.fall)], [23, 25]); assertions++;

  // Suggestions: today in the school timezone; an existing DRAFT date; the plan's fixed term; open ended.
  { const today = await localToday();
    const m = await generic(), p = await preview(OWN, m.id);
    assert.deepEqual(p.suggestedDates, { startDate: today, endDate: null, startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'NO_END_DATE' });
    assert.deepEqual(p.proposedDates, { startDate: today, endDate: null, dateSource: 'SUGGESTED' }); assert.equal(p.localToday, today); assert.equal(p.schoolTimezone, LA);
    assert.equal(p.effectiveStatusIfConfirmedNow, 'IN_EFFECT');
    const done = await confirm(OWN, m.id, confirmationFor(p));
    const dayStart = (await sql("SELECT to_char(hon.membership_local_day_start($1::date,$2) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') s", [today, LA]))[0].s;
    assert.deepEqual(done.membership.effectivePeriod, { periodVersion: 1, startDate: today, endDate: null, endDateInclusive: true, schoolTimezone: LA, dateSource: 'SUGGESTED', termStartedAt: dayStart, termEndsAt: null });
    assert.equal(done.membership.effectiveStatusAtActivation, 'IN_EFFECT');
    assert.deepEqual(await row(m.id), { state: 'ACTIVE', version: 2, s: dayStart, e: null });
    const period = (await sql('SELECT * FROM hon.membership_effective_periods WHERE membership_id=$1', [m.id]))[0];
    assert.equal(period.change_kind, 'INITIAL'); assert.equal(period.approval_reference, null); assert.deepEqual(period.suggestion_basis, { startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'NO_END_DATE' });
    // A DRAFT recorded with LA-midnight instants suggests those local dates; the end instant is the next local midnight (inclusive end).
    const dated = await generic({ input: { termStartedAt: '2026-01-15T08:00:00.000Z', termEndsAt: '2027-01-15T08:00:00.000Z' } });
    const dp = await preview(OWN, dated.id);
    assert.deepEqual(dp.suggestedDates, { startDate: '2026-01-15', endDate: '2027-01-14', startBasis: 'DRAFT_START_DATE', endBasis: 'DRAFT_END_DATE' });
    assert.deepEqual(dp.projection, { termStartedAt: '2026-01-15T08:00:00.000Z', termEndsAt: '2027-01-15T08:00:00.000Z' });
    assert.ok(dp.warnings.some((w) => w.code === 'START_DATE_BACKDATED' && w.days > 0));
    await assert.rejects(confirm(OWN, dated.id, confirmationFor(dp, { reasonText: undefined })), (e) => e.getStatus() === 400 || code(422, 'ACTIVATION_REASON_TEXT_REQUIRED')(e));
    const { reasonText, ...withoutReason } = confirmationFor(dp);
    assert.ok(reasonText); await assert.rejects(confirm(OWN, dated.id, withoutReason), code(422, 'ACTIVATION_REASON_TEXT_REQUIRED'));
    assert.deepEqual((await confirm(OWN, dated.id, confirmationFor(dp))).membership.effectivePeriod.termEndsAt, '2027-01-15T08:00:00.000Z');
    assertions += 15; }

  // Fixed-term plans: start + N months - 1 day (month-end and leap-day clamping as 0175), required end, differing end, open-ended plan with an end.
  { const monthly = await plan({ termKind: 'FIXED_MONTHS', termMonths: 1 }), yearly = await plan({ termKind: 'FIXED_MONTHS', termMonths: 12 }), open = await plan();
    const today = await localToday();
    const a = await crmAdult({ plan: monthly });
    const sp = await preview(OWN, a.id);
    assert.equal(sp.source, 'CRM_ADULT_PLAN'); assert.equal(sp.suggestedDates.endBasis, 'PLAN_FIXED_TERM');
    const suggestedEnd = (await sql("SELECT (($1::date + interval '1 month')::date - 1)::text d", [today]))[0].d;
    assert.equal(sp.suggestedDates.endDate, suggestedEnd);
    for (const [start, end] of [['2027-01-31', '2027-02-27'], ['2027-03-31', '2027-04-29'], ['2027-12-31', '2028-01-30']]) {
      const p = await preview(OWN, a.id, { startDate: start, endDate: end });
      assert.equal(p.warnings.some((w) => w.code === 'FIXED_TERM_DIFFERS_FROM_PLAN'), false, `${start} + 1 month - 1 day = ${end}`);
      assert.equal(p.proposedDates.dateSource, 'STAFF_ADJUSTED');
    }
    const differs = await preview(OWN, a.id, { startDate: '2027-01-31', endDate: '2027-02-28' });
    assert.deepEqual(differs.warnings.find((w) => w.code === 'FIXED_TERM_DIFFERS_FROM_PLAN'), { code: 'FIXED_TERM_DIFFERS_FROM_PLAN', planEndDate: '2027-02-27' });
    const required = await preview(OWN, a.id, { startDate: '2027-01-31', endDate: null });
    assert.deepEqual(required.blocks, [{ code: 'FIXED_TERM_END_DATE_REQUIRED' }]); assert.equal(required.projection, null); assert.equal(required.canConfirm, false);
    await assert.rejects(confirm(OWN, a.id, confirmationFor(required)), code(422, 'ACTIVATION_BLOCKED'));
    const y = await crmAdult({ plan: yearly });
    assert.deepEqual((await preview(OWN, y.id, { startDate: '2028-02-29', endDate: '2029-02-28' })).warnings.find((w) => w.code === 'FIXED_TERM_DIFFERS_FROM_PLAN'),
      { code: 'FIXED_TERM_DIFFERS_FROM_PLAN', planEndDate: '2029-02-27' });
    // A staff-adjusted fixed-term activation: dates exactly as confirmed, the reason recorded, the period immutable.
    const done = await confirm(OWN, a.id, confirmationFor(differs, { dateAdjustmentReason: 'Agreed one extra day with the member.' }));
    assert.deepEqual(done.membership.effectivePeriod, { periodVersion: 1, startDate: '2027-01-31', endDate: '2027-02-28', endDateInclusive: true, schoolTimezone: LA, dateSource: 'STAFF_ADJUSTED',
      termStartedAt: '2027-01-31T08:00:00.000Z', termEndsAt: '2027-03-01T08:00:00.000Z' });
    assert.equal(done.membership.effectiveStatusAtActivation, 'SCHEDULED');
    assert.equal((await sql('SELECT adjustment_reason FROM hon.membership_effective_periods WHERE membership_id=$1', [a.id]))[0].adjustment_reason, 'Agreed one extra day with the member.');
    const o = await crmAdult({ plan: open });
    const op = await preview(OWN, o.id, { startDate: today, endDate: addDays(today, 30) });
    assert.ok(op.warnings.some((w) => w.code === 'OPEN_ENDED_PLAN_HAS_END_DATE')); assert.equal((await preview(OWN, o.id)).suggestedDates.endBasis, 'PLAN_OPEN_ENDED');
    assertions += 19; }

  // Staff adjustments need a reason; the claimed date source must match the server's.
  { const today = await localToday(), m = await generic();
    const adjusted = await preview(OWN, m.id, { startDate: addDays(today, 3), endDate: null });
    const { dateAdjustmentReason, ...noReason } = confirmationFor(adjusted);
    assert.ok(dateAdjustmentReason); await assert.rejects(confirm(OWN, m.id, noReason), (e) => e.getStatus() === 400);
    const same = await preview(OWN, m.id, { startDate: today, endDate: null });
    assert.equal(same.proposedDates.dateSource, 'SUGGESTED', 'proposing the suggestion is not an adjustment');
    await assert.rejects(confirm(OWN, m.id, confirmationFor(same, { dateSource: 'STAFF_ADJUSTED', dateAdjustmentReason: 'Claimed an adjustment.' })), code(422, 'DATE_SOURCE_MISMATCH'));
    await assert.rejects(confirm(OWN, m.id, confirmationFor(same, { dateAdjustmentReason: 'Not adjusted.' })), (e) => e.getStatus() === 400);
    await assert.rejects(confirm(OWN, m.id, confirmationFor(adjusted, { startDate: addDays(today, 4) })), code(409, 'ACTIVATION_PREVIEW_STALE'), 'dates other than the previewed ones');
    // Range blocks and invalid calendar dates.
    for (const [dates, block] of [[{ startDate: '1999-12-31', endDate: null }, 'START_DATE_OUT_OF_RANGE'], [{ startDate: addDays(today, 731), endDate: null }, 'START_DATE_OUT_OF_RANGE'],
      [{ startDate: today, endDate: addDays(today, -1) }, 'END_DATE_BEFORE_START'], [{ startDate: today, endDate: addDays(today, 3654) }, 'END_DATE_OUT_OF_RANGE']]) {
      const p = await preview(OWN, m.id, dates);
      assert.deepEqual(p.blocks.map((b) => b.code), [block], JSON.stringify(dates)); assert.equal(p.canConfirm, false);
    }
    assert.deepEqual((await preview(OWN, m.id, { startDate: addDays(today, 730), endDate: addDays(today, 730 + 3653) })).blocks, []);
    for (const dates of [{ startDate: '2027-02-30', endDate: null }, { startDate: '2027-1-01', endDate: null }, { startDate: today }, { endDate: null }, { startDate: today, endDate: null, extra: 1 }, { startDate: `${today}T00:00:00Z`, endDate: null }]) {
      await assert.rejects(preview(OWN, m.id, dates), (e) => e.getStatus() === 400, JSON.stringify(dates));
    }
    assert.deepEqual(await counts(m.id), none);
    assertions += 22; }

  // Future start: ACTIVE (confirmed) but SCHEDULED, starting at the school's local midnight across a DST change.
  { const m = await generic();
    const p = await preview(OWN, m.id, { startDate: '2027-03-14', endDate: '2027-11-07' });
    assert.ok(p.warnings.some((w) => w.code === 'START_DATE_IN_FUTURE')); assert.equal(p.effectiveStatusIfConfirmedNow, 'SCHEDULED');
    assert.deepEqual(p.projection, { termStartedAt: '2027-03-14T08:00:00.000Z', termEndsAt: '2027-11-08T08:00:00.000Z' });
    const done = await confirm(OWN, m.id, confirmationFor(p));
    assert.equal(done.membership.state, 'ACTIVE'); assert.equal(done.membership.effectiveStatusAtActivation, 'SCHEDULED');
    assert.deepEqual(await row(m.id), { state: 'ACTIVE', version: 2, s: '2027-03-14T08:00:00.000Z', e: '2027-11-08T08:00:00.000Z' });
    const status = async (at) => (await sql('SELECT hon.membership_effective_status_at(state,term_started_at,term_ends_at,$2::timestamptz) s FROM hon.memberships WHERE id=$1', [m.id, at]))[0].s;
    assert.deepEqual([await status('2027-03-14T07:59:59.999Z'), await status('2027-03-14T08:00:00Z'), await status('2027-11-08T07:59:59.999Z'), await status('2027-11-08T08:00:00Z')],
      ['SCHEDULED', 'IN_EFFECT', 'IN_EFFECT', 'ENDED'], 'the inclusive end date lasts until the next local midnight');
    assertions += 7; }
  // Other zones end to end: a skipped midnight (Santiago) and a midnight DST change (Havana); an invalid zone fails closed.
  for (const [school, start, end, startsAt, endsAt] of [[ids.santiago, '2026-09-06', '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z'],
    [ids.havana, '2027-03-14', '2027-03-14', '2027-03-14T05:00:00.000Z', '2027-03-15T04:00:00.000Z']]) {
    const actor = OWNS[school], m = await generic({ by: actor });
    const p = await preview(actor, m.id, { startDate: start, endDate: end });
    assert.deepEqual(p.projection, { termStartedAt: startsAt, termEndsAt: endsAt }, school);
    const done = await confirm(actor, m.id, confirmationFor(p));
    assert.equal(done.membership.effectivePeriod.schoolTimezone, school === ids.santiago ? 'America/Santiago' : 'America/Havana');
    assert.deepEqual(await row(m.id), { state: 'ACTIVE', version: 2, s: startsAt, e: endsAt });
    assertions += 3;
  }
  { const actor = OWNS[ids.badZone], m = await generic({ by: actor });
    await assert.rejects(preview(actor, m.id), code(409, 'SCHOOL_TIMEZONE_INVALID'));
    await assert.rejects(confirm(actor, m.id, { ...confirmationFor({ version: 1, previewDigest: 'a'.repeat(64), proposedDates: { startDate: '2027-01-01', endDate: null, dateSource: 'SUGGESTED' }, warnings: [], overridableWarnings: [] }) }),
      code(409, 'SCHOOL_TIMEZONE_INVALID'));
    assert.deepEqual(await counts(m.id), none); assertions += 3; }

  // ---------- 5. two-step integrity, idempotency and concurrency ----------
  { const m = await generic(), p = await preview(OWN, m.id);
    // The pre-0177 body fails closed with a dedicated code and no write.
    await assert.rejects(act(OWN.context(), m.id, { expectedVersion: 1 }), code(400, 'ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED'));
    for (const patch of [{ confirmation: 'I_CONFIRM' }, { reasonCode: 'BECAUSE' }, { reasonCode: 'OTHER' }, { expectedVersion: 0 }, { previewDigest: 'x' }, { acknowledgedWarnings: ['NOT_A_CODE', 'NOT_A_CODE'] },
      { payment: true }, { agreementId: randomUUID() }, { startDate: '2027-02-29' }]) {
      await assert.rejects(confirm(OWN, m.id, confirmationFor(p, patch)), (e) => e.getStatus() === 400, JSON.stringify(patch));
    }
    await assert.rejects(confirm(OWN, m.id, confirmationFor(p, { expectedVersion: 2 })), code(409, 'VERSION_CONFLICT'));
    await assert.rejects(confirm(OWN, m.id, confirmationFor(p, { previewDigest: 'f'.repeat(64) })), code(409, 'ACTIVATION_PREVIEW_STALE'));
    // Facts that change after the preview make it stale: the DRAFT itself, a new schedule, the school timezone.
    await admin.query("UPDATE hon.memberships SET plan_code=plan_code||'-X' WHERE id=$1", [m.id]);
    await assert.rejects(confirm(OWN, m.id, confirmationFor(p)), code(409, 'ACTIVATION_PREVIEW_STALE'));
    const p2 = await preview(OWN, m.id);
    await sql("UPDATE hon.schools SET timezone='America/New_York' WHERE id=$1", [ids.school]);
    try { await assert.rejects(confirm(OWN, m.id, confirmationFor(p2)), code(409, 'ACTIVATION_PREVIEW_STALE')); }
    finally { await sql('UPDATE hon.schools SET timezone=$2 WHERE id=$1', [ids.school, LA]); }
    await sql("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,auto_renew) VALUES($1,$2,$3,'MONTHLY',1000,'USD',false)", [ids.org, ids.school, m.id]);
    await assert.rejects(confirm(OWN, m.id, confirmationFor(p2)), code(409, 'ACTIVATION_PREVIEW_STALE'));
    const p3 = await preview(OWN, m.id);
    assert.ok(p3.warnings.some((w) => w.code === 'EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED'), 'an existing schedule is disclosed, not evaluated');
    assert.deepEqual(await counts(m.id), none);
    // Exact replay, different request under the same key, fresh key after activation.
    const context = OWN.context(), body = confirmationFor(p3);
    const first = await act(context, m.id, body);
    const schedule = (await sql('SELECT * FROM hon.membership_payment_schedules WHERE membership_id=$1', [m.id]))[0];
    const replay = await act({ ...context, requestId: randomUUID() }, m.id, body);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.membership, first.membership);
    await assert.rejects(act({ ...context, requestId: randomUUID() }, m.id, { ...body, reasonCode: 'LEGACY_MEMBERSHIP' }), code(409, 'IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(act({ ...context, requestId: randomUUID() }, randomUUID(), body), code(409, 'IDEMPOTENCY_KEY_REUSED'), 'the key is bound to the membership');
    await assert.rejects(confirm(OWN, m.id, body), code(409, 'MEMBERSHIP_NOT_DRAFT'));
    // The decision is the lifetime record of its key: an exact replay still works after the idempotency record is purged.
    await sql('DELETE FROM hon.idempotency_records WHERE principal_id=$1 AND idempotency_key=$2', [OWN.principal, context.idempotencyKey]);
    const late = await act({ ...context, requestId: randomUUID() }, m.id, body);
    assert.equal(late.replayed, true); assert.deepEqual(late.membership, first.membership);
    assert.equal((await sql("SELECT status FROM hon.idempotency_records WHERE principal_id=$1 AND idempotency_key=$2", [OWN.principal, context.idempotencyKey]))[0].status, 'COMPLETED');
    assert.deepEqual(await counts(m.id), { decisions: 1, periods: 1, follow_ups: 0, audits: 1, outbox: 1 });
    assert.deepEqual((await sql('SELECT * FROM hon.membership_payment_schedules WHERE membership_id=$1', [m.id]))[0], schedule, 'the schedule is untouched');
    const outbox = (await sql("SELECT schema_version,payload FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.activated'", [m.id]))[0];
    assert.equal(outbox.schema_version, 2); assert.equal(outbox.payload.executionAllowed, false); assert.equal(outbox.payload.humanOnly, true);
    const audit = (await sql("SELECT prior_state,next_state,source FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.activate'", [m.id]))[0];
    assert.deepEqual(audit.prior_state, { state: 'DRAFT', version: 1, termStartedAt: null, termEndsAt: null }); assert.deepEqual(audit.next_state, first.membership); assert.equal(audit.source, 'HUMAN_UI');
    assertions += 33; }
  // A pre-0177 in-flight activation key is refused rather than replayed or re-run.
  { const m = await generic(), p = await preview(OWN, m.id), key = randomUUID();
    await sql("INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at) VALUES($1,$2,$3,$4,$5,'COMPLETED',200,$6,clock_timestamp()+interval '1 day')",
      [ids.org, ids.school, OWN.principal, key, createHash('sha256').update(JSON.stringify({ operation: 'billing.membership.activate', membershipId: m.id, expectedVersion: 1 })).digest('hex'), { id: m.id, state: 'ACTIVE', version: 2 }]);
    await assert.rejects(confirm(OWN, m.id, confirmationFor(p), { idempotencyKey: key }), code(409, 'IDEMPOTENCY_KEY_REUSED'));
    assert.deepEqual(await counts(m.id), none); assertions += 2; }
  // Parallel confirmations with different keys by different staff: exactly one decision.
  { const m = await generic(), p = await preview(OWN, m.id);
    const results = await Promise.allSettled([OWN, ACT, ACT2, OVR, OWN].map((actor) => confirm(actor, m.id, confirmationFor(p))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(code(409, 'MEMBERSHIP_NOT_DRAFT')(r.reason) || code(409, 'ACTIVATION_PREVIEW_STALE')(r.reason), r.reason?.getResponse?.()?.code);
    assert.deepEqual(await counts(m.id), { decisions: 1, periods: 1, follow_ups: 0, audits: 1, outbox: 1 }); assertions += 2; }
  // Activation racing cancellation of the same membership: no deadlock, and the end state is one of the two serial orders.
  { const m = await generic(), p = await preview(OWN, m.id);
    const [a, c] = await Promise.allSettled([confirm(OWN, m.id, confirmationFor(p)), cxl(OWN.context(), m.id, { expectedVersion: 2, cancellationReason: 'Member moved away.' })]);
    assert.equal(a.status, 'fulfilled');
    const end = await row(m.id);
    if (c.status === 'fulfilled') assert.deepEqual([end.state, end.version], ['CANCELLED', 3]);
    else { assert.ok(code(409, 'MEMBERSHIP_NOT_ACTIVE')(c.reason), c.reason?.getResponse?.()?.code); assert.deepEqual([end.state, end.version], ['ACTIVE', 2]); }
    assertions += 2; }

  // ---------- 6. cancellation: unchanged contract and fingerprint, live authority ----------
  { const m = await generic(), done = await activate(OWN, m.id);
    const reason = 'Café closed — moved "upstate" / see notes';
    const context = OWN.context(), input = { expectedVersion: 2, cancellationReason: reason };
    await assert.rejects(cxl(NOCANCEL.context(), m.id, input), code(403, 'MEMBERSHIP_CANCELLATION_FORBIDDEN'));
    await assert.rejects(cxl(OWN.context(), m.id, { ...input, expectedVersion: 1 }), code(409, 'VERSION_CONFLICT'));
    const cancelled = await cxl(context, m.id, input);
    assert.deepEqual(Object.keys(cancelled.membership).sort(), ['billingAccountId', 'cancellationReason', 'createdAt', 'id', 'participantPersonId', 'planCode', 'state', 'version']);
    assert.equal(cancelled.membership.state, 'CANCELLED'); assert.equal(cancelled.membership.version, 3); assert.equal(cancelled.membership.cancellationReason, reason);
    // The fingerprint is byte-identical to the pre-0177 TypeScript fingerprint, so in-flight cancellation keys keep working.
    const legacy = createHash('sha256').update(JSON.stringify({ operation: 'billing.membership.cancel', membershipId: m.id, expectedVersion: 2, cancellationReason: reason, effectiveAt: null })).digest('hex');
    assert.equal((await sql('SELECT request_fingerprint FROM hon.idempotency_records WHERE principal_id=$1 AND idempotency_key=$2', [OWN.principal, context.idempotencyKey]))[0].request_fingerprint, legacy);
    const replay = await cxl({ ...context, requestId: randomUUID() }, m.id, input);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.membership, cancelled.membership);
    await assert.rejects(cxl({ ...context, requestId: randomUUID() }, m.id, { ...input, cancellationReason: 'Different.' }), code(409, 'IDEMPOTENCY_KEY_REUSED'));
    await assert.rejects(cxl(OWN.context(), m.id, { expectedVersion: 3, cancellationReason: 'Again.' }), code(409, 'MEMBERSHIP_NOT_ACTIVE'));
    // Terms are preserved; the derived status is CANCELLED; the row can no longer change in place.
    const ended = await row(m.id);
    assert.equal(ended.s, done.membership.effectivePeriod.termStartedAt);
    assert.equal((await sql('SELECT hon.membership_effective_status_at(state,term_started_at,term_ends_at,clock_timestamp()) s FROM hon.memberships WHERE id=$1', [m.id]))[0].s, 'CANCELLED');
    await assert.rejects(admin.query('UPDATE hon.memberships SET term_ends_at=clock_timestamp() WHERE id=$1', [m.id]), (e) => e.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    await assert.rejects(admin.query("UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [m.id]), (e) => e.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    // A pre-0177 completed cancellation record replays verbatim under the new function.
    const n = await generic(); await activate(OWN, n.id);
    const oldKey = randomUUID(), oldInput = { expectedVersion: 2, cancellationReason: 'Legacy retry.', effectiveAt: '2030-01-01T00:00:00Z' };
    const oldBody = { id: n.id, billingAccountId: n.account, participantPersonId: n.participant, planCode: 'LEGACY', state: 'CANCELLED', version: 3, cancellationReason: 'Legacy retry.', effectiveAt: oldInput.effectiveAt, createdAt: '2026-01-01T00:00:00.000Z' };
    await sql("INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at) VALUES($1,$2,$3,$4,$5,'COMPLETED',200,$6,clock_timestamp()+interval '1 day')",
      [ids.org, ids.school, OWN.principal, oldKey, createHash('sha256').update(JSON.stringify({ operation: 'billing.membership.cancel', membershipId: n.id, ...oldInput })).digest('hex'), oldBody]);
    const legacyReplay = await cxl(OWN.context({ idempotencyKey: oldKey }), n.id, oldInput);
    assert.equal(legacyReplay.replayed, true); assert.deepEqual(legacyReplay.membership, oldBody);
    assertions += 16; }

  // ---------- 7. separation ----------
  assert.ok(guardedCommands > 100, `${guardedCommands} guarded commands`);
  assert.equal((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type NOT IN ('billing.membership.activated','billing.membership.cancelled','billing.membership.drafted','billing.account.created') AND event_type ~ '(payment|invoice|charge|refund|entitlement|subscription)'", [ids.org]))[0].n, 0);
  assertions += 2;

  // ---------- 8. static benefit-path guard ----------
  // Every function that reads hon.memberships is a reviewed path. None is a booking, attendance, ClassPass, kiosk or
  // check-in path, so a SCHEDULED (future-dated) ACTIVE membership grants no benefit today. A new reader fails here
  // until it is reviewed for effective dates (E1b).
  const readers = (await sql("SELECT proname FROM pg_proc WHERE pronamespace='hon'::regnamespace AND prosrc ~* '\\mmemberships\\M' ORDER BY proname")).map((r) => r.proname);
  assert.deepEqual(readers, ['acknowledge_retention_review_evidence', 'activate_school_membership', 'cancel_school_membership', 'crm_adult_membership_draft_is_current',
    'crm_guardian_child_membership_draft_current', 'draft_crm_adult_membership', 'draft_crm_adult_membership_from_plan', 'draft_crm_guardian_child_membership_from_plan',
    'draft_owner_launch_membership', 'evaluate_membership_activation', 'read_crm_adult_membership_draft_confirmation', 'read_crm_adult_membership_preparation',
    'read_crm_guardian_child_enrollment', 'read_crm_lead_registration_recovery', 'read_owner_launch_membership_draft', 'read_parent_billing_view', 'read_parent_testing_status',
    'read_retention_review_signals', 'read_school_command_center', 'read_school_health_score', 'record_retention_attention_alert', 'renewal_membership_facts',
    'resolve_retention_attention_alert', 'revenue_plan_snapshot']);
  // Four retention/health reads also read attendance as a signal; no reader of memberships books, checks in or records attendance.
  assert.deepEqual((await sql("SELECT proname FROM pg_proc WHERE pronamespace='hon'::regnamespace AND prosrc ~* '\\mmemberships\\M' AND prosrc ~* '(class_bookings|attendance_records|class_pass|kiosk|check_in)' ORDER BY 1")).map((r) => r.proname),
    ['acknowledge_retention_review_evidence', 'read_retention_review_signals', 'read_school_health_score', 'record_retention_attention_alert']);
  assert.equal((await sql("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND prosrc ~* '\\mmemberships\\M' AND prosrc ~* '(INSERT\\s+INTO|UPDATE)\\s+(hon\\.)?(class_bookings|attendance_records|class_pass\\w*|kiosk\\w*|check_in\\w*)'"))[0].n, 0);
  assert.equal((await sql("SELECT count(*)::int n FROM pg_views WHERE definition ~* '\\mmemberships\\M'"))[0].n, 0);
  const apiRoot = new URL('../../../apps/api/src/', import.meta.url);
  const apiReaders = [];
  for (const file of await readdir(apiRoot, { recursive: true })) {
    if (file.endsWith('.ts') && /hon\.memberships\b/.test(await readFile(new URL(file, apiRoot), 'utf8'))) apiReaders.push(file);
  }
  assert.deepEqual(apiReaders.sort(), ['billing/invoice.service.ts', 'billing/membership.service.ts', 'reports/operations-report.service.ts']);
  assertions += 5;

  console.log(`PASS: membership activation gate 0177 (${assertions} assertions) — D41 option C: runtime has SELECT, no UPDATE/DELETE/TRUNCATE and INSERT on exactly 7 DRAFT columns; a settings-free trigger refuses every transition without matching decision and period evidence, even for the table owner with forged settings; private immutable evidence. D30a: three sensitive staff-assignable permissions mapped exactly to activate holders and system owners; owner and delegated staff activate, override needs both permissions at the exact school; other school, other organization, parent, nonhuman, delegated, Action Engine and suspended contexts refused in the API and the database; revocation during the IAM wait, before replay and of the override before replay all fail closed. D29a: unresolved identity review needs a documented override, creates one reminder, resolves and merges nothing, replays without duplicates under concurrency. D3: missing birth date warns, reminds and allows an optional staff attestation; known minors still need a guardian of record. D40/D40a: suggested and staff-adjusted school-local dates, inclusive end at the next local midnight, 23/25-hour days, skipped midnights, month end and leap day, SCHEDULED future starts, invalid zones fail closed. Two-step: stale previews, exact acknowledgements, exact-request idempotency (lifetime key record), pre-0177 keys refused, one decision under parallel staff, activation vs cancellation serial. Cancellation contract and fingerprint unchanged. ${separated.length} money/consent/automation tables unchanged across ${guardedCommands} commands and previews (previews write nothing at all); every memberships reader reviewed (no benefit path).`);
} finally {
  await database.onModuleDestroy?.();
  await Promise.allSettled([admin.end(), blocker.end(), restricted.end()]);
}
