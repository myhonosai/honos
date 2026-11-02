/** Actual frontend HTTP modules -> signed HON sessions -> merged Nest backend -> guarded disposable PostgreSQL.
 * Browser rendering uses separate synthetic evidence. This proof never changes production backend files. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { issueSession, HON_SESSION_COOKIE, SESSION_SECONDS } from '@hon/auth';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';

const BACKEND_FOUNDATION_SHA = 'dce550e7c286dcf34a8ca6beb175b39289f7c69e';
assert.equal(process.env.HON_CRM_TRIAL_RECOVERY_API_TEST, '1');
const urls = await requireFlexibleBillingAccountsLocalUrls(); // Exact aliases, marked private descriptor, no external credentials.
const front = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Both sides are built from this exact reconciled PR checkout; no alternate backend path or credentials.
const back = front;
const sha = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const frontendSha = sha(front); assert.match(frontendSha, /^[0-9a-f]{40}$/);
assert.equal(frontendSha, process.env.HON_CRM_TRIAL_RECOVERY_FRONTEND_SHA);
assert.equal(sha(back), frontendSha);
const apiRequire = createRequire(resolve(back, 'apps/api/package.json')), dbRequire = createRequire(resolve(back, 'packages/database/package.json'));
const webRequire = createRequire(resolve(front, 'apps/web/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), { Client } = dbRequire('pg'), ts = webRequire('typescript');
const classes = {};
for (const file of ['foundation/runtime-database.service.js', 'foundation/identity.controller.js', 'foundation/hon-identity.guard.js', 'foundation/hon-identity.service.js', 'crm/lead.controller.js', 'crm/lead.service.js', 'crm/lead-create-human-ui.guard.js', 'crm/trial-appointment.controller.js', 'crm/trial-appointment-read.controller.js', 'crm/trial-appointment.service.js', 'crm/trial-appointment-human-ui.guard.js', 'crm/trial-appointment-outcome.controller.js', 'crm/trial-appointment-outcome.service.js']) Object.assign(classes, await import(pathToFileURL(resolve(back, 'apps/api/dist', file)).href));
const owner = new Client({ connectionString: urls.DATABASE_URL, ssl: false }), originalFetch = globalThis.fetch, originalNow = Date.now, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const session = { mode: 'OIDC', audience: 'hon-crm-trial-recovery-disposable', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
const checks = [], posts = []; let app, database, proxy, compiled, apiOrigin, browserOrigin, actor, expired = false, loseNext = false;
const sql = (text, values = []) => owner.query(text, values), signal = () => AbortSignal.timeout(15000);
const pass = name => { checks.push(name); console.log('PASS CRM trial recovery: ' + name); };
const allowed = /^\/api\/v1\/organizations\/[0-9a-f-]+\/schools\/[0-9a-f-]+\/crm\/(?:leads(?:\?limit=50|\/[0-9a-f-]+\/trials)|appointments\/[0-9a-f-]+(?:\/outcome)?)$/;
async function boot() {
  database = new classes.RuntimeDatabaseService();
  const controllerNames = ['IdentityController', 'LeadController', 'TrialAppointmentController', 'TrialAppointmentReadController', 'TrialAppointmentOutcomeController'];
  const providerNames = ['HonIdentityService', 'HonIdentityGuard', 'LeadService', 'LeadCreateHumanUiGuard', 'TrialAppointmentService', 'TrialAppointmentOutcomeService', 'TrialAppointmentHumanUiGuard', 'TrialAppointmentReadGuard'];
  const module = await Test.createTestingModule({ controllers: controllerNames.map(n => classes[n]), providers: [...providerNames.map(n => classes[n]), { provide: classes.RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1'); apiOrigin = 'http://127.0.0.1:' + app.getHttpServer().address().port;
}
try {
  await owner.connect();
  assert.deepEqual((await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0], { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  async function school() {
    const s = Object.fromEntries(['organizationId', 'schoolId', 'role', 'user', 'principal', 'grant', 'pipeline', 'stage', 'person', 'leadId'].map(key => [key, randomUUID()])); s.subject = 'trial-recovery-' + randomUUID();
    await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic trial organization','Synthetic trial organization')", [s.organizationId]);
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic trial school',$3)", [s.schoolId, s.organizationId, 'trial-' + s.schoolId]);
    await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [s.organizationId]);
    await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'TRIAL_RECOVERY_STAFF','Synthetic trial staff')", [s.role, s.organizationId]);
    for (const permission of ['crm.lead.read', 'crm.trial.schedule', 'crm.trial.manage']) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [s.role, s.organizationId, permission]);
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic trial staff')", [s.user, s.subject, s.user + '@example.test']);
    await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic trial staff')", [s.principal, s.user]);
    await sql('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [s.grant, s.organizationId, s.schoolId, s.principal, s.role]);
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic trial pipeline')", [s.pipeline, s.organizationId, s.schoolId]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'Open',1)", [s.stage, s.organizationId, s.schoolId, s.pipeline]);
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Trial')", [s.person, s.organizationId, s.schoolId]);
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'OPEN')", [s.leadId, s.organizationId, s.schoolId, s.person, s.pipeline, s.stage]);
    return s;
  }
  const A = await school(), B = await school(), scope = s => ({ organizationId: s.organizationId, schoolId: s.schoolId }); actor = A;
  await boot();
  // A real loopback rewrite keeps response.url at the browser path while forwarding unchanged real API bytes.
  proxy = createServer(async (req, res) => {
    try {
      assert(req.url === '/api/identity/me' || allowed.test(req.url)); let body = ''; for await (const chunk of req) { body += chunk; assert(body.length <= 300000); }
      const headers = new Headers(req.headers); headers.delete('host');
      const upstream = await originalFetch(apiOrigin + (req.url === '/api/identity/me' ? '/v1/identity/me' : req.url.slice(4)), { method: req.method, headers, redirect: 'error', ...(req.method === 'GET' ? {} : { body }) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([key]) => !['connection', 'keep-alive', 'transfer-encoding'].includes(key)))); res.end(bytes);
    } catch { res.destroy(); }
  });
  await new Promise((yes, no) => { proxy.once('error', no); proxy.listen(0, '127.0.0.1', yes); });
  browserOrigin = 'http://127.0.0.1:' + proxy.address().port; process.env.HON_PUBLIC_ORIGIN = browserOrigin;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: browserOrigin } });
  globalThis.fetch = async (path, options = {}) => {
    assert(path === '/api/identity/me' || allowed.test(path));
    const headers = new Headers(options.headers); headers.set('Origin', browserOrigin); headers.set('Sec-Fetch-Site', 'same-origin'); headers.set('Sec-Fetch-Mode', 'same-origin'); headers.set('Sec-Fetch-Dest', 'empty');
    if (actor) headers.set('Cookie', HON_SESSION_COOKIE + '=' + issueSession({ externalSubject: actor.subject }, session, Math.floor(Date.now() / 1000) - (expired ? SESSION_SECONDS + 1 : 0)));
    const response = await originalFetch(browserOrigin + path, { ...options, headers });
    if (options.method === 'POST') { posts.push({ path, body: options.body, key: headers.get('Idempotency-Key'), status: response.status }); if (loseNext && response.status === 201) { loseNext = false; await response.arrayBuffer(); throw new DOMException('Synthetic lost response after actual commit', 'TimeoutError'); } }
    return response;
  };
  compiled = await mkdtemp(join(tmpdir(), 'hon-trial-recovery-')); const cache = new Map();
  async function compile(file) {
    assert(!relative(resolve(front, 'apps/web/src'), file).startsWith('..'));
    if (cache.has(file)) return cache.get(file);
    const destination = join(compiled, createHash('sha256').update(file).digest('hex') + '.mjs'), url = pathToFileURL(destination).href; cache.set(file, url);
    let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const match of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
      const spec = match[1]; let target;
      if (spec.startsWith('.')) target = await compile(resolve(dirname(file), spec + '.ts'));
      else { assert.equal(spec, '@hon/contracts'); target = pathToFileURL(webRequire.resolve(spec)).href; }
      code = code.replace(match[0], 'from ' + JSON.stringify(target));
    }
    await writeFile(destination, code); return url;
  }
  const journey = await import(await compile(resolve(front, 'apps/web/src/components/crm-journey/http.ts')));
  const recovery = await import(await compile(resolve(front, 'apps/web/src/components/crm-journey/trial-recovery-http.ts')));
  const tableNames = (await sql("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(r => r.tablename);
  async function snapshot(excluded = []) {
    const result = {};
    for (const table of tableNames.filter(t => !excluded.includes(t))) { assert.match(table, /^[a-z][a-z0-9_]*$/); const rows = (await sql(`SELECT to_jsonb(t)::text row FROM hon.${table} t ORDER BY 1`)).rows; result[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }; }
    return result;
  }
  async function unchanged(work) { const before = await snapshot(); const result = await work(); assert.deepEqual(await snapshot(), before, 'Read/replay/refusal changed database rows'); return result; }
  const denied = (work, kind, status) => unchanged(() => assert.rejects(work, e => e instanceof journey.JourneyError && e.kind === kind && (status === undefined || e.status === status)));
  const unrelated = ['crm_appointments', 'audit_events', 'outbox_events', 'idempotency_records'], baseline = await snapshot(unrelated);
  const effects = async () => (await sql('SELECT (SELECT count(*)::int FROM hon.crm_appointments) appointments,(SELECT count(*)::int FROM hon.audit_events) audits,(SELECT count(*)::int FROM hon.outbox_events) outbox,(SELECT count(*)::int FROM hon.idempotency_records) claims')).rows[0];
  const initialEffects = await effects();
  const row = (await unchanged(() => journey.readLeads(scope(A), signal()))).find(r => r.id === A.leadId); assert(row);
  await journey.verifyJourneySession(A.subject, signal());
  assert.deepEqual(await unchanged(() => recovery.readTrialRecovery(scope(A), A.leadId, signal())), { activeTrial: null, trials: [] });
  pass('actual signed identity and an empty protected trial read; no mock API or read effects');
  const startsAt = new Date(Date.now() + 3 * 86400000).toISOString(), endsAt = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
  const command = journey.prepareCommand('SCHEDULE', scope(A), row, { startsAt, endsAt, notes: 'Synthetic saved trial; no contact' }, randomUUID());
  loseNext = true; await assert.rejects(() => journey.sendCommand(command, signal()), e => e instanceof journey.JourneyError && e.kind === 'UNKNOWN');
  assert.equal(posts.length, 1); await Promise.resolve(); assert.equal(posts.length, 1);
  const persisted = (await sql('SELECT id FROM hon.crm_appointments WHERE crm_lead_id=$1', [A.leadId])).rows; assert.equal(persisted.length, 1);
  pass('actual committed appointment survives a deliberately lost response without an automatic POST retry');
  await app.close(); app = null; database = null; await boot();
  const saved = await unchanged(() => recovery.readTrialRecovery(scope(A), A.leadId, signal())); assert.equal(saved.activeTrial.id, persisted[0].id);
  const detail = await unchanged(() => recovery.readTrialDetail(scope(A), A.leadId, persisted[0].id, signal())); assert.deepEqual(detail, saved.activeTrial);
  const replays = await unchanged(() => Promise.all([journey.sendCommand(command, signal()), journey.sendCommand(command, signal())])); assert(replays.every(r => r.record.id === detail.id));
  assert.deepEqual((await sql("SELECT (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1 AND idempotency_key=$2) claims,(SELECT count(*)::int FROM hon.audit_events WHERE entity_id=$3 AND action_code='crm.trial.schedule') audits,(SELECT count(*)::int FROM hon.outbox_events WHERE aggregate_id=$3 AND event_type='crm.trial.scheduled' AND published_at IS NULL AND attempt_count=0) outbox", [A.organizationId, command.key, detail.id])).rows[0], { claims: 1, audits: 1, outbox: 1 });
  pass('a new real Nest controller/service instance reads persisted state; concurrent identical retries have one claim/audit/outbox');
  const conflict = journey.prepareCommand('SCHEDULE', scope(A), row, { startsAt: new Date(Date.parse(startsAt) + 86400000).toISOString(), endsAt: new Date(Date.parse(endsAt) + 86400000).toISOString() }, randomUUID());
  async function duplicate() { await unchanged(() => assert.rejects(() => journey.sendCommand(conflict, signal()), e => { assert(e instanceof journey.JourneyError && e.status === 409); assert.equal(recovery.parseTrialConflict(e.trialConflict, A.leadId).id, detail.id); return true; })); }
  await duplicate(); pass('new-key duplicate returns actual 409 current appointment evidence and rolls back its claim');
  // Guarded owner-only upgrade fixture: a preserved active row older than 51 later-created cancelled rows.
  await sql("INSERT INTO hon.crm_appointments(id,organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id,created_at,updated_at) SELECT gen_random_uuid(),$1,$2,$3,'TRIAL','CANCELLED',now()+(g||' days')::interval,now()+(g||' days')::interval+interval '1 hour',$4,clock_timestamp()+(g||' seconds')::interval,clock_timestamp()+(g||' seconds')::interval FROM generate_series(1,51) g", [A.organizationId, A.schoolId, A.leadId, A.principal]);
  const upgraded = await unchanged(() => recovery.readTrialRecovery(scope(A), A.leadId, signal()));
  assert.equal(upgraded.activeTrial.id, detail.id); assert.equal(upgraded.trials.length, 50); assert(upgraded.trials.every(t => t.id !== detail.id && t.status === 'CANCELLED')); await duplicate();
  pass('active trial outside the newest 50 history rows remains independently readable and prevents a replacement');
  Date.now = () => originalNow() + 4 * 86400000;
  try { assert.equal((await unchanged(() => journey.sendCommand(command, signal()))).record.id, detail.id); await denied(() => journey.sendCommand({ ...command, key: randomUUID() }, signal()), 'REJECTED', 400); }
  finally { Date.now = originalNow; }
  assert.equal(posts.at(-2).body, command.body); assert.equal(posts.at(-2).key, command.key);
  assert.equal(posts.at(-2).status, 200);
  pass('synthetic clock advance past start preserves the exact committed-key replay; a new past-window command is refused');
  const outcome = journey.prepareCommand('OUTCOME', scope(A), row, { status: 'COMPLETED', expectedVersion: detail.version }, randomUUID(), detail);
  const completed = await journey.sendCommand(outcome, signal()); assert.equal(completed.record.version, 2);
  assert.equal((await unchanged(() => recovery.readTrialDetail(scope(A), A.leadId, detail.id, signal()))).status, 'COMPLETED');
  assert.equal((await unchanged(() => recovery.readTrialRecovery(scope(A), A.leadId, signal()))).activeTrial, null);
  pass('a recovered current trial supports the real versioned outcome; subsequent detail is current, not the old receipt');
  actor = B;
  await denied(() => recovery.readTrialRecovery(scope(A), A.leadId, signal()), 'DENIED', 403);
  await denied(() => recovery.readTrialDetail(scope(A), A.leadId, detail.id, signal()), 'DENIED', 403);
  await denied(() => recovery.readTrialDetail(scope(B), A.leadId, detail.id, signal()), 'READ', 404);
  await denied(() => journey.sendCommand(command, signal()), 'DENIED', 403);
  assert.deepEqual(await unchanged(() => recovery.readTrialRecovery(scope(B), B.leadId, signal())), { activeTrial: null, trials: [] }); actor = A;
  pass('two independently authorized organizations remain isolated on trial list, detail, and exact replay');
  actor = null; await denied(() => recovery.readTrialRecovery(scope(A), A.leadId, signal()), 'SESSION', 401);
  actor = A; expired = true; await denied(() => recovery.readTrialDetail(scope(A), A.leadId, detail.id, signal()), 'SESSION', 401); expired = false;
  assert.deepEqual(await snapshot(unrelated), baseline, 'Trial recovery changed lead, family, booking, billing, membership, payment, messaging, AI or other domain state');
  const finalEffects = await effects(); for (const [key, increment] of Object.entries({ appointments: 52, audits: 2, outbox: 2, claims: 2 })) assert.equal(finalEffects[key] - initialEffects[key], increment, key + ' has unexpected effects');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [A.grant]);
  await denied(() => recovery.readTrialRecovery(scope(A), A.leadId, signal()), 'DENIED', 403);
  await denied(() => recovery.readTrialDetail(scope(A), A.leadId, detail.id, signal()), 'DENIED', 403);
  await denied(() => journey.sendCommand(command, signal()), 'DENIED', 403);
  pass('absent/expired sessions and a revoked live grant refuse reads/replays with no unauthorized effects');
  console.log(JSON.stringify({ evidence: 'ACTUAL_FRONTEND_SIGNED_SESSION_NEST_DISPOSABLE_POSTGRES', frontendSha, backendSha: frontendSha, backendFoundationSha: BACKEND_FOUNDATION_SHA, checks: checks.length, browserFixtureEvidence: false, identityMocked: false, apiMocked: false, providerCalls: 0, entitlementPolicyChanged: false }));
} finally {
  globalThis.fetch = originalFetch; Date.now = originalNow;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
  try { if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); } }
  finally { try { if (app) await app.close(); else if (database) await database.onModuleDestroy(); } finally { await owner.end(); if (compiled) await rm(compiled, { recursive: true, force: true }); } }
}
