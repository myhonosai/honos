/** Frontend transport -> real signed-session Nest route -> disposable PostgreSQL. No mocked API or identity guard. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';

assert.equal(process.env.HON_CRM_API_TEST, '1');
await requireFlexibleBillingAccountsLocalUrls(); // Refuses remote/shared DBs, provider credentials and unsafe descriptor files before connecting.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
const dbRequire = createRequire(resolve(repo, 'packages/database/package.json'));
const webRequire = createRequire(resolve(repo, 'apps/web/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), pg = dbRequire('pg');
const load = p => import(pathToFileURL(resolve(repo, 'apps/api/dist', p)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { LeadRegistrationRecoveryController } = await load('crm/lead-registration-recovery.controller.js');
const { LeadRegistrationRecoveryService } = await load('crm/lead-registration-recovery.service.js');
const { LeadRegistrationRecoveryHumanUiGuard } = await load('crm/lead-registration-recovery.dto.js');
const { LeadRegistrationService } = await load('crm/lead-registration.service.js');
const { BillingAccountService } = await load('billing/billing-account.service.js');
const { CrmAdultMembershipDraftService } = await load('billing/crm-adult-membership-draft.service.js');
const { MembershipPlanController, CrmAdultMembershipDraftFromPlanController } = await load('billing/membership-plan.controller.js');
const { MembershipPlanService } = await load('billing/membership-plan.service.js');
const planGuards = await load('billing/membership-plan.dto.js');
const database = new RuntimeDatabaseService(), owner = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const session = { mode: 'OIDC', audience: 'hon-crm-disposable-transport', secret: randomBytes(32).toString('hex') };
// Fresh synthetic application sessions, generated after the fixture environment safety check. Never logged or written.
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
let app;
const originalFetch = globalThis.fetch;
try {
  await owner.connect();
  const marker = (await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const sql = (q, v = []) => owner.query(q, v);
  const org = randomUUID(), school = randomUUID(), otherSchool = randomUUID(), role = randomUUID(), pipeline = randomUUID(), stage = randomUUID(), lead = randomUUID(), person = randomUUID();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic recovery organization','Synthetic recovery organization')", [org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic school',$4),($3,$2,'Other synthetic school',$5)", [school, org, otherSchool, `synthetic-${school}`, `synthetic-${otherSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [org]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'RECOVERY_FRONT_DESK','Synthetic role')", [role, org]);
  for (const permission of ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'billing.membership.create', 'billing.account.create', 'billing.membership_plan.manage']) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  async function staff(atSchool = school) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `recovery-http-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic staff')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Synthetic staff')", [principal, user]);
    await sql('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [grant, org, atSchool, principal, role]);
    return { subject, principal, grant, context: () => { const id = randomUUID(); return { organizationId: org, schoolId: atSchool, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: subject, requestId: id, correlationId: id, idempotencyKey: randomUUID() }; } };
  }
  const S = await staff(), T = await staff(), U = await staff(otherSchool);
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [stage, org, school, pipeline]);
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Adult')", [person, org, school]);
  await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, org, school, person, pipeline, stage]);
  const module = await Test.createTestingModule({ controllers: [LeadRegistrationRecoveryController, MembershipPlanController, CrmAdultMembershipDraftFromPlanController], providers: [HonIdentityGuard, HonIdentityService, LeadRegistrationRecoveryHumanUiGuard, LeadRegistrationRecoveryService, MembershipPlanService, ...Object.entries(planGuards).filter(([name]) => name.endsWith('Guard')).map(([,guard]) => guard), { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${app.getHttpServer().address().port}`; process.env.HON_PUBLIC_ORIGIN = origin;
  const ts = webRequire('typescript'), source = await readFile(resolve(repo, 'apps/web/src/components/crm-adult-flow-http.ts'), 'utf8');
  const contractsUrl = pathToFileURL(webRequire.resolve('@hon/contracts')).href;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from\s+['"]@hon\/contracts['"]/g, 'from ' + JSON.stringify(contractsUrl));
  const { readAdultRecovery, AdultAccessError, AdultRecoveryError } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  const planSource = await readFile(resolve(repo, 'apps/web/src/components/membership-plans/http.ts'), 'utf8');
  const planCompiled = ts.transpileModule(planSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from\s+['"]@hon\/contracts['"]/g, 'from ' + JSON.stringify(contractsUrl));
  const plans = await import('data:text/javascript;base64,' + Buffer.from(planCompiled).toString('base64'));
  const { MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION } = await import(contractsUrl);
  let actor = S;
  globalThis.fetch = (path, options) => {
    assert.match(path, /^\/api\/v1\/organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/(?:crm\/leads\/[a-f0-9-]+\/registration-recovery|billing\/(?:membership-plans(?:\/catalog|\/[a-f0-9-]+\/revisions)?|crm-adult-membership-drafts\/(?:plan-options|from-plan)))$/);
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`);
    return originalFetch(origin + path.slice(4), { ...options, headers });
  };
  const tables = ['people', 'student_profiles', 'families', 'family_members', 'crm_leads', 'crm_lead_registration_conversions', 'billing_accounts', 'memberships', 'crm_adult_membership_draft_sources', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'audit_events', 'outbox_events', 'idempotency_records', 'communication_messages', 'action_requests', 'ai_usage_ledger', 'membership_plans', 'membership_plan_versions', 'membership_plan_selections'];
  const snapshot = async () => {
    const result = {};
    for (const t of tables) result[t] = (await sql(`SELECT md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) h,count(*)::int n FROM hon.${t} x`)).rows[0];
    return result;
  };
  async function read(scope = { organizationId: org, schoolId: school }) { const before = await snapshot(); try { return await readAdultRecovery(scope, lead, person); } finally { assert.deepEqual(await snapshot(), before); } }
  const states = [];
  async function expectState(state) { const result = await read(); assert.equal(result.workflowState, state); states.push(state); return result; }
  await expectState('NOT_REGISTERED');
  const registration = await new LeadRegistrationService(database).register(S.context(), lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
  await expectState('BILLING_ACCOUNT_REQUIRED');
  await new BillingAccountService(database).create(S.context(), { responsiblePersonId: person, currency: 'USD' });
  const ready = await expectState('READY_FOR_DRAFT'); assert.deepEqual(ready.billingAccount, { classification: 'CANONICAL', currency: 'USD' });
  const d = await new CrmAdultMembershipDraftService(database).draft(S.context(), { studentProfileId: registration.result.studentProfileId, planCode: 'SYNTHETIC-ADULT', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });
  assert.equal((await expectState('CURRENT_DRAFT')).currentMembershipDraft.receipt.membershipId, d.receipt.membershipId);
  actor = T; const other = await expectState('CURRENT_DRAFT_BY_OTHER_STAFF'); assert.deepEqual(other.currentMembershipDraft, { state: 'RECORDED_DRAFT' });
  assert(!JSON.stringify(other).includes(d.receipt.membershipId));
  actor = U; await assert.rejects(read({ organizationId: org, schoolId: otherSchool }), e => e instanceof AdultRecoveryError && e.status === 404);
  await assert.rejects(read(), e => e instanceof AdultAccessError);
  actor = null; await assert.rejects(read(), e => e instanceof AdultAccessError);
  actor = T; await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [T.grant]);
  await assert.rejects(read(), e => e instanceof AdultAccessError);
  actor = S; await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'EUR','ADDITIONAL')", [org, school, person]);
  await expectState('NEEDS_STAFF_REVIEW');
  assert.equal(new Set(states).size, 6);
  // New frontend transports, real controllers/guards/services and PostgreSQL. No API or identity substitution.
  const planScope = { organizationId: org, schoolId: school };
  const beforeRead = await snapshot(); assert.deepEqual((await plans.readPlanCatalog(planScope)).plans, []); assert.deepEqual(await snapshot(), beforeRead);
  const terms = { displayName: 'Synthetic adult plan', description: null, programId: null, availability: 'AVAILABLE', currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
  const noFinancialEffects = ['membership_payment_schedules','invoices','payment_attempts','communication_messages','action_requests','ai_usage_ledger'];
  const financialBefore = await snapshot();
  const create = plans.createPlanRequest(planScope, { ...terms, planCode: 'HTTP-ADULT' }, randomUUID());
  const published = await plans.sendPlanRequest(create); assert.equal(published.kind, 'create'); assert.equal(published.plan.version, 1);
  const options = await plans.readAdultPlanOptions(planScope); assert.equal(options.plans[0].planId, published.plan.planId);
  const revise = plans.revisePlanRequest(planScope, published.plan.planId, { ...terms, expectedVersion: 1, priceMinor: 15900 }, randomUUID());
  const revised = await plans.sendPlanRequest(revise); assert.equal(revised.plan.version, 2);
  let before = await snapshot();
  await assert.rejects(plans.sendPlanRequest(plans.revisePlanRequest(planScope, published.plan.planId, { ...terms, expectedVersion: 1, priceMinor: 16900 }, randomUUID())), e => e instanceof plans.PlanRejectedError && e.code === 'MEMBERSHIP_PLAN_VERSION_STALE');
  assert.deepEqual(await snapshot(), before);
  // Use a new adult: the earlier recovery proof deliberately made the first adult ambiguous.
  const lead2 = randomUUID(), person2 = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Plan adult')", [person2,org,school]);
  await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead2,org,school,person2,pipeline,stage]);
  const registered2 = await new LeadRegistrationService(database).register(S.context(), lead2, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
  await new BillingAccountService(database).create(S.context(), { responsiblePersonId: person2, currency: 'USD' });
  const draftInput = { studentProfileId: registered2.result.studentProfileId, membershipPlanId: published.plan.planId, membershipPlanVersion: 2, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  before = await snapshot();
  await assert.rejects(plans.sendPlanRequest(plans.draftFromPlanRequest(planScope, { ...draftInput, membershipPlanVersion: 1 }, randomUUID())), e => e instanceof plans.PlanRejectedError && e.code === 'MEMBERSHIP_PLAN_VERSION_STALE');
  assert.deepEqual(await snapshot(), before);
  const draftRequest = plans.draftFromPlanRequest(planScope, draftInput, randomUUID());
  const draft = await plans.sendPlanRequest(draftRequest); assert.equal(draft.kind, 'draft'); assert.equal(draft.draft.plan.priceMinor, 15900);
  const confirmation = await new CrmAdultMembershipDraftService(database).confirmCurrentDraft({ ...S.context(), idempotencyKey: '' }, { studentProfileId: registered2.result.studentProfileId });
  assert.equal(confirmation.receipt.membershipId, draft.draft.receipt.membershipId);
  const recovery2 = await readAdultRecovery(planScope, lead2, person2); assert.equal(recovery2.workflowState, 'CURRENT_DRAFT');
  await plans.sendPlanRequest(plans.revisePlanRequest(planScope, published.plan.planId, { ...terms, expectedVersion: 2, priceMinor: 19900, availability: 'UNAVAILABLE' }, randomUUID()));
  assert.deepEqual((await plans.readAdultPlanOptions(planScope)).plans, []);
  before = await snapshot(); const replay = await plans.sendPlanRequest(draftRequest);
  assert.equal(replay.replayed, true); assert.equal(replay.draft.plan.version, 2); assert.equal(replay.draft.plan.priceMinor, 15900); assert.deepEqual(await snapshot(), before);
  const selection = (await sql('SELECT plan_version FROM hon.membership_plan_selections WHERE membership_id=$1', [draft.draft.receipt.membershipId])).rows;
  assert.deepEqual(selection, [{ plan_version: 2 }]);
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_plan_versions WHERE plan_id=$1', [published.plan.planId])).rows[0].n, 3);
  actor = U; await assert.rejects(plans.readPlanCatalog(planScope), e => e instanceof plans.PlanAccessError);
  assert.deepEqual((await plans.readPlanCatalog({ organizationId: org, schoolId: otherSchool })).plans, []);
  actor = null; await assert.rejects(plans.readAdultPlanOptions(planScope), e => e instanceof plans.PlanAccessError);
  actor = S; await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.membership_plan.manage'", [role]);
  await assert.rejects(plans.readPlanCatalog(planScope), e => e instanceof plans.PlanAccessError);
  assert.deepEqual((await plans.readAdultPlanOptions(planScope)).plans, []); // Enrollment permission does not gain publishing permission.
  const after = await snapshot(); for (const table of noFinancialEffects) assert.deepEqual(after[table], financialBefore[table], table);
  console.log('PASS: actual frontend plan transports through signed-session Nest and guarded disposable PostgreSQL: create/revise/read/options/plan-DRAFT, stale rollback, v2 immutable history after v3, exact replay without effects, current confirmation/recovery, isolated schools, revoked permission and absent session. No schedules, invoices, payment, provider or activation effects.');

  console.log('PASS: frontend recovery transport through real signed-session Nest API and disposable PostgreSQL; all six states, creator/noncreator redaction, cross-school/revoked/session denials, and zero read effects on 21 tables. No API/identity mock, provider, production DB or activation.');
} finally {
  globalThis.fetch = originalFetch;
  try { if (app) await app.close(); else await database.onModuleDestroy(); }
  finally { await owner.end(); }
}
