import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { activateWithPreview } from './membership-activation-test-support.mjs';

// Disposable-localhost proof for 0174 CRM lead registration recovery. The workflow is driven through the real
// registration, billing-account, adult DRAFT and membership services; recovery is read through the real service and
// directly as the restricted runtime role. Every recovery call is bracketed by an all-table effect snapshot.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { LeadRegistrationRecoveryService } = await import('../../../apps/api/dist/crm/lead-registration-recovery.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const blocker = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'otherOrg', 'otherOrgSchool', 'role', 'otherSchoolRole', 'otherOrgRole', 'noBillingRole', 'pipeline', 'stage',
  'otherSchoolPipeline', 'otherSchoolStage', 'otherOrgPipeline', 'otherOrgStage'].map((key) => [key, randomUUID()]));
const fullPermissions = ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage',
  'billing.membership.create', 'billing.account.create', 'billing.membership.activate'];
let assertions = 0;
const sql = async (text, values = []) => (await admin.query(text, values)).rows;

await admin.connect(); await restricted.connect(); await blocker.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), drafts: new CrmAdultMembershipDraftService(database),
  registrations: new LeadRegistrationService(database), recovery: new LeadRegistrationRecoveryService(database) };
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });

  // ---------- function posture: exact 0174 body, definer, fixed search path, runtime EXECUTE only, no table access ----------
  const migration = await readFile(new URL('../migrations/0174_crm_lead_registration_recovery.sql', import.meta.url), 'utf8');
  const expectedBody = migration.match(/CREATE FUNCTION hon\.read_crm_lead_registration_recovery\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(expectedBody);
  const posture = (await admin.query(`SELECT p.prosrc,p.prosecdef definer,p.provolatile volatility,p.proconfig config,(o.rolsuper OR o.rolbypassrls) trusted,
    has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,has_function_privilege('public',p.oid,'EXECUTE') public_execute,
    (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1 sole,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
      AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable OR a.privilege_type<>'EXECUTE')) private
    FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_crm_lead_registration_recovery(text,uuid)'::regprocedure`, [runtimeUrl.username])).rows[0];
  assert.equal(posture.prosrc, expectedBody, 'installed body is exactly 0174');
  assert.deepEqual({ ...posture, prosrc: undefined }, { prosrc: undefined, definer: true, volatility: 'v', config: ['search_path=pg_catalog, hon'], trusted: true,
    runtime_execute: true, public_execute: false, sole: true, private: true });
  assert.doesNotMatch(expectedBody, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i, 'recovery contains no DML');
  const helperBody = migration.match(/CREATE FUNCTION hon\.crm_adult_membership_draft_is_current\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.doesNotMatch(helperBody, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|LOCK)\b/i, 'private current-DRAFT check contains no DML');
  assert.deepEqual((await admin.query(`SELECT p.prosrc=$2 exact,p.prosecdef definer,p.proconfig config,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
    has_function_privilege('public',p.oid,'EXECUTE') public_execute FROM pg_proc p WHERE p.oid='hon.crm_adult_membership_draft_is_current(uuid)'::regprocedure`, [runtimeUrl.username, helperBody])).rows[0],
    { exact: true, definer: true, config: ['search_path=pg_catalog, hon'], runtime_execute: false, public_execute: false }, 'private current-DRAFT check is never runtime-callable');
  assertions += 2;
  for (const table of ['crm_lead_registration_conversions', 'crm_adult_membership_draft_sources']) {
    await assert.rejects(restricted.query(`SELECT 1 FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `runtime cannot read ${table} directly`);
  }
  assertions += 5;

  // ---------- fixture: org A school 1 (home), school 2 (other school), org B (other org) ----------
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_RECOVERY_ORG','PRIVATE_RECOVERY_ORG'),($2,'PRIVATE_RECOVERY_OTHER_ORG','PRIVATE_RECOVERY_OTHER_ORG')", [ids.org, ids.otherOrg]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_RECOVERY_SCHOOL',$3),($4,$2,'PRIVATE_RECOVERY_OTHER_SCHOOL',$5),($6,$7,'PRIVATE_RECOVERY_OTHER_ORG_SCHOOL',$8)",
    [ids.school, ids.org, `recovery-${ids.school}`, ids.otherSchool, `recovery-${ids.otherSchool}`, ids.otherOrgSchool, ids.otherOrg, `recovery-${ids.otherOrgSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.org, ids.otherOrg]);
  for (const [role, org, permissions] of [[ids.role, ids.org, fullPermissions], [ids.otherSchoolRole, ids.org, fullPermissions], [ids.otherOrgRole, ids.otherOrg, fullPermissions],
    [ids.noBillingRole, ids.org, fullPermissions.filter((code) => code !== 'billing.membership.create')]]) {
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'PRIVATE_RECOVERY_ROLE')", [role, org, `FRONT_DESK_${role.slice(0, 8)}`]);
    for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  }
  for (const [pipeline, stage, org, school] of [[ids.pipeline, ids.stage, ids.org, ids.school], [ids.otherSchoolPipeline, ids.otherSchoolStage, ids.org, ids.otherSchool],
    [ids.otherOrgPipeline, ids.otherOrgStage, ids.otherOrg, ids.otherOrgSchool]]) {
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_RECOVERY_PIPELINE')", [pipeline, org, school]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [stage, org, school, pipeline]);
  }
  async function staff(role = ids.role, org = ids.org, school = ids.school) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `recovery-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_RECOVERY_STAFF')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_RECOVERY_STAFF')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, role]);
    const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
    return { user, principal, grant, subject, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
  }
  const S = await staff(), T = await staff(), U = await staff(ids.otherSchoolRole, ids.org, ids.otherSchool), V = await staff(ids.otherOrgRole, ids.otherOrg, ids.otherOrgSchool);
  const N = await staff(ids.noBillingRole);
  async function wonLead(org = ids.org, school = ids.school, pipeline = ids.pipeline, stage = ids.stage) {
    const lead = randomUUID(), person = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Recovery',$4)", [person, org, school, `Adult-${person.slice(0, 8)}`]);
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, org, school, person, pipeline, stage]);
    return { lead, person };
  }
  const adultInput = { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' };
  const draftInput = (student) => ({ studentProfileId: student, planCode: 'STAFF-OPAQUE', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });

  // Every row the workflow could create, change or emit, organization-wide plus a whole-database fingerprint.
  const effectTables = ['people', 'student_profiles', 'families', 'family_members', 'crm_leads', 'crm_lead_registration_conversions', 'billing_accounts', 'memberships',
    'crm_adult_membership_draft_sources', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'audit_events', 'outbox_events', 'idempotency_records',
    'communication_messages', 'action_requests', 'ai_usage_ledger'];
  const snapshot = async () => Object.fromEntries(await Promise.all(effectTables.map(async (table) =>
    [table, (await admin.query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h,count(*)::int n FROM hon.${table} t`)).rows[0]])));
  async function recover(actor, lead, patch) {
    const before = await snapshot();
    try { return await services.recovery.recover(actor.read(patch), lead); }
    finally { assert.deepEqual(await snapshot(), before, 'recovery has no effect on any tracked table'); assertions++; }
  }
  const code = (expectedStatus, expectedCode) => (error) => error?.getStatus?.() === expectedStatus && error?.getResponse?.()?.code === expectedCode;

  // ---------- 1. session recovery across the whole adult workflow, each read in a fresh request ----------
  const journey = await wonLead();
  assert.deepEqual(await recover(S, journey.lead), { leadId: journey.lead, workflowState: 'NOT_REGISTERED' });
  const registration = await services.registrations.register(S.context(), journey.lead, adultInput);
  assert.equal(registration.result.outcome, 'REGISTERED');
  const afterRegister = await recover(S, journey.lead);
  assert.deepEqual(afterRegister, { leadId: journey.lead, workflowState: 'BILLING_ACCOUNT_REQUIRED', historicalRegistrationReceipt: registration.result });
  const account = await services.accounts.create(S.context(), { responsiblePersonId: journey.person, currency: 'USD' });
  const ready = await recover(S, journey.lead);
  assert.deepEqual(ready, { leadId: journey.lead, workflowState: 'READY_FOR_DRAFT', historicalRegistrationReceipt: registration.result, billingAccount: { classification: 'CANONICAL', currency: 'USD' } });
  assert.equal(JSON.stringify(ready).includes(account.account.id), false, 'no account id is disclosed');
  const draft = await services.drafts.draft(S.context(), draftInput(registration.result.studentProfileId));
  const current = await recover(S, journey.lead);
  assert.deepEqual(current, { leadId: journey.lead, workflowState: 'CURRENT_DRAFT', historicalRegistrationReceipt: registration.result,
    billingAccount: { classification: 'CANONICAL', currency: 'USD' }, currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt: draft.receipt } });
  // The current DRAFT section is the live 0163 observation, never the stored command receipt.
  assert.deepEqual(current.currentMembershipDraft, await services.drafts.confirmCurrentDraft(S.read(), { studentProfileId: registration.result.studentProfileId }));
  // Upper-case lead selector is the same lead; a different unknown lead is unavailable.
  assert.deepEqual(await recover(S, journey.lead.toUpperCase()), current);
  await assert.rejects(recover(S, randomUUID()), code(404, 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE'));
  assertions += 9;

  // ---------- 2. duplicate requests: repeated and concurrent reads are identical; commands after recovery do not duplicate ----------
  const before = await snapshot();
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => services.recovery.recover(S.read(), journey.lead)));
  for (const value of concurrent) assert.deepEqual(value, current);
  assert.deepEqual(await snapshot(), before);
  // A fresh-key registration retry after recovery records nothing new; a fresh-key DRAFT retry is refused without a second membership.
  assert.deepEqual((await services.registrations.register(S.context(), journey.lead, adultInput)).result, { outcome: 'NEEDS_STAFF_REVIEW' });
  await assert.rejects(services.drafts.draft(S.context(), draftInput(registration.result.studentProfileId)), code(404, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
  assert.deepEqual(await snapshot(), before);
  // Recovery never needs or accepts an idempotency key.
  await assert.rejects(services.recovery.recover(S.context(), journey.lead), code(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  assertions += 10;

  // ---------- 3. stale and drifted records: historical receipts are never reported as current ----------
  // (a) Another authorized staff member sees only that the DRAFT is current: no receipt, membership id or creator.
  const otherView = await recover(T, journey.lead);
  assert.deepEqual(otherView, { leadId: journey.lead, workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF', historicalRegistrationReceipt: registration.result,
    billingAccount: { classification: 'CANONICAL', currency: 'USD' }, currentMembershipDraft: { state: 'RECORDED_DRAFT' } });
  for (const hidden of [draft.receipt.membershipId, S.principal, S.user, S.subject, draft.receipt.planCode]) assert.equal(JSON.stringify(otherView).includes(hidden), false);
  // Visibility grants nothing: the creator-owned confirmation and a new DRAFT stay unavailable to the noncreator.
  await assert.rejects(services.drafts.confirmCurrentDraft(T.read(), { studentProfileId: registration.result.studentProfileId }), code(404, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
  await assert.rejects(services.drafts.draft(T.context(), draftInput(registration.result.studentProfileId)), code(404, 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE'));
  // The private yes/no check is not runtime-callable.
  await assert.rejects(restricted.query('SELECT hon.crm_adult_membership_draft_is_current($1::uuid)', [registration.result.studentProfileId]), (error) => error.code === '42501');
  // (b) Activation after the DRAFT: the historical DRAFT receipt still replays for its key, yet recovery no longer reports a current DRAFT to anyone.
  const membership = (await sql('SELECT id,version FROM hon.memberships WHERE participant_person_id=$1', [journey.person]))[0];
  await activateWithPreview(services.memberships, S, membership.id);
  assert.deepEqual(await recover(S, journey.lead), { leadId: journey.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  assert.deepEqual(await recover(T, journey.lead), { leadId: journey.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  assertions += 11;
  // (c) Creator versus noncreator on a DRAFT recorded by T; then drift, revocation and concurrent changes for the noncreator.
  async function otherDraft(currency = 'EUR') {
    const other = await wonLead(); const r = await services.registrations.register(T.context(), other.lead, adultInput);
    await services.accounts.create(T.context(), { responsiblePersonId: other.person, currency });
    const d = await services.drafts.draft(T.context(), draftInput(r.result.studentProfileId));
    return { ...other, student: r.result.studentProfileId, receipt: d.receipt, membership: d.receipt.membershipId };
  }
  { const other = await wonLead(); const r = await services.registrations.register(T.context(), other.lead, adultInput);
    assert.equal((await recover(S, other.lead)).workflowState, 'BILLING_ACCOUNT_REQUIRED', 'registration recovery is not creator-restricted');
    await services.accounts.create(T.context(), { responsiblePersonId: other.person, currency: 'EUR' });
    assert.deepEqual((await recover(S, other.lead)).billingAccount, { classification: 'CANONICAL', currency: 'EUR' });
    const d = await services.drafts.draft(T.context(), draftInput(r.result.studentProfileId));
    assert.deepEqual((await recover(T, other.lead)).currentMembershipDraft, { state: 'RECORDED_DRAFT', receipt: d.receipt }, 'creator sees the 0163 confirmation');
    assert.equal((await recover(T, other.lead)).workflowState, 'CURRENT_DRAFT');
    assert.equal((await recover(S, other.lead)).workflowState, 'CURRENT_DRAFT_BY_OTHER_STAFF');
    assert.equal((await recover(N, other.lead).catch((e) => e.getStatus())), 403, 'visibility still needs billing.membership.create');
    assert.equal((await recover(U, other.lead).catch((e) => e.getResponse().code)), 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE', 'other-school staff');
    assert.equal((await recover(V, other.lead).catch((e) => e.getResponse().code)), 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE', 'other-organization staff');
    assertions += 7; }
  // Drift on another staff member's DRAFT is review, exactly as for the creator.
  for (const [label, change] of [
    ['plan changed', (o) => sql("UPDATE hon.memberships SET plan_code='CHANGED-PLAN' WHERE id=$1", [o.membership])],
    ['version moved', (o) => sql('UPDATE hon.memberships SET version=version+1 WHERE id=$1', [o.membership])],
    ['term changed', (o) => sql("UPDATE hon.memberships SET term_ends_at='2031-01-01T00:00:00Z' WHERE id=$1", [o.membership])],
    ['activated', (o) => activateWithPreview(services.memberships, T, o.membership)],
    ['second account', (o) => sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'USD','ADDITIONAL')", [ids.org, ids.school, o.person])],
    ['student archived', (o) => sql("UPDATE hon.student_profiles SET status='ARCHIVED' WHERE person_id=$1", [o.person])],
  ]) {
    const o = await otherDraft();
    assert.equal((await recover(S, o.lead)).workflowState, 'CURRENT_DRAFT_BY_OTHER_STAFF', label);
    await change(o);
    assert.deepEqual(await recover(S, o.lead), { leadId: o.lead, workflowState: 'NEEDS_STAFF_REVIEW' }, label);
    assert.deepEqual(await recover(T, o.lead), { leadId: o.lead, workflowState: 'NEEDS_STAFF_REVIEW' }, `${label} (creator)`);
    assertions += 3;
  }
  // Noncreator with a revoked grant sees nothing.
  { const o = await otherDraft(); const W = await staff();
    assert.equal((await recover(W, o.lead)).workflowState, 'CURRENT_DRAFT_BY_OTHER_STAFF');
    await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [W.grant]);
    await assert.rejects(recover(W, o.lead), code(403, 'CRM_LEAD_REGISTRATION_RECOVERY_FORBIDDEN')); assertions += 2; }
  // Concurrent change: a writer holding an uncommitted change to the DRAFT blocks the read, which then reports the committed outcome.
  for (const outcome of ['COMMIT', 'ROLLBACK']) {
    const o = await otherDraft();
    await blocker.query('BEGIN'); await blocker.query("UPDATE hon.memberships SET plan_code='CONCURRENT-CHANGE' WHERE id=$1", [o.membership]);
    const reading = services.recovery.recover(S.read(), o.lead);
    for (let attempt = 0; ; attempt++) {
      const waiting = (await admin.query("SELECT count(*)::int n FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE NOT l.granted AND c.relname='memberships'")).rows[0].n;
      if (waiting) break; assert.ok(attempt < 300, 'recovery waits for the uncommitted change'); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await blocker.query(outcome);
    assert.deepEqual((await reading).workflowState, outcome === 'COMMIT' ? 'NEEDS_STAFF_REVIEW' : 'CURRENT_DRAFT_BY_OTHER_STAFF', outcome);
    assertions += 2;
  }
  // Concurrent activation and noncreator reads: no deadlock, every read is one of the two consistent states, and the final read is review.
  { const o = await otherDraft(); const before = await snapshot();
    const reads = Array.from({ length: 4 }, () => services.recovery.recover(S.read(), o.lead));
    const activation = activateWithPreview(services.memberships, T, o.membership);
    const results = await Promise.all([...reads, activation]);
    for (const value of results.slice(0, 4)) assert.ok(['CURRENT_DRAFT_BY_OTHER_STAFF', 'NEEDS_STAFF_REVIEW'].includes(value.workflowState));
    assert.equal(results[4].membership.state, 'ACTIVE');
    assert.deepEqual(await recover(S, o.lead), { leadId: o.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
    const after = await snapshot();
    assert.deepEqual(Object.keys(after).filter((table) => after[table].h !== before[table].h).sort(), ['audit_events', 'idempotency_records', 'memberships', 'outbox_events'], 'only the activation wrote');
    assertions += 7; }
  // (d) Account ambiguity and inactive student profile.
  { const a = await wonLead(); await services.registrations.register(S.context(), a.lead, adultInput);
    await services.accounts.create(S.context(), { responsiblePersonId: a.person, currency: 'USD' });
    await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'EUR','ADDITIONAL')", [ids.org, ids.school, a.person]);
    assert.deepEqual(await recover(S, a.lead), { leadId: a.lead, workflowState: 'NEEDS_STAFF_REVIEW' }); assertions++; }
  { const a = await wonLead(); await services.registrations.register(S.context(), a.lead, adultInput);
    await sql("UPDATE hon.student_profiles SET status='ARCHIVED' WHERE person_id=$1", [a.person]);
    assert.deepEqual(await recover(S, a.lead), { leadId: a.lead, workflowState: 'NEEDS_STAFF_REVIEW' }); assertions++; }
  // (e) A membership for the adult that did not come from this conversion.
  { const a = await wonLead(); await services.registrations.register(S.context(), a.lead, adultInput);
    const acc = await services.accounts.create(S.context(), { responsiblePersonId: a.person, currency: 'USD' });
    await services.memberships.createDraft(S.context(), { billingAccountId: acc.account.id, participantPersonId: a.person, planCode: 'STAFF-OPAQUE' });
    assert.deepEqual(await recover(S, a.lead), { leadId: a.lead, workflowState: 'NEEDS_STAFF_REVIEW' }); assertions++; }
  // (f) Guardian/child conversion is outside this contract: review, no ids.
  { const a = await wonLead();
    const r = await services.registrations.register(S.context(), a.lead, { registrationPath: 'GUARDIAN_CHILD', childGivenName: `Kid${randomUUID().slice(0, 6)}`, childFamilyName: `Fam${randomUUID().slice(0, 6)}`, childBirthDate: '2016-05-06', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    assert.equal(r.result.outcome, 'REGISTERED');
    assert.deepEqual(await recover(S, a.lead), { leadId: a.lead, workflowState: 'NEEDS_STAFF_REVIEW' }); assertions++; }
  // (g) An unregistered lead whose contact already has a student profile mirrors the registration review outcome.
  { const a = await wonLead(); await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id) VALUES($1,$2,$3)', [ids.org, ids.school, a.person]);
    assert.deepEqual(await recover(S, a.lead), { leadId: a.lead, workflowState: 'NEEDS_STAFF_REVIEW' }); assertions++; }

  // ---------- 4. revoked / expired / insufficient authority, entitlement and context ----------
  const victim = await wonLead(); await services.registrations.register(S.context(), victim.lead, adultInput);
  const denied = code(403, 'CRM_LEAD_REGISTRATION_RECOVERY_FORBIDDEN');
  await assert.rejects(recover(N, victim.lead), denied, 'registration authority without billing.membership.create');
  { const W = await staff(); await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [W.grant]);
    await assert.rejects(recover(W, victim.lead), denied, 'revoked grant'); }
  { const W = await staff(); await sql("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE id=$1", [W.grant]);
    await assert.rejects(recover(W, victim.lead), denied, 'expired grant'); }
  { const W = await staff(); await sql('UPDATE hon.principals SET is_active=false WHERE id=$1', [W.principal]);
    await assert.rejects(recover(W, victim.lead), denied, 'inactive principal'); }
  { const W = await staff(); await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.lead.register'", [ids.role]);
    try { await assert.rejects(recover(W, victim.lead), denied, 'permission removed from role'); }
    finally { await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'crm.lead.register')", [ids.role, ids.org]); } }
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  try { await assert.rejects(recover(S, victim.lead), denied, 'suspended entitlement (B6A)'); }
  finally { await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]); }
  assert.equal((await recover(S, victim.lead)).workflowState, 'BILLING_ACCOUNT_REQUIRED', 'restored authority recovers again');
  // Identity mismatches: subject of one staff with the principal of another, non-human source, Action Engine or delegation context.
  await assert.rejects(recover(S, victim.lead, { principalId: T.principal }), denied);
  await assert.rejects(services.recovery.recover({ ...S.read(), source: 'AI_ACTION' }, victim.lead), denied);
  await assert.rejects(services.recovery.recover({ ...S.read(), actionRequestId: randomUUID() }, victim.lead), denied);
  async function rawRecovery(setup) {
    await restricted.query('BEGIN');
    try {
      const requestId = randomUUID();
      await restricted.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
        set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
        set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [ids.org, ids.school, S.principal, requestId, S.subject]);
      await setup?.();
      return (await restricted.query('SELECT hon.read_crm_lead_registration_recovery($1,$2::uuid) data', [S.subject, victim.lead])).rows[0].data;
    } finally { await restricted.query('ROLLBACK'); }
  }
  assert.equal((await rawRecovery()).workflowState, 'BILLING_ACCOUNT_REQUIRED', 'runtime role reaches only the fixed function');
  for (const forged of ["set_config('app.hon_source','AI',true)", "set_config('app.hon_action_request_id',gen_random_uuid()::text,true)", "set_config('app.hon_delegated_by_principal_id',gen_random_uuid()::text,true)",
    "set_config('app.hon_principal_type','SERVICE',true)", "set_config('app.hon_external_subject','someone-else',true)"]) {
    await assert.rejects(rawRecovery(() => restricted.query(`SELECT ${forged}`)), (error) => error.code === '42501', forged);
  }
  await assert.rejects(rawRecovery(() => restricted.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids.otherOrg])), (error) => error.code === '42501', 'forged organization');
  assertions += 18;

  // ---------- 5. cross-school and cross-organization isolation ----------
  const otherSchoolLead = await wonLead(ids.org, ids.otherSchool, ids.otherSchoolPipeline, ids.otherSchoolStage);
  const otherOrgLead = await wonLead(ids.otherOrg, ids.otherOrgSchool, ids.otherOrgPipeline, ids.otherOrgStage);
  const unavailable = code(404, 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE');
  await assert.rejects(recover(S, otherSchoolLead.lead), unavailable, 'a lead of another school is unavailable, not disclosed');
  await assert.rejects(recover(S, otherOrgLead.lead), unavailable, 'a lead of another organization is unavailable');
  assert.deepEqual(await recover(U, otherSchoolLead.lead), { leadId: otherSchoolLead.lead, workflowState: 'NOT_REGISTERED' }, 'the owning school recovers it');
  await assert.rejects(recover(U, journey.lead), unavailable, 'other-school staff cannot recover this school\'s lead');
  await assert.rejects(recover(V, journey.lead), unavailable, 'other-organization staff cannot recover it');
  // Staff authorized only at school 2 presenting school 1 as their scope: refused by authority, not by lookup.
  await assert.rejects(recover(U, journey.lead, { schoolId: ids.school }), denied);
  await assert.rejects(recover(V, journey.lead, { organizationId: ids.org, schoolId: ids.school }), denied);
  // The scope resolver used by the controller derives scope from identity; the URL school is only a selector.
  assert.equal((await database.resolveCrmLeadRegistrationScope(U.subject, ids.school)), undefined);
  assert.equal((await database.resolveCrmLeadRegistrationScope(S.subject, ids.school))?.principalId, S.principal);
  assertions += 9;

  // ---------- 6. ablation: a recovery that trusted the stored DRAFT receipt would report the activated membership as current ----------
  const exact = migration.match(/CREATE FUNCTION hon\.read_crm_lead_registration_recovery\([\s\S]*?\nEND \$\$;\n/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const trusting = exact.replace('current_draft:=hon.read_crm_adult_membership_draft_confirmation(subject,c.resulting_student_profile_id);',
    "current_draft:=jsonb_build_object('state','RECORDED_DRAFT','receipt',(SELECT x.receipt FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=c.id));");
  assert.notEqual(trusting, exact);
  try {
    await admin.query(trusting);
    assert.equal((await services.recovery.recover(S.read(), journey.lead)).workflowState, 'CURRENT_DRAFT', 'the receipt-trusting variant misreports the activated membership');
  } finally { await admin.query(exact); }
  assert.equal((await admin.query("SELECT prosrc FROM pg_proc WHERE oid='hon.read_crm_lead_registration_recovery(text,uuid)'::regprocedure")).rows[0].prosrc, expectedBody, 'exact 0174 body restored');
  assert.deepEqual(await recover(S, journey.lead), { leadId: journey.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  assertions += 4;
  // The same for noncreators: a check that only finds the source row would report T's view of the activated DRAFT as current.
  const exactHelper = migration.match(/CREATE FUNCTION hon\.crm_adult_membership_draft_is_current\([\s\S]*?\nEND \$\$;\n/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  const sourceOnly = exactHelper.replace(/\nBEGIN\n[\s\S]*\nEND \$\$;\n$/, () => "\nBEGIN\n  RETURN EXISTS(SELECT 1 FROM hon.crm_lead_registration_conversions c JOIN hon.crm_adult_membership_draft_sources x ON x.conversion_id=c.id WHERE c.resulting_student_profile_id=selected_student);\nEND $$;\n");
  assert.notEqual(sourceOnly, exactHelper);
  try {
    await admin.query(sourceOnly);
    assert.equal((await services.recovery.recover(T.read(), journey.lead)).workflowState, 'CURRENT_DRAFT_BY_OTHER_STAFF', 'the source-only variant misreports the activated membership to a noncreator');
  } finally { await admin.query(exactHelper); }
  assert.equal((await admin.query("SELECT prosrc=$1 exact FROM pg_proc WHERE oid='hon.crm_adult_membership_draft_is_current(uuid)'::regprocedure", [helperBody])).rows[0].exact, true);
  assert.deepEqual(await recover(T, journey.lead), { leadId: journey.lead, workflowState: 'NEEDS_STAFF_REVIEW' });
  assertions += 4;

  console.log(`PASS: CRM lead registration recovery (${assertions} assertions): exact read-only 0174 function posture; session recovery through NOT_REGISTERED, BILLING_ACCOUNT_REQUIRED, READY_FOR_DRAFT and CURRENT_DRAFT with the historical registration receipt kept distinct from the live current-DRAFT confirmation; repeated and concurrent reads identical with zero effect on ${effectTables.length} tracked tables; post-recovery command retries create no duplicate; creator versus noncreator visibility (noncreator sees only a yes/no current DRAFT and still cannot confirm or draft); activation, plan/version/term changes, ambiguous-account, inactive-student, foreign-membership, guardian/child and pre-existing-profile drift all fail closed to NEEDS_STAFF_REVIEW; revoked, expired, inactive, missing-permission, suspended-entitlement and forged-context reads refused; cross-school and cross-organization leads unavailable; a noncreator read waits for an uncommitted DRAFT change and reports the committed outcome, and concurrent activation never deadlocks; receipt-trusting (creator) and source-only (noncreator) variants are each caught misreporting an activated membership as a current DRAFT.`);
} finally {
  await database.onModuleDestroy();
  await restricted.end().catch(() => {});
  await blocker.end().catch(() => {});
  await admin.end();
}
