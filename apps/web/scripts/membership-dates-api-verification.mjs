/** Actual web transport -> signed-session Nest controller -> restricted runtime -> guarded disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
import { confirmationFor } from '../../../packages/database/scripts/membership-activation-test-support.mjs';
assert.equal(process.env.HON_CRM_API_TEST, '1');
await requireFlexibleBillingAccountsLocalUrls();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json')), dbRequire = createRequire(resolve(repo, 'packages/database/package.json')), webRequire = createRequire(resolve(repo, 'apps/web/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), pg = dbRequire('pg');
const load = p => import(pathToFileURL(resolve(repo, 'apps/api/dist', p)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js'), { HonIdentityGuard } = await load('foundation/hon-identity.guard.js'), { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { MembershipController } = await load('billing/membership.controller.js'), { MembershipService } = await load('billing/membership.service.js'), guards = await load('billing/membership-activation-human-ui.guard.js'), { BillingAccountService } = await load('billing/billing-account.service.js');
const { MembershipDateRevisionController } = await load('billing/membership-date-revision.controller.js'), { MembershipDateRevisionService } = await load('billing/membership-date-revision.service.js'), { MembershipStatusReportController } = await load('reports/membership-status-report.controller.js');
const database = new RuntimeDatabaseService(), owner = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const session = { mode: 'OIDC', audience: 'hon-e1a-disposable-transport', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
let app; const originalFetch = globalThis.fetch;
try {
  await owner.connect();
  assert.deepEqual((await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0], { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const sql = (q, v = []) => owner.query(q, v), org = randomUUID(), school = randomUUID(), otherSchool = randomUUID(), role = randomUUID();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic E1a organization','Synthetic E1a organization')", [org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Synthetic E1a school',$4,'America/Los_Angeles'),($3,$2,'Other synthetic school',$5,'UTC')", [school, org, otherSchool, `e1a-${school}`, `e1a-${otherSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [org]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'E1A_DELEGATED_STAFF','Synthetic delegated staff')", [role, org]);
  for (const permission of ['billing.membership.activate', 'billing.membership.cancel', 'billing.membership.create', 'billing.account.create', 'billing.membership.read', 'billing.membership.dates.revise', 'billing.membership.dates.retroactive', 'reporting.view']) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  async function staff(atSchool = school) {
    const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `e1a-http-${randomUUID()}`;
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic E1a staff')", [user, subject, `${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Synthetic E1a staff')", [principal, user]);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, atSchool, principal, role]);
    return { subject, principal, grant, context: () => { const requestId = randomUUID(); return { organizationId: org, schoolId: atSchool, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID() }; } };
  }
  const staffOne = await staff(), other = await staff(otherSchool), memberships = new MembershipService(database), accounts = new BillingAccountService(database);
  async function draft(birthDate = '1990-04-05') {
    const person = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic',$4)", [person, org, school, `E1a-${person}`]);
    await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4)', [org, school, person, birthDate]);
    const account = (await accounts.create(staffOne.context(), { responsiblePersonId: person, currency: 'USD' })).account;
    const { membership } = await memberships.createDraft(staffOne.context(), { participantPersonId: person, billingAccountId: account.id, planCode: `E1A-${randomUUID().slice(0, 8)}` });
    return { scope: { organizationId: org, schoolId: school, membershipId: membership.id }, person };
  }
  const module = await Test.createTestingModule({ controllers: [MembershipController, MembershipDateRevisionController, MembershipStatusReportController], providers: [HonIdentityGuard, HonIdentityService, MembershipService, MembershipDateRevisionService, guards.MembershipDatePreviewHumanUiGuard, guards.MembershipDateRevisionHumanUiGuard, guards.MembershipDateHistoryHumanUiGuard, guards.MembershipDateQueueHumanUiGuard, guards.MembershipStatusSummaryHumanUiGuard, guards.MembershipActivationHumanUiGuard, guards.MembershipActivationPreviewHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${app.getHttpServer().address().port}`; process.env.HON_PUBLIC_ORIGIN = origin;
  const ts = webRequire('typescript'), contractsUrl = pathToFileURL(webRequire.resolve('@hon/contracts')).href;
  const sessionInvalidation = ts.transpileModule(await readFile(resolve(repo, 'apps/web/src/components/session-invalidation.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = ts.transpileModule(await readFile(resolve(repo, 'apps/web/src/components/membership-activation-http.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from\s+['"]@hon\/contracts['"]/g, 'from ' + JSON.stringify(contractsUrl)).replace(/from\s+['"]\.\/session-invalidation['"]/g, 'from ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(sessionInvalidation).toString('base64')));
  const web = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  const dateCompiled = ts.transpileModule(await readFile(resolve(repo, 'apps/web/src/components/membership-dates-http.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from\s+['"]@hon\/contracts['"]/g, 'from ' + JSON.stringify(contractsUrl)).replace(/from\s+['"]\.\/membership-activation-http['"]/g, 'from ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))).replace(/from\s+['"]\.\/session-invalidation['"]/g, 'from ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(sessionInvalidation).toString('base64')));
  const dateWeb = await import('data:text/javascript;base64,' + Buffer.from(dateCompiled).toString('base64'));
  let actor = staffOne, expired = false, loseResponse = false;
  globalThis.fetch = async (path, options) => {
    assert.match(path, /^\/api\/v1\/organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\//);
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session, expired ? 1 : undefined)}`);
    const response = await originalFetch(origin + path.slice(4), { ...options, headers });
    if (loseResponse && path.endsWith('/revisions') && response.status === 200) { loseResponse = false; throw new DOMException('Synthetic lost response after real commit', 'TimeoutError'); }
    return response;
  };
  const separated = (await sql("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r' AND relname ~ '^(saas_|payment|invoice|refund|membership_payment|organization_entitlement|document_ack|agreement|consent|communication_|action_|ai_|school_payment|stripe|provider)' ORDER BY relname")).rows.map(x => x.relname);
  const effects = ['memberships', 'idempotency_records', 'audit_events', 'outbox_events', 'work_items', 'membership_activation_decisions', 'membership_effective_periods', 'membership_activation_follow_ups'];
  async function snapshot(tables) { const result = {}; for (const table of tables) result[table] = (await sql(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h; return result; }
  async function unchanged(work, tables = [...separated, ...effects]) { const before = await snapshot(tables); try { return await work(); } finally { assert.deepEqual(await snapshot(tables), before); } }
  const read = scope => unchanged(() => web.previewMembershipActivation(scope, {}));
  const request = (scope, p) => web.prepareMembershipActivation(scope, confirmationFor(p), randomUUID());
  const rejected = status => error => error instanceof web.MembershipActivationError && error.status === status;

  const a = await draft(), activation = await read(a.scope);
  await web.activateKnownMembership(request(a.scope, activation));
  const start = activation.proposedDates.startDate;
  const addDays = (day, count) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
  const proposed = { changeKind: 'CORRECTION', startDate: start, endDate: addDays(start, 30) };
  const readDates = (input = proposed) => unchanged(() => dateWeb.previewMembershipDates(a.scope, input), [...separated, ...effects, 'membership_date_revisions', 'membership_date_revision_follow_ups']);
  const dateCommand = p => dateWeb.prepareMembershipDateRevision(a.scope, { expectedVersion: p.version, expectedPeriodVersion: p.currentPeriod?.periodVersion ?? null,
    previewDigest: p.previewDigest, changeKind: p.changeKind, startDate: p.proposedDates.startDate, endDate: p.proposedDates.endDate, dateSource: p.proposedDates.dateSource,
    ...(p.proposedDates.dateSource === 'STAFF_ADJUSTED' ? { dateAdjustmentReason: 'Synthetic school verified the exact adjustment.' } : {}),
    acknowledgedWarnings: p.warnings.map(w => w.code), reasonCode: 'DATA_ENTRY_ERROR', reasonText: '학교 현지 날짜를 확인했습니다. Fechas verificadas por el personal.',
    confirmation: 'I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE' }, randomUUID());
  const dateRejected = status => e => e instanceof dateWeb.MembershipDatesError && e.status === status;
  const schoolScope = { organizationId: org, schoolId: school };
  const p = await readDates(); assert.equal(p.canConfirm, true); assert.equal(p.membershipId, a.scope.membershipId);
  const command = dateCommand(p), safe = await snapshot(separated);
  const concurrent = await Promise.all([dateWeb.reviseMembershipDates(command), dateWeb.reviseMembershipDates(command)]);
  assert.deepEqual(concurrent.map(r => r.replayed).sort(), [false, true]); assert.deepEqual(concurrent[0].receipt, concurrent[1].receipt); assert.deepEqual(await snapshot(separated), safe);
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_date_revisions WHERE membership_id=$1', [a.scope.membershipId])).rows[0].n, 1);
  const h = await unchanged(() => dateWeb.loadMembershipDateHistory(a.scope)); assert.equal(h.currentPeriod.periodVersion, 2); assert.equal(h.versions[0].periodVersion, 2); assert.equal(h.versions.at(-1).periodVersion, 1); assert.equal(h.versions[0].reasonText, JSON.parse(command.body).reasonText); assert.equal(concurrent[0].receipt.reasonCode, JSON.parse(command.body).reasonCode);
  await unchanged(() => dateWeb.loadMembershipDateQueue(schoolScope, { limit: 1 }));
  const summary = await unchanged(() => dateWeb.loadMembershipStatusSummary(schoolScope)); assert.equal(summary.lifecycle.ACTIVE, 1);
  const nextPreview = await readDates({ ...proposed, endDate: addDays(start, 31) }), exact = dateCommand(nextPreview); loseResponse = true;
  await assert.rejects(dateWeb.reviseMembershipDates(exact), e => e.uncertain === true);
  await unchanged(async () => assert.equal((await dateWeb.reviseMembershipDates(exact)).replayed, true));
  const stale = dateCommand(await readDates({ ...proposed, endDate: addDays(start, 32) }));
  const freshCommand = dateCommand(await readDates({ ...proposed, endDate: addDays(start, 33) })); await dateWeb.reviseMembershipDates(freshCommand);
  await unchanged(() => assert.rejects(dateWeb.reviseMembershipDates(stale), e => dateRejected(409)(e) && ['VERSION_CONFLICT', 'DATE_REVISION_PREVIEW_STALE'].includes(e.code)));
  actor = other;
  await unchanged(() => assert.rejects(dateWeb.loadMembershipDateHistory(a.scope), dateRejected(403)));
  await unchanged(() => assert.rejects(dateWeb.loadMembershipStatusSummary(schoolScope), dateRejected(403)));
  await unchanged(() => assert.rejects(dateWeb.reviseMembershipDates(command), dateRejected(403)));
  actor = staffOne; expired = true;
  await unchanged(() => assert.rejects(dateWeb.loadMembershipDateHistory(a.scope), dateRejected(401))); expired = false;
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [org]);
  await unchanged(() => assert.rejects(dateWeb.previewMembershipDates(a.scope, proposed), dateRejected(403)));
  await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [org]);
  await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.membership.dates.retroactive'", [role]);
  const retro = await readDates({ ...proposed, startDate: addDays(start, -1) }); assert.equal(retro.canConfirm, false); assert(retro.requiredPermissions.includes('billing.membership.dates.retroactive'));
  await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.membership.dates.revise'", [role]);
  await unchanged(() => assert.rejects(dateWeb.previewMembershipDates(a.scope, proposed), dateRejected(403)));
  await unchanged(() => assert.rejects(dateWeb.reviseMembershipDates(command), dateRejected(403)));
  // Read authority remains independently usable, never converted into revision permission.
  await unchanged(() => dateWeb.loadMembershipDateHistory(a.scope));
  // Fixture-only entitlement suspension above is restored explicitly; compare the other money records byte-for-byte.
  const financialTables = separated.filter(table => table !== 'organization_entitlements');
  assert.deepEqual(await snapshot(financialTables), Object.fromEntries(financialTables.map(table => [table, safe[table]])));
  assert.equal((await sql('SELECT status FROM hon.organization_entitlements WHERE organization_id=$1', [org])).rows[0].status, 'ACTIVE');
  console.log('PASS: actual date frontend transport -> signed-session Nest -> restricted runtime -> guarded disposable PostgreSQL. Zero-effect preview/history/queue/summary; concurrent exact replay; one immutable revision; post-commit lost response/exact retry; stale versions; cross-school, expired session, suspended entitlement and permission revocation including replay; no financial, provider or entitlement effects. Synthetic data only.');
} catch (error) {
  console.error(error instanceof Error ? error.stack : error); throw error;
} finally {
  globalThis.fetch = originalFetch;
  if (app) await app.close(); else await database.onModuleDestroy();
  await owner.end();
}
