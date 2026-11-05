/** Actual browser transport -> signed HON session -> Nest controllers -> descriptor-bound disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
import { loadSchoolCreateFrontend } from './hq-school-create-frontend-loader.mjs';

assert.equal(process.env.HON_HQ_CREATE_API_TEST, '1');
const urls = await requireFlexibleBillingAccountsLocalUrls(); // Includes private descriptor, exact aliases and external-execution refusal.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
const dbRequire = createRequire(resolve(root, 'packages/database/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), { Client } = dbRequire('pg');
const load = path => import(pathToFileURL(resolve(root, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js'), { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HqController } = await load('hq/hq.controller.js'), { HqOnboardingController } = await load('hq/hq-onboarding.controller.js');
const { HqOnboardingService } = await load('hq/hq-onboarding.service.js'), { HqOverviewService } = await load('hq/hq-overview.service.js');
const { HqSchoolDirectoryService } = await load('hq/hq-school-directory.service.js');
const { HqSchoolProvisioningHumanGuard } = await load('hq/hq-school-provisioning-human.guard.js'); // Requires accepted #141; no legacy fallback.
const database = new RuntimeDatabaseService(), owner = new Client({ connectionString: urls.DATABASE_URL, ssl: false });
const session = { mode: 'OIDC', audience: 'hon-hq-create-disposable-api', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
const realFetch = globalThis.fetch, checks = [], posts = [], created = [], actors = {};
const suffix = randomUUID().replaceAll('-', ''), faultName = 'hq_create_api_fault_' + suffix;
let app, actor = 'owner', postActor = null, alterPostHeaders = null, expired = false, loseNext = false, faultInstalled = false;
const sql = (text, values = []) => owner.query(text, values), pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  await owner.connect();
  const marker = (await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  for (const who of ['owner', 'ownerB', 'operator', 'support', 'staffA', 'staffB']) {
    const a = actors[who] = { user: randomUUID(), principal: randomUUID(), subject: 'hq-create-api-' + who + '-' + randomUUID() };
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic HQ create user')", [a.user, a.subject, a.user + '@example.test']);
    await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Synthetic principal',true)", [a.principal, a.user]);
    if (!who.startsWith('staff')) await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 day')", [a.principal, who.startsWith('owner') ? 'HON_HQ_OWNER' : who === 'operator' ? 'HON_HQ_OPERATOR' : 'HON_HQ_SUPPORT', ['hq.dashboard.view']]);
    else {
      a.org = randomUUID(); a.school = randomUUID(); a.role = randomUUID();
      await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic existing organization','Synthetic existing organization')", [a.org]);
      await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [a.org]);
      await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic existing school',$3)", [a.school, a.org, 'existing-' + a.school]);
      await sql("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [a.role, a.org]);
      await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [a.role, a.org]);
      await sql('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [a.org, a.school, a.principal, a.role]);
    }
  }
  const module = await Test.createTestingModule({ controllers: [HqController, HqOnboardingController], providers: [HonIdentityService, HonIdentityGuard, HqSchoolProvisioningHumanGuard, HqOnboardingService, HqOverviewService, HqSchoolDirectoryService, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1'); const origin = 'http://127.0.0.1:' + app.getHttpServer().address().port; process.env.HON_PUBLIC_ORIGIN = origin;
  const { http, SchoolCreationController, directory } = await loadSchoolCreateFrontend(root);
  globalThis.fetch = async (path, options = {}) => {
    assert.match(path, /^\/api\/v1\/hq\/(?:session|organizations|schools)$/); // No provider or arbitrary network bridge.
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    // Change only the signed browser session at dispatch; the real guard, resolver and database decide authority.
    const sessionActor = options.method === 'POST' ? postActor ?? actor : actor;
    if (sessionActor) headers.set('Cookie', HON_SESSION_COOKIE + '=' + issueSession({ externalSubject: actors[sessionActor].subject }, session, Math.floor(Date.now() / 1000) - (expired ? 43201 : 0)));
    if (options.method === 'POST') {
      assert.equal(headers.get('X-HON-Human-Command'), 'hq-school-provisioning');
      assert(headers.has('X-HON-Expected-Principal'));
      alterPostHeaders?.(headers);
    }
    // Undici writes Sec-Fetch-Mode from Request.mode, as a browser does; keep the negative wire request consistent.
    const mode = headers.get('Sec-Fetch-Mode'); assert(['same-origin', 'cors'].includes(mode));
    const response = await realFetch(origin + path.slice(4), { ...options, mode, headers });
    if (options.method === 'POST') {
      posts.push({ key: headers.get('Idempotency-Key'), expectedPrincipalId: headers.get('X-HON-Expected-Principal'), body: options.body, status: response.status });
      if (loseNext && response.status === 201) { loseNext = false; await response.arrayBuffer(); throw new DOMException('Synthetic lost response after actual commit', 'TimeoutError'); }
    }
    return response;
  };
  const tables = (await sql("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(r => r.tablename);
  const topology = new Set(['organizations', 'schools', 'roles', 'role_permissions', 'principal_role_grants', 'organization_entitlements', 'audit_events', 'outbox_events', 'hq_onboarding_requests']);
  const snapshot = async (exclude = []) => {
    const result = {};
    for (const table of tables) {
      assert.match(table, /^[a-z][a-z0-9_]*$/);
      const column = table === 'organizations' ? 'id' : table === 'hq_onboarding_requests' ? "coalesce(response_body->>'organizationId','')" : 'organization_id';
      const where = topology.has(table) ? ` WHERE ${column} IS NULL OR ${column}::text <> ALL($1::text[])` : '';
      const rows = (await sql(`SELECT to_jsonb(t)::text r FROM hon.${table} t${where} ORDER BY 1`, where ? [exclude] : [])).rows;
      result[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }; // Failures print hashes, never private rows.
    }
    return result;
  };
  const baseline = await snapshot(), form = label => ({ legalName: 'Synthetic ' + label + ' LLC', displayName: 'Synthetic ' + label, schoolName: 'Synthetic ' + label + ' Main', schoolSlug: 'hq-create-' + randomUUID(), timezone: 'America/Los_Angeles' });
  const refused = async (run, status, code) => { const before = await snapshot(); await assert.rejects(run(), error => (status ? error.status === status : error.status >= 400) && (!code || error.code === code)); assert.deepEqual(await snapshot(), before, 'Refused command changed database rows'); };
  const evidence = async (request, receipt) => {
    assert.equal(receipt.actorPrincipalId, request.principalId); assert.equal(receipt.entitlementStatus, 'SUSPENDED');
    const claim = (await sql('SELECT status,request_fingerprint,response_body FROM hon.hq_onboarding_requests WHERE actor_principal_id=$1 AND idempotency_key=$2', [actors.owner.principal, request.key])).rows;
    assert.equal(claim.length, 1); assert.equal(claim[0].status, 'COMPLETED'); assert.equal(claim[0].request_fingerprint, createHash('sha256').update(request.body).digest('hex'));
    assert.deepEqual(claim[0].response_body, { organizationId: receipt.organizationId, schoolId: receipt.schoolId, ownerRoleId: receipt.ownerRoleId, tier: 'COMPLETE', entitlementStatus: 'SUSPENDED', access: 'NONE' });
    assert.deepEqual((await sql('SELECT tier::text,status::text FROM hon.organization_entitlements WHERE organization_id=$1', [receipt.organizationId])).rows, [{ tier: 'COMPLETE', status: 'SUSPENDED' }]);
    const access = (await sql('SELECT hon.saas_organization_access($1) access', [receipt.organizationId])).rows[0].access; assert.deepEqual([access.state, access.source, access.capabilities, access.entitlement.inEffect], ['PROVISIONED', 'NONE', [], false]);
    assert.deepEqual((await sql('SELECT (SELECT count(*)::int FROM hon.schools WHERE organization_id=$1) schools,(SELECT count(*)::int FROM hon.roles WHERE organization_id=$1) roles,(SELECT count(*)::int FROM hon.principal_role_grants WHERE organization_id=$1) grants,(SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1) audits,(SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1) outbox', [receipt.organizationId])).rows[0], { schools: 1, roles: 1, grants: 1, audits: 1, outbox: 1 });
    assert.equal((await sql('SELECT count(*)::int n FROM hon.principal_role_grants WHERE organization_id=$1 AND school_id=$2 AND role_id=$3 AND principal_id=$4 AND granted_by_principal_id=$4', [receipt.organizationId, receipt.schoolId, receipt.ownerRoleId, actors.owner.principal])).rows[0].n, 1);
    assert.equal((await sql("SELECT count(*)::int n FROM hon.audit_events a JOIN hon.outbox_events o ON o.correlation_id=a.correlation_id AND o.causation_id=a.request_id WHERE a.organization_id=$1 AND a.school_id=$2 AND a.actor_principal_id=$3 AND a.action_code='hq.organization.provision' AND a.source='HON_HQ' AND a.result='SUCCEEDED' AND o.event_type='organization.provisioned' AND o.status='PENDING' AND o.attempt_count=0 AND o.published_at IS NULL AND o.payload=a.next_state", [receipt.organizationId, receipt.schoolId, actors.owner.principal])).rows[0].n, 1);
  };
  assert.equal(await http.schoolCreationApi.authorize(new AbortController().signal), actors.owner.principal);
  const guardRequest = http.createSchoolRequest(form('Guard'), actors.owner.principal), beforeGuards = await snapshot();
  for (const [name, value, status] of [
    ['Origin', null, 403], ['Origin', 'https://foreign.example.test', 403],
    ['Sec-Fetch-Site', 'cross-site', 403], ['Sec-Fetch-Mode', 'cors', 403], ['Sec-Fetch-Dest', 'document', 403],
    ['X-HON-Human-Command', null, 403], ['X-HON-Human-Command', 'another-command', 403],
    ['X-HON-Expected-Principal', null, 400], ['X-HON-Expected-Principal', 'unverified', 400],
    ['X-HON-Actor', actors.owner.principal, 403], ['Authorization', 'Bearer synthetic-forbidden', 403],
    ['Idempotency-Key', null, 409],
  ]) {
    alterPostHeaders = headers => value === null ? headers.delete(name) : headers.set(name, value);
    try { await assert.rejects(http.schoolCreationApi.send(guardRequest), error => error.status === status); }
    finally { alterPostHeaders = null; }
  }
  assert.deepEqual(await snapshot(), beforeGuards);
  pass('actual human guard refuses missing/foreign Origin, fetch metadata, marker, expected principal, authority headers and missing key without writes');
  const race = http.createSchoolRequest(form('Race'), actors.owner.principal), receipts = await Promise.all(Array.from({ length: 5 }, () => http.schoolCreationApi.send(race)));
  assert.equal(new Set(receipts.map(r => r.organizationId)).size, 1); assert.equal(receipts.filter(r => !r.replayed).length, 1); created.push(receipts[0].organizationId);
  await evidence(race, receipts[0]); pass('real signed owner, five simultaneous exact-key requests, one suspended school and atomic evidence');
  const workbench = new SchoolCreationController(); workbench.start(); await workbench.authorize();
  for (const [key, value] of Object.entries(form('Lost'))) workbench.edit(key, value);
  workbench.confirm(true); loseNext = true; const postCount = posts.length; await workbench.submit();
  assert(workbench.snapshot().uncertain); assert.equal(posts.length, postCount + 1); await Promise.resolve(); assert.equal(posts.length, postCount + 1);
  const lost = { principalId: actors.owner.principal, key: posts.at(-1).key, body: posts.at(-1).body };
  const beforeMismatch = await snapshot(); postActor = 'ownerB'; workbench.confirm(true); await workbench.submit(); postActor = null;
  assert.deepEqual(await snapshot(), beforeMismatch);
  assert.equal(posts.at(-1).status, 409); assert.equal(posts.at(-1).key, lost.key); assert.equal(posts.at(-1).body, lost.body);
  assert.equal(posts.at(-1).expectedPrincipalId, lost.principalId);
  assert.equal(posts.length, postCount + 2);
  assert.deepEqual([workbench.snapshot().concealed, workbench.snapshot().message, workbench.snapshot().receipt], [true, 'principalChanged', null]);
  actor = 'ownerB'; await workbench.authorize();
  assert.equal(workbench.snapshot().access, 'forbidden'); assert.equal(workbench.snapshot().form.legalName, '');
  workbench.confirm(true); await workbench.submit(); assert.equal(posts.length, postCount + 2);
  actor = 'owner'; workbench.conceal(); await workbench.authorize();
  assert(workbench.snapshot().uncertain); assert(!workbench.snapshot().confirmed);
  workbench.edit('schoolName', 'Replacement refused'); assert.equal(workbench.snapshot().form.schoolName, JSON.parse(lost.body).schoolName);
  await workbench.submit(); assert.equal(posts.length, postCount + 2);
  workbench.confirm(true); await workbench.submit(); const recovered = workbench.snapshot().receipt; assert(recovered?.replayed);
  assert.equal(posts.at(-1).body, lost.body); assert.equal(posts.at(-1).key, lost.key); assert.equal(posts.at(-1).expectedPrincipalId, lost.principalId); created.push(recovered.organizationId); await evidence(lost, recovered); workbench.stop();
  pass('lost actual commit, signed second-owner mismatch without writes, privacy and original-owner restoration retain the exact body/key/principal for explicit replay');
  const currentDirectory = await directory.loadHqSchoolDirectory();
  for (const receipt of [receipts[0], recovered]) assert.equal(currentDirectory.schools.find(s => s.schoolId === receipt.schoolId)?.entitlementTier, null);
  actor = 'operator'; assert.equal(await directory.readHqSchoolDirectoryPrincipal(new AbortController().signal), actors.operator.principal); await directory.loadHqSchoolDirectory(); actor = 'owner';
  pass('real closed directory includes suspended schools without a current tier and retains operator read access');
  for (const who of ['operator', 'support', 'staffA', 'staffB', null]) { actor = who; await refused(() => http.schoolCreationApi.authorize(new AbortController().signal), who ? 403 : 401); await refused(() => http.schoolCreationApi.send(http.createSchoolRequest(form('Denied'), actors.owner.principal)), who ? 403 : 401); }
  actor = 'owner'; expired = true; await refused(() => http.schoolCreationApi.send(race), 401); expired = false;
  await refused(() => http.schoolCreationApi.send({ ...race, principalId: actors.operator.principal }), 409, 'HQ_EXPECTED_PRINCIPAL_MISMATCH');
  await refused(() => http.schoolCreationApi.send({ ...race, key: randomUUID(), body: JSON.stringify({ ...JSON.parse(race.body), organizationId: actors.staffA.org }) }), 400);
  await refused(() => http.schoolCreationApi.send({ ...race, body: JSON.stringify({ ...JSON.parse(race.body), schoolName: 'Different payload' }) }));
  pass('operator/support/two isolated school owners/absent/expired identities, unknown fields and key reuse refuse without claims or effects');
  const rollback = http.createSchoolRequest(form('Rollback'), actors.owner.principal), slug = JSON.parse(rollback.body).schoolSlug;
  await sql(`CREATE FUNCTION hon.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='organization.provisioned' AND EXISTS(SELECT 1 FROM hon.schools WHERE id=NEW.school_id AND slug='${slug}') THEN RAISE EXCEPTION 'Synthetic outbox rollback proof'; END IF; RETURN NEW; END $$`);
  faultInstalled = true; await sql(`CREATE TRIGGER ${faultName} BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.${faultName}()`);
  await refused(() => http.schoolCreationApi.send(rollback)); await sql(`DROP TRIGGER ${faultName} ON hon.outbox_events; DROP FUNCTION hon.${faultName}()`); faultInstalled = false;
  const afterRollback = await http.schoolCreationApi.send(rollback); assert(!afterRollback.replayed); created.push(afterRollback.organizationId); await evidence(rollback, afterRollback);
  pass('real outbox failure rolls back topology, entitlement, audit and idempotency claim; identical retry then creates once');
  assert.deepEqual(await snapshot(created), baseline, 'Existing topology, family, billing, AI, financial and other domain rows changed');
  for (const table of ['saas_access_program', 'saas_credit_program']) assert.deepEqual((await sql(`SELECT status FROM hon.${table}`)).rows, [{ status: 'INACTIVE' }]);
  pass('all other HON table hashes unchanged; new entitlements suspended, paid-access and credit programs inactive');
  await sql("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1", [actors.owner.principal]);
  await refused(() => http.schoolCreationApi.authorize(new AbortController().signal), 403); await refused(() => http.schoolCreationApi.send(race), 403);
  pass('live HQ-owner grant expiry refuses even an exact completed-key replay without any database claim');
  console.log(JSON.stringify({ sourceSha: process.env.HON_HQ_SOURCE_SHA, checks: checks.length, signedSession: true, realNest: true, realPostgreSQL: true, identityMocked: false, apiMocked: false, providerCalls: 0, financialActivation: false, backendHumanGuardVerified: true, expectedPrincipalContract: '141_ACTUAL_GUARD_AND_DATABASE' }));
} finally {
  globalThis.fetch = realFetch;
  try { if (faultInstalled) await sql(`DROP TRIGGER IF EXISTS ${faultName} ON hon.outbox_events; DROP FUNCTION IF EXISTS hon.${faultName}()`); }
  finally { try { if (app) await app.close(); else await database.onModuleDestroy(); } finally { await owner.end(); } }
}
