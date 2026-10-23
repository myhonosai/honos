import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { confirmationFor, membershipFixtureQuery } from './membership-activation-test-support.mjs';

// Disposable-localhost proof for the 0178 membership date revisions (E1b-1). Every command runs through the real
// MembershipDateRevisionService against the restricted runtime role; the owner connection only builds fixtures and
// observes. Sections (numbers in brackets are the owner's required test areas):
//  1. posture: private immutable evidence, runtime privileges, the extended settings-free trigger [1][2][3][4]
//  2. E1b-D1/D2 permissions: owner-only mapping, delegation, live checks, revocation at every wait and replay [5][6]
//  3. school-local inclusive dates: DST, skipped midnight, month end, leap day, anchored extensions [11]
//  4. kinds and retroactive days: corrections, extensions (including an ended membership), early ends, blocks
//  5. two-step integrity: digests, acknowledgements, idempotency, concurrency [7][8]
//  6. financial separation: schedules, invoices, renewals, reminders, exact table snapshots [12]
//  7. legacy queue, history and the status summary [13]
//  8. same-membership races against invoice creation, cancellation, renewal and retention, both orders [9][10]
//  9. unchanged V1 reader bodies and the 0177 gate [4][14]
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { MembershipDateRevisionService } = await import('../../../apps/api/dist/billing/membership-date-revision.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { InvoiceService } = await import('../../../apps/api/dist/billing/invoice.service.js');
const { RenewalService } = await import('../../../apps/api/dist/billing/renewal.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const blocker = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'santiago', 'legacySchool', 'otherOrg', 'otherOrgSchool', 'pipeline', 'stage', 'program']
  .map((key) => [key, randomUUID()]));
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;
const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
const LA = 'America/Los_Angeles';
const REVISE = 'billing.membership.dates.revise', RETRO = 'billing.membership.dates.retroactive';
const CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE';
const REASON = { INITIAL_CONFIRMATION: 'LEGACY_RECORDS_REVIEWED', CORRECTION: 'DATA_ENTRY_ERROR', EXTENSION: 'MEMBER_REQUESTED', EARLY_END: 'MEMBER_REQUESTED' };
const BASE = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create',
  'billing.account.create', 'billing.membership_plan.manage'];

await admin.connect(); await blocker.connect(); await restricted.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), dates: new MembershipDateRevisionService(database),
  plans: new MembershipPlanService(database), registrations: new LeadRegistrationService(database), invoices: new InvoiceService(database), renewals: new RenewalService(database) };
const ms = services.memberships, dates = services.dates;
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const migration = await readFile(new URL('../migrations/0178_membership_date_revisions.sql', import.meta.url), 'utf8');

  // ---------- 1. posture ----------
  const bodyOf = (name) => migration.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
  const entry = ['preview_membership_date_revision(text,uuid,jsonb)', 'revise_membership_dates(text,uuid,jsonb,text,uuid,uuid)', 'read_membership_date_history(text,uuid)',
    'read_membership_date_confirmation_queue(text,jsonb)', 'read_school_membership_status_summary(text)'];
  const definers = ['evaluate_membership_date_revision(uuid,text,boolean,date,date)', 'membership_lifecycle_permission(uuid,uuid,uuid,text)', 'require_membership_lifecycle_actor(text,text)'];
  const plain = ['guard_membership_date_revision_insert()', 'guard_membership_state_transition()', 'membership_instant_text(timestamptz)', 'membership_next_anchored_term_end(date,integer,date)',
    'membership_date_revision_retroactive_days(date,date,date,date,date)', 'membership_current_period(uuid)',
    'membership_reporting_status(hon.membership_state,timestamptz,timestamptz,boolean,timestamptz)'];
  for (const signature of [...entry, ...definers, ...plain]) {
    const body = bodyOf(signature.replace(/\(.*$/, ''));
    assert.ok(body, `0178 defines ${signature}`);
    const row = (await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,(SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)::int overloads,
      array_length(p.proconfig,1) settings FROM pg_proc p WHERE p.oid=$3::regprocedure`, [runtimeUrl.username, body, `hon.${signature}`])).rows[0];
    assert.deepEqual(row, { exact: true, definer: !plain.includes(signature), runtime_execute: entry.includes(signature), public_execute: false, overloads: 1, settings: 1 }, signature);
    assertions++;
  }
  // 0178 replaces exactly three 0177 functions and alters no existing table, view or reader.
  assert.deepEqual([...migration.matchAll(/CREATE OR REPLACE FUNCTION hon\.(\w+)/g)].map((m) => m[1]).sort(),
    ['guard_membership_state_transition', 'membership_lifecycle_permission', 'require_membership_lifecycle_actor']);
  assert.doesNotMatch(migration, /\b(ALTER\s+TABLE\s+hon\.(?!membership_date_revision)|DROP\s+|CREATE\s+(OR\s+REPLACE\s+)?VIEW|ALTER\s+FUNCTION|DISABLE\s+TRIGGER)/i);
  // The trigger and the insert guard read no session, transaction or custom setting.
  assert.doesNotMatch(bodyOf('guard_membership_state_transition') + bodyOf('guard_membership_date_revision_insert'), /current_setting|set_config|session_user|current_user|pg_has_role/i);
  // The trigger body is the reviewed 0177 body with exactly one added ACTIVE branch.
  { const old = (await readFile(new URL('../migrations/0177_membership_activation_gate.sql', import.meta.url), 'utf8'))
      .match(/CREATE FUNCTION hon\.guard_membership_state_transition\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)[1];
    const added = bodyOf('guard_membership_state_transition').replace(/\n    -- E1b \(0178\)[\s\S]*?      RETURN NEW;\n    END IF;\n/, '\n');
    assert.equal(added, old, 'only the ACTIVE->ACTIVE revision branch was added'); }
  assert.doesNotMatch(bodyOf('preview_membership_date_revision') + bodyOf('evaluate_membership_date_revision') + bodyOf('read_membership_date_history')
    + bodyOf('read_membership_date_confirmation_queue') + bodyOf('read_school_membership_status_summary'), /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/, 'reads are DML- and lock-free');
  assert.deepEqual((await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal`)).rows, [{ tgname: 'membership_state_transition_guard' }]);
  assertions += 6;
  const evidence = ['membership_date_revisions', 'membership_date_revision_follow_ups'];
  for (const table of evidence) {
    assert.deepEqual((await admin.query(`SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid=$1::regclass`, [`hon.${table}`])).rows[0],
      { r: true, f: true, policies: 0 }, `${table} forced RLS, private`);
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table}`);
    await assert.rejects(restricted.query(`INSERT INTO hon.${table}(organization_id) VALUES(gen_random_uuid())`), (error) => error.code === '42501', `runtime cannot write ${table}`);
    assertions += 3;
  }
  // The deployment verifier's 0177 and 0178 sections (infra/postgres/011) pass against this database with its runtime role.
  { const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    for (const [start, end] of [['-- Membership activation gate exact verification (0177)', '-- End membership activation gate exact verification.'],
      ['-- Membership date revisions exact verification (0178)', '-- End membership date revisions exact verification.']]) {
      const section = verify.split(start)[1]?.split(end)[0];
      assert.ok(section, start);
      await admin.query(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', runtimeUrl.username));
      assertions++;
    } }
  // [1] The runtime still has exactly the 0177 D41 option C privileges: no UPDATE at any level, no DELETE/TRUNCATE.
  assert.deepEqual((await restricted.query(`SELECT has_table_privilege('hon.memberships','SELECT') s,has_table_privilege('hon.memberships','INSERT') i,
    has_any_column_privilege('hon.memberships','UPDATE') u,has_table_privilege('hon.memberships','DELETE') d,has_table_privilege('hon.memberships','TRUNCATE') t`)).rows[0],
  { s: true, i: false, u: false, d: false, t: false });
  for (const statement of ["UPDATE hon.memberships SET term_ends_at=clock_timestamp()", "UPDATE hon.memberships SET version=version+1",
    'SELECT hon.evaluate_membership_date_revision(gen_random_uuid(),\'CORRECTION\',false,NULL,NULL)', 'SELECT hon.membership_current_period(gen_random_uuid())',
    "SELECT hon.membership_reporting_status('ACTIVE',NULL,NULL,false,clock_timestamp())", 'SELECT hon.membership_next_anchored_term_end(current_date,1,NULL)',
    'SELECT hon.membership_date_revision_retroactive_days(current_date,NULL,current_date,NULL,current_date)', 'SELECT hon.membership_instant_text(clock_timestamp())',
    "SELECT hon.require_membership_lifecycle_actor('x','billing.membership.dates.revise')"]) {
    await assert.rejects(restricted.query(statement), (error) => error.code === '42501', statement);
  }
  assertions += 10;

  // ---------- fixture ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_DATES_ORG','PRIVATE_DATES_ORG'),($2,'PRIVATE_DATES_OTHER_ORG','PRIVATE_DATES_OTHER_ORG')", [ids.org, ids.otherOrg]);
  for (const [school, org, zone] of [[ids.school, ids.org, LA], [ids.otherSchool, ids.org, LA], [ids.santiago, ids.org, 'America/Santiago'], [ids.legacySchool, ids.org, LA],
    [ids.otherOrgSchool, ids.otherOrg, LA]]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'PRIVATE_DATES_SCHOOL',$3,$4)", [school, org, `dates-${school}`, zone]);
  }
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_DATES_PIPELINE')", [ids.pipeline, ids.org, ids.school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [ids.stage, ids.org, ids.school, ids.pipeline]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Karate','SCHEDULED')", [ids.program, ids.org, ids.school]);
  async function role(permissions, { org = ids.org, roleCode, system = false } = {}) {
    const id = randomUUID();
    await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,\'PRIVATE_DATES_ROLE\',$4)', [id, org, roleCode ?? `FRONT_DESK_${id.slice(0, 8)}`, system]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
    return id;
  }
  async function staff(roleId, { org = ids.org, school = ids.school, extraRole } = {}) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `dates-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DATES_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_DATES_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    if (extraRole) await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, extraRole]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, role: roleId, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  // School owners hold every permission (system OWNER role, as HQ provisioning grants); delegated staff roles below.
  const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).map((row) => row.code);
  assert.ok(allPermissions.includes(REVISE) && allPermissions.includes(RETRO));
  const ownerRole = await role(allPermissions, { roleCode: 'OWNER', system: true });
  const OWN = await staff(ownerRole), OWNS = await staff(ownerRole, { school: ids.santiago }), OWNL = await staff(ownerRole, { school: ids.legacySchool });
  const revRole = await role([...BASE, REVISE]), retroRole = await role([...BASE, REVISE, RETRO]);
  const REV = await staff(revRole), REV2 = await staff(revRole), RETROS = await staff(retroRole), RETRO2 = await staff(retroRole);
  const RETROONLY = await staff(await role([...BASE, RETRO])), READER = await staff(await role(['billing.membership.read'])), ACTIVATOR = await staff(await role(['billing.membership.activate']));
  const REPORTER = await staff(await role(['reporting.view']), { school: ids.legacySchool }), NONE = await staff(await role(BASE));
  const PARENT = await staff(retroRole, { extraRole: await role([REVISE], { roleCode: 'PARENT_PORTAL' }) });
  const OTHER_SCHOOL = await staff(await role(allPermissions), { school: ids.otherSchool });
  const OTHER_ORG = await staff(await role(allPermissions, { org: ids.otherOrg }), { org: ids.otherOrg, school: ids.otherOrgSchool });

  // [12] Money, provider, agreement, consent, payer, plan, renewal, SaaS and entitlement tables a revision must never touch (whole-table, every organization).
  const separated = (await sql(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' AND c.relname ~ $1 ORDER BY 1`,
    ['^(saas_|payment|invoice|refund|membership_payment|membership_plan|membership_renewal|billing_account|organization_entitlement|document_ack|agreement|consent|communication_|action_|ai_|crm_guardian_child_payer|school_payment|stripe|provider|membership_activation|membership_effective_period)'])).map((r) => r.relname);
  for (const table of ['saas_invoices', 'organization_entitlements', 'payment_attempts', 'invoices', 'membership_payment_schedules', 'billing_accounts', 'membership_plans',
    'membership_plan_versions', 'membership_plan_selections', 'membership_renewal_reviews', 'membership_renewal_versions', 'membership_activation_decisions', 'membership_effective_periods']) {
    assert.ok(separated.includes(table), `${table} is snapshotted`);
  }
  async function person({ school = ids.school, label = 'Member' } = {}) {
    const id = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)", [id, ids.org, school, label, `P${tag()}`]);
    return id;
  }
  async function generic(by = OWN) {
    const participant = await person({ school: by.school });
    const account = (await services.accounts.create(by.context(), { responsiblePersonId: participant, currency: 'USD' })).account.id;
    const { membership } = await ms.createDraft(by.context(), { billingAccountId: account, participantPersonId: participant, planCode: `GENERIC-${tag()}` });
    return { id: membership.id, participant, account };
  }
  async function crmAdult(plan) {
    const lead = randomUUID(), adult = await person({ label: 'Adult' });
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, ids.school, adult, ids.pipeline, ids.stage]);
    const registration = await services.registrations.register(OWN.context(), lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    const account = (await services.accounts.create(OWN.context(), { responsiblePersonId: adult, currency: 'USD' })).account.id;
    const draft = await services.plans.draftAdultMembershipFromPlan(OWN.context(), { studentProfileId: registration.result.studentProfileId, membershipPlanId: plan.planId,
      membershipPlanVersion: plan.version, confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' });
    return { id: draft.receipt.membershipId, participant: adult, account };
  }
  const plan = async (patch = {}) => (await services.plans.create(OWN.context(), { planCode: `PLAN-${tag().toUpperCase()}`, displayName: 'Adult Plan', programId: ids.program, availability: 'AVAILABLE',
    currency: 'USD', priceMinor: 15900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE', ...patch })).plan;
  const effectTables = ['memberships', 'idempotency_records', 'audit_events', 'outbox_events', 'work_items', 'human_work_history', ...evidence, 'membership_activation_follow_ups'];
  const hashTables = async (tables) => Object.fromEntries(await Promise.all(tables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h])));
  let guardedCommands = 0;
  async function guarded(work, tables = separated) {
    const before = await hashTables(tables);
    try { return await work(); } finally { assert.deepEqual(await hashTables(tables), before, 'no separated effect'); guardedCommands++; }
  }
  const localToday = async (school = ids.school) => (await sql('SELECT (clock_timestamp() AT TIME ZONE timezone)::date::text d FROM hon.schools WHERE id=$1', [school]))[0].d;
  const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const today = await localToday();
  // E1a activation through the real two-step service (fixture, outside the guarded revision snapshot).
  async function activate(actor, id, startDate, endDate) {
    const preview = await ms.previewActivation(actor.read(), id, startDate === undefined ? {} : { startDate, endDate });
    return (await ms.activate(actor.context(), id, confirmationFor(preview))).membership;
  }
  async function active(startDate, endDate, by = OWN) { const m = await generic(by); await activate(by, m.id, startDate, endDate); return m; }
  // Two-step date revision helpers. Previews must write nothing anywhere; confirmations nothing outside their own effects.
  const previewWith = (context, id, body) => guarded(() => dates.preview(context, id, body), [...separated, ...effectTables]);
  const preview = (actor, id, body) => previewWith(actor.read(), id, body);
  function confirmFor(p, patch = {}) {
    const input = { expectedVersion: p.version, expectedPeriodVersion: p.currentPeriod?.periodVersion ?? null, previewDigest: p.previewDigest, changeKind: p.changeKind,
      startDate: p.proposedDates.startDate, endDate: p.proposedDates.endDate, dateSource: p.proposedDates.dateSource, acknowledgedWarnings: p.warnings.map((w) => w.code),
      reasonCode: REASON[p.changeKind], reasonText: 'Staff reviewed the membership dates with the member.', confirmation: CONFIRMATION };
    if (input.dateSource === 'STAFF_ADJUSTED') input.dateAdjustmentReason = 'Member asked for a different last day.';
    return { ...input, ...patch };
  }
  const revise = (context, id, body) => guarded(() => dates.revise(context, id, body));
  async function change(actor, id, body, patch = {}) {
    const p = await preview(actor, id, body);
    assert.deepEqual(p.blocks, [], `${body.changeKind} has no blocks`);
    return { preview: p, ...(await revise(actor.context(), id, confirmFor(p, patch))) };
  }
  const row = async (id) => (await sql("SELECT state::text,version,to_char(term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') s,to_char(term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') e FROM hon.memberships WHERE id=$1", [id]))[0];
  const counts = async (id) => (await sql(`SELECT (SELECT count(*)::int FROM hon.membership_date_revisions WHERE membership_id=$1) revisions,
    (SELECT count(*)::int FROM hon.membership_date_revision_follow_ups WHERE membership_id=$1) follow_ups,
    (SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.dates.revise') audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.dates_revised') outbox`, [id]))[0];
  // [11] Every receipt's projection is the school-local day start of startDate and of endDate+1, whatever the day length.
  async function assertProjection(receipt) {
    const p = receipt.effectivePeriod;
    const check = (await sql(`SELECT ($1::timestamptz AT TIME ZONE $3)::date::text s_day,(($1::timestamptz - interval '1 microsecond') AT TIME ZONE $3)::date::text s_prev,
      CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE ($2::timestamptz AT TIME ZONE $3)::date::text END e_day,
      CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE (($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3)::date::text END e_last,
      $1::timestamptz=hon.membership_local_day_start($4::date,$3) s_exact,
      CASE WHEN $2::timestamptz IS NULL THEN true ELSE $2::timestamptz=hon.membership_local_day_start($5::date+1,$3) END e_exact`,
    [p.termStartedAt, p.termEndsAt, p.schoolTimezone, p.startDate, p.endDate]))[0];
    assert.equal(check.s_day, p.startDate); assert.equal(check.s_prev, addDays(p.startDate, -1)); assert.equal(check.s_exact, true); assert.equal(check.e_exact, true);
    if (p.endDate !== null) { assert.equal(check.e_last, p.endDate); assert.equal(check.e_day, addDays(p.endDate, 1)); }
    assert.deepEqual(await row(receipt.membershipId), { state: 'ACTIVE', version: receipt.version, s: p.termStartedAt, e: p.termEndsAt });
    assertions += 4;
  }

  // ---------- 1b. owner-level trigger, history and replay proofs ----------
  // Even the BYPASSRLS table owner with forged settings cannot change a confirmed membership without a matching revision row.
  const forged = "SELECT set_config('app.hon_source','HUMAN_UI',false),set_config('app.hon_external_subject','x',false),set_config('app.hon_membership_date_revision','on',false)";
  const ownerRevision = await active(today, null);
  { await admin.query(forged);
    for (const statement of ["UPDATE hon.memberships SET term_ends_at=term_started_at+interval '30 days' WHERE id=$1",
      "UPDATE hon.memberships SET term_ends_at=term_started_at+interval '30 days',version=version+1 WHERE id=$1",
      "UPDATE hon.memberships SET plan_code='FORGED',version=version+1 WHERE id=$1", "UPDATE hon.memberships SET version=version+1 WHERE id=$1",
      "UPDATE hon.memberships SET term_started_at=term_started_at-interval '1 day',version=version+2 WHERE id=$1"]) {
      await assert.rejects(admin.query(statement, [ownerRevision.id]), (error) => error.code === '42501' && error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED', statement);
    }
    await admin.query("SELECT set_config('app.hon_source','',false),set_config('app.hon_external_subject','',false),set_config('app.hon_membership_date_revision','',false)");
    assertions += 5; }
  const r1 = await change(OWN, ownerRevision.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 60) });
  await assertProjection(r1.receipt);
  const r2 = await change(OWN, ownerRevision.id, { changeKind: 'EXTENSION', startDate: today, endDate: addDays(today, 90) });
  await assertProjection(r2.receipt);
  assert.deepEqual([r1.receipt.effectivePeriod.periodVersion, r2.receipt.effectivePeriod.periodVersion, r2.receipt.previousPeriod.periodVersion], [2, 3, 2]);
  // [3] An older revision can never be replayed as the current period, not even by the owner with the next version number.
  { const old = (await sql("SELECT term_started_at,term_ends_at FROM hon.membership_date_revisions WHERE membership_id=$1 AND period_version=2", [ownerRevision.id]))[0];
    await assert.rejects(admin.query('UPDATE hon.memberships SET term_started_at=$2,term_ends_at=$3,version=version+1 WHERE id=$1', [ownerRevision.id, old.term_started_at, old.term_ends_at]),
      (error) => error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    // The current revision's own terms cannot be re-applied either: its version pair is already consumed.
    const cur = (await sql("SELECT term_started_at,term_ends_at FROM hon.membership_date_revisions WHERE membership_id=$1 AND period_version=3", [ownerRevision.id]))[0];
    await assert.rejects(admin.query('UPDATE hon.memberships SET term_started_at=$2,term_ends_at=$3,version=version+1 WHERE id=$1', [ownerRevision.id, cur.term_started_at, cur.term_ends_at]),
      (error) => error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    assertions += 2; }
  // [2] History is immutable and append-only in order: no UPDATE, DELETE, TRUNCATE or out-of-sequence INSERT, even for the owner.
  { const revisionId = r1.receipt.revisionId;
    for (const statement of [`UPDATE hon.membership_date_revisions SET reason_text='Rewritten history text' WHERE id='${revisionId}'`,
      `DELETE FROM hon.membership_date_revisions WHERE id='${revisionId}'`, 'TRUNCATE hon.membership_date_revisions CASCADE', 'TRUNCATE hon.membership_date_revision_follow_ups',
]) {
      await assert.rejects(admin.query(statement), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE', statement);
    }
    const source = (await sql('SELECT * FROM hon.membership_date_revisions WHERE id=$1', [r2.receipt.revisionId]))[0];
    const forge = async (patch) => {
      const values = { ...source, id: randomUUID(), idempotency_key: randomUUID(), ...patch };
      const columns = Object.keys(values);
      return admin.query(`INSERT INTO hon.membership_date_revisions(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`,
        columns.map((c) => (values[c] !== null && typeof values[c] === 'object' && !(values[c] instanceof Date) ? JSON.stringify(values[c]) : values[c])));
    };
    const v = (await row(ownerRevision.id)).version;
    // A forged row must continue the exact current period of the current membership version.
    for (const patch of [{ period_version: 4, prior_period_version: 3, prior_membership_version: v - 1, next_membership_version: v },
      { period_version: 4, prior_period_version: 3, prior_membership_version: v, next_membership_version: v + 1 },
      { period_version: 3, prior_period_version: 2, prior_membership_version: v, next_membership_version: v + 1, prior_start_date: r1.receipt.effectivePeriod.startDate, prior_end_date: r1.receipt.effectivePeriod.endDate },
      { change_kind: 'INITIAL_CONFIRMATION', period_version: 1, prior_period_version: null, prior_start_date: null, prior_end_date: null, prior_membership_version: v, next_membership_version: v + 1,
        prior_term_started_at: source.term_started_at, prior_term_ends_at: source.term_ends_at }]) {
      await assert.rejects(forge(patch), (error) => ['MEMBERSHIP_DATE_REVISION_DENIED'].includes(error.message) || error.code === '23505' || error.code === '23514', JSON.stringify(Object.keys(patch)));
    }
    assert.deepEqual(await counts(ownerRevision.id), { revisions: 2, follow_ups: 0, audits: 2, outbox: 2 });
    // The 0177 evidence and the 0177 transitions are intact.
    await assert.rejects(admin.query('DELETE FROM hon.membership_effective_periods WHERE membership_id=$1', [ownerRevision.id]), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE');
    await assert.rejects(admin.query("UPDATE hon.memberships SET state='DRAFT',version=version+1 WHERE id=$1", [ownerRevision.id]), (error) => error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    await assert.rejects(admin.query("UPDATE hon.memberships SET state='CANCELLED',version=version+1,term_ends_at=clock_timestamp() WHERE id=$1", [ownerRevision.id]), (error) => error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED');
    { const draft = await generic();
      await assert.rejects(admin.query("UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=$1", [draft.id]), (error) => error.message === 'MEMBERSHIP_STATE_TRANSITION_DENIED'); }
    assertions += 13; }

  // ---------- 2. permissions ----------
  // E1b-D1: the migration maps the two permissions to system OWNER roles only (re-run here on fresh roles, then rolled back).
  { const mapping = migration.match(/INSERT INTO hon\.role_permissions\(role_id,organization_id,permission_code\)[\s\S]*?ON CONFLICT DO NOTHING;/)[0];
    await admin.query('BEGIN');
    try {
      const orgA = randomUUID(), orgB = randomUUID();
      await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_MAP_A','PRIVATE_MAP_A'),($2,'PRIVATE_MAP_B','PRIVATE_MAP_B')", [orgA, orgB]);
      const sysOwner = await role([], { org: orgA, roleCode: 'OWNER', system: true }), sysManager = await role([], { org: orgA, roleCode: 'MANAGER', system: true });
      const custom = await role([], { org: orgB, roleCode: 'OWNER' });
      await admin.query(mapping);
      const granted = await sql(`SELECT role_id,array_agg(permission_code::text ORDER BY permission_code) codes FROM hon.role_permissions WHERE role_id=ANY($1) GROUP BY role_id`, [[sysOwner, custom, sysManager]]);
      assert.deepEqual(granted, [{ role_id: sysOwner, codes: [RETRO, REVISE] }]);
    } finally { await admin.query('ROLLBACK'); }
    assert.deepEqual(await sql("SELECT code,is_sensitive,is_staff_assignable FROM hon.permissions WHERE code IN ($1,$2) ORDER BY code", [REVISE, RETRO]),
      [{ code: RETRO, is_sensitive: true, is_staff_assignable: true }, { code: REVISE, is_sensitive: true, is_staff_assignable: true }]);
    assertions += 2; }
  // Delegated revise (no retroactive): routine revisions only; a retroactive confirmation is refused live and writes nothing.
  const pastStart = addDays(today, -10);
  const retroTarget = await active(pastStart, null);
  { const p = await preview(REV, retroTarget.id, { changeKind: 'CORRECTION', startDate: addDays(today, -15), endDate: null });
    assert.deepEqual(p.retroactiveDays, { added: 5, removed: 0 });
    assert.deepEqual(p.requiredPermissions, [REVISE, RETRO]); assert.equal(p.canConfirm, false); assert.deepEqual(p.blocks, []);
    assert.deepEqual(p.warnings.find((w) => w.code === 'RETROACTIVE_CHANGE'), { code: 'RETROACTIVE_CHANGE', added: 5, removed: 0 });
    await assert.rejects(revise(REV.context(), retroTarget.id, confirmFor(p)), code(403, 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN'));
    assert.deepEqual(await counts(retroTarget.id), { revisions: 0, follow_ups: 0, audits: 0, outbox: 0 });
    // The same change by staff holding both permissions at this school.
    const ok = await preview(RETROS, retroTarget.id, { changeKind: 'CORRECTION', startDate: addDays(today, -15), endDate: null });
    assert.equal(ok.canConfirm, true); assert.equal(ok.previewDigest, p.previewDigest, 'the digest binds facts, not the viewer');
    const done = await revise(RETROS.context(), retroTarget.id, confirmFor(ok));
    assert.equal(done.receipt.retroactivePermission, RETRO); assert.deepEqual(done.receipt.retroactiveDays, { added: 5, removed: 0 });
    await assertProjection(done.receipt);
    assert.equal((await sql('SELECT retroactive_permission FROM hon.membership_date_revisions WHERE id=$1', [done.receipt.revisionId]))[0].retroactive_permission, RETRO);
    assertions += 9; }
  // Non-retroactive change by delegated revise staff.
  { const m = await active(today, null);
    const done = await change(REV, m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 40) });
    assert.equal(done.receipt.retroactivePermission, null); assert.deepEqual(done.receipt.retroactiveDays, { added: 0, removed: 0 });
    assert.equal(done.receipt.authorizingPermission, REVISE); assert.equal(done.replayed, false);
    // Read authority: billing.membership.read or activate or dates.revise reads history; none of them alone may preview or revise.
    for (const actor of [READER, ACTIVATOR, REV]) assert.equal((await dates.history(actor.read(), m.id, {})).versions.length, 2);
    for (const actor of [READER, ACTIVATOR, RETROONLY, NONE, PARENT]) {
      await assert.rejects(preview(actor, m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 30) }), code(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
      await assert.rejects(dates.confirmationQueue(actor.read(), {}), code(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    }
    for (const actor of [NONE, RETROONLY]) await assert.rejects(dates.history(actor.read(), m.id, {}), code(403, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'));
    // Other school and other organization: a context at their own school cannot see this membership; at this school they hold nothing.
    for (const actor of [OTHER_SCHOOL, OTHER_ORG]) {
      await assert.rejects(preview(actor, m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 30) }), (e) => [404, 403].includes(e?.getStatus?.()));
      await assert.rejects(previewWith(actor.read({ organizationId: ids.org, schoolId: ids.school }), m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 30) }),
        (e) => e?.getStatus?.() === 403);
    }
    // Non-human, delegated and Action Engine contexts are refused by the service and by the database itself.
    for (const patch of [{ principalType: 'SERVICE_ACCOUNT' }, { source: 'AI_AGENT' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
      await assert.rejects(dates.preview(REV.read(patch), m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 30) }), code(403, 'HUMAN_COMMAND_REQUIRED'));
      await assert.rejects(dates.revise(REV.context(patch), m.id, {}), code(403, 'HUMAN_COMMAND_REQUIRED'));
    }
    for (const [setting, value] of [['app.hon_source', 'AI_AGENT'], ['app.hon_action_request_id', randomUUID()], ['app.hon_delegated_by_principal_id', randomUUID()], ['app.hon_external_subject', 'someone-else']]) {
      await assert.rejects(database.withTenantReadOnlyTransaction(REV.read(), async (client) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [REV.subject]);
        await client.query('SELECT set_config($1,$2,true)', [setting, value]);
        return client.query("SELECT hon.preview_membership_date_revision($1,$2::uuid,'{\"changeKind\":\"EARLY_END\"}')", [REV.subject, m.id]);
      }), (error) => error.code === '42501', setting);
    }
    assertions += 34; }
  // [5] Revocation: before confirmation, during the IAM wait, and before an exact replay; retroactive revocation before replay.
  { const m = await active(today, null);
    const p = await preview(REV2, m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 50) });
    await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [REV2.grant]);
    await assert.rejects(revise(REV2.context(), m.id, confirmFor(p)), code(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    await assert.rejects(dates.history(REV2.read(), m.id, {}), code(403, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'));
    await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [REV2.grant]);
    // Revoked while the command waits on the IAM SHARE locks: the uncommitted revocation holds the grant row; on commit the command re-checks and fails closed.
    await blocker.query('BEGIN'); await blocker.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [REV2.grant]);
    const pending = revise(REV2.context(), m.id, confirmFor(p));
    pending.catch(() => {});
    for (let i = 0; i < 300 && !(await sql("SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE NOT l.granted AND c.relname='principal_role_grants'")).length; i++) await sleep(10);
    assert.ok((await sql("SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE NOT l.granted AND c.relname='principal_role_grants'")).length, 'revision waited on IAM');
    await blocker.query('COMMIT');
    await assert.rejects(pending, code(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    assert.deepEqual(await counts(m.id), { revisions: 0, follow_ups: 0, audits: 0, outbox: 0 });
    await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [REV2.grant]);
    // Exact replay after revocation of the revise permission.
    const context = REV2.context();
    const first = await revise(context, m.id, confirmFor(p));
    await sql('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [revRole, REVISE]);
    await assert.rejects(revise({ ...context, requestId: randomUUID() }, m.id, confirmFor(p)), code(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [revRole, ids.org, REVISE]);
    const again = await revise({ ...context, requestId: randomUUID() }, m.id, confirmFor(p));
    assert.equal(again.replayed, true); assert.deepEqual(again.receipt, first.receipt);
    // A retroactive receipt replays only while the retroactive permission is still held.
    const rm = await active(addDays(today, -6), null);
    const rp = await preview(RETRO2, rm.id, { changeKind: 'EARLY_END', startDate: addDays(today, -6), endDate: addDays(today, -3) });
    assert.deepEqual(rp.retroactiveDays, { added: 0, removed: 2 });
    const rc = RETRO2.context();
    const rfirst = await revise(rc, rm.id, confirmFor(rp));
    assert.equal(rfirst.receipt.effectiveStatusAtRevision, 'ENDED');
    await sql('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2', [retroRole, RETRO]);
    await assert.rejects(revise({ ...rc, requestId: randomUUID() }, rm.id, confirmFor(rp)), code(403, 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN'));
    await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [retroRole, ids.org, RETRO]);
    assert.deepEqual((await revise({ ...rc, requestId: randomUUID() }, rm.id, confirmFor(rp))).receipt, rfirst.receipt);
    assert.deepEqual(await counts(rm.id), { revisions: 1, follow_ups: 0, audits: 1, outbox: 1 });
    assertions += 14; }

  // ---------- 3. school-local inclusive dates ----------
  // America/Los_Angeles: the spring-forward day is 23 hours and the fall-back day 25; ends are inclusive.
  const lengths = (await sql(`SELECT extract(epoch FROM hon.membership_local_day_start('2027-03-15',$1)-hon.membership_local_day_start('2027-03-14',$1))/3600 spring,
    extract(epoch FROM hon.membership_local_day_start('2027-11-08',$1)-hon.membership_local_day_start('2027-11-07',$1))/3600 fall`, [LA]))[0];
  assert.deepEqual([Number(lengths.spring), Number(lengths.fall)], [23, 25]);
  { const m = await active('2027-03-14', '2027-11-06');
    const a = await change(OWN, m.id, { changeKind: 'EXTENSION', startDate: '2027-03-14', endDate: '2027-11-07' });
    await assertProjection(a.receipt);
    assert.deepEqual([a.receipt.effectivePeriod.termStartedAt, a.receipt.effectivePeriod.termEndsAt], ['2027-03-14T08:00:00.000Z', '2027-11-08T08:00:00.000Z']);
    assert.equal(a.preview.proposedDates.dateSource, 'STAFF_ENTERED'); assert.equal(a.receipt.effectiveStatusAtRevision, 'SCHEDULED');
    const b = await change(OWN, m.id, { changeKind: 'CORRECTION', startDate: '2027-03-15', endDate: '2027-11-06' });
    await assertProjection(b.receipt);
    assert.deepEqual([b.receipt.effectivePeriod.termStartedAt, b.receipt.effectivePeriod.termEndsAt], ['2027-03-15T07:00:00.000Z', '2027-11-07T07:00:00.000Z']);
    assert.ok(b.preview.warnings.some((w) => w.code === 'START_DATE_CHANGED' && w.fromDate === '2027-03-14' && w.toDate === '2027-03-15'));
    // One-day membership: start and inclusive end on the same local day.
    const c = await change(OWN, m.id, { changeKind: 'EARLY_END', startDate: '2027-03-15', endDate: '2027-03-15' });
    assert.deepEqual([c.receipt.effectivePeriod.termStartedAt, c.receipt.effectivePeriod.termEndsAt], ['2027-03-15T07:00:00.000Z', '2027-03-16T07:00:00.000Z']);
    await assertProjection(c.receipt);
    assertions += 7; }
  // America/Santiago: midnight does not exist on the spring-forward day; the day starts at the first instant that exists.
  { const m = await active('2027-09-06', null, OWNS);
    const r = await change(OWNS, m.id, { changeKind: 'CORRECTION', startDate: '2027-09-05', endDate: '2027-09-11' });
    await assertProjection(r.receipt);
    assert.equal(r.receipt.effectivePeriod.schoolTimezone, 'America/Santiago');
    const local = (await sql("SELECT to_char($1::timestamptz AT TIME ZONE 'America/Santiago','HH24:MI') t", [r.receipt.effectivePeriod.termStartedAt]))[0].t;
    assert.equal(local, '01:00', 'the skipped midnight starts at 01:00 local');
    assertions += 2; }
  // Leap day and month end: fixed-term extensions are anchored to the confirmed start (E1b-D4, E1a month arithmetic preserved).
  { const yearly = await plan({ termKind: 'FIXED_MONTHS', termMonths: 12, billingFrequency: 'PAID_IN_FULL' });
    const m = await crmAdult(yearly);
    await activate(OWN, m.id, '2028-02-29', '2029-02-27');
    const first = await preview(OWN, m.id, { changeKind: 'EXTENSION' });
    assert.deepEqual(first.suggestedDates, { startDate: '2028-02-29', endDate: '2030-02-27', startBasis: 'CURRENT_START', endBasis: 'PLAN_FIXED_TERM_ANCHORED' });
    assert.equal(first.proposedDates.dateSource, 'SUGGESTED'); assert.ok(!first.warnings.some((w) => w.code === 'FIXED_TERM_DIFFERS_FROM_PLAN'));
    const e1 = await revise(OWN.context(), m.id, confirmFor(first));
    await assertProjection(e1.receipt);
    const second = await preview(OWN, m.id, { changeKind: 'EXTENSION' });
    assert.equal(second.suggestedDates.endDate, '2031-02-27', 'anchored to 2028-02-29, not compounded from the previous end');
    // Staff adjust the suggestion with a reason; the plan's anchored end is disclosed for acknowledgement.
    const adjusted = await preview(OWN, m.id, { changeKind: 'EXTENSION', startDate: '2028-02-29', endDate: '2032-03-15' });
    assert.equal(adjusted.proposedDates.dateSource, 'STAFF_ADJUSTED');
    assert.deepEqual(adjusted.warnings.find((w) => w.code === 'FIXED_TERM_DIFFERS_FROM_PLAN'), { code: 'FIXED_TERM_DIFFERS_FROM_PLAN', planEndDate: '2033-02-27' });
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(adjusted, { dateAdjustmentReason: undefined })), code(400, 'VALIDATION_FAILED'));
    const e2 = await revise(OWN.context(), m.id, confirmFor(adjusted));
    assert.equal((await sql('SELECT adjustment_reason,suggested_end_date::text s FROM hon.membership_date_revisions WHERE id=$1', [e2.receipt.revisionId]))[0].s, '2031-02-27');
    await assertProjection(e2.receipt);
    const monthly = await plan({ termKind: 'FIXED_MONTHS', termMonths: 1, billingFrequency: 'PAID_IN_FULL' });
    const mm = await crmAdult(monthly);
    await activate(OWN, mm.id, '2027-01-31', '2027-02-27');
    assert.equal((await preview(OWN, mm.id, { changeKind: 'EXTENSION' })).suggestedDates.endDate, '2027-03-30');
    // A fixed-term plan never takes an open end.
    assert.deepEqual((await preview(OWN, mm.id, { changeKind: 'EXTENSION', startDate: '2027-01-31', endDate: null })).blocks.map((b) => b.code), ['FIXED_TERM_END_DATE_REQUIRED']);
    assertions += 11; }

  // ---------- 4. kinds, retroactive days and blocks ----------
  { // E1b-D6: extending an ended membership needs the retroactive permission for the past days it newly covers.
    const ended = await active(addDays(today, -40), addDays(today, -5));
    const p = await preview(RETROS, ended.id, { changeKind: 'EXTENSION', startDate: addDays(today, -40), endDate: addDays(today, 30) });
    assert.deepEqual(p.retroactiveDays, { added: 4, removed: 0 });
    assert.deepEqual(p.warnings.map((w) => w.code), ['EFFECTIVE_STATUS_CHANGES', 'EXTENDS_ENDED_MEMBERSHIP', 'RETROACTIVE_CHANGE']);
    assert.deepEqual(p.warnings[0], { code: 'EFFECTIVE_STATUS_CHANGES', from: 'ENDED', to: 'IN_EFFECT' });
    await assert.rejects(revise(REV.context(), ended.id, confirmFor(p)), code(403, 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN'));
    const r = await revise(RETROS.context(), ended.id, confirmFor(p));
    assert.equal(r.receipt.effectiveStatusAtRevision, 'IN_EFFECT'); assert.equal(r.receipt.changeKind, 'EXTENSION'); assert.deepEqual(r.receipt.financialEffects, []);
    // Early end in the past removes past days; early end in the future does not.
    const open = await active(addDays(today, -20), null);
    assert.deepEqual((await preview(OWN, open.id, { changeKind: 'EARLY_END', startDate: addDays(today, -20), endDate: addDays(today, -3) })).retroactiveDays, { added: 0, removed: 2 });
    assert.deepEqual((await preview(OWN, open.id, { changeKind: 'EARLY_END', startDate: addDays(today, -20), endDate: addDays(today, -1) })).retroactiveDays, { added: 0, removed: 0 });
    // Kind shapes and the D5 rule.
    const shapes = async (body) => (await preview(OWN, open.id, body)).blocks.map((b) => b.code);
    assert.deepEqual(await shapes({ changeKind: 'EXTENSION', startDate: addDays(today, -20), endDate: addDays(today, 10) }), ['CHANGE_KIND_SHAPE_MISMATCH']);
    assert.deepEqual(await shapes({ changeKind: 'EARLY_END', startDate: addDays(today, -19), endDate: addDays(today, 10) }), ['CHANGE_KIND_SHAPE_MISMATCH']);
    assert.deepEqual(await shapes({ changeKind: 'CORRECTION', startDate: addDays(today, -20), endDate: null }), ['DATES_UNCHANGED']);
    assert.deepEqual(await shapes({ changeKind: 'INITIAL_CONFIRMATION', startDate: addDays(today, -20), endDate: addDays(today, 3) }), ['CHANGE_KIND_NOT_APPLICABLE']);
    assert.deepEqual(await shapes({ changeKind: 'CORRECTION', startDate: addDays(today, 800), endDate: null }), ['START_DATE_OUT_OF_RANGE']);
    assert.deepEqual(await shapes({ changeKind: 'CORRECTION', startDate: today, endDate: addDays(today, 3700) }), ['END_DATE_OUT_OF_RANGE']);
    await assert.rejects(preview(OWN, open.id, { changeKind: 'CORRECTION' }), code(400, 'VALIDATION_FAILED'), 'no suggestion: staff must enter dates');
    await assert.rejects(preview(OWN, open.id, { changeKind: 'CORRECTION', startDate: today, endDate: addDays(today, -1) }), code(400, 'VALIDATION_FAILED'));
    await assert.rejects(preview(OWN, open.id, { changeKind: 'CORRECTION', startDate: '2027-02-30', endDate: null }), code(400, 'VALIDATION_FAILED'));
    await assert.rejects(preview(OWN, open.id, { changeKind: 'RENEWAL', startDate: today, endDate: null }), code(400, 'VALIDATION_FAILED'));
    // E1b-D5: no revisions on CANCELLED (or DRAFT) memberships; the cancellation API is unchanged.
    const cancelled = await active(today, null);
    await ms.cancel(OWN.context(), cancelled.id, { expectedVersion: 2, cancellationReason: 'Member moved away.' });
    const cp = await preview(OWN, cancelled.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 5) });
    assert.deepEqual(cp.blocks.map((b) => b.code), ['MEMBERSHIP_NOT_ACTIVE']); assert.equal(cp.canConfirm, false); assert.equal(cp.effectiveStatusNow, 'CANCELLED');
    await assert.rejects(revise(OWN.context(), cancelled.id, confirmFor(cp)), code(409, 'MEMBERSHIP_NOT_ACTIVE'));
    const draft = await generic();
    assert.deepEqual((await preview(OWN, draft.id, { changeKind: 'INITIAL_CONFIRMATION', startDate: today, endDate: null })).blocks.map((b) => b.code), ['MEMBERSHIP_NOT_ACTIVE']);
    assert.deepEqual(await counts(cancelled.id), { revisions: 0, follow_ups: 0, audits: 0, outbox: 0 });
    assertions += 23; }

  // ---------- 5. two-step integrity ----------
  { const m = await active(today, null);
    const body = { changeKind: 'CORRECTION', startDate: addDays(today, 1), endDate: addDays(today, 100) };
    const p = await preview(OWN, m.id, body);
    assert.deepEqual(p.warnings.map((w) => w.code), ['EFFECTIVE_STATUS_CHANGES', 'START_DATE_CHANGED', 'START_DATE_IN_FUTURE']);
    const nothing = { revisions: 0, follow_ups: 0, audits: 0, outbox: 0 };
    // [7] Digest and fact binding.
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { previewDigest: p.previewDigest.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) })), code(409, 'DATE_REVISION_PREVIEW_STALE'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { endDate: addDays(today, 101) })), code(409, 'DATE_REVISION_PREVIEW_STALE'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { changeKind: 'EXTENSION', reasonCode: 'MEMBER_REQUESTED' })), code(409, 'DATE_REVISION_PREVIEW_STALE'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { acknowledgedWarnings: [] })), code(422, 'DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { acknowledgedWarnings: [...p.warnings.map((w) => w.code), 'END_DATE_PASSED'] })), code(422, 'DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { dateSource: 'SUGGESTED' })), code(422, 'DATE_SOURCE_MISMATCH'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { expectedVersion: p.version + 1 })), code(409, 'VERSION_CONFLICT'));
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, { expectedPeriodVersion: 7 })), code(409, 'PERIOD_VERSION_CONFLICT'));
    for (const patch of [{ reasonCode: 'SCHOOL_COURTESY' }, { reasonCode: 'MOVED_AWAY' }, { reasonText: 'Too short' }, { reasonText: ' Leading whitespace is refused.' }, { confirmation: 'YES' },
      { expectedPeriodVersion: null }, { acknowledgedWarnings: ['NOT_A_WARNING'] }, { unexpected: true }, { dateAdjustmentReason: 'Not adjusted at all.' }]) {
      await assert.rejects(revise(OWN.context(), m.id, confirmFor(p, patch)), code(400, 'VALIDATION_FAILED'), JSON.stringify(patch));
    }
    await assert.rejects(dates.revise(OWN.context({ idempotencyKey: '' }), m.id, confirmFor(p)), code(409, 'IDEMPOTENCY_KEY_REQUIRED'));
    await assert.rejects(dates.preview(OWN.context(), m.id, { changeKind: 'EARLY_END' }), code(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
    assert.deepEqual(await counts(m.id), nothing);
    // A financial fact that appears after the preview makes it stale.
    await sql("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,auto_renew,status) VALUES($1,$2,$3,'MONTHLY',100,'USD',hon.membership_local_day_start($4::date,$5),false,'PAUSED')",
      [ids.org, ids.school, m.id, addDays(today, 10), LA]);
    await assert.rejects(revise(OWN.context(), m.id, confirmFor(p)), code(409, 'DATE_REVISION_PREVIEW_STALE'));
    assert.deepEqual(await counts(m.id), nothing);
    // [8] Exact retry, key reuse and parallel staff.
    const fresh = await preview(OWN, m.id, body);
    const context = OWN.context();
    const [x, y] = await Promise.all([revise(context, m.id, confirmFor(fresh)), revise({ ...context, requestId: randomUUID() }, m.id, confirmFor(fresh)).catch((e) => e)]);
    const replays = [x, y].filter((r) => r?.replayed === true).length;
    assert.ok(x.replayed === false || y?.replayed === false, 'one original');
    assert.ok(replays === 1 || code(409, 'IDEMPOTENCY_IN_PROGRESS')(y) || code(409, 'IDEMPOTENCY_IN_PROGRESS')(x));
    const replay = await revise({ ...context, requestId: randomUUID() }, m.id, confirmFor(fresh));
    assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, (x.replayed === false ? x : y).receipt);
    await assert.rejects(revise({ ...context, requestId: randomUUID() }, m.id, confirmFor(fresh, { reasonText: 'A different reason for the same key.' })), code(409, 'IDEMPOTENCY_KEY_REUSED'));
    const other = await active(today, null);
    await assert.rejects(revise({ ...context, requestId: randomUUID() }, other.id, confirmFor(fresh)), code(409, 'IDEMPOTENCY_KEY_REUSED'));
    assert.deepEqual(await counts(m.id), { revisions: 1, follow_ups: 1, audits: 1, outbox: 1 });
    assert.equal((await sql("SELECT count(*)::int n FROM hon.idempotency_records WHERE principal_id=$1 AND idempotency_key=$2 AND status='COMPLETED'", [OWN.principal, context.idempotencyKey]))[0].n, 1);
    // Two staff confirm the same preview with their own keys at the same time: exactly one revision.
    const race = await preview(OWN, other.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 20) });
    const results = await Promise.allSettled([revise(OWN.context(), other.id, confirmFor(race)), revise(RETROS.context(), other.id, confirmFor(race))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.some((r) => r.status === 'rejected' && (code(409, 'VERSION_CONFLICT')(r.reason) || code(409, 'PERIOD_VERSION_CONFLICT')(r.reason))));
    assert.deepEqual(await counts(other.id), { revisions: 1, follow_ups: 0, audits: 1, outbox: 1 });
    // The outbox event is inert and human-only.
    const event = (await sql("SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.dates_revised'", [other.id]))[0].payload;
    assert.equal(event.executionAllowed, false); assert.equal(event.humanOnly, true); assert.deepEqual(event.financialEffects, []);
    assertions += 33; }

  // ---------- 6. financial separation ----------
  { const insertSchedule = (id, days, status = 'ACTIVE') => sql(`INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,auto_renew,status)
      VALUES($1,$2,$3,'MONTHLY',15900,'USD',hon.membership_local_day_start($4::date,$5),true,$6)`, [ids.org, ids.school, id, addDays(today, days), LA, status]);
    const insertInvoice = (m, status, days) => sql(`INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at)
      VALUES($1,$2,$3,$4,$5,'USD',15900,0,15900,CASE WHEN $6::int IS NULL THEN NULL ELSE hon.membership_local_day_start($7::date+$6::int,$8) END)`, [ids.org, ids.school, m.account, m.id, status, days, today, LA]);
    // A schedule that would charge after the new last day refuses the revision; one inside the period is disclosed and reminded.
    const s = await active(today, null);
    await insertSchedule(s.id, 10);
    assert.deepEqual((await preview(OWN, s.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 5) })).blocks.map((b) => b.code), ['DATE_CHANGE_CONFLICTS_WITH_PAYMENT_SCHEDULE']);
    const sr = await change(OWN, s.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 20) });
    assert.deepEqual(sr.preview.warnings.find((w) => w.code === 'PAYMENT_SCHEDULE_UNCHANGED'), { code: 'PAYMENT_SCHEDULE_UNCHANGED', count: 1 });
    assert.equal(sr.receipt.followUps.length, 1); assert.equal(sr.receipt.followUps[0].kind, 'BILLING_REVIEW');
    const work = (await sql('SELECT title,priority,work_origin,status FROM hon.work_items WHERE id=$1', [sr.receipt.followUps[0].workItemId]))[0];
    assert.deepEqual(work, { title: 'Review billing after a membership date change', priority: 'NORMAL', work_origin: 'HUMAN_UI', status: 'READY' });
    assert.equal(sr.preview.financialFacts.schedules.length, 1); assert.equal(sr.preview.financialFacts.schedules[0].nextChargeDate, addDays(today, 10));
    for (const statement of [`UPDATE hon.membership_date_revision_follow_ups SET created_at=clock_timestamp() WHERE revision_id='${sr.receipt.revisionId}'`,
      `DELETE FROM hon.membership_date_revision_follow_ups WHERE revision_id='${sr.receipt.revisionId}'`]) {
      await assert.rejects(admin.query(statement), (error) => error.message === 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE', statement);
    }
    // E1b-D3: shortening with a PAID invoice is allowed with an acknowledgement and a reminder; nothing is refunded or credited.
    const paid = await active(today, null);
    await insertInvoice(paid, 'PAID', 0);
    const pr = await change(OWN, paid.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 15) });
    assert.ok(pr.preview.warnings.some((w) => w.code === 'PAID_INVOICE_NOT_REFUNDED_OR_CREDITED'));
    assert.equal(pr.receipt.followUps.length, 1); assert.deepEqual(pr.receipt.financialEffects, []);
    assert.equal((await sql('SELECT financial_effects FROM hon.membership_date_revisions WHERE id=$1', [pr.receipt.revisionId]))[0].financial_effects.length, 0);
    // An open invoice due after a shortened end refuses; an extension with an open invoice discloses it.
    const issued = await active(today, addDays(today, 60));
    await insertInvoice(issued, 'ISSUED', 30);
    assert.deepEqual((await preview(OWN, issued.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 20) })).blocks.map((b) => b.code), ['DATE_CHANGE_CONFLICTS_WITH_OPEN_INVOICE']);
    const ir = await change(OWN, issued.id, { changeKind: 'EXTENSION', startDate: today, endDate: addDays(today, 90) });
    assert.ok(ir.preview.warnings.some((w) => w.code === 'OPEN_INVOICE_UNCHANGED')); assert.equal(ir.receipt.followUps.length, 1);
    // A DRAFT invoice is disclosed only; more than 20 financial records fails closed.
    const drafted = await active(today, null);
    await insertInvoice(drafted, 'DRAFT', null);
    const dr = await change(OWN, drafted.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 25) });
    assert.ok(dr.preview.warnings.some((w) => w.code === 'DRAFT_INVOICE_UNCHANGED')); assert.equal(dr.receipt.followUps.length, 0);
    for (let i = 0; i < 20; i++) await insertInvoice(drafted, 'VOID', null);
    const many = await preview(OWN, drafted.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 24) });
    assert.deepEqual(many.blocks.map((b) => b.code), ['FINANCIAL_FACTS_TOO_MANY_TO_EVALUATE']); assert.equal(many.financialFacts.invoicesTruncated, true);
    assert.equal(many.financialFacts.invoices.length, 20);
    // An open renewal review keeps its stored facts and is disclosed.
    const renewing = await active(today, addDays(today, 30));
    const from = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z'), to = new Date(Date.now() + 20 * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    await services.renewals.mutate(OWN.context(), 'CREATE', null, { expectedVersion: 0, membershipId: renewing.id, reviewFrom: from, reviewTo: to, status: 'OPEN', note: 'Review renewal.', reason: 'Term ending soon.', reminderNeeded: false });
    const rr = await change(OWN, renewing.id, { changeKind: 'EXTENSION', startDate: today, endDate: addDays(today, 60) });
    assert.ok(rr.preview.warnings.some((w) => w.code === 'RENEWAL_REVIEW_FACTS_OUTDATED'));
    // No payment, invoice, charge, refund, entitlement or subscription event was ever emitted for this organization by a revision.
    assert.equal((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type NOT IN ('billing.membership.activated','billing.membership.cancelled','billing.membership.drafted','billing.account.created','billing.membership.dates_revised','billing.membership_plan.created','crm.lead.registered','billing.renewal.created') AND event_type ~ '(payment|invoice|charge|refund|entitlement|subscription)'", [ids.org]))[0].n, 0);
    assertions += 25; }

  // ---------- 7. legacy queue, history and status summary ----------
  { const school = ids.legacySchool;
    const legacyRow = async (label, start, end, createdAt) => {
      const participant = await person({ school, label });
      const account = (await services.accounts.create(OWNL.context(), { responsiblePersonId: participant, currency: 'USD' })).account.id;
      return (await membershipFixtureQuery(admin, `INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,version,term_started_at,term_ends_at,created_at)
        VALUES($1,$2,$3,$4,'LEGACY-PLAN','ACTIVE',1,$5,$6,$7) RETURNING id`, [ids.org, school, account, participant, start, end, createdAt]))[0].id;
    };
    const schoolToday = await localToday(school);
    const day = (offset, time = '00:00') => sql(`SELECT ((($1::date + $2::int)::text||' '||$3)::timestamp AT TIME ZONE $4) t`, [schoolToday, offset, time, LA]).then((r) => r[0].t);
    // (a) stored local midnights, in effect; (b) arbitrary instants, ended; (c) future start; (d) nothing stored. Created in this order.
    const a = await legacyRow('Alpha', await day(-40), await day(21), '2020-01-01T00:00:00Z');
    const b = await legacyRow('Bravo', await day(-100, '13:17'), await day(-10, '09:45'), '2020-01-02T00:00:00Z');
    const c = await legacyRow('Charlie', await day(15), null, '2020-01-03T00:00:00Z');
    const d = await legacyRow('Delta', null, null, '2020-01-04T00:00:00Z');
    const cancelledLegacy = await legacyRow('Echo', await day(-10), null, '2020-01-05T00:00:00Z');
    await membershipFixtureQuery(admin, "UPDATE hon.memberships SET state='CANCELLED',version=2 WHERE id=$1", [cancelledLegacy]);
    await generic(OWNL);
    const lt = await localToday(school);
    await active(addDays(lt, 10), null, OWNL); await active(addDays(lt, -1), addDays(lt, 20), OWNL); await active(addDays(lt, -30), addDays(lt, -2), OWNL);
    const summary = await guarded(() => dates.statusSummary(REPORTER.read()), [...separated, ...effectTables]);
    assert.deepEqual({ lifecycle: summary.lifecycle, active: summary.activeByEffectiveStatus, hints: summary.undatedHints, starting: summary.confirmedStartingNext30Days, ending: summary.confirmedEndingNext30Days,
      zone: summary.schoolTimezone, localToday: summary.localToday, windowEndDate: summary.windowEndDate }, {
      lifecycle: { DRAFT: 1, ACTIVE: 7, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 1, EXPIRED: 0 }, active: { SCHEDULED: 1, IN_EFFECT: 1, ENDED: 1, UNDATED: 4 },
      hints: { storedTermInEffect: 1, storedTermEnded: 1, storedTermFuture: 1, noStoredStart: 1 }, starting: 1, ending: 1, zone: LA, localToday: lt, windowEndDate: addDays(lt, 30) });
    await assert.rejects(dates.statusSummary(NONE.read()), code(403, 'MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN'));
    await assert.rejects(dates.statusSummary(REPORTER.read({ schoolId: ids.school })), (e) => e?.getStatus?.() === 403);
    // The queue lists exactly the undated ACTIVE rows, oldest first, keyset-paginated; it never includes cancelled rows.
    const page1 = await guarded(() => dates.confirmationQueue(OWNL.read(), { limit: 2 }), [...separated, ...effectTables]);
    assert.deepEqual(page1.items.map((i) => i.membershipId), [a, b]); assert.equal(page1.next, b);
    assert.equal(page1.items[0].participantDisplayName.startsWith('Alpha'), true); assert.equal(page1.items[1].legacyStoredTerm.termStartedAt, new Date(await day(-100, '13:17')).toISOString());
    const page2 = await dates.confirmationQueue(OWNL.read(), { after: page1.next, limit: 2 });
    assert.deepEqual(page2.items.map((i) => i.membershipId), [c, d]); assert.equal(page2.next, null);
    await assert.rejects(dates.confirmationQueue(OWNL.read(), { limit: 51 }), code(400, 'VALIDATION_FAILED'));
    await assert.rejects(dates.confirmationQueue(OWNL.read(), { after: randomUUID() }), code(400, 'VALIDATION_FAILED'));
    // History before confirmation: no versions, the stored instants are hints only.
    const hd = await dates.history(OWNL.read(), d, {});
    assert.deepEqual({ datesConfirmed: hd.datesConfirmed, effectiveStatus: hd.effectiveStatus, versions: hd.versions, legacy: hd.legacyStoredTerm, current: hd.currentPeriod },
      { datesConfirmed: false, effectiveStatus: 'UNDATED', versions: [], legacy: { termStartedAt: null, termEndsAt: null }, current: null });
    // E1b-D7: each one is confirmed individually. (a) HON suggests the stored local dates exactly; nothing past changes.
    const pa = await preview(OWNL, a, { changeKind: 'INITIAL_CONFIRMATION' });
    assert.deepEqual(pa.suggestedDates, { startDate: addDays(lt, -40), endDate: addDays(lt, 20), startBasis: 'LEGACY_STORED_START', endBasis: 'LEGACY_STORED_END' });
    assert.deepEqual(pa.warnings.map((w) => w.code), ['EFFECTIVE_STATUS_CHANGES', 'LEGACY_TERM_INTERPRETATION']); assert.deepEqual(pa.retroactiveDays, { added: 0, removed: 0 });
    assert.equal(pa.effectiveStatusNow, 'UNDATED'); assert.equal(pa.effectiveStatusIfConfirmedNow, 'IN_EFFECT'); assert.equal(pa.currentPeriod, null);
    const ra = await revise(OWNL.context(), a, confirmFor(pa));
    assert.deepEqual([ra.receipt.previousVersion, ra.receipt.version, ra.receipt.effectivePeriod.periodVersion, ra.receipt.previousPeriod.periodVersion], [1, 2, 1, null]);
    assert.equal(ra.receipt.previousPeriod.legacyTermStartedAt, new Date(await day(-40)).toISOString());
    await assertProjection(ra.receipt);
    // (b) arbitrary stored instants are replaced by local-day projections and disclosed.
    const pb = await preview(OWNL, b, { changeKind: 'INITIAL_CONFIRMATION' });
    const bStoredStart = new Date(await day(-100, '13:17')).toISOString();
    assert.ok(pb.warnings.some((w) => w.code === 'LEGACY_STORED_TERM_REPLACED' && w.storedStart === bStoredStart));
    assert.deepEqual([pb.suggestedDates.startDate, pb.suggestedDates.endDate], [addDays(lt, -100), addDays(lt, -10)]);
    await assertProjection((await revise(OWNL.context(), b, confirmFor(pb))).receipt);
    // (d) nothing stored: no suggestion; staff enter dates; past days need the retroactive permission. HON never fabricates dates.
    await assert.rejects(preview(OWNL, d, { changeKind: 'INITIAL_CONFIRMATION' }), code(400, 'VALIDATION_FAILED'));
    const pd = await preview(OWNL, d, { changeKind: 'INITIAL_CONFIRMATION', startDate: addDays(lt, -3), endDate: null });
    assert.equal(pd.proposedDates.dateSource, 'STAFF_ENTERED'); assert.deepEqual(pd.retroactiveDays, { added: 3, removed: 0 });
    assert.ok(pd.warnings.some((w) => w.code === 'LEGACY_TERM_NOT_STORED')); assert.deepEqual(pd.requiredPermissions, [REVISE, RETRO]);
    await assert.rejects(revise(OWNL.context(), d, confirmFor(pd, { reasonCode: 'DATA_ENTRY_ERROR' })), code(400, 'VALIDATION_FAILED'));
    const rd = await revise(OWNL.context(), d, confirmFor(pd, { reasonCode: 'MEMBER_CONFIRMED_DATES' }));
    assert.equal(rd.receipt.retroactivePermission, RETRO);
    // A second INITIAL_CONFIRMATION is impossible; corrections continue the history.
    assert.deepEqual((await preview(OWNL, d, { changeKind: 'INITIAL_CONFIRMATION', startDate: addDays(lt, -2), endDate: null })).blocks.map((x) => x.code), ['CHANGE_KIND_NOT_APPLICABLE']);
    const rd2 = await change(OWNL, d, { changeKind: 'EARLY_END', startDate: addDays(lt, -3), endDate: addDays(lt, 45) });
    const h = await dates.history(READER.read({ schoolId: school }), d, {}).catch(() => dates.history(OWNL.read(), d, {}));
    assert.deepEqual(h.versions.map((v) => [v.periodVersion, v.changeKind, v.dateSource, v.reasonCode]), [[2, 'EARLY_END', 'STAFF_ENTERED', 'MEMBER_REQUESTED'], [1, 'INITIAL_CONFIRMATION', 'STAFF_ENTERED', 'MEMBER_CONFIRMED_DATES']]);
    assert.deepEqual([h.datesConfirmed, h.currentPeriod.periodVersion, h.currentPeriod.source, h.legacyStoredTerm, h.versions[1].retroactiveDays], [true, 2, 'REVISION', null, { added: 3, removed: 0 }]);
    assert.equal(rd2.receipt.effectivePeriod.periodVersion, 2);
    // The activation period is part of the history with its own decision facts.
    const activated = await active(today, null);
    await change(OWN, activated.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, 9) });
    const ah = await dates.history(OWN.read(), activated.id, {});
    assert.deepEqual(ah.versions.map((v) => [v.periodVersion, v.changeKind]), [[2, 'EARLY_END'], [1, 'INITIAL']]);
    assert.deepEqual([ah.versions[1].reasonCode, ah.versions[1].retroactiveDays, ah.currentPeriod.source], ['ROUTINE_ENROLLMENT', null, 'REVISION']);
    // Totals after the confirmations: lifecycle unchanged, nothing disappears, the queue holds only (c).
    const after = await dates.statusSummary(REPORTER.read());
    assert.deepEqual([after.lifecycle.ACTIVE, after.activeByEffectiveStatus, after.undatedHints], [7, { SCHEDULED: 1, IN_EFFECT: 3, ENDED: 2, UNDATED: 1 },
      { storedTermInEffect: 0, storedTermEnded: 0, storedTermFuture: 1, noStoredStart: 0 }]);
    assert.deepEqual((await dates.confirmationQueue(OWNL.read(), {})).items.map((i) => i.membershipId), [c]);
    assertions += 40; }

  // ---------- 8. same-membership races: invoice creation, cancellation, renewal, retention ----------
  const deadlocks = async () => Number((await sql('SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()'))[0].deadlocks);
  const waitingOn = async (relname, excluded) => (await sql(`SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE NOT l.granted AND a.datname=current_database() AND c.relname=$1 AND NOT (l.pid = ANY($2::int[]))`, [relname, excluded]))[0]?.pid;
  const anyWaiting = async (excluded) => (await sql(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database() AND NOT (l.pid = ANY($1::int[]))`, [excluded])).length > 0;
  function track(promise) { const s = { done: false }; s.promise = promise.then((v) => { s.done = true; return v; }, (e) => { s.done = true; throw e; }); s.promise.catch(() => {}); return s; }
  // First is held by a blocker holding EXCLUSIVE on `stage` (a table it locks after the membership row); second then arrives.
  async function race(stage, first, second) {
    const before = await deadlocks();
    await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE hon.${stage} IN EXCLUSIVE MODE`);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    let a, b;
    try {
      a = track(first());
      let aPid;
      for (let i = 0; i < 300 && !aPid; i++) { if (a.done) break; aPid = await waitingOn(stage, [blockerPid]); if (!aPid) await sleep(10); }
      assert.ok(aPid, `first workflow reached ${stage}`);
      b = track(second());
      for (let i = 0; i < 300 && !b.done && !(await anyWaiting([blockerPid, aPid])); i++) await sleep(10);
    } finally { await blocker.query('ROLLBACK'); }
    const results = await Promise.allSettled([a.promise, b.promise]);
    assert.equal(await deadlocks(), before, `no deadlock at ${stage}`);
    for (const r of results) if (r.status === 'rejected') assert.notEqual(r.reason?.code, '40P01');
    return results;
  }
  const codeOf = (r) => (r.status === 'fulfilled' ? 'OK' : r.reason?.getResponse?.()?.code ?? r.reason?.code ?? r.reason?.message);
  const raceInvoice = (m) => () => services.invoices.createDraft(OWN.context(), { billingAccountId: m.account, membershipId: m.id, dueAt: new Date(Date.now() + 5 * 86400000).toISOString(), currency: 'USD', subtotalMinor: 1000 });
  async function revisionCall(m, endOffset) {
    const p = await dates.preview(OWN.read(), m.id, { changeKind: 'EARLY_END', startDate: today, endDate: addDays(today, endOffset) });
    return () => dates.revise(OWN.context(), m.id, confirmFor(p));
  }
  { // [9] Revision holds its membership row (FOR NO KEY UPDATE); an invoice for the same membership takes FK KEY SHARE and never waits on it.
    const m = await active(today, null);
    const results = await race('membership_plans', await revisionCall(m, 30), raceInvoice(m));
    assert.deepEqual(results.map(codeOf), ['DATE_REVISION_PREVIEW_STALE', 'OK'], 'the new invoice is a new fact: the revision refuses, nothing deadlocks');
    // Invoice creation paused after its insert (before its audit row); the revision arrives and waits on invoices SHARE.
    const n = await active(today, null);
    const second = await race('audit_events', raceInvoice(n), await revisionCall(n, 30));
    assert.deepEqual(second.map(codeOf), ['OK', 'DATE_REVISION_PREVIEW_STALE']);
    // [10] Cancellation vs revision, both orders: serialized on the membership row, never deadlocked.
    const c1 = await active(today, null);
    const cancel = (m, v = 2) => () => ms.cancel(OWN.context(), m.id, { expectedVersion: v, cancellationReason: 'Member moved away.' });
    const r1x = await race('membership_plans', await revisionCall(c1, 30), cancel(c1));
    assert.deepEqual(r1x.map(codeOf), ['OK', 'VERSION_CONFLICT']);
    const c2 = await active(today, null);
    const r2x = await race('audit_events', cancel(c2), await revisionCall(c2, 30));
    assert.deepEqual(r2x.map(codeOf), ['OK', 'MEMBERSHIP_NOT_ACTIVE']);
    // [10] Renewal creation vs revision, both orders.
    const renew = (m) => () => services.renewals.mutate(OWN.context(), 'CREATE', null, { expectedVersion: 0, membershipId: m.id,
      reviewFrom: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z'), reviewTo: new Date(Date.now() + 10 * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      status: 'OPEN', note: 'Review renewal.', reason: 'Term ending soon.', reminderNeeded: false });
    const n1 = await active(today, addDays(today, 60));
    assert.deepEqual((await race('membership_plans', await revisionCall(n1, 30), renew(n1))).map(codeOf), ['OK', 'OK']);
    const n2 = await active(today, addDays(today, 60));
    assert.deepEqual((await race('audit_events', renew(n2), await revisionCall(n2, 30))).map(codeOf), ['OK', 'DATE_REVISION_PREVIEW_STALE']);
    // [10] Retention acknowledgement (one SHARE lock statement that includes memberships) vs revision, both orders.
    const ackCall = async (m) => { const e = await database.readRetentionReviewAcknowledgementEvidence(OWN.read(), m.id);
      return () => database.acknowledgeRetentionReviewEvidence(OWN.read(), m.id, { evidenceVersion: e.evidenceVersion, evidenceFingerprint: e.evidenceFingerprint, observedAt: e.signals.observedAt, idempotencyKey: randomUUID() }); };
    const t1 = await active(today, null);
    const tr1 = await race('membership_plans', await revisionCall(t1, 30), await ackCall(t1));
    assert.equal(codeOf(tr1[0]), 'OK'); assert.notEqual(tr1[1].reason?.code, '40P01');
    const t2 = await active(today, null);
    const tr2 = await race('audit_events', await ackCall(t2), await revisionCall(t2, 30));
    assert.equal(codeOf(tr2[0]), 'OK'); assert.equal(codeOf(tr2[1]), 'OK');
    assertions += 10; }

  // ---------- 9. unchanged V1 readers ----------
  // [14] Every V1 reader of memberships keeps the exact body of the latest migration that defined it before 0178.
  { const files = (await readdir(new URL('../migrations/', import.meta.url))).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < '0178').sort();
    const readers = ['read_parent_billing_view', 'read_school_health_score', 'read_retention_review_signals', 'revenue_plan_snapshot', 'renewal_membership_facts', 'read_school_command_center',
      'read_parent_testing_status', 'acknowledge_retention_review_evidence', 'record_retention_attention_alert', 'resolve_retention_attention_alert', 'mutate_renewal',
      'activate_school_membership', 'cancel_school_membership', 'preview_school_membership_activation', 'evaluate_membership_activation', 'membership_effective_status_at'];
    const latest = {};
    for (const file of files) {
      const text = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const name of readers) {
        const found = [...text.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, 'g'))];
        if (found.length) latest[name] = found.at(-1)[1];
      }
    }
    for (const name of readers) {
      assert.ok(latest[name], `${name} defined before 0178`);
      assert.equal((await sql('SELECT count(*)::int n FROM pg_proc WHERE pronamespace=\'hon\'::regnamespace AND proname=$1 AND prosrc=$2', [name, latest[name]]))[0].n, 1, `${name} unchanged`);
      assertions++;
    } }

  assert.ok(guardedCommands > 100, `${guardedCommands} guarded calls`);
  console.log(`PASS: membership date revisions 0178 (${assertions} assertions) — private immutable revision evidence with a settings-free insert guard; the 0177 trigger gains one ACTIVE branch bound to the latest revision row, so no direct UPDATE, forged or replayed period works even for the owner with forged settings; runtime privileges unchanged (no UPDATE). E1b-D1/D2: two sensitive permissions mapped only to system owners; delegated revise without retroactive is refused live on any past-day change; revocation before confirmation, during the IAM wait and before replay (including the retroactive permission) fails closed; other school/org, parent, nonhuman, delegated and Action Engine contexts refused in the API and the database. School-local inclusive dates across 23/25-hour days, a skipped midnight, month end and leap day; fixed-term extensions anchored to the confirmed start. Kinds, D5 (no CANCELLED/DRAFT), D6 (ended extension needs retroactive). Two-step digests, acknowledgements, exact idempotency, parallel staff. D3 financial rules: schedule/open-invoice conflicts refuse, paid/open/draft/renewal facts disclosed, billing-review reminders, financial effects always empty; ${separated.length} money/plan/renewal/consent/SaaS/entitlement tables byte-identical across ${guardedCommands} guarded calls (previews and reads write nothing). D7 legacy queue and exact status totals. Same-membership races with invoice creation, cancellation, renewal and retention in both orders: no deadlock. V1 readers and 0177 bodies unchanged.`);
} finally {
  await database.onModuleDestroy?.();
  await Promise.allSettled([admin.end(), blocker.end(), restricted.end()]);
}
