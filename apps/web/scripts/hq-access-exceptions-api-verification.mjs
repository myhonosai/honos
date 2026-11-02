/** Real frontend transport -> signed-session Nest -> restricted, marked disposable PostgreSQL.
 * Synthetic exception approval exists ONLY in this guarded test database. No operational approval. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { issueSession, HON_SESSION_COOKIE, SESSION_SECONDS } from '@hon/auth';
import { syntheticExceptionPolicy } from '../../../packages/database/scripts/exception-policy-fixture.mjs';

assert.equal(process.env.HON_HQ_EXCEPTION_API_TEST, '1');
const ownerUrl = new URL(process.env.DATABASE_URL ?? ''), runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
for (const [url, user] of [[ownerUrl, 'hon_champions_owner'], [runtimeUrl, 'hon_champions_runtime']]) {
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/hon_champions_validation'); assert.equal(url.username, user); assert.equal(url.search, '');
}
assert(!Object.keys(process.env).some(k => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)), 'No provider credentials/activation flags');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json')), webRequire = createRequire(resolve(root, 'apps/web/package.json')), dbRequire = createRequire(resolve(root, 'packages/database/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { Client } = dbRequire('pg'), ts = webRequire('typescript');
const classes = {};
for (const path of ['foundation/runtime-database.service.js', 'foundation/hon-identity.service.js', 'foundation/hon-identity.guard.js', 'hq/hq.controller.js', 'hq/hq-overview.service.js', 'hq/hq-school-directory.service.js', 'saas-billing/saas-billing.service.js', 'saas-billing/saas-billing.controller.js', 'saas-billing/saas-billing.guards.js', 'school-billing/saas-school-billing.service.js', 'school-billing/saas-school-billing.controller.js']) Object.assign(classes, await import(pathToFileURL(resolve(root, 'apps/api/dist', path)).href));
const owner = new Client({ connectionString: ownerUrl.toString(), ssl: false }), database = new classes.RuntimeDatabaseService();
const session = { mode: 'OIDC', audience: 'hon-hq-exceptions-disposable', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
let app, compiled, actor, expired = false, loseNext = false, origin, connected = false;
const originalFetch = globalThis.fetch, posts = [], checks = [];
const sql = (text, values = []) => owner.query(text, values), signal = () => AbortSignal.timeout(15000);
const pass = text => { checks.push(text); console.log('PASS HQ access exceptions: ' + text); };
const allowed = /^\/api\/v1\/hq\/(?:session|saas\/(?:access-exception-policy|organizations\/[a-f0-9-]+\/(?:access-exceptions|subscription)|access-exceptions\/[a-f0-9-]+\/revoke))$/;
try {
  await owner.connect(); connected = true;
  assert.deepEqual((await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0], { owner: 'hon_champions_owner', marker: 'HON disposable Champions Club validation' });
  const actors = {};
  for (const [who, hqRole] of [['owner', 'HON_HQ_OWNER'], ['operator', 'HON_HQ_OPERATOR'], ['school', null], ['otherSchool', null]]) {
    const user = randomUUID(), principal = randomUUID(), subject = 'exceptions-http-' + randomUUID(); actors[who] = { user, principal, subject };
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic HQ exception user')", [user, subject, user + '@example.test']);
    await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic user')", [principal, user]);
    if (hqRole) await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')", [principal, hqRole, ['hq.dashboard.view', 'hq.billing.manage']]);
  }
  const targets = [];
  for (const who of ['school', 'otherSchool']) {
    const target = { organizationId: randomUUID(), schoolId: randomUUID() }, role = randomUUID(); targets.push(target);
    await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic exception organization','Synthetic exception organization')", [target.organizationId]);
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic exception school',$3)", [target.schoolId, target.organizationId, 'exceptions-' + target.schoolId]);
    await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','SUSPENDED',clock_timestamp()-interval '1 day')", [target.organizationId]);
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'EXCEPTION_FIXTURE_OWNER','Synthetic owner')", [role, target.organizationId]);
    for (const permission of ['billing.hon.view', 'billing.hon.purchase']) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, target.organizationId, permission]);
    await sql('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)', [target.organizationId, target.schoolId, actors[who].principal, role]);
  }
  const [A, B] = targets; actor = actors.owner;
  const module = await Test.createTestingModule({ controllers: ['HqController', 'SaasBillingHqController', 'SaasExceptionPolicyHqController', 'SaasAccessExceptionsHqController', 'SaasAccessExceptionCommandsHqController'].map(n => classes[n]), providers: [...['HonIdentityService', 'HonIdentityGuard', 'HqOverviewService', 'HqSchoolDirectoryService', 'SaasBillingService', 'SaasSchoolBillingService', 'SaasCommandGuard', 'SaasReadGuard'].map(n => classes[n]), { provide: classes.RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  origin = 'http://127.0.0.1:' + app.getHttpServer().address().port; process.env.HON_PUBLIC_ORIGIN = origin;
  globalThis.fetch = async (path, options = {}) => {
    assert(allowed.test(path)); assert(!path.endsWith('/access-exception-policy') || options.method === 'GET', 'Frontend cannot approve a policy');
    const headers = new Headers(options.headers); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', HON_SESSION_COOKIE + '=' + issueSession({ externalSubject: actor.subject }, session, Math.floor(Date.now() / 1000) - (expired ? SESSION_SECONDS + 1 : 0)));
    const response = await originalFetch(origin + path.slice(4), { ...options, headers });
    if (options.method === 'POST') { posts.push({ path, body: options.body, key: headers.get('Idempotency-Key'), status: response.status }); if (loseNext && response.status === 200) { loseNext = false; await response.arrayBuffer(); throw new DOMException('Synthetic lost response after actual commit', 'TimeoutError'); } }
    return response;
  };
  compiled = await mkdtemp(join(tmpdir(), 'hon-exception-http-')); const cache = new Map();
  async function compile(file) {
    if (cache.has(file)) return cache.get(file);
    assert(file.startsWith(resolve(root, 'apps/web/src') + '/'));
    const destination = join(compiled, createHash('sha256').update(file).digest('hex') + '.mjs'), url = pathToFileURL(destination).href; cache.set(file, url);
    let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const match of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]) { const spec = match[1]; const target = spec.startsWith('.') ? await compile(resolve(dirname(file), spec + '.ts')) : (assert.equal(spec, '@hon/contracts'), pathToFileURL(webRequire.resolve(spec)).href); code = code.replace(match[0], 'from ' + JSON.stringify(target)); }
    await writeFile(destination, code); return url;
  }
  const { exceptionApi: api, prepareGrant, prepareRevoke, ExceptionError } = await import(await compile(resolve(root, 'apps/web/src/components/hq-access-exceptions/http.ts')));
  const names = (await sql("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(x => x.tablename);
  async function snapshot(except = []) { const result = {}; for (const name of names.filter(n => !except.includes(n))) { assert.match(name, /^[a-z][a-z0-9_]*$/); result[name] = createHash('sha256').update(JSON.stringify((await sql(`SELECT to_jsonb(t)::text row FROM hon.${name} t ORDER BY 1`)).rows)).digest('hex'); } return result; }
  async function unchanged(work) { const before = await snapshot(); const result = await work(); assert.deepEqual(await snapshot(), before, 'Protected read/refusal/replay wrote data'); return result; }
  const input = (target, version = 1) => ({ schoolId: target.schoolId, purpose: 'APPROVED_PILOT', reason: 'DISPOSABLE SYNTHETIC TEST ONLY, not an operational grant', scopeTier: 'COMPLETE', startsAt: new Date(Date.now() + 3600000).toISOString(), expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(), expectedEntitlementVersion: version });
  const denied = (work, status) => unchanged(() => assert.rejects(work, e => e instanceof ExceptionError && e.status === status));
  assert.equal(await unchanged(() => api.owner(signal())), actors.owner.principal);
  const initial = await unchanged(() => api.read(A, signal())); assert.equal(initial.policy.effectiveStatus, 'ABSENT'); assert.equal(initial.exceptions.access.entitlement.status, 'SUSPENDED');
  const otherEntitlement = (await sql('SELECT to_jsonb(e) row FROM hon.organization_entitlements e WHERE organization_id=$1', [B.organizationId])).rows;
  await denied(() => api.send(prepareGrant(actor.principal, A, input(A))), 422);
  pass('actual owner resolver and closed reads have zero effects; absent policy refuses the frontend grant');
  const immutableBefore = await snapshot(['organization_entitlements', 'saas_access_exceptions', 'saas_exception_policy_decisions', 'saas_requests', 'saas_audit', 'saas_outbox']);
  await syntheticExceptionPolicy(owner, module.get(classes.SaasSchoolBillingService), actor.subject, { maxDays: 7 });
  const approved = await unchanged(() => api.read(A, signal())); assert.equal(approved.policy.current.maxDays, 7); assert.equal(approved.policy.termsStatus, 'PROPOSED');
  const request = prepareGrant(actor.principal, A, input(A)); loseNext = true;
  await assert.rejects(() => api.send(request), e => e.name === 'TimeoutError'); assert.equal(posts.filter(p => p.key === request.key).length, 1);
  const receipts = await unchanged(() => Promise.all([api.send(request), api.send(request)])); assert(receipts.every(r => r.kind === 'grant' && r.data.replayed));
  const exception = receipts[0].data.exception; assert.equal(exception.schoolId, A.schoolId); assert.equal(exception.aiCredits, 'NONE'); assert.equal(exception.governingPolicy.maxDays, 7);
  assert(posts.filter(p => p.key === request.key).every(p => p.path === request.path && p.body === request.body));
  const effects = (await sql("SELECT (SELECT count(*)::int FROM hon.saas_requests WHERE actor_principal_id=$1 AND idempotency_key=$2) requests,(SELECT count(*)::int FROM hon.saas_audit WHERE actor_principal_id=$1 AND idempotency_key=$2) audits,(SELECT count(*)::int FROM hon.saas_outbox o JOIN hon.saas_audit a ON a.id=o.audit_id WHERE a.actor_principal_id=$1 AND a.idempotency_key=$2 AND o.payload->>'executionAllowed'='false') outbox", [actor.principal, request.key])).rows[0];
  assert.deepEqual(effects, { requests: 1, audits: 1, outbox: 1 });
  pass('scheduled synthetic exception survives post-commit response loss; concurrent exact replay preserves body/key and one audit/inert-outbox/claim');
  for (const who of ['operator', 'school', 'otherSchool']) { actor = actors[who]; await denied(() => api.owner(signal()), 403); await denied(() => api.send(prepareGrant(actor.principal, B, input(B))), 403); }
  actor = actors.owner; expired = true; await denied(() => api.owner(signal()), 401); await denied(() => api.send(request), 401); expired = false;
  actor = null; await denied(() => api.owner(signal()), 401); actor = actors.owner;
  pass('operator, two independently signed school owners, absent and expired sessions cannot use HQ commands; no loser effects');
  await unchanged(() => assert.rejects(() => api.send(prepareGrant(actor.principal, { organizationId: A.organizationId, schoolId: B.schoolId }, input(B))), e => e instanceof ExceptionError && e.status >= 400));
  await denied(() => api.send(prepareGrant(actor.principal, B, input(B, 99))), 409);
  const tooLong = input(B); tooLong.expiresAt = new Date(Date.now() + 9 * 86400000).toISOString(); await denied(() => api.send(prepareGrant(actor.principal, B, tooLong)), 422);
  pass('foreign-school target, stale entitlement revision and duration beyond the actual approved limit are refused atomically');
  const revoke = prepareRevoke(actor.principal, A, exception.exceptionId, 'DISPOSABLE synthetic pilot ended before any paid conversion');
  const revoked = await api.send(revoke); assert.equal(revoked.kind, 'revoke'); assert.equal(revoked.data.exception.lifecycle, 'REVOKED'); assert.equal(revoked.data.entitlementSuspended, true);
  assert((await unchanged(() => api.send(revoke))).data.replayed); assert.equal((await unchanged(() => api.read(A, signal()))).exceptions.access.entitlement.status, 'SUSPENDED');
  pass('explicit canonical revoke and exact replay restore suspension without invoking paid conversion or billing');
  // A real IAM lock wait: revocation must win before this fresh grant can write.
  const beforeWait = await snapshot(['hq_operator_grants']); const waitRequest = prepareGrant(actor.principal, B, input(B));
  await sql('BEGIN'); await sql('UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1', [actor.principal]);
  const waiter = api.send(waitRequest).then(value => ({ value }), error => ({ error }));
  const pid = (await sql('SELECT pg_backend_pid() pid')).rows[0].pid; let blocked = false;
  for (const end = Date.now() + 7000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) { if ((await sql('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) waiting', [pid])).rows[0].waiting) { blocked = true; break; } }
  await sql('COMMIT'); assert(blocked, 'Command must actually wait on the authorization lock'); const settled = await waiter;
  assert(settled.error instanceof ExceptionError && settled.error.status === 403); assert.deepEqual(await snapshot(['hq_operator_grants']), beforeWait);
  pass('live HQ-owner revocation during an actual PostgreSQL lock wait refuses the grant without entitlement/audit/outbox/idempotency effects');
  assert.deepEqual(await snapshot(['organization_entitlements', 'saas_access_exceptions', 'saas_exception_policy_decisions', 'saas_requests', 'saas_audit', 'saas_outbox', 'hq_operator_grants']), Object.fromEntries(Object.entries(immutableBefore).filter(([name]) => name !== 'hq_operator_grants')));
  const programs = (await sql('SELECT (SELECT status FROM hon.saas_access_program) paid,(SELECT status FROM hon.saas_credit_program) ai,(SELECT status FROM hon.saas_payment_program) payment')).rows[0];
  assert.deepEqual(programs, { paid: 'INACTIVE', ai: 'INACTIVE', payment: 'DISABLED' });
  assert.deepEqual((await sql('SELECT to_jsonb(e) row FROM hon.organization_entitlements e WHERE organization_id=$1', [B.organizationId])).rows, otherEntitlement);
  for (const name of ['saas_credit_allowances', 'saas_credit_ledger', 'ai_usage_ledger']) assert.equal((await sql(`SELECT count(*)::int n FROM hon.${name}`)).rows[0].n, 0);
  pass('all unrelated tables, other organization and financial/AI records preserved; commercial programs remain shipped inactive');
  console.log(JSON.stringify({ sourceSha: process.env.HON_HQ_EXCEPTION_SOURCE_SHA, groups: checks.length, signedSession: true, actualHqResolver: true, realPostgreSQL: true, identityMocked: false, apiMocked: false, syntheticPolicyAndExceptionOnly: true, providerCalls: 0, paidActivation: false, aiCredits: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  if (connected) await sql('ROLLBACK').catch(() => {});
  try { if (app) await app.close(); else await database.onModuleDestroy(); } finally { if (connected) await owner.end(); if (compiled) await rm(compiled, { recursive: true, force: true }); }
}
