import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { activateWithPreview } from './membership-activation-test-support.mjs';

// Disposable-localhost proof for D-M1 (0200) CRM lead membership discovery. The adult and guardian/child workflows
// are driven through the real registration, account, DRAFT, plan and activation services; discovery is read through
// the real service and directly as the restricted runtime role. Every discovery read is bracketed by an effect snapshot.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { CrmLeadMembershipsService } = await import('../../../apps/api/dist/billing/crm-lead-memberships.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { GuardianChildEnrollmentService } = await import('../../../apps/api/dist/crm/guardian-child-enrollment.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'otherOrg', 'otherOrgSchool', 'role', 'noActivateRole', 'noLeadReadRole', 'parentRole', 'otherSchoolRole', 'otherOrgRole',
  'pipeline', 'stage', 'otherPipeline', 'otherStage', 'otherOrgPipeline', 'otherOrgStage', 'program'].map((key) => [key, randomUUID()]));
const fullPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage',
  'billing.membership.create', 'billing.account.create', 'billing.membership.activate', 'billing.membership_plan.manage'];
const REGISTER = 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION';
const DESIGNATE = { confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_PAYER_DESIGNATION' };
const ADD = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_ADDITION';
const GC_DRAFT = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN';
const PLAN = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE';
const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;

await admin.connect(); await restricted.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), plans: new MembershipPlanService(database),
  drafts: new CrmAdultMembershipDraftService(database), registrations: new LeadRegistrationService(database), gc: new GuardianChildEnrollmentService(database),
  discovery: new CrmLeadMembershipsService(database) };
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });

  // ---------- 1. posture: exact 0200 body, definer, fixed search path, runtime EXECUTE only, no DML, private source tables ----------
  const migration = await readFile(new URL('../migrations/0200_crm_lead_membership_discovery.sql', import.meta.url), 'utf8');
  const expectedBody = migration.match(/CREATE FUNCTION hon\.read_crm_lead_memberships\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(expectedBody);
  const posture = (await admin.query(`SELECT p.prosrc,p.prosecdef definer,p.provolatile volatility,p.proconfig config,(o.rolsuper OR o.rolbypassrls) trusted,
    has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,has_function_privilege('public',p.oid,'EXECUTE') public_execute,
    (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1 sole,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
      AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable OR a.privilege_type<>'EXECUTE')) private
    FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_crm_lead_memberships(text,uuid)'::regprocedure`, [runtimeUrl.username])).rows[0];
  assert.equal(posture.prosrc, expectedBody, 'installed body is exactly 0200');
  assert.deepEqual({ ...posture, prosrc: undefined }, { prosrc: undefined, definer: true, volatility: 'v', config: ['search_path=pg_catalog, hon'], trusted: true,
    runtime_execute: true, public_execute: false, sole: true, private: true });
  assert.doesNotMatch(expectedBody, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/i, 'discovery contains no DML');
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION|CREATE TABLE|ALTER TABLE/, '0200 replaces no function and changes no table');
  for (const table of ['crm_lead_registration_conversions', 'crm_adult_membership_draft_sources', 'crm_guardian_child_enrolled_children', 'crm_guardian_child_membership_draft_sources']) {
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table} directly`);
  }
  assertions += 8;

  // ---------- fixture: org A school 1 (home) and school 2, org B ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_DM1_ORG','PRIVATE_DM1_ORG'),($2,'PRIVATE_DM1_OTHER_ORG','PRIVATE_DM1_OTHER_ORG')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_DM1_SCHOOL',$3),($4,$2,'PRIVATE_DM1_OTHER_SCHOOL',$5),($6,$7,'PRIVATE_DM1_OTHER_ORG_SCHOOL',$8)",
    [ids.school, ids.org, `dm1-${ids.school}`, ids.otherSchool, `dm1-${ids.otherSchool}`, ids.otherOrgSchool, ids.otherOrg, `dm1-${ids.otherOrgSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  for (const [role, org, permissions, roleCode] of [[ids.role, ids.org, fullPermissions], [ids.noActivateRole, ids.org, fullPermissions.filter((p) => p !== 'billing.membership.activate')],
    [ids.noLeadReadRole, ids.org, fullPermissions.filter((p) => p !== 'crm.lead.read')], [ids.parentRole, ids.org, fullPermissions, 'PARENT_PORTAL'],
    [ids.otherSchoolRole, ids.org, fullPermissions], [ids.otherOrgRole, ids.otherOrg, fullPermissions]]) {
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'PRIVATE_DM1_ROLE')", [role, org, roleCode ?? `FRONT_DESK_${role.slice(0, 8)}`]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  }
  for (const [pipeline, stage, org, school] of [[ids.pipeline, ids.stage, ids.org, ids.school], [ids.otherPipeline, ids.otherStage, ids.org, ids.otherSchool],
    [ids.otherOrgPipeline, ids.otherOrgStage, ids.otherOrg, ids.otherOrgSchool]]) {
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_DM1_PIPELINE')", [pipeline, org, school]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [stage, org, school, pipeline]);
  }
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [ids.program, ids.org, ids.school]);
  async function staff(role = ids.role, org = ids.org, school = ids.school, extraRole) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `dm1-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DM1_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_DM1_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, role]);
    if (extraRole) await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, extraRole]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  const S = await staff(), T = await staff(), NA = await staff(ids.noActivateRole), NL = await staff(ids.noLeadReadRole), P = await staff(ids.role, ids.org, ids.school, ids.parentRole),
    U = await staff(ids.otherSchoolRole, ids.org, ids.otherSchool), V = await staff(ids.otherOrgRole, ids.otherOrg, ids.otherOrgSchool);
  async function wonLead(org = ids.org, school = ids.school, pipeline = ids.pipeline, stage = ids.stage) {
    const lead = randomUUID(), person = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Discovery',$4)", [person, org, school, `P${tag()}`]);
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, org, school, person, pipeline, stage]);
    return { lead, person };
  }
  const effectTables = ['people', 'student_profiles', 'families', 'family_members', 'crm_leads', 'crm_lead_registration_conversions', 'billing_accounts', 'memberships',
    'crm_adult_membership_draft_sources', 'crm_guardian_child_enrolled_children', 'crm_guardian_child_payer_designations', 'crm_guardian_child_membership_draft_sources',
    'membership_plan_selections', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'audit_events', 'outbox_events', 'idempotency_records',
    'communication_messages', 'action_requests', 'ai_usage_ledger'];
  const snapshot = async () => Object.fromEntries(await Promise.all(effectTables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h,count(*)::int n FROM hon.${table} t`)).rows[0]])));
  async function discover(actor, lead, patch) {
    const before = await snapshot();
    try { return await services.discovery.read(actor.read(patch), lead); }
    finally { assert.deepEqual(await snapshot(), before, 'discovery has no effect on any tracked table'); assertions++; }
  }
  const membershipRow = async (id) => (await sql("SELECT state::text state,version,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') created FROM hon.memberships WHERE id=$1", [id]))[0];

  // ---------- 2. adult workflow: nothing before a DRAFT, the DRAFT, then the same membership as ACTIVE in a new request ----------
  const adult = await wonLead();
  assert.deepEqual(await discover(S, adult.lead), { leadId: adult.lead, memberships: [], truncated: false }, 'unregistered lead: no memberships');
  const registration = await services.registrations.register(S.context(), adult.lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: REGISTER });
  await services.accounts.create(S.context(), { responsiblePersonId: adult.person, currency: 'USD' });
  assert.deepEqual((await discover(S, adult.lead)).memberships, [], 'registered with an account but no DRAFT: none');
  const draft = await services.drafts.draft(S.context(), { studentProfileId: registration.result.studentProfileId, planCode: 'STAFF-OPAQUE', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });
  const adultMembership = draft.receipt.membershipId;
  const asDraft = await discover(S, adult.lead);
  assert.deepEqual(asDraft, { leadId: adult.lead, truncated: false, memberships: [{ membershipId: adultMembership, origin: 'ADULT_REGISTRATION',
    studentProfileId: registration.result.studentProfileId, state: 'DRAFT', version: 1, createdAt: (await membershipRow(adultMembership)).created }] });
  // Another authorized staff member finds the same membership (activation authority already reaches it by id); no creator, plan or payer.
  assert.deepEqual(await discover(T, adult.lead), asDraft, 'not creator-restricted');
  for (const hidden of [S.principal, S.user, S.subject, 'STAFF-OPAQUE', adult.person]) assert.equal(JSON.stringify(asDraft).includes(hidden), false, 'no creator, plan or person disclosed');
  await activateWithPreview(services.memberships, S, adultMembership);
  const asActive = await discover(T, adult.lead);
  const activeRow = await membershipRow(adultMembership);
  assert.equal(activeRow.state, 'ACTIVE');
  assert.deepEqual(asActive.memberships, [{ ...asDraft.memberships[0], state: 'ACTIVE', version: activeRow.version }], 'the activated membership is found again in a new request');
  // The id leads straight to the existing detail read, which re-proves its own authority.
  assert.deepEqual(await services.memberships.readActivationContext(T.read(), adultMembership),
    { organizationId: ids.org, schoolId: ids.school, membershipId: adultMembership, state: 'ACTIVE', version: activeRow.version });
  // Repeated and concurrent reads are identical.
  for (const value of await Promise.all(Array.from({ length: 6 }, () => services.discovery.read(S.read(), adult.lead)))) assert.deepEqual(value, asActive);
  assertions += 10;

  // ---------- 3. guardian/child workflow: each child's DRAFT, additional children, oldest first; adult and family never mix ----------
  const plan = (await services.plans.create(S.context(), { planCode: `KIDS-${tag().toUpperCase()}`, displayName: 'Kids Monthly', programId: ids.program, availability: 'AVAILABLE',
    currency: 'USD', priceMinor: 12900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: PLAN })).plan;
  const family = await wonLead();
  const famReg = await services.registrations.register(S.context(), family.lead, { registrationPath: 'GUARDIAN_CHILD', childGivenName: `Kid${tag()}`, childFamilyName: `F${tag()}`,
    childBirthDate: '2016-04-05', confirmation: REGISTER });
  assert.equal(famReg.result.outcome, 'REGISTERED');
  await services.accounts.create(S.context(), { responsiblePersonId: family.person, currency: 'USD' });
  await services.gc.designatePayer(S.context(), family.lead, DESIGNATE);
  assert.deepEqual((await discover(S, family.lead)).memberships, [], 'family without DRAFTs: none');
  const sibling = await services.gc.addChild(T.context(), family.lead, { childGivenName: `Sib${tag()}`, childFamilyName: `F${tag()}`, childBirthDate: '2018-09-10', confirmation: ADD });
  const childDraft = (student, by) => services.gc.draftMembershipFromPlan(by.context(), { studentProfileId: student, membershipPlanId: plan.planId, membershipPlanVersion: plan.version, confirmation: GC_DRAFT });
  const first = await childDraft(famReg.result.studentProfileId, S);
  const second = await childDraft(sibling.result.studentProfileId, T);
  const firstId = first.receipt.membershipId, secondId = second.receipt.membershipId;
  assert.ok(firstId && secondId, 'child DRAFT receipts carry membership ids');
  const familyView = await discover(S, family.lead);
  assert.deepEqual(familyView.memberships.map((m) => [m.membershipId, m.origin, m.studentProfileId, m.state, m.version]),
    [[firstId, 'GUARDIAN_CHILD_REGISTRATION', famReg.result.studentProfileId, 'DRAFT', 1], [secondId, 'GUARDIAN_CHILD_REGISTRATION', sibling.result.studentProfileId, 'DRAFT', 1]],
    'both children, oldest first, regardless of which staff member drafted them');
  assert.equal(familyView.truncated, false);
  assert.equal(JSON.stringify(familyView).includes(adultMembership), false, 'another lead\'s membership never appears');
  assert.equal(JSON.stringify(await discover(S, adult.lead)).includes(firstId), false, 'a family membership never appears under the adult lead');
  await activateWithPreview(services.memberships, T, secondId);
  assert.deepEqual((await discover(S, family.lead)).memberships.map((m) => m.state), ['DRAFT', 'ACTIVE'], 'mixed lifecycle states are reported as they are');
  assertions += 6;

  // ---------- 4. only workflow-created memberships: a staff-created membership for the same person is never returned ----------
  { const a = await wonLead(); const r = await services.registrations.register(S.context(), a.lead, { registrationPath: 'ADULT', birthDate: '1991-02-03', confirmation: REGISTER });
    const acc = await services.accounts.create(S.context(), { responsiblePersonId: a.person, currency: 'USD' });
    const foreign = await services.memberships.createDraft(S.context(), { billingAccountId: acc.account.id, participantPersonId: a.person, planCode: 'STAFF-OPAQUE' });
    assert.ok(r.result.studentProfileId && foreign.membership.id);
    assert.deepEqual((await discover(S, a.lead)).memberships, [], 'person matching is never used: the direct membership is not this lead\'s workflow');
    assertions++; }

  // ---------- 5. authority: activation + lead read, direct human, live grant, ACTIVE entitlement; forged context refused ----------
  const denied = code(403, 'CRM_LEAD_MEMBERSHIPS_FORBIDDEN');
  await assert.rejects(discover(NA, adult.lead), denied, 'without billing.membership.activate');
  await assert.rejects(discover(NL, adult.lead), denied, 'without crm.lead.read');
  await assert.rejects(discover(P, adult.lead), denied, 'a family/parent role is never staff');
  { const W = await staff(); await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [W.grant]);
    await assert.rejects(discover(W, adult.lead), denied, 'revoked grant'); }
  { const W = await staff(); await sql("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE id=$1", [W.grant]);
    await assert.rejects(discover(W, adult.lead), denied, 'expired grant'); }
  { const W = await staff(); await sql('UPDATE hon.principals SET is_active=false WHERE id=$1', [W.principal]);
    await assert.rejects(discover(W, adult.lead), denied, 'inactive principal'); }
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  try { await assert.rejects(discover(S, adult.lead), denied, 'suspended entitlement (B6A)'); }
  finally { await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]); }
  assert.equal((await discover(S, adult.lead)).memberships.length, 1, 'restored authority reads again');
  await assert.rejects(discover(S, adult.lead, { principalId: T.principal }), denied, 'subject of one staff with the principal of another');
  await assert.rejects(services.discovery.read({ ...S.read(), source: 'AI_ACTION' }, adult.lead), denied);
  await assert.rejects(services.discovery.read({ ...S.read(), actionRequestId: randomUUID() }, adult.lead), denied);
  await assert.rejects(services.discovery.read({ ...S.read(), delegatedByPrincipalId: T.principal }, adult.lead), denied);
  await assert.rejects(services.discovery.read(S.context(), adult.lead), code(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(services.discovery.read(S.read(), 'not-a-uuid'), code(400, 'VALIDATION_FAILED'));
  await assert.rejects(services.discovery.read(S.read(), adult.lead.toUpperCase()), code(400, 'VALIDATION_FAILED'), 'the service takes only the normalized selector the controller produces');
  async function raw(setup, lead = adult.lead) {
    await restricted.query('BEGIN');
    try {
      const requestId = randomUUID();
      await restricted.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
        set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
        set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [ids.org, ids.school, S.principal, requestId, S.subject]);
      await setup?.();
      return (await restricted.query('SELECT hon.read_crm_lead_memberships($1,$2::uuid) data', [S.subject, lead])).rows[0].data;
    } finally { await restricted.query('ROLLBACK'); }
  }
  assert.equal((await raw()).memberships[0].membershipId, adultMembership, 'runtime role reaches only the fixed function');
  for (const forged of ["set_config('app.hon_source','AI',true)", "set_config('app.hon_action_request_id',gen_random_uuid()::text,true)", "set_config('app.hon_delegated_by_principal_id',gen_random_uuid()::text,true)",
    "set_config('app.hon_principal_type','SERVICE',true)", "set_config('app.hon_external_subject','someone-else',true)"]) {
    await assert.rejects(raw(() => restricted.query(`SELECT ${forged}`)), (error) => error.code === '42501', forged);
  }
  await assert.rejects(raw(() => restricted.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids.otherOrg])), (error) => error.code === '42501', 'forged organization');
  await assert.rejects(raw(() => restricted.query("SELECT set_config('app.hon_school_id',$1,true)", [ids.otherSchool])), (error) => error.code === '42501', 'forged school');
  assertions += 24;

  // ---------- 6. cross-school and cross-organization isolation; unknown leads are unavailable ----------
  const unavailable = code(404, 'CRM_LEAD_MEMBERSHIPS_UNAVAILABLE');
  const otherSchoolLead = await wonLead(ids.org, ids.otherSchool, ids.otherPipeline, ids.otherStage);
  const otherOrgLead = await wonLead(ids.otherOrg, ids.otherOrgSchool, ids.otherOrgPipeline, ids.otherOrgStage);
  await assert.rejects(discover(S, randomUUID()), unavailable, 'unknown lead');
  await assert.rejects(discover(S, otherSchoolLead.lead), unavailable, 'a lead of another school is unavailable, not disclosed');
  await assert.rejects(discover(S, otherOrgLead.lead), unavailable, 'a lead of another organization is unavailable');
  await assert.rejects(discover(U, adult.lead), unavailable, 'other-school staff cannot read this school\'s lead');
  await assert.rejects(discover(V, adult.lead), unavailable, 'other-organization staff cannot read it');
  await assert.rejects(discover(U, adult.lead, { schoolId: ids.school }), denied, 'scope presented for a school without a grant');
  await assert.rejects(discover(V, adult.lead, { organizationId: ids.org, schoolId: ids.school }), denied);
  assert.deepEqual(await discover(U, otherSchoolLead.lead), { leadId: otherSchoolLead.lead, memberships: [], truncated: false }, 'the owning school reads its own lead');
  assertions += 8;

  // ---------- 7. a full family (0176 caps a family at 10 children): every child, oldest first, below the defensive 20-item cap ----------
  { const many = await wonLead(); const r = await services.registrations.register(S.context(), many.lead, { registrationPath: 'GUARDIAN_CHILD', childGivenName: `Kid${tag()}`,
      childFamilyName: `F${tag()}`, childBirthDate: '2015-01-01', confirmation: REGISTER });
    await services.accounts.create(S.context(), { responsiblePersonId: many.person, currency: 'USD' });
    await services.gc.designatePayer(S.context(), many.lead, DESIGNATE);
    const students = [r.result.studentProfileId];
    for (let i = 0; i < 9; i++) {
      const c = await services.gc.addChild(S.context(), many.lead, { childGivenName: `Kid${tag()}`, childFamilyName: `F${tag()}`, childBirthDate: `2010-01-${String(i + 1).padStart(2, '0')}`, confirmation: ADD });
      assert.ok(c.result.studentProfileId, `child ${i}`); students.push(c.result.studentProfileId);
    }
    for (const student of students) await childDraft(student, S);
    const page = await discover(S, many.lead);
    assert.equal(page.memberships.length, 10); assert.equal(page.truncated, false);
    assert.deepEqual(page.memberships.map((m) => m.studentProfileId), students, 'all ten children, in creation order');
    assertions += 3; }

  // ---------- 8. ablation: a variant without the crm.lead.read check admits a staff member who cannot read leads ----------
  const exact = migration.match(/CREATE FUNCTION hon\.read_crm_lead_memberships\([\s\S]*?\nEND \$\$;\n/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const unchecked = exact.replace(/  IF NOT hon\.crm_lead_registration_has_permission\(actor,org,school,'crm\.lead\.read'\) THEN\n.*\n  END IF;\n/, '');
  assert.notEqual(unchecked, exact);
  try {
    await admin.query(unchecked);
    assert.equal((await services.discovery.read(NL.read(), adult.lead)).memberships.length, 1, 'the unchecked variant leaks to a staff member without crm.lead.read');
  } finally { await admin.query(exact); }
  assert.equal((await admin.query("SELECT prosrc FROM pg_proc WHERE oid='hon.read_crm_lead_memberships(text,uuid)'::regprocedure")).rows[0].prosrc, expectedBody, 'exact 0200 body restored');
  await assert.rejects(discover(NL, adult.lead), denied);
  assertions += 4;

  console.log(`PASS: CRM lead membership discovery (${assertions} assertions): exact read-only 0200 posture with private source tables; adult lead reports nothing before a DRAFT, its DRAFT, then the same membership as ACTIVE in a fresh request for any authorized staff member, leading to the existing activation-context read; guardian/child lead reports each child's DRAFT (including additional children) oldest first with mixed states; adult and family memberships never mix and a staff-created membership for the same person is never returned; repeated and concurrent reads identical with zero effect on ${effectTables.length} tracked tables; missing activation or lead-read permission, parent role, revoked/expired/inactive, suspended entitlement and forged context refused; other-school and other-organization leads unavailable; full ten-child family returned in creation order below the defensive 20-item cap; a variant without the lead-read check is caught leaking.`);
} finally {
  await database.onModuleDestroy();
  await restricted.end().catch(() => {});
  await admin.end();
}
