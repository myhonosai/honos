import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { activateWithPreview } from './membership-activation-test-support.mjs';

// Disposable-localhost proof for 0176 guardian/child CRM enrollment. Every step runs through the real services:
// guardian/child registration (0160/0169, unchanged), the guardian's canonical billing account (0159 command),
// payer designation, additional children, one plan-bound DRAFT per child (0175 catalog) and the read-only family
// recovery. Effects outside each command's own records are proven absent with organization-wide table snapshots.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { MembershipPlanService } = await import('../../../apps/api/dist/billing/membership-plan.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { LeadRegistrationRecoveryService } = await import('../../../apps/api/dist/crm/lead-registration-recovery.service.js');
const { GuardianChildEnrollmentService } = await import('../../../apps/api/dist/crm/guardian-child-enrollment.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'otherOrg', 'otherOrgSchool', 'role', 'adultRole', 'noBillingRole', 'parentRole', 'otherSchoolRole', 'otherOrgRole',
  'pipeline', 'stage', 'otherPipeline', 'otherStage', 'program'].map((key) => [key, randomUUID()]));
const deskPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create', 'billing.account.create', 'billing.membership.activate'];
const managerPermissions = [...deskPermissions, 'billing.membership_plan.manage'];
const adultPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'billing.membership.create', 'billing.account.create'];
const noBillingPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.account.create'];
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;
const code = (status, expected) => (error) => error?.getStatus?.() === status && error?.getResponse?.()?.code === expected;
const REGISTER = 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION';
const DESIGNATE = { confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_PAYER_DESIGNATION' };
const ADD = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_ADDITION';
const DRAFT = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN';
const PLAN = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE';
const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);

await admin.connect(); await restricted.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), plans: new MembershipPlanService(database),
  registrations: new LeadRegistrationService(database), recovery: new LeadRegistrationRecoveryService(database), gc: new GuardianChildEnrollmentService(database) };
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });

  // ---------- 1. posture: exact 0176 bodies, definers, fixed search path, four runtime entry points, private tables ----------
  const migration = await readFile(new URL('../migrations/0176_crm_guardian_child_enrollment.sql', import.meta.url), 'utf8');
  const runtimeFns = ['read_crm_guardian_child_enrollment(text,uuid)', 'designate_crm_guardian_child_payer(text,uuid,jsonb,uuid,uuid,uuid)',
    'add_crm_guardian_child_additional_child(text,uuid,jsonb,uuid,uuid,uuid)', 'draft_crm_guardian_child_membership_from_plan(text,jsonb,uuid,uuid,uuid)'];
  const privateFns = ['require_crm_guardian_child_enrollment_actor(text)', 'crm_guardian_child_family_relation(uuid)', 'crm_guardian_child_child_relation(uuid)',
    'crm_guardian_child_current_designation(uuid,uuid,uuid,uuid,uuid)', 'crm_guardian_child_membership_draft_current(uuid)', 'capture_crm_guardian_child_registration_child()',
    'guard_crm_guardian_child_enrollment_history()'];
  const bodyOf = (name) => migration.match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
  for (const signature of [...runtimeFns, ...privateFns]) {
    const name = signature.replace(/\(.*$/, '');
    const body = bodyOf(name);
    assert.ok(body, `0176 defines ${name}`);
    const row = (await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,p.proconfig config,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
      has_function_privilege('public',p.oid,'EXECUTE') public_execute,(SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)::int overloads
      FROM pg_proc p WHERE p.oid=$3::regprocedure`, [runtimeUrl.username, body, `hon.${signature}`])).rows[0];
    assert.deepEqual(row, { exact: true, definer: name !== 'guard_crm_guardian_child_enrollment_history', config: ['search_path=pg_catalog, hon'],
      runtime_execute: runtimeFns.includes(signature), public_execute: false, overloads: 1 }, signature);
    assertions++;
  }
  assert.doesNotMatch(bodyOf('read_crm_guardian_child_enrollment'), /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i, 'the family read has no DML');
  for (const name of ['crm_guardian_child_family_relation', 'crm_guardian_child_child_relation', 'crm_guardian_child_membership_draft_current']) {
    assert.doesNotMatch(bodyOf(name), /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/i, `${name} is a pure check`);
  }
  const newTables = ['crm_guardian_child_enrolled_children', 'crm_guardian_child_payer_designations', 'crm_guardian_child_membership_draft_sources'];
  for (const table of newTables) {
    assert.deepEqual((await admin.query(`SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int policies FROM pg_class c WHERE oid=$1::regclass`, [`hon.${table}`])).rows[0],
      { r: true, f: true, policies: 0 }, `${table} forced RLS, private`);
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table}`);
    assertions += 2;
  }
  // 0174 (adult recovery) and 0163 (creator-owned adult confirmation) are byte-for-byte unchanged: 0176 replaces no function.
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION/, '0176 replaces no existing function');
  assert.doesNotMatch(migration.replace(/AS \$\$[\s\S]*?\$\$;/g, ''), /INSERT\s+INTO|UPDATE\s+hon\./i, '0176 seeds and backfills nothing');
  assertions += 5;

  // ---------- fixture: org A school 1 (home) and school 2, org B ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_GC_ORG','PRIVATE_GC_ORG'),($2,'PRIVATE_GC_OTHER_ORG','PRIVATE_GC_OTHER_ORG')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_GC_SCHOOL',$3),($4,$2,'PRIVATE_GC_OTHER_SCHOOL',$5),($6,$7,'PRIVATE_GC_OTHER_ORG_SCHOOL',$8)",
    [ids.school, ids.org, `gc-${ids.school}`, ids.otherSchool, `gc-${ids.otherSchool}`, ids.otherOrgSchool, ids.otherOrg, `gc-${ids.otherOrgSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  for (const [role, org, permissions, code_] of [[ids.role, ids.org, managerPermissions], [ids.adultRole, ids.org, adultPermissions], [ids.noBillingRole, ids.org, noBillingPermissions],
    [ids.parentRole, ids.org, managerPermissions, 'PARENT_PORTAL'], [ids.otherSchoolRole, ids.org, managerPermissions], [ids.otherOrgRole, ids.otherOrg, managerPermissions]]) {
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'PRIVATE_GC_ROLE')", [role, org, code_ ?? `FRONT_DESK_${role.slice(0, 8)}`]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  }
  for (const [pipeline, stage, school] of [[ids.pipeline, ids.stage, ids.school], [ids.otherPipeline, ids.otherStage, ids.otherSchool]]) {
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_GC_PIPELINE')", [pipeline, ids.org, school]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [stage, ids.org, school, pipeline]);
  }
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [ids.program, ids.org, ids.school]);
  async function staff(role = ids.role, org = ids.org, school = ids.school, extraRole) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `gc-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_GC_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_GC_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, role]);
    if (extraRole) await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, extraRole]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  const D = await staff(), D2 = await staff(), A = await staff(ids.adultRole), N = await staff(ids.noBillingRole), P = await staff(ids.role, ids.org, ids.school, ids.parentRole),
    U = await staff(ids.otherSchoolRole, ids.org, ids.otherSchool), V = await staff(ids.otherOrgRole, ids.otherOrg, ids.otherOrgSchool);
  async function wonLead(school = ids.school, pipeline = ids.pipeline, stage = ids.stage) {
    const lead = randomUUID(), guardian = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Guardian',$4)", [guardian, ids.org, school, `G${tag()}`]);
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, school, guardian, pipeline, stage]);
    return { lead, guardian };
  }
  const childName = () => ({ childGivenName: `Kid${tag()}`, childFamilyName: `F${tag()}`, childBirthDate: '2016-04-05' });
  async function gcFamily({ account = true, designate = false, currency = 'USD', by = D } = {}) {
    const { lead, guardian } = await wonLead();
    const child = childName();
    const registration = await services.registrations.register(by.context(), lead, { registrationPath: 'GUARDIAN_CHILD', ...child, confirmation: REGISTER });
    assert.equal(registration.result.outcome, 'REGISTERED');
    if (account) await services.accounts.create(by.context(), { responsiblePersonId: guardian, currency });
    if (designate) await services.gc.designatePayer(by.context(), lead, DESIGNATE);
    return { lead, guardian, child, student: registration.result.studentProfileId, family: registration.result.familyId, registration: registration.result };
  }
  const effectTables = ['people', 'student_profiles', 'families', 'family_members', 'billing_accounts', 'memberships', 'membership_payment_schedules', 'invoices', 'payment_attempts',
    'audit_events', 'outbox_events', 'idempotency_records', 'membership_plan_selections', 'crm_lead_registration_conversions', 'crm_adult_membership_draft_sources', ...newTables,
    'communication_messages', 'action_requests', 'ai_usage_ledger'];
  const snapshot = async () => Object.fromEntries(await Promise.all(effectTables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h,count(*)::int n FROM hon.${table} t WHERE t.organization_id=$1`, [ids.org])).rows[0]])));
  async function unchanged(work) { const before = await snapshot(); try { return await work(); } finally { assert.deepEqual(await snapshot(), before, 'no tracked effect'); assertions++; } }
  const read = (lead, by = D) => services.gc.read(by.read(), lead);
  const plan = async (patch = {}) => (await services.plans.create(D.context(), { planCode: `KIDS-${tag().toUpperCase()}`, displayName: 'Kids Monthly', programId: ids.program, availability: 'AVAILABLE',
    currency: 'USD', priceMinor: 12900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: PLAN, ...patch })).plan;
  const drafter = (student, p, patch = {}) => ({ studentProfileId: student, membershipPlanId: p.planId, membershipPlanVersion: p.version, confirmation: DRAFT, ...patch });

  // ---------- 2. registration captures one immutable child snapshot; the adult path captures none ----------
  const fam = await gcFamily({ account: false });
  const captured = await sql('SELECT * FROM hon.crm_guardian_child_enrolled_children WHERE family_id=$1', [fam.family]);
  const conversion = (await sql('SELECT * FROM hon.crm_lead_registration_conversions WHERE source_lead_id=$1', [fam.lead]))[0];
  assert.equal(captured.length, 1);
  assert.deepEqual({ ...captured[0], child_person_id: undefined, child_member_id: undefined }, { student_profile_id: fam.student, organization_id: ids.org, school_id: ids.school,
    conversion_id: conversion.id, source_lead_id: fam.lead, guardian_person_id: fam.guardian, family_id: fam.family, child_person_id: undefined, child_member_id: undefined,
    origin: 'CRM_REGISTRATION', given_name: fam.child.childGivenName, family_name: fam.child.childFamilyName, birth_date: captured[0].birth_date, actor_principal_id: D.principal,
    idempotency_key: null, request_fingerprint: null, receipt: null, created_at: conversion.created_at });
  assert.equal(captured[0].birth_date.toISOString?.().slice(0, 10) ?? captured[0].birth_date, '2016-04-05');
  assert.notEqual(captured[0].child_person_id, fam.guardian, 'guardian and child are separate people');
  const adultLead = await wonLead();
  const adultReg = await services.registrations.register(D.context(), adultLead.lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: REGISTER });
  assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1', [adultReg.result.studentProfileId]))[0].n, 0, 'adult registration captures nothing');
  assertions += 5;

  // ---------- 3. family recovery states before payer designation ----------
  const notRegistered = await wonLead();
  assert.deepEqual(await unchanged(() => read(notRegistered.lead)), { leadId: notRegistered.lead, workflowState: 'NOT_REGISTERED' });
  assert.deepEqual(await unchanged(() => read(adultLead.lead)), { leadId: adultLead.lead, workflowState: 'ADULT_REGISTRATION' }, 'the adult workflow is not disclosed here');
  const duplicateContact = await wonLead();
  await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id) VALUES($1,$2,$3)', [ids.org, ids.school, duplicateContact.guardian]);
  assert.deepEqual(await unchanged(() => read(duplicateContact.lead)), { leadId: duplicateContact.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  await assert.rejects(unchanged(() => read(randomUUID())), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'an unknown lead');
  const before = await unchanged(() => read(fam.lead));
  assert.deepEqual(before, { leadId: fam.lead, workflowState: 'BILLING_ACCOUNT_REQUIRED', historicalRegistrationReceipt: fam.registration,
    guardian: { displayName: (await sql("SELECT given_name||' '||family_name n FROM hon.people WHERE id=$1", [fam.guardian]))[0].n },
    children: [{ studentProfileId: fam.student, displayName: `${fam.child.childGivenName} ${fam.child.childFamilyName}`, origin: 'CRM_REGISTRATION', workflowState: 'AWAITING_PAYER_DESIGNATION' }] });
  // The adult recovery (0174) is unchanged: a guardian/child lead stays a staff-review outcome there.
  assert.deepEqual(await services.recovery.recover(D.read(), fam.lead), { leadId: fam.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  assert.equal((await services.recovery.recover(D.read(), adultLead.lead)).workflowState, 'BILLING_ACCOUNT_REQUIRED');
  // Payer responsibility is never inferred: no account means no designation, and no account is created.
  await assert.rejects(unchanged(() => services.gc.designatePayer(D.context(), fam.lead, DESIGNATE)), code(409, 'CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED'));
  assert.equal((await sql('SELECT is_billing_contact b FROM hon.family_members WHERE person_id=$1', [fam.guardian]))[0].b, false);
  assertions += 9;

  // ---------- 4. explicit payer designation through the guardian's canonical account ----------
  const account = (await services.accounts.create(D.context(), { responsiblePersonId: fam.guardian, currency: 'USD' })).account;
  // An ADDITIONAL account for the same guardian exists but is never selected.
  await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'EUR','ADDITIONAL')", [ids.org, ids.school, fam.guardian]);
  assert.equal((await unchanged(() => read(fam.lead))).workflowState, 'PAYER_DESIGNATION_REQUIRED');
  const designateKey = randomUUID();
  const designated = await services.gc.designatePayer(D.context({ idempotencyKey: designateKey }), fam.lead, DESIGNATE);
  assert.deepEqual({ ...designated, receipt: { ...designated.receipt, recordedAt: undefined } }, { receipt: { state: 'PAYER_DESIGNATED', guardianDisplayName: before.guardian.displayName, currency: 'USD', recordedAt: undefined }, replayed: false });
  const designationRow = (await sql('SELECT * FROM hon.crm_guardian_child_payer_designations WHERE family_id=$1', [fam.family]))[0];
  assert.deepEqual([designationRow.guardian_person_id, designationRow.billing_account_id, designationRow.conversion_id, designationRow.actor_principal_id], [fam.guardian, account.id, conversion.id, D.principal]);
  assert.equal((await sql('SELECT is_billing_contact b FROM hon.family_members WHERE person_id=$1', [fam.guardian]))[0].b, true, 'projection set for the guardian only');
  assert.deepEqual(await sql("SELECT a.action_code,a.entity_type,a.next_state,o.event_type,o.payload->>'executionAllowed' execution FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.entity_id=$1", [designationRow.id]),
    [{ action_code: 'billing.guardian_payer.designate', entity_type: 'CRM_GUARDIAN_CHILD_PAYER_DESIGNATION', next_state: designated.receipt, event_type: 'billing.guardian_payer.designated', execution: 'false' }]);
  assert.deepEqual(await unchanged(() => services.gc.designatePayer(D.context({ idempotencyKey: designateKey }), fam.lead, DESIGNATE)), { receipt: designated.receipt, replayed: true });
  await assert.rejects(unchanged(() => services.gc.designatePayer(D.context({ idempotencyKey: designateKey }), notRegistered.lead, DESIGNATE)), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(unchanged(() => services.gc.designatePayer(D2.context(), fam.lead, DESIGNATE)), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'a family is designated once');
  await assert.rejects(unchanged(() => services.gc.designatePayer(D.context(), adultLead.lead, DESIGNATE)), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'never for an adult conversion');
  await assert.rejects(unchanged(() => services.gc.designatePayer(D.context(), notRegistered.lead, DESIGNATE)), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'never from lead contact data alone');
  for (const bad of [{}, { confirmation: 'yes' }, { ...DESIGNATE, billingAccountId: account.id }, { ...DESIGNATE, guardianPersonId: fam.guardian }]) {
    await assert.rejects(unchanged(() => services.gc.designatePayer(D.context(), fam.lead, bad)), code(400, 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT'), JSON.stringify(bad));
  }
  const designatedRead = await unchanged(() => read(fam.lead));
  assert.deepEqual([designatedRead.workflowState, designatedRead.billingAccount, designatedRead.payerDesignation, designatedRead.children.map((c) => c.workflowState)],
    ['PAYER_DESIGNATED', { classification: 'CANONICAL', currency: 'USD' }, designated.receipt, ['READY_FOR_DRAFT']]);
  assert.deepEqual(await unchanged(() => read(fam.lead, D2)), designatedRead, 'the family state is the same for every authorized staff member');
  assertions += 14;

  // ---------- 5. additional children under the same verified guardian ----------
  const sibling = { childGivenName: `Sib${tag()}`, childFamilyName: fam.child.childFamilyName, childBirthDate: '2018-09-10', confirmation: ADD };
  const addKey = randomUUID();
  const added = await services.gc.addChild(D2.context({ idempotencyKey: addKey }), fam.lead, sibling);
  assert.deepEqual({ ...added.result, studentProfileId: undefined, recordedAt: undefined }, { outcome: 'CHILD_ADDED', leadId: fam.lead, studentProfileId: undefined,
    childDisplayName: `${sibling.childGivenName} ${sibling.childFamilyName}`, recordedAt: undefined });
  const siblingRow = (await sql('SELECT * FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1', [added.result.studentProfileId]))[0];
  assert.deepEqual([siblingRow.origin, siblingRow.conversion_id, siblingRow.source_lead_id, siblingRow.guardian_person_id, siblingRow.family_id, siblingRow.actor_principal_id, siblingRow.receipt],
    ['ADDITIONAL_CHILD', conversion.id, fam.lead, fam.guardian, fam.family, D2.principal, added.result], 'lead attribution and the enrolling staff member are kept');
  assert.deepEqual(await sql("SELECT member_role::text r,is_billing_contact b FROM hon.family_members WHERE family_id=$1 ORDER BY member_role,created_at", [fam.family]),
    [{ r: 'GUARDIAN', b: true }, { r: 'STUDENT', b: false }, { r: 'STUDENT', b: false }], 'one guardian, two separate children');
  assert.equal((await sql('SELECT count(DISTINCT person_id)::int n FROM hon.student_profiles WHERE primary_family_id=$1', [fam.family]))[0].n, 2);
  assert.equal((await sql('SELECT count(*)::int n FROM hon.student_profiles WHERE person_id=$1', [fam.guardian]))[0].n, 0, 'the guardian gets no student profile');
  assert.deepEqual(await sql("SELECT a.action_code,o.event_type,o.payload->>'humanOnly' human FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id WHERE a.entity_id=$1", [added.result.studentProfileId]),
    [{ action_code: 'crm.guardian_child.child.add', event_type: 'crm.guardian_child.child_added', human: 'true' }]);
  assert.deepEqual(await unchanged(() => services.gc.addChild(D2.context({ idempotencyKey: addKey }), fam.lead, sibling)), { result: added.result, replayed: true });
  await assert.rejects(unchanged(() => services.gc.addChild(D2.context({ idempotencyKey: addKey }), fam.lead, { ...sibling, childBirthDate: '2018-09-11' })), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  // Possible existing records are a non-writing staff-review outcome: same name, or a twin (same birth date and family name).
  assert.deepEqual(await unchanged(() => services.gc.addChild(D.context(), fam.lead, { ...sibling, childBirthDate: '2019-01-01' })), { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false });
  assert.deepEqual(await unchanged(() => services.gc.addChild(D.context(), fam.lead, { ...sibling, childGivenName: `Twin${tag()}` })), { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false });
  assert.deepEqual(await unchanged(() => services.gc.addChild(D.context(), fam.lead, { ...sibling, childGivenName: before.guardian.displayName.split(' ')[0], childFamilyName: before.guardian.displayName.split(' ')[1], childBirthDate: '2017-01-01' })),
    { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false }, 'the guardian is never re-registered as a child');
  await assert.rejects(unchanged(() => services.gc.addChild(D.context(), adultLead.lead, { ...childName(), confirmation: ADD })), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'no family is inferred for an adult lead');
  await assert.rejects(unchanged(() => services.gc.addChild(D.context(), notRegistered.lead, { ...childName(), confirmation: ADD })), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'nor for an unregistered lead');
  for (const bad of [{ childBirthDate: '2016-02-30' }, { childBirthDate: '2999-01-01' }, { childGivenName: ' padded' }, { childGivenName: '<b>' }, { childGivenName: '' }, { guardianPersonId: fam.guardian },
    { familyId: fam.family }, { confirmation: REGISTER }]) {
    await assert.rejects(unchanged(() => services.gc.addChild(D.context(), fam.lead, { ...childName(), confirmation: ADD, ...bad })), code(400, 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT'), JSON.stringify(bad));
  }
  const two = await unchanged(() => read(fam.lead));
  assert.deepEqual(two.children.map((c) => [c.studentProfileId, c.origin, c.workflowState]), [[fam.student, 'CRM_REGISTRATION', 'READY_FOR_DRAFT'], [added.result.studentProfileId, 'ADDITIONAL_CHILD', 'READY_FOR_DRAFT']]);
  assertions += 22;

  // ---------- 6. one plan-bound DRAFT per child, billed to the designated guardian's canonical account ----------
  const monthly = await plan();
  const fixed = await plan({ displayName: 'Kids 6 months', billingFrequency: 'PAID_IN_FULL', termKind: 'FIXED_MONTHS', termMonths: 6, priceMinor: 60000 });
  const draftKey = randomUUID();
  const first = await services.gc.draftMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(fam.student, monthly));
  assert.deepEqual({ ...first.receipt, membershipId: undefined, recordedAt: undefined }, { membershipId: undefined, state: 'DRAFT', planCode: monthly.planCode, termStartedAt: null, termEndsAt: null, recordedAt: undefined });
  assert.deepEqual([first.plan, first.replayed], [monthly, false]);
  const start = '2026-08-31T13:00:00.000Z';
  const second = await services.gc.draftMembershipFromPlan(D2.context(), drafter(added.result.studentProfileId, fixed, { termStartedAt: start }));
  assert.deepEqual([second.receipt.termStartedAt, second.receipt.termEndsAt], [start, '2027-02-28T13:00:00.000Z'], 'fixed term derived from the plan, end-of-month clamped');
  const rows = await sql(`SELECT m.participant_person_id,m.billing_account_id,m.state::text,m.plan_code,s.plan_id,s.plan_version,g.designation_id,g.family_id
    FROM hon.memberships m JOIN hon.membership_plan_selections s ON s.membership_id=m.id JOIN hon.crm_guardian_child_membership_draft_sources g ON g.membership_id=m.id
    WHERE m.id = ANY($1::uuid[]) ORDER BY m.created_at`, [[first.receipt.membershipId, second.receipt.membershipId]]);
  assert.deepEqual(rows.map((r) => [r.billing_account_id, r.state, r.designation_id, r.family_id]), [[account.id, 'DRAFT', designationRow.id, fam.family], [account.id, 'DRAFT', designationRow.id, fam.family]],
    'both children are billed to the one designated guardian account, never the ADDITIONAL one');
  assert.deepEqual(rows.map((r) => r.participant_person_id), [captured[0].child_person_id, siblingRow.child_person_id], 'each child is its own participant');
  assert.deepEqual(rows.map((r) => [r.plan_id, r.plan_version]), [[monthly.planId, 1], [fixed.planId, 1]]);
  for (const table of ['membership_payment_schedules', 'invoices', 'payment_attempts']) assert.equal((await sql(`SELECT count(*)::int n FROM hon.${table} WHERE organization_id=$1`, [ids.org]))[0].n, 0, `no ${table}`);
  assert.deepEqual(await sql("SELECT a.next_state,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id AND o.event_type='billing.membership.drafted' WHERE a.entity_id=$1", [first.receipt.membershipId]),
    [{ next_state: { ...first.receipt, membershipPlanId: monthly.planId, membershipPlanVersion: 1 }, payload: { ...first.receipt, membershipPlanId: monthly.planId, membershipPlanVersion: 1, executionAllowed: false, humanOnly: true } }]);
  assert.equal((await sql('SELECT count(*)::int n FROM hon.memberships WHERE participant_person_id=$1', [fam.guardian]))[0].n, 0, 'the guardian is never a participant');
  assert.deepEqual(await unchanged(() => services.gc.draftMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(fam.student, monthly))), { ...first, replayed: true });
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context({ idempotencyKey: draftKey }), drafter(fam.student, fixed))), code(409, 'IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(fam.student, monthly))), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'one DRAFT per child');
  // Creator sees the current receipt and bound plan terms; another staff member sees a yes/no state only.
  const mine = await unchanged(() => read(fam.lead));
  assert.deepEqual(mine.children.map((c) => [c.workflowState, c.currentMembershipDraft]), [['CURRENT_DRAFT', { state: 'RECORDED_DRAFT', receipt: first.receipt, plan: monthly }],
    ['CURRENT_DRAFT_BY_OTHER_STAFF', { state: 'RECORDED_DRAFT' }]]);
  const theirs = await unchanged(() => read(fam.lead, D2));
  assert.deepEqual(theirs.children.map((c) => [c.workflowState, c.currentMembershipDraft]), [['CURRENT_DRAFT_BY_OTHER_STAFF', { state: 'RECORDED_DRAFT' }],
    ['CURRENT_DRAFT', { state: 'RECORDED_DRAFT', receipt: second.receipt, plan: fixed }]]);
  assert.equal(JSON.stringify(theirs).includes(first.receipt.membershipId), false, 'no membership id of another staff member\'s DRAFT');
  // A newer published plan version leaves the DRAFT's bound terms and current state untouched.
  const monthly2 = (await services.plans.revise(D.context(), monthly.planId, { displayName: 'Kids Monthly', programId: ids.program, availability: 'AVAILABLE', currency: 'USD', priceMinor: 13900,
    billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', expectedVersion: 1, confirmation: PLAN })).plan;
  assert.deepEqual((await read(fam.lead)).children[0].currentMembershipDraft, { state: 'RECORDED_DRAFT', receipt: first.receipt, plan: monthly });
  assertions += 16;

  // ---------- 7. server verification of payer and plan ----------
  const pending = await gcFamily();
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, monthly2))), code(409, 'CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED'));
  await services.gc.designatePayer(D.context(), pending.lead, DESIGNATE);
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, monthly))), code(409, 'MEMBERSHIP_PLAN_VERSION_STALE'));
  const hidden = await plan({ availability: 'UNAVAILABLE' });
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, hidden))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'));
  const euro = await plan({ currency: 'EUR' });
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, euro))), code(409, 'MEMBERSHIP_PLAN_CURRENCY_MISMATCH'), 'plan currency differs from the payer account');
  const foreign = (await services.plans.create(U.context(), { planCode: `OTHER-${tag().toUpperCase()}`, displayName: 'Other school', availability: 'AVAILABLE', currency: 'USD', priceMinor: 1,
    billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', confirmation: PLAN })).plan;
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, foreign))), code(404, 'MEMBERSHIP_PLAN_UNAVAILABLE'), 'another school\'s plan');
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(adultReg.result.studentProfileId, monthly2))), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'never an adult student');
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(randomUUID(), monthly2))), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'));
  for (const patch of [{ membershipPlanVersion: '2' }, { planCode: monthly2.planCode }, { termEndsAt: '2027-01-01T00:00:00.000Z' }, { billingAccountId: account.id },
    { participantPersonId: pending.guardian }, { priceMinor: 1 }, { confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' }, { termStartedAt: '2026-08-31' }]) {
    await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, monthly2, patch))), code(400, 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT'), JSON.stringify(patch));
  }
  assertions += 15;

  // ---------- 8. authority: permissions, roles, schools, organizations, identity and entitlement ----------
  const denied = code(403, 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN');
  for (const [who, why] of [[A, 'adult enrollment staff without family permissions'], [N, 'family staff without billing.membership.create'], [P, 'a staff member who also holds a family-portal role']]) {
    await assert.rejects(unchanged(() => read(pending.lead, who)), denied, why);
    await assert.rejects(unchanged(() => services.gc.addChild(who.context(), pending.lead, { ...childName(), confirmation: ADD })), denied, why);
    await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(who.context(), drafter(pending.student, monthly2))), denied, why);
  }
  await assert.rejects(unchanged(() => read(pending.lead, U)), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'another school never sees this lead');
  await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(U.context(), drafter(pending.student, monthly2))), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'));
  await assert.rejects(unchanged(() => read(pending.lead, V)), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'), 'another organization never sees this lead');
  await assert.rejects(unchanged(() => services.gc.read(D.read({ schoolId: ids.otherSchool }), pending.lead)), denied, 'school 1 staff presenting school 2');
  await assert.rejects(unchanged(() => services.gc.read(D.read({ principalId: D2.principal }), pending.lead)), denied, 'subject of one staff with the principal of another');
  await assert.rejects(services.gc.read({ ...D.read(), source: 'AI_ACTION' }, pending.lead), denied);
  await assert.rejects(services.gc.read({ ...D.read(), actionRequestId: randomUUID() }, pending.lead), denied);
  await assert.rejects(services.gc.designatePayer(D.read(), pending.lead, DESIGNATE), code(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  try {
    await assert.rejects(unchanged(() => read(pending.lead)), denied, 'suspended entitlement');
    await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(pending.student, monthly2))), denied, 'suspended entitlement');
  } finally { await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]); }
  const revoked = await staff();
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [revoked.grant, D.principal]);
  await assert.rejects(unchanged(() => read(pending.lead, revoked)), denied, 'revoked grant');
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
  for (const forged of ["set_config('app.hon_source','AI',true)", "set_config('app.hon_action_request_id',gen_random_uuid()::text,true)", "set_config('app.hon_principal_type','SERVICE',true)",
    "set_config('app.hon_delegated_by_principal_id',gen_random_uuid()::text,true)"]) {
    await assert.rejects(raw(D, 'SELECT hon.read_crm_guardian_child_enrollment($1,$2::uuid) data', () => [pending.lead], forged), (error) => error.code === '42501', forged);
  }
  await assert.rejects(raw(D, 'SELECT hon.read_crm_guardian_child_enrollment($2,$3::uuid) data WHERE $1::text IS NOT NULL', () => [D2.subject, pending.lead]), (error) => error.code === '42501', 'another subject');
  assert.equal((await raw(D, 'SELECT hon.read_crm_guardian_child_enrollment($1,$2::uuid) data', () => [pending.lead])).workflowState, 'PAYER_DESIGNATED', 'the runtime role reaches only the fixed function');
  assertions += 26;

  // ---------- 9. drift and ambiguity are staff-review outcomes; nothing is merged, relinked or chosen ----------
  async function driftCase(name, mutate, expectFamily, expectChild, restore) {
    const f = await gcFamily({ designate: true });
    await mutate(f);
    try {
      const state = await unchanged(() => read(f.lead));
      assert.equal(state.workflowState, expectFamily, `${name}: family state`);
      if (expectChild) assert.equal(state.children[0].workflowState, expectChild, `${name}: child state`);
      await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(f.student, monthly2))), (error) => [404, 409].includes(error?.getStatus?.()), `${name}: no DRAFT`);
      assertions += expectChild ? 3 : 2;
    } finally { if (restore) await restore(f); }
    return f;
  }
  await driftCase('child renamed after registration', (f) => sql("UPDATE hon.people SET given_name='Renamed' WHERE id=(SELECT child_person_id FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1)", [f.student]),
    'PAYER_DESIGNATED', 'NEEDS_STAFF_REVIEW');
  await driftCase('child birth date changed', (f) => sql("UPDATE hon.student_profiles SET birth_date='2015-01-01' WHERE id=$1", [f.student]), 'PAYER_DESIGNATED', 'NEEDS_STAFF_REVIEW');
  await driftCase('a second guardian added outside this workflow', async (f) => {
    const co = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Co','Guardian')", [co, ids.org, ids.school]);
    await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'GUARDIAN')", [ids.org, ids.school, f.family, co]);
  }, 'NEEDS_STAFF_REVIEW');
  await driftCase('guardian added to a second family', async (f) => {
    const other = (await sql("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,'Other family') RETURNING id", [ids.org, ids.school]))[0].id;
    await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'GUARDIAN')", [ids.org, ids.school, other, f.guardian]);
  }, 'NEEDS_STAFF_REVIEW');
  await driftCase('billing-contact projection cleared', (f) => sql('UPDATE hon.family_members SET is_billing_contact=false WHERE person_id=$1', [f.guardian]), 'NEEDS_STAFF_REVIEW');
  await driftCase('lead contact changed', async (f) => {
    const other = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Other','Contact')", [other, ids.org, ids.school]);
    // A WON lead is frozen by the 0145 close guard; the drift is forced only to prove the defense in depth.
    await sql('ALTER TABLE hon.crm_leads DISABLE TRIGGER crm_lead_close_update_guard');
    try { await sql('UPDATE hon.crm_leads SET primary_person_id=$2 WHERE id=$1', [f.lead, other]); }
    finally { await sql('ALTER TABLE hon.crm_leads ENABLE TRIGGER crm_lead_close_update_guard'); }
  }, 'NEEDS_STAFF_REVIEW');
  await driftCase('family archived', (f) => sql("UPDATE hon.families SET status='ARCHIVED' WHERE id=$1", [f.family]), 'NEEDS_STAFF_REVIEW');
  // A membership created for the child through the generic path is never adopted.
  { const f = await gcFamily({ designate: true });
    const childPerson = (await sql('SELECT child_person_id p FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1', [f.student]))[0].p;
    const accountId = (await sql("SELECT id FROM hon.billing_accounts WHERE responsible_person_id=$1 AND account_classification='CANONICAL'", [f.guardian]))[0].id;
    await services.memberships.createDraft(D.context(), { billingAccountId: accountId, participantPersonId: childPerson, planCode: 'GENERIC' });
    assert.equal((await read(f.lead)).children[0].workflowState, 'NEEDS_STAFF_REVIEW');
    await assert.rejects(unchanged(() => services.gc.draftMembershipFromPlan(D.context(), drafter(f.student, monthly2))), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'));
    assertions += 2; }
  // An activated or changed DRAFT is no longer a current DRAFT; activation stays the separate existing command.
  { const f = await gcFamily({ designate: true });
    const d = await services.gc.draftMembershipFromPlan(D.context(), drafter(f.student, monthly2));
    assert.equal((await read(f.lead)).children[0].workflowState, 'CURRENT_DRAFT');
    assert.equal((await activateWithPreview(services.memberships, D, d.receipt.membershipId)).membership.membershipSource, 'CRM_GUARDIAN_CHILD_PLAN');
    assert.equal((await read(f.lead)).children[0].workflowState, 'NEEDS_STAFF_REVIEW');
    assertions += 2; }
  // A guardian/child conversion recorded before 0176 has no snapshot: it stays a staff-review outcome (no backfill).
  { const { lead } = await wonLead();
    await admin.query('ALTER TABLE hon.crm_lead_registration_conversions DISABLE TRIGGER crm_guardian_child_registration_child_capture');
    try { await services.registrations.register(D.context(), lead, { registrationPath: 'GUARDIAN_CHILD', ...childName(), confirmation: REGISTER }); }
    finally { await admin.query('ALTER TABLE hon.crm_lead_registration_conversions ENABLE TRIGGER crm_guardian_child_registration_child_capture'); }
    assert.deepEqual(await unchanged(() => read(lead)), { leadId: lead, workflowState: 'NEEDS_STAFF_REVIEW' });
    await assert.rejects(unchanged(() => services.gc.addChild(D.context(), lead, { ...childName(), confirmation: ADD })), code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE'));
    assertions += 2; }
  // Ten children at most under one family.
  { const f = await gcFamily();
    const familyName = `Big${tag()}`;
    for (let i = 1; i < 10; i++) await services.gc.addChild(D.context(), f.lead, { childGivenName: `Child${tag()}`, childFamilyName: familyName, childBirthDate: `2010-01-${String(i + 10).padStart(2, '0')}`, confirmation: ADD });
    await assert.rejects(unchanged(() => services.gc.addChild(D.context(), f.lead, { childGivenName: `Child${tag()}`, childFamilyName: familyName, childBirthDate: '2010-02-01', confirmation: ADD })), code(409, 'CRM_GUARDIAN_CHILD_LIMIT'));
    assert.equal((await read(f.lead)).children.length, 10);
    assertions += 2; }

  // ---------- 10. immutability below the functions ----------
  for (const [statement, value] of [['UPDATE hon.crm_guardian_child_enrolled_children SET given_name=$2 WHERE student_profile_id=$1', 'X'],
    ['DELETE FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1 AND $2::text IS NOT NULL', 'X'],
    ['UPDATE hon.crm_guardian_child_payer_designations SET billing_account_id=billing_account_id WHERE family_id=(SELECT family_id FROM hon.crm_guardian_child_enrolled_children WHERE student_profile_id=$1) AND $2::text IS NOT NULL', 'X'],
    ['DELETE FROM hon.crm_guardian_child_membership_draft_sources WHERE student_profile_id=$1 AND $2::text IS NOT NULL', 'X']]) {
    await assert.rejects(admin.query(statement, [fam.student, value]), (error) => error.message === 'IMMUTABLE_CRM_GUARDIAN_CHILD_ENROLLMENT', statement);
  }
  for (const table of newTables) await assert.rejects(admin.query(`TRUNCATE hon.${table} CASCADE`), (error) => /IMMUTABLE_CRM_GUARDIAN_CHILD_ENROLLMENT/.test(error.message), table);
  assertions += 7;

  // ---------- 11. concurrency: same key, distinct keys, twins and designation races ----------
  { const f = await gcFamily(); const c = D.context();
    const results = await Promise.allSettled([services.gc.designatePayer(c, f.lead, DESIGNATE), services.gc.designatePayer({ ...c, requestId: randomUUID() }, f.lead, DESIGNATE)]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), 'same key: both resolve');
    assert.deepEqual(results.map((r) => r.value.replayed).sort(), [false, true]);
    assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_guardian_child_payer_designations WHERE family_id=$1', [f.family]))[0].n, 1);
    assertions += 3; }
  { const f = await gcFamily();
    const results = await Promise.allSettled([1, 2, 3].map(() => services.gc.designatePayer(D.context(), f.lead, DESIGNATE)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'distinct keys: one designation');
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => code(404, 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE')(r.reason)));
    assertions += 2; }
  { const f = await gcFamily({ designate: true });
    const twin = { childGivenName: `Twin${tag()}`, childFamilyName: `T${tag()}`, childBirthDate: '2019-05-05', confirmation: ADD };
    const results = await Promise.allSettled([services.gc.addChild(D.context(), f.lead, twin), services.gc.addChild(D2.context(), f.lead, { ...twin, childGivenName: `Twin${tag()}` })]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(results.map((r) => r.value.result.outcome).sort(), ['CHILD_ADDED', 'NEEDS_STAFF_REVIEW'], 'concurrent twins: one added, the other reviewed');
    const c = D.context(), sib = { ...childName(), confirmation: ADD };
    const same = await Promise.allSettled([services.gc.addChild(c, f.lead, sib), services.gc.addChild({ ...c, requestId: randomUUID() }, f.lead, sib)]);
    assert.deepEqual(same.map((r) => r.value.replayed).sort(), [false, true], 'same key: one child, one replay');
    assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_guardian_child_enrolled_children WHERE family_id=$1', [f.family]))[0].n, 3);
    const kids = (await read(f.lead)).children.map((child) => child.studentProfileId);
    const drafts = await Promise.allSettled([...kids, ...kids].map((student) => services.gc.draftMembershipFromPlan(D.context(), drafter(student, monthly2))));
    assert.equal(drafts.filter((r) => r.status === 'fulfilled').length, 3, 'one DRAFT per child under concurrent distinct keys');
    assert.equal((await sql('SELECT count(*)::int n FROM hon.crm_guardian_child_membership_draft_sources WHERE family_id=$1', [f.family]))[0].n, 3);
    assertions += 6; }
  assert.equal((await sql("SELECT count(*)::int n FROM hon.idempotency_records WHERE organization_id=$1 AND status='IN_PROGRESS'", [ids.org]))[0].n, 0, 'no unfinished reservation');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_payment_schedules WHERE organization_id=$1', [ids.org]))[0].n, 0, 'no payment schedule anywhere');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.invoices WHERE organization_id=$1', [ids.org]))[0].n, 0, 'no invoice anywhere');
  assertions += 3;

  // ---------- 12. ablation: a family proof that ignores extra members lets a co-guardian family through ----------
  const exactRelation = migration.match(/CREATE FUNCTION hon\.crm_guardian_child_family_relation\([\s\S]*?\nEND \$\$;\n/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const lenient = exactRelation.replace("OR (SELECT count(*) FROM hon.family_members x WHERE x.family_id=f.id AND x.organization_id=org AND x.school_id=school)<>children+1", '')
    .replace("AND (x.member_role<>'STUDENT' OR x.is_billing_contact OR NOT EXISTS(", "AND x.member_role='STUDENT' AND (x.is_billing_contact OR NOT EXISTS(");
  assert.notEqual(lenient, exactRelation);
  const ablated = await gcFamily({ designate: true });
  const co = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Unreviewed','Adult')", [co, ids.org, ids.school]);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'OTHER')", [ids.org, ids.school, ablated.family, co]);
  try {
    await admin.query(lenient);
    assert.equal((await read(ablated.lead)).workflowState, 'PAYER_DESIGNATED', 'the ablation is observable: an unreviewed family member is accepted');
  } finally { await admin.query(exactRelation); }
  assert.equal((await admin.query("SELECT prosrc=$1 exact FROM pg_proc WHERE oid='hon.crm_guardian_child_family_relation(uuid)'::regprocedure", [bodyOf('crm_guardian_child_family_relation')])).rows[0].exact, true, 'exact 0176 body restored');
  assert.equal((await read(ablated.lead)).workflowState, 'NEEDS_STAFF_REVIEW', 'restored body refuses again');
  assertions += 3;

  console.log(`PASS: Guardian/child CRM enrollment (${assertions} assertions): exact 0176 posture with four runtime entry points and private immutable tables; registration child snapshot (adult path untouched, no backfill); family recovery through every family and child state with creator vs other-staff DRAFT visibility; explicit payer designation only through the guardian's existing canonical account (ADDITIONAL accounts never selected, nothing inferred from lead contact); additional children with lead attribution, twin/duplicate/guardian review outcomes and a ten-child limit; one plan-bound DRAFT per child billed to the designated guardian with exact version binding; payer, plan, currency, school and adult refusals; permission, role, school, organization, identity, entitlement and forged-context refusals; drift and ambiguity as staff review; immutability; same-key, distinct-key, twin and per-child DRAFT races; zero schedule, invoice or payment effect; family-proof ablation detected.`);
} finally {
  await admin.query('ALTER TABLE hon.crm_lead_registration_conversions ENABLE TRIGGER crm_guardian_child_registration_child_capture').catch(() => {});
  await database.onModuleDestroy();
  await restricted.end().catch(() => {});
  await admin.end();
}
