/** Actual frontend transports -> signed human sessions -> Nest -> restricted runtime -> marked disposable PostgreSQL.
 * All people, organizations, plans, identity ambiguity and activations are synthetic. No browser/API/provider mocks. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
import { confirmationFor } from '../../../packages/database/scripts/membership-activation-test-support.mjs';
assert.equal(process.env.HON_SCHOOL_MEMBERSHIP_API_TEST, '1');
const urls = await requireFlexibleBillingAccountsLocalUrls(); // Refuse credentials/PG overrides/unsafe URLs/descriptors BEFORE any client.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/); assert.equal(sourceSha, process.env.HON_SCHOOL_MEMBERSHIP_SHA);
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json')), dbRequire = createRequire(resolve(repo, 'packages/database/package.json')), webRequire = createRequire(resolve(repo, 'apps/web/package.json'));
apiRequire('reflect-metadata'); const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), { Client } = dbRequire('pg'), ts = webRequire('typescript');
const classes = {}, modules = ['foundation/runtime-database.service', 'foundation/hon-identity.guard', 'foundation/hon-identity.service', 'crm/lead-registration.controller', 'crm/lead-registration.service', 'crm/lead-registration.dto', 'crm/lead-registration-recovery.controller', 'crm/lead-registration-recovery.service', 'crm/lead-registration-recovery.dto', 'crm/guardian-child-enrollment.controller', 'crm/guardian-child-enrollment.service', 'crm/guardian-child-enrollment.dto', 'billing/billing-account.controller', 'billing/billing-account.service', 'billing/billing-account-human-ui.guard', 'billing/membership-plan.controller', 'billing/membership-plan.service', 'billing/membership-plan.dto', 'billing/crm-adult-membership-draft.controller', 'billing/crm-adult-membership-draft.service', 'billing/crm-adult-membership-draft.dto', 'billing/membership.controller', 'billing/membership.service', 'billing/membership-activation-human-ui.guard', 'billing/membership-date-revision.controller', 'billing/membership-date-revision.service', 'billing/membership-date-revision.dto'];
for (const file of modules) Object.assign(classes, await import(pathToFileURL(resolve(repo, 'apps/api/dist', file + '.js')).href));
const database = new classes.RuntimeDatabaseService(), owner = new Client({ connectionString: urls.DATABASE_URL, ssl: false }), originalFetch = globalThis.fetch;
const session = { mode: 'OIDC', audience: 'hon-school-membership-integration-disposable', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
let app, compiled, actor, expired = false, loseResponse = false; const checks = [], attempts = [], pass = name => { checks.push(name); console.log('PASS school membership integration: ' + name); };
try {
  await owner.connect(); const sql = (query, values = []) => owner.query(query, values);
  assert.deepEqual((await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0], { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  async function school() {
    const s = Object.fromEntries(['organizationId', 'schoolId', 'pipeline', 'stage'].map(key => [key, randomUUID()]));
    await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic integration organization','Synthetic integration organization')", [s.organizationId]);
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Synthetic integration school',$3,'UTC')", [s.schoolId, s.organizationId, 'membership-' + s.schoolId]);
    await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [s.organizationId]);
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic integration pipeline')", [s.pipeline, s.organizationId, s.schoolId]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [s.stage, s.organizationId, s.schoolId, s.pipeline]); return s;
  }
  async function staff(s, override = false) {
    const p = Object.fromEntries(['user', 'principal', 'role', 'grant'].map(key => [key, randomUUID()])); p.subject = 'membership-integration-' + randomUUID();
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'Synthetic integration staff')", [p.role, s.organizationId, 'INTEGRATION_' + p.role]);
    for (const code of ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create', 'billing.account.create', 'billing.membership_plan.manage', 'billing.membership.activate', 'billing.membership.read', 'billing.membership.dates.revise', ...(override ? ['billing.membership.activation.override'] : [])]) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [p.role, s.organizationId, code]);
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic integration staff')", [p.user, p.subject, p.user + '@example.test']);
    await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic integration staff')", [p.principal, p.user]);
    await sql('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [p.grant, s.organizationId, s.schoolId, p.principal, p.role]); return p;
  }
  const A = await school(), B = await school(), S = await staff(A, true), T = await staff(A), U = await staff(B), scope = { organizationId: A.organizationId, schoolId: A.schoolId }; actor = S;
  async function lead() { const person = randomUUID(), leadId = randomUUID(); await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic',$4)", [person, A.organizationId, A.schoolId, 'Person-' + person]); await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [leadId, A.organizationId, A.schoolId, person, A.pipeline, A.stage]); return { person, leadId }; }
  const adultLead = await lead(), familyLead = await lead();
  const controllers = ['LeadRegistrationController', 'LeadRegistrationRecoveryController', 'GuardianChildEnrollmentController', 'GuardianChildMembershipDraftController', 'BillingAccountController', 'MembershipPlanController', 'CrmAdultMembershipDraftFromPlanController', 'CrmAdultMembershipDraftController', 'MembershipController', 'MembershipDateRevisionController'];
  const providers = [...new Set(['HonIdentityService', ...Object.keys(classes).filter(name => name.endsWith('Guard') || name.endsWith('Service') && name !== 'RuntimeDatabaseService')])].map(name => classes[name]);
  const module = await Test.createTestingModule({ controllers: controllers.map(name => classes[name]), providers: [...providers, { provide: classes.RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const origin = 'http://127.0.0.1:' + app.getHttpServer().address().port; process.env.HON_PUBLIC_ORIGIN = origin;
  compiled = await mkdtemp(join(tmpdir(), 'hon-membership-integration-')); const cache = new Map(), sourceRoot = resolve(repo, 'apps/web/src/components');
  async function frontend(file) {
    assert(!relative(sourceRoot, file).startsWith('..')); if (cache.has(file)) return cache.get(file);
    let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const match of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]) { const spec = match[1]; let url; if (spec.startsWith('.')) url = await frontend(resolve(dirname(file), spec + '.ts')); else { assert.equal(spec, '@hon/contracts'); url = pathToFileURL(webRequire.resolve(spec)).href; } code = code.replace(match[0], 'from ' + JSON.stringify(url)); }
    const output = join(compiled, randomUUID() + '.mjs'); await writeFile(output, code); const url = pathToFileURL(output).href; cache.set(file, url); return url;
  }
  const adult = await import(await frontend(resolve(sourceRoot, 'crm-adult-flow-http.ts'))), family = await import(await frontend(resolve(sourceRoot, 'crm-family-http.ts'))), plans = await import(await frontend(resolve(sourceRoot, 'membership-plans/http.ts'))), activation = await import(await frontend(resolve(sourceRoot, 'membership-activation-http.ts'))), dates = await import(await frontend(resolve(sourceRoot, 'membership-dates-http.ts'))), contracts = await import(pathToFileURL(webRequire.resolve('@hon/contracts')).href);
  const allowed = /^\/api\/v1\/organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/(?:crm\/leads\/[a-f0-9-]+\/(?:register|registration-recovery|guardian-child-enrollment(?:\/payer-designation|\/children)?)|billing\/(?:accounts|membership-plans(?:\/catalog)?|crm-adult-membership-drafts\/(?:plan-options|from-plan|confirmation)|crm-guardian-child-membership-drafts\/from-plan|memberships\/[a-f0-9-]+\/(?:activation-context|activation-preview|activate|effective-period\/history)))$/;
  globalThis.fetch = async (path, options) => {
    assert.equal(typeof path, 'string'); assert(allowed.test(path), 'Unapproved transport path'); assert(['GET', 'POST'].includes(options.method));
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', HON_SESSION_COOKIE + '=' + issueSession({ externalSubject: actor.subject }, session, expired ? 1 : undefined));
    const response = await originalFetch(origin + path.slice(4), { ...options, headers, redirect: 'error' });
    if (path.endsWith('/activate')) { attempts.push({ path, body: options.body, key: headers.get('Idempotency-Key'), status: response.status }); if (loseResponse && response.status === 200) { loseResponse = false; await response.arrayBuffer(); throw new DOMException('Synthetic response loss after actual commit', 'TimeoutError'); } } return response;
  };
  const tables = (await sql("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(r => r.tablename);
  async function snapshot(selected = tables) { const result = {}; for (const table of selected) { assert.match(table, /^[a-z][a-z0-9_]*$/); result[table] = (await sql(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) hash,count(*)::int count FROM hon.${table} t`)).rows[0]; } return result; }
  async function unchanged(work) { const before = await snapshot(); try { return await work(); } finally { assert.deepEqual(await snapshot(), before, 'Read/replay/refusal changed database rows'); } }
  const changedTables = new Set(['people', 'student_profiles', 'families', 'family_members', 'crm_leads', 'crm_lead_registration_conversions', 'billing_accounts', 'memberships', 'crm_adult_membership_draft_sources', 'crm_guardian_child_enrolled_children', 'crm_guardian_child_payer_designations', 'crm_guardian_child_membership_draft_sources', 'membership_plan_selections', 'membership_plans', 'membership_plan_versions', 'idempotency_records', 'audit_events', 'outbox_events', 'work_items', 'human_work_history', 'membership_activation_decisions', 'membership_effective_periods', 'membership_activation_follow_ups', 'role_permissions']);
  const historyColumns = 'work_item_id,organization_id,school_id,actor_id,operation,version';
  const historyBefore = (await sql(`SELECT ${historyColumns} FROM hon.human_work_history ORDER BY work_item_id,version`)).rows;
  const protectedTables = tables.filter(t => !changedTables.has(t)), protectedBefore = await snapshot(protectedTables), ar = (step, selection, value, key) => adult.sendAdultRequest(adult.adultRequest(scope, step, selection, value, key)), fr = (step, selection, input, key = randomUUID()) => family.sendFamilyRequest(family.familyRequest(scope, step, selection, input, key));
  const recoverAdult = () => unchanged(() => adult.readAdultRecovery(scope, adultLead.leadId, adultLead.person)), recoverFamily = () => unchanged(() => family.readFamilyEnrollment(scope, familyLead.leadId, familyLead.person));
  const registration = await ar('register', adultLead.leadId, '1990-01-02', randomUUID()), profile = registration.registration.studentProfileId, account = await ar('account', adultLead.person, 'USD', randomUUID()); assert.equal(account.account.classification, 'CANONICAL'); assert.equal((await recoverAdult()).workflowState, 'READY_FOR_DRAFT');
  const terms = { planCode: 'INTEGRATION-' + randomUUID().slice(0, 8).toUpperCase(), displayName: 'Synthetic published integration plan', description: null, programId: null, availability: 'AVAILABLE', currency: 'USD', priceMinor: 9900, billingFrequency: 'MONTHLY', termKind: 'OPEN_ENDED', termMonths: null, confirmation: contracts.MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
  const published = await plans.sendPlanRequest(plans.createPlanRequest(scope, terms, randomUUID())), plan = published.plan; assert.equal((await unchanged(() => plans.readAdultPlanOptions(scope))).plans.find(p => p.planId === plan.planId).version, 1);
  const adultDraft = await plans.sendPlanRequest(plans.draftFromPlanRequest(scope, { studentProfileId: profile, membershipPlanId: plan.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }, randomUUID())), adultScope = { ...scope, membershipId: adultDraft.draft.receipt.membershipId };
  assert.equal(adultDraft.draft.plan.priceMinor, 9900); // Historical creation terms; recovery deliberately omits plan terms.
  assert.equal((await unchanged(() => ar('confirm', profile, ''))).confirmation.receipt.membershipId, adultScope.membershipId); assert.equal((await recoverAdult()).currentMembershipDraft.receipt.membershipId, adultScope.membershipId);
  actor = T; const redacted = await recoverAdult(); assert.equal(redacted.workflowState, 'CURRENT_DRAFT_BY_OTHER_STAFF'); assert.deepEqual(redacted.currentMembershipDraft, { state: 'RECORDED_DRAFT' }); assert(!JSON.stringify(redacted).includes(adultScope.membershipId)); actor = S;
  pass('adult signed registration, canonical payer, actual published plan, plan-bound DRAFT and fresh creator confirmation; noncreator redaction');
  const registered = await fr('register', familyLead.leadId, { registrationPath: 'GUARDIAN_CHILD', childGivenName: 'SyntheticFirst', childFamilyName: 'Child-' + randomUUID(), childBirthDate: '2016-02-03', confirmation: contracts.CRM_LEAD_REGISTRATION_CONFIRMATION }), first = registered.registration.studentProfileId;
  const guardianAccount = await fr('account', familyLead.person, { currency: 'USD' }); await fr('payer', familyLead.leadId, { confirmation: contracts.CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION });
  const added = await fr('child', familyLead.leadId, { childGivenName: 'SyntheticSecond', childFamilyName: 'Child-' + randomUUID(), childBirthDate: '2018-04-05', confirmation: contracts.CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION }), second = added.child.studentProfileId; assert.notEqual(first, second);
  const childInput = id => ({ studentProfileId: id, membershipPlanId: plan.planId, membershipPlanVersion: 1, confirmation: contracts.CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION });
  const childOne = await fr('childDraft', first, childInput(first)); actor = T; const childTwo = await fr('childDraft', second, childInput(second)); const secondScope = { ...scope, membershipId: childTwo.draft.receipt.membershipId }; actor = S;
  const current = await recoverFamily(); assert.equal(current.children.find(c => c.studentProfileId === first).currentMembershipDraft.receipt.membershipId, childOne.draft.receipt.membershipId); assert.deepEqual(current.children.find(c => c.studentProfileId === second).currentMembershipDraft, { state: 'RECORDED_DRAFT' }); assert(!JSON.stringify(current).includes(secondScope.membershipId));
  const rows = (await sql('SELECT participant_person_id,billing_account_id,state FROM hon.memberships WHERE id=ANY($1::uuid[])', [[childOne.draft.receipt.membershipId, secondScope.membershipId]])).rows; assert.equal(rows.length, 2); assert(rows.every(r => r.state === 'DRAFT' && r.billing_account_id === guardianAccount.account.id)); assert.equal(new Set(rows.map(r => r.participant_person_id)).size, 2); assert(rows.every(r => r.participant_person_id !== familyLead.person));
  pass('guardian registration, explicit canonical payer designation, two distinct children and DRAFTs with original plan terms and creator-bound recovery');
  const preview = (s, input = {}) => unchanged(() => activation.previewMembershipActivation(s, input)), prepare = (s, p, patch) => activation.prepareMembershipActivation(s, confirmationFor(p, patch), randomUUID()), rejected = (status, code) => e => e instanceof activation.MembershipActivationError && e.status === status && (!code || e.code === code);
  const old = await preview(adultScope); assert.equal(old.source, 'CRM_ADULT_PLAN'); assert.equal(old.blocks.length, 0);
  // Existing supported precondition from the canonical E1a proof; no ACTIVE writes or trigger bypasses.
  await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification) VALUES($1,$2,$3,'USD','ADDITIONAL')", [A.organizationId, A.schoolId, adultLead.person]);
  await unchanged(() => assert.rejects(activation.activateKnownMembership(prepare(adultScope, old)), rejected(409, 'ACTIVATION_PREVIEW_STALE')));
  actor = T; const unprivileged = await preview(adultScope); assert(unprivileged.warnings.some(w => w.code === 'CRM_IDENTITY_REVIEW_PENDING')); assert.equal(unprivileged.canConfirm, false); assert.deepEqual(unprivileged.availableOverrides, []);
  await unchanged(() => assert.rejects(activation.activateKnownMembership(prepare(adultScope, unprivileged)), rejected(403, 'ACTIVATION_OVERRIDE_FORBIDDEN'))); actor = S;
  const reviewed = await preview(adultScope); assert.equal(reviewed.canConfirm, true); assert.deepEqual(reviewed.availableOverrides, ['CRM_IDENTITY_REVIEW_PENDING']); assert.equal(reviewed.previewDigest, unprivileged.previewDigest);
  pass('all-table zero-effect previews, genuine stale-fact refusal and existing permission-bound unresolved identity override');
  const exact = prepare(adultScope, reviewed), identityTables = ['people', 'student_profiles', 'families', 'family_members', 'billing_accounts', 'crm_leads', 'crm_lead_registration_conversions'], identityBefore = await snapshot(identityTables);
  const concurrent = await Promise.all([activation.activateKnownMembership(exact), activation.activateKnownMembership(exact)]); assert.deepEqual(concurrent.map(r => r.replayed).sort(), [false, true]); assert.deepEqual(concurrent[0].receipt, concurrent[1].receipt); assert.deepEqual(concurrent[0].receipt.overridesUsed, [{ code: 'CRM_IDENTITY_REVIEW_PENDING', resolved: false }]); assert.deepEqual(await snapshot(identityTables), identityBefore);
  await unchanged(() => activation.activateKnownMembership(exact)); assert.equal((await unchanged(() => activation.loadMembershipActivationContext(adultScope))).state, 'ACTIVE');
  assert.equal((await recoverAdult()).workflowState, 'NEEDS_STAFF_REVIEW', 'DRAFT recovery must never turn an activation receipt into current DRAFT evidence');
  pass('concurrent exact activation records one result, preserves unresolved identities and returns a fresh ACTIVE context');
  const childScope = { ...scope, membershipId: childOne.draft.receipt.membershipId }, childPreview = await preview(childScope); assert.equal(childPreview.source, 'CRM_GUARDIAN_CHILD_PLAN'); assert.equal(childPreview.knownMinor, true); assert.equal(childPreview.blocks.length, 0);
  const futureDate = new Date(Date.parse(childPreview.localToday + 'T00:00:00Z') + 2 * 86400000).toISOString().slice(0, 10), scheduledPreview = await preview(childScope, { startDate: futureDate, endDate: null }); assert.equal(scheduledPreview.effectiveStatusIfConfirmedNow, 'SCHEDULED');
  const lost = prepare(childScope, scheduledPreview), beforeAttempts = attempts.length; loseResponse = true;
  await assert.rejects(activation.activateKnownMembership(lost), e => e instanceof activation.MembershipActivationError && e.uncertain); assert.equal(attempts.length, beforeAttempts + 1, 'No automatic retry');
  const replay = await unchanged(() => activation.activateKnownMembership(lost)); assert.equal(replay.replayed, true); assert.equal(replay.receipt.state, 'ACTIVE'); assert.equal(replay.receipt.effectiveStatusAtActivation, 'SCHEDULED'); assert.deepEqual(attempts.at(-1), attempts.at(-2));
  assert.equal((await unchanged(() => activation.loadMembershipActivationContext(childScope))).state, 'ACTIVE'); assert.equal((await unchanged(() => activation.loadMembershipActivationContext(secondScope))).state, 'DRAFT');
  const afterActivation = await recoverFamily();
  assert.equal(afterActivation.children.find(c => c.studentProfileId === first).workflowState, 'NEEDS_STAFF_REVIEW');
  assert(!Object.hasOwn(afterActivation.children.find(c => c.studentProfileId === first), 'currentMembershipDraft'));
  pass('one child future activation survives real committed response loss/exact body-key retry; sibling stays DRAFT and ACTIVE is not in-effect or paid');
  for (const membershipId of [adultScope.membershipId, childScope.membershipId]) assert.deepEqual((await sql("SELECT (SELECT count(*)::int FROM hon.membership_activation_decisions WHERE membership_id=$1) decisions,(SELECT count(*)::int FROM hon.membership_effective_periods WHERE membership_id=$1) periods,(SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$1 AND action_code='billing.membership.activate') audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.membership.activated' AND schema_version=2 AND published_at IS NULL AND attempt_count=0) outbox", [membershipId])).rows[0], { decisions: 1, periods: 1, audits: 1, outbox: 1 });
  actor = U; await unchanged(() => assert.rejects(preview(childScope), rejected(403))); await unchanged(() => assert.rejects(activation.activateKnownMembership(lost), rejected(403))); await unchanged(() => assert.rejects(recoverFamily(), e => e instanceof plans.PlanAccessError));
  await unchanged(() => assert.rejects(activation.loadMembershipActivationContext({ organizationId: B.organizationId, schoolId: B.schoolId, membershipId: childScope.membershipId }), rejected(404)));
  actor = null; await unchanged(() => assert.rejects(preview(secondScope), rejected(401))); actor = S; expired = true; await unchanged(() => assert.rejects(preview(secondScope), rejected(401))); expired = false;
  await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.membership.activate'", [S.role]); await unchanged(() => assert.rejects(preview(secondScope), rejected(403))); await unchanged(() => assert.rejects(activation.activateKnownMembership(lost), rejected(403))); await unchanged(() => assert.rejects(activation.loadMembershipActivationContext(childScope), rejected(403)));
  pass('two independently signed organizations, school-bound reads/commands, absent/expired sessions and live permission revocation including historical replay');
  const expectedReminders = concurrent[0].receipt.followUps.map(f => ({ work_item_id: f.workItemId, organization_id: A.organizationId, school_id: A.schoolId, actor_id: S.principal, operation: 'CREATE', version: 1 }));
  assert.equal(expectedReminders.length, 1); assert.equal(concurrent[0].receipt.followUps[0].kind, 'IDENTITY_REVIEW_UNRESOLVED');
  assert.deepEqual((await sql(`SELECT ${historyColumns} FROM hon.human_work_history ORDER BY work_item_id,version`)).rows, [...historyBefore, ...expectedReminders].sort((a, b) => a.work_item_id.localeCompare(b.work_item_id) || a.version - b.version), 'Only the exact recorded activation reminder may add human work history');
  const adultHistory = await unchanged(() => dates.loadMembershipDateHistory(adultScope));
  assert.equal(adultHistory.membershipId, adultScope.membershipId); assert.equal(adultHistory.state, 'ACTIVE');
  assert.equal(adultHistory.currentPeriod.endDateInclusive, true); assert.equal(adultHistory.currentPeriod.startDate, concurrent[0].receipt.effectivePeriod.startDate);
  const childHistory = await unchanged(() => dates.loadMembershipDateHistory(childScope));
  assert.equal(childHistory.membershipId, childScope.membershipId); assert.equal(childHistory.currentPeriod.startDate, futureDate); assert.equal(childHistory.effectiveStatus, 'SCHEDULED');
  assert.notEqual(adultHistory.membershipId, childHistory.membershipId);
  actor = U; await unchanged(() => assert.rejects(dates.loadMembershipDateHistory(adultScope), e => e instanceof dates.MembershipDatesError && [403,404].includes(e.status))); actor = S;
  pass('CRM adult and separate child activations hand off to actual authorized date history; inclusive current periods, scheduled child status, tenant denial and zero read effects');
  assert.deepEqual(await snapshot(protectedTables), protectedBefore, 'Unexpected financial/consent/entitlement/provider/AI or other unrelated effect');
  pass('every unrelated hon table unchanged, including payment schedules, invoices, payments, agreements, consent, entitlements, providers and AI');
  console.log(JSON.stringify({ evidence: 'ACTUAL_FRONTEND_SIGNED_SESSION_NEST_RESTRICTED_DISPOSABLE_POSTGRES', sourceSha, groups: checks.length, apiMocked: false, identityMocked: false, providerCalls: 0, protectedTables: protectedTables.length, syntheticActivations: 2, paidAccessActivated: false }));
} finally { globalThis.fetch = originalFetch; try { if (app) await app.close(); else await database.onModuleDestroy(); } finally { try { await owner.end(); } finally { if (compiled) await rm(compiled, { recursive: true, force: true }); } } }
