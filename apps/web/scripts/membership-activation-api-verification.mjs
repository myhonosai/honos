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
  for (const permission of ['billing.membership.activate', 'billing.membership.cancel', 'billing.membership.create', 'billing.account.create']) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
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
  const module = await Test.createTestingModule({ controllers: [MembershipController], providers: [HonIdentityGuard, HonIdentityService, MembershipService, guards.MembershipActivationHumanUiGuard, guards.MembershipActivationPreviewHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${app.getHttpServer().address().port}`; process.env.HON_PUBLIC_ORIGIN = origin;
  const ts = webRequire('typescript'), contractsUrl = pathToFileURL(webRequire.resolve('@hon/contracts')).href;
  const compiled = ts.transpileModule(await readFile(resolve(repo, 'apps/web/src/components/membership-activation-http.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from\s+['"]@hon\/contracts['"]/g, 'from ' + JSON.stringify(contractsUrl));
  const web = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  let actor = staffOne, expired = false, loseResponse = false;
  globalThis.fetch = async (path, options) => {
    assert.match(path, /^\/api\/v1\/organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/billing\/memberships\/[a-f0-9-]+\/(?:activation-context|activation-preview|activate)$/);
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session, expired ? 1 : undefined)}`);
    const response = await originalFetch(origin + path.slice(4), { ...options, headers });
    if (loseResponse && path.endsWith('/activate') && response.status === 200) { loseResponse = false; throw new DOMException('Synthetic lost response after real commit', 'TimeoutError'); }
    return response;
  };
  const separated = (await sql("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r' AND relname ~ '^(saas_|payment|invoice|refund|membership_payment|organization_entitlement|document_ack|agreement|consent|communication_|action_|ai_|school_payment|stripe|provider)' ORDER BY relname")).rows.map(x => x.relname);
  const effects = ['memberships', 'idempotency_records', 'audit_events', 'outbox_events', 'work_items', 'membership_activation_decisions', 'membership_effective_periods', 'membership_activation_follow_ups'];
  async function snapshot(tables) { return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await sql(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h]))); }
  async function unchanged(work, tables = [...separated, ...effects]) { const before = await snapshot(tables); try { return await work(); } finally { assert.deepEqual(await snapshot(tables), before); } }
  const read = scope => unchanged(() => web.previewMembershipActivation(scope, {}));
  const request = (scope, p) => web.prepareMembershipActivation(scope, confirmationFor(p), randomUUID());
  const rejected = status => error => error instanceof web.MembershipActivationError && error.status === status;

  const a = await draft(), p = await read(a.scope); assert.equal(p.state, 'DRAFT'); assert.equal(p.schoolTimezone, 'America/Los_Angeles');
  const command = request(a.scope, p), safeBefore = await snapshot(separated);
  const simultaneous = await Promise.all([web.activateKnownMembership(command), web.activateKnownMembership(command)]);
  assert.deepEqual(simultaneous.map(r => r.replayed).sort(), [false, true]); assert.deepEqual(simultaneous[0].receipt, simultaneous[1].receipt); assert.deepEqual(await snapshot(separated), safeBefore);
  await unchanged(() => web.activateKnownMembership(command)); assert.equal((await web.loadMembershipActivationContext(a.scope)).state, 'ACTIVE');
  assert.equal((await sql('SELECT count(*)::int n FROM hon.membership_activation_decisions WHERE membership_id=$1', [a.scope.membershipId])).rows[0].n, 1);
  const b = await draft(null), birth = await read(b.scope); assert(birth.warnings.some(w => w.code === 'BIRTH_DATE_MISSING')); assert.equal(birth.blocks.length, 0);
  const unknownRequest = request(b.scope, birth); loseResponse = true;
  await assert.rejects(web.activateKnownMembership(unknownRequest), e => e instanceof web.MembershipActivationError && e.uncertain);
  const exactReplay = await unchanged(() => web.activateKnownMembership(unknownRequest)); assert.equal(exactReplay.replayed, true); assert(exactReplay.receipt.followUps.some(x => x.kind === 'BIRTH_DATE_MISSING'));
  const c = await draft(), earlier = await read(c.scope), stale = request(c.scope, earlier);
  await sql('UPDATE hon.people SET given_name=$2 WHERE id=$1', [c.person, 'Changed synthetic name']);
  await unchanged(() => assert.rejects(web.activateKnownMembership(stale), e => rejected(409)(e) && e.code === 'ACTIVATION_PREVIEW_STALE'));
  const minor = await draft('2018-04-05'), minorPreview = await read(minor.scope); assert(minorPreview.blocks.some(x => x.code === 'MINOR_GUARDIAN_OF_RECORD_REQUIRED'));
  actor = other; await unchanged(() => assert.rejects(web.previewMembershipActivation(c.scope, {}), rejected(403)));
  actor = staffOne; expired = true; await unchanged(() => assert.rejects(web.previewMembershipActivation(c.scope, {}), rejected(401))); expired = false;
  actor = null; await unchanged(() => assert.rejects(web.previewMembershipActivation(c.scope, {}), rejected(401))); actor = staffOne;
  const fresh = await read(c.scope), revoked = request(c.scope, fresh);
  await sql("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.membership.activate'", [role]);
  await unchanged(() => assert.rejects(web.previewMembershipActivation(c.scope, {}), rejected(403)));
  await unchanged(() => assert.rejects(web.activateKnownMembership(revoked), rejected(403)));
  await unchanged(() => assert.rejects(web.activateKnownMembership(command), rejected(403)));
  console.log('PASS: E1a actual frontend transport -> real signed-session Nest -> restricted-runtime disposable PostgreSQL. Delegated staff preview and confirmation, zero-effect preview, concurrent same-key replay with one decision, post-commit lost response/exact replay, missing-birth reminder, minor guard, stale facts, cross-school, expired/absent session, live permission revocation including replay, and zero financial/entitlement/provider effects. Synthetic data only; not production or a browser mock.');
} finally { globalThis.fetch = originalFetch; if (app) await app.close(); await database.onModuleDestroy(); await owner.end(); }
