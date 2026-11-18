/**
 * Eian family AI proof (E-AI1, 0474) over signed HTTP (HON session cookie -> HonIdentityGuard + Eian guards -> EianController
 * -> EianService -> the existing guarded parent reads and the 0474 definer functions on the restricted runtime role with
 * forced RLS), on the guarded disposable CRM-close fixture only. The provider is an in-process fake; no network call is
 * made and nothing is sent. Synthetic names only.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { EianController, EianAskGuard, EianReadGuard } = await load('eian/eian.controller.js');
const { EianService } = await load('eian/eian.service.js');
const { EIAN_PROVIDER_RUNTIME, EianProviderRuntimeError } = await load('eian/eian-provider-runtime.js');
const { ParentClassBookingService } = await load('families/parent-class-booking.service.js');
const { ParentSchoolBookingService } = await load('families/parent-school-bookings.service.js');
const { ParentBillingViewService } = await load('families/parent-billing-view.service.js');
const { ParentClassPassViewService } = await load('families/parent-classpass-view.service.js');
const { FamilyMessagesService } = await load('families/family-messages.service.js');
const { ParentTestingStatusService } = await load('testing/parent-testing-status.service.js');
const { ParentFamilyKnowledgeService } = await load('knowledge/parent-family-knowledge.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-eian-family-ai', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'coreOrganization', 'school', 'coreSchool', 'family', 'otherFamily', 'coreFamily', 'catalog', 'policy']
  .map((key) => [key, randomUUID()]));
const PREFIX = `eian-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
const one = async (text, values = []) => (await sql(text, values)).rows[0];
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const database = new RuntimeDatabaseService();

/** The fake provider: readiness is switchable; each call runs the next scripted behavior and records exactly what was sent. */
const fake = { ready: 'READY', calls: [], next: [] };
const provider = {
  readiness: (providerId) => providerId === 'OPENROUTER' ? fake.ready : 'UNSUPPORTED_PROVIDER',
  generate: async (input) => {
    fake.calls.push(input);
    const step = fake.next.shift() ?? (() => ({ reply: 'Min-jun is booked for Little Tigers.', screen: 'SCHEDULE', inputTokens: 900, outputTokens: 40, providerCostMicrounits: 50 }));
    return step(input);
  },
};

let app, origin;
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [EianController],
    providers: [HonIdentityGuard, HonIdentityService, EianService, EianAskGuard, EianReadGuard,
      ParentClassBookingService, ParentSchoolBookingService, ParentBillingViewService, ParentClassPassViewService, FamilyMessagesService, ParentTestingStatusService, ParentFamilyKnowledgeService,
      { provide: EIAN_PROVIDER_RUNTIME, useValue: provider }, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(json({ limit: '64kb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function send(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
function call(actor, method, path, { body, key, command = 'parent.eian.ask', headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Hon-Human-Command': command, ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1/parent/eian/${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const status = (actor, options) => call(actor, 'GET', 'status', options);
const ask = (actor, question, key = randomUUID(), options = {}) => call(actor, 'POST', 'turns', { body: { question }, key, ...options });
const readTurn = (actor, id) => call(actor, 'GET', `turns/${id}`);
async function expect(read, code, label) {
  const { status: got, body } = await read;
  assert.equal(got, code, `${label}: expected ${code}, got ${got} ${JSON.stringify(body).slice(0, 400)}`);
  ok(true, label);
  return body;
}
async function refused(read, code, errorCode, label) {
  const body = await expect(read, code, label);
  assert.equal(body.code, errorCode, `${label}: expected ${errorCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: no data`);
}

async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  const orgs = [ids.organization, ids.coreOrganization];
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.hq_ai_routing_candidates WHERE policy_id = $1', [ids.policy]);
    await sql('DELETE FROM hon.hq_ai_routing_policies WHERE policy_id = $1', [ids.policy]);
    await sql('DELETE FROM hon.hq_ai_model_catalog WHERE catalog_id = $1', [ids.catalog]);
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Person')", [user, subject, `${label}-${user.slice(0, 8)}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Person')", [principal, user]);
  return { subject, principal, user };
}
async function grant(actor, family, school, org, level = 'PRIMARY_GUARDIAN') {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [org, school, family, actor.principal, level]);
}
async function child(given, family, school, org) {
  const personId = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Kim')", [personId, org, school, given]);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [org, school, family, personId]);
  await sql("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,'ACTIVE')", [org, school, personId, family]);
}

let PARENT, OTHER, CORE_PARENT, STAFF, NOBODY, HQ;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Eian Org','Eian Org'),($2,'Eian Core Org','Eian Core Org')", [ids.organization, ids.coreOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.coreOrganization]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Eian Dojo',$3,'America/Los_Angeles'),($4,$5,'Eian Core Dojo',$6,'America/Los_Angeles')",
    [ids.school, ids.organization, `eian-${ids.school.slice(0, 8)}`, ids.coreSchool, ids.coreOrganization, `eian-c-${ids.coreSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Kim Family'),($4,$2,$3,'Lee Family'),($5,$6,$7,'Core Family')",
    [ids.family, ids.organization, ids.school, ids.otherFamily, ids.coreFamily, ids.coreOrganization, ids.coreSchool]);
  PARENT = await person('parent'); OTHER = await person('other'); CORE_PARENT = await person('core'); STAFF = await person('staff'); NOBODY = await person('nobody'); HQ = await person('hq');
  await grant(PARENT, ids.family, ids.school, ids.organization);
  await grant(OTHER, ids.otherFamily, ids.school, ids.organization);
  await grant(CORE_PARENT, ids.coreFamily, ids.coreSchool, ids.coreOrganization);
  await child('Min-jun', ids.family, ids.school, ids.organization);
  await child('Otherkid', ids.otherFamily, ids.school, ids.organization);
  const role = randomUUID();
  await sql("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'EIAN_STAFF','Staff',false)", [role, ids.organization]);
  await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')", [role, ids.organization]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [ids.organization, ids.school, STAFF.principal, role]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.dashboard.view']::text[])", [HQ.principal]);
}
async function route() {
  await sql("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Fixture route','HEALTHY',$1) ON CONFLICT(provider_id) DO UPDATE SET state='HEALTHY',credential_secret_ref=excluded.credential_secret_ref", [`hon-secret:${randomUUID()}`]);
  await sql("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/eian-local','Fixture model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [ids.catalog]);
  await sql("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')", [ids.policy, ids.organization, ids.school]);
  await sql('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [ids.policy, ids.catalog]);
}
const turnRow = (id) => one('SELECT * FROM hon.eian_turns WHERE id=$1', [id]);
const turnsOf = async (actor) => Number((await one('SELECT count(*) n FROM hon.eian_turns WHERE requested_by=$1', [actor.principal])).n);

/** Runs SQL on the runtime role inside a rolled-back transaction bound to the parent's verified tenant. */
async function asParent(actor, org, school, work) {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
      set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`,
      [org, school, actor.principal, randomUUID(), actor.subject]);
    return await work((text, values) => runtime.query(text, values));
  } finally { await runtime.query('ROLLBACK'); }
}
async function sqlRefused(work, message, label) {
  await assert.rejects(work, (e) => { assert.equal(e.message, message, `${label}: ${e.message}`); return true; });
  ok(true, label);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Scope: only a signed-in guardian with exactly one live family. Staff, strangers and unsigned callers are refused.
  await refused(status(NOBODY), 403, 'EIAN_FORBIDDEN', 'no family grant');
  await refused(status(STAFF), 403, 'EIAN_FORBIDDEN', 'staff are not parents');
  await refused(ask(STAFF, 'When is class?'), 403, 'EIAN_FORBIDDEN', 'staff cannot ask as a parent');
  const unsigned = await send(new URL(`${origin}/v1/parent/eian/status`), 'GET', { Accept: 'application/json' });
  ok([401, 403].includes(unsigned.status) && !('data' in unsigned.body), 'no session is refused');
  // 2. Reads take no selectors; the ask is a closed body under its own command.
  await refused(call(PARENT, 'GET', `status?familyId=${ids.otherFamily}`), 400, 'EIAN_SELECTORS_NOT_ACCEPTED', 'status selector');
  await refused(status(PARENT, { headers: { 'X-Hon-School-Id': ids.school } }), 403, 'EIAN_READ_ONLY', 'x-hon header on a read');
  await refused(call(PARENT, 'POST', 'turns', { body: { question: 'Hi', familyId: ids.otherFamily }, key: randomUUID() }), 400, 'VALIDATION_FAILED', 'extra body key');
  await refused(call(PARENT, 'POST', 'turns', { body: { question: 'Hi' } }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'key required');
  const wrongCommand = await call(PARENT, 'POST', 'turns', { body: { question: 'Hi' }, key: randomUUID(), command: 'parent.family_messages.send' });
  ok(wrongCommand.status === 403, 'another command header is refused');

  // 3. The gate: HON's own rule. Core is guided only; Complete without a route is guided (NOT_CONFIGURED).
  assert.deepEqual((await expect(status(CORE_PARENT), 200, 'core status')).data, { mode: 'GUIDED', reason: 'NOT_INCLUDED' });
  await refused(ask(CORE_PARENT, 'When is class?'), 503, 'EIAN_AI_UNAVAILABLE', 'core cannot ask');
  ok(await turnsOf(CORE_PARENT) === 0, 'a refused ask writes no turn');
  assert.deepEqual((await expect(status(PARENT), 200, 'no route status')).data, { mode: 'GUIDED', reason: 'NOT_CONFIGURED' });
  await route();
  fake.ready = 'CONFIGURATION_REQUIRED';
  assert.deepEqual((await expect(status(PARENT), 200, 'provider not ready')).data, { mode: 'GUIDED', reason: 'NOT_CONFIGURED' });
  const notReady = (await expect(ask(PARENT, 'When is the next class?'), 201, 'ask while provider not ready')).data;
  ok(notReady.status === 'CONFIGURATION_REQUIRED' && notReady.reason === 'NOT_CONFIGURED' && notReady.reply === null, 'not ready: no call, guided reason');
  ok(fake.calls.length === 0, 'no provider call while not ready');
  ok((await turnRow(notReady.id)).reserved_credits === 0, 'nothing reserved while not ready');
  fake.ready = 'READY';
  assert.deepEqual((await expect(status(PARENT), 200, 'ready status')).data, { mode: 'AI', reason: null });

  // 4. One answer: plan on the parent path, facts from this family only, usage recorded before the answer is shown.
  const key = randomUUID();
  const created = await expect(ask(PARENT, 'When is the next class?', key), 201, 'first answer');
  const turn = created.data;
  ok(created.meta.replayed === false, 'new turn');
  ok(turn.status === 'COMPLETED' && turn.reply === 'Min-jun is booked for Little Tigers.' && turn.screen === 'SCHEDULE', 'answer and closed screen shown');
  ok(fake.calls.length === 1, 'one provider call');
  const sent = fake.calls[0];
  ok(sent.modelId === 'approved/eian-local' && sent.inputBudget === 9000 && sent.outputBudget === 700 && sent.maxCostMicrounits === 20000, 'fixed route and budgets');
  ok(sent.facts.includes('Min-jun') && !sent.facts.includes('Otherkid'), 'facts name this family\'s child and never another family\'s');
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sent.facts) && !/@/.test(sent.facts), 'no uuid or email in the provider input');
  ok(sent.question === 'When is the next class?', 'the question as asked');
  const row = await turnRow(turn.id);
  ok(row.family_id === ids.family && row.requested_by === PARENT.principal && row.reserved_credits === 0 && row.usage_id && /^[a-f0-9]{64}$/.test(row.context_digest), 'turn row');
  const ledger = await one('SELECT * FROM hon.ai_usage_ledger WHERE id=$1', [row.usage_id]);
  ok(ledger.source_invocation_id === turn.id && ledger.spend_class === 'AGENT_INFERENCE' && Number(ledger.customer_credits) === 1 && ledger.initiator_principal_id === PARENT.principal, 'one ledger row for the turn');
  const plan = await one('SELECT * FROM hon.ai_invocation_plans WHERE id=$1', [row.plan_id]);
  ok(plan.agent_key === 'eian' && plan.task_class === 'SUMMARIZE' && plan.work_item_id === row.work_item_id && plan.route_selection, 'plan row on the turn\'s work item');
  const audit = await one("SELECT source, actor_principal_id FROM hon.audit_events WHERE entity_id=$1 AND action_code='ai.invocation.plan'", [row.plan_id]);
  ok(audit.source === 'HUMAN_UI' && audit.actor_principal_id === PARENT.principal, 'plan audited as the parent');

  // 5. Replay never plans or calls again; a different question under the key is refused; reads are the parent's own.
  const replay = await expect(ask(PARENT, 'When is the next class?', key), 200, 'replay');
  ok(replay.meta.replayed === true && replay.data.id === turn.id && fake.calls.length === 1, 'replay: same turn, no call');
  await refused(ask(PARENT, 'Something else?', key), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reuse');
  ok((await expect(readTurn(PARENT, turn.id), 200, 'read own turn')).data.reply === turn.reply, 'read own turn');
  await refused(readTurn(OTHER, turn.id), 404, 'EIAN_TURN_NOT_FOUND', 'another family cannot read it');

  // 6. Outcomes: UNKNOWN keeps the hold for HQ; an answer over budget is recorded but never shown; unavailable releases.
  fake.next.push(() => { throw new EianProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN'); });
  const unknown = (await expect(ask(PARENT, 'Is there class on Friday?'), 201, 'unknown')).data;
  const unknownRow = await turnRow(unknown.id);
  ok(unknown.status === 'UNKNOWN' && unknown.reason === 'OUTCOME_UNKNOWN' && unknown.reply === null && unknownRow.reserved_credits > 0 && unknownRow.held_at, 'UNKNOWN keeps its hold');
  ok(Number((await one('SELECT hon.ai_org_committed_credits($1,clock_timestamp()) c', [ids.organization])).c) >= unknownRow.reserved_credits, 'the hold counts against the school budget');
  fake.next.push(() => ({ reply: 'Too long', inputTokens: 900, outputTokens: 701, providerCostMicrounits: 10 }));
  const over = (await expect(ask(PARENT, 'Tell me everything.'), 201, 'over budget')).data;
  const overRow = await turnRow(over.id);
  ok(over.status === 'FAILED' && over.reply === null && overRow.usage_id && overRow.reply_text === null && overRow.reserved_credits === 0, 'over budget: recorded, never shown');
  fake.next.push(() => { throw new EianProviderRuntimeError('FAILED', 'PROVIDER_UNAVAILABLE'); });
  const down = (await expect(ask(PARENT, 'Model down?'), 201, 'unavailable')).data;
  ok(down.status === 'FAILED' && (await turnRow(down.id)).reserved_credits === 0 && (await turnRow(down.id)).usage_id === null, 'unavailable: released, nothing charged');

  // 7. HQ sees the unknown Eian turn and Eian usage under its own agent.
  const queue = (await runtime.query('SELECT hon.read_ai_unknown_invocations_from_hq($1) d', [HQ.subject])).rows[0].d;
  ok(queue.open.some((o) => o.agent === 'EIAN' && o.invocationId === unknown.id), 'unknown Eian turn in the HQ queue');
  const usage = (await runtime.query("SELECT hon.read_ai_school_usage_from_hq($1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 hour') d", [HQ.subject])).rows[0].d;
  const school = usage.schools.find((s) => s.schoolId === ids.school);
  ok(school && school.byClass.AGENT_INFERENCE.byAgent.EIAN.entries >= 2 && school.unreconciledInvocations >= 1, 'HQ usage attributes Eian');
  const resolved = (await runtime.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3,$4::jsonb,$5,$6,$7) d', [HQ.subject, 'EIAN', unknown.id,
    JSON.stringify({ decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider log, no charge.', evidence: { providerLookupReference: 'lookup-1' } }), randomUUID(), randomUUID(), randomUUID()])).rows[0].d;
  ok(resolved && (await turnRow(unknown.id)).reserved_credits === 0, 'HQ resolves the Eian hold');

  // 8. A lapse mid-flight: the usage is recorded, the answer is held, and shown again only once access returns.
  fake.next.push((input) => sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization])
    .then(() => ({ reply: 'Held answer.', inputTokens: 800, outputTokens: 20, providerCostMicrounits: 5 })));
  // The lapse also ends the parent scope (0471 checks the live entitlement), so the ask itself is refused afterwards.
  const heldKey = randomUUID();
  await refused(ask(PARENT, 'Do we owe anything?', heldKey), 403, 'EIAN_FORBIDDEN', 'lapse mid-flight: the parent is refused');
  const heldRow = await one('SELECT * FROM hon.eian_turns WHERE requested_by=$1 AND idempotency_key=$2', [PARENT.principal, heldKey]);
  const held = { id: heldRow.id };
  ok(heldRow.status === 'RESULT_HELD' && heldRow.reason === 'ACCESS_LAPSED' && heldRow.usage_id && heldRow.reserved_credits === 0, 'held: usage recorded, hold released, answer kept back');
  await refused(status(PARENT), 403, 'EIAN_FORBIDDEN', 'lapsed status');
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", [ids.organization]);
  const released = (await expect(readTurn(PARENT, held.id), 200, 'read after access returns')).data;
  ok(released.status === 'COMPLETED' && released.reply === 'Held answer.', 'released once access returned, no new call');

  // 9. Database refusals on the runtime role: facts shape, scope binding and plan swap (each rolled back).
  await asParent(PARENT, ids.organization, ids.school, async (q) => {
    const begun = (await q('SELECT hon.begin_eian_turn($1,$2,$3) d', [PARENT.subject, 'Direct?', randomUUID()])).rows[0].d.turn;
    const planned = (await q("SELECT hon.plan_eian_turn($1,$2,current_setting('app.hon_request_id')::uuid,current_setting('app.hon_request_id')::uuid) d", [PARENT.subject, begun.id])).rows[0].d;
    ok(planned.status === 'PLANNED', 'direct plan');
    const scope = { organizationId: ids.organization, schoolId: ids.school, familyId: ids.family };
    for (const [facts, label] of [[{ children: [{ name: 'a@b.example' }] }, 'email'], [{ children: [{ name: ids.family }] }, 'uuid'], [{ children: [{ name: 'A', birthDate: '2015' }] }, 'extra item key'],
      [{ secrets: [] }, 'unknown section'], [{ messages: [{ text: 'x'.repeat(5000) }] }, 'byte cap'], [{ children: Array.from({ length: 11 }, () => ({ name: 'A' })) }, 'section cap']]) {
      await q('SAVEPOINT f');
      await sqlRefused(q('SELECT hon.prepare_eian_turn($1,$2,$3,true,$4::jsonb,$5::jsonb)', [PARENT.subject, begun.id, planned.planId, JSON.stringify(scope), JSON.stringify(facts)]), 'EIAN_FACTS_INVALID', `facts refused: ${label}`);
      await q('ROLLBACK TO SAVEPOINT f');
    }
    for (const bad of [{ ...scope, familyId: ids.otherFamily }, { ...scope, schoolId: ids.coreSchool }, { ...scope, extra: 1 }]) {
      await q('SAVEPOINT s');
      await sqlRefused(q('SELECT hon.prepare_eian_turn($1,$2,$3,true,$4::jsonb,$5::jsonb)', [PARENT.subject, begun.id, planned.planId, JSON.stringify(bad), '{}']), 'EIAN_FORBIDDEN', 'facts bound to another scope');
      await q('ROLLBACK TO SAVEPOINT s');
    }
    await q('SAVEPOINT p');
    await sqlRefused(q('SELECT hon.prepare_eian_turn($1,$2,$3,true,$4::jsonb,$5::jsonb)', [PARENT.subject, begun.id, row.plan_id, JSON.stringify(scope), '{}']), 'EIAN_PLAN_SWAP', 'a plan from another turn');
    await q('ROLLBACK TO SAVEPOINT p');
    const prepared = (await q('SELECT hon.prepare_eian_turn($1,$2,$3,true,$4::jsonb,$5::jsonb) d', [PARENT.subject, begun.id, planned.planId, JSON.stringify(scope), JSON.stringify({ children: [{ name: 'Min-jun' }] })])).rows[0].d;
    ok(prepared && JSON.parse(prepared.facts).family.children[0].name === 'Min-jun' && Object.keys(prepared).sort().join() === 'facts,inputBudget,maxCostMicrounits,modelId,outputBudget,providerId,providerRequestId,question', 'prepare returns only the provider input');
    await q('SAVEPOINT r');
    await sqlRefused(q('SELECT hon.record_eian_turn_result($1,$2,$3::jsonb)', [PARENT.subject, begun.id, JSON.stringify({ reply: 'x', screen: 'PAY_NOW', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 })]), 'INVALID_EIAN_RESULT', 'screen outside the closed list');
    await q('ROLLBACK TO SAVEPOINT r');
    await sqlRefused(q('SELECT hon.read_eian_turn($1,$2)', [OTHER.subject, begun.id]), 'EIAN_FORBIDDEN', 'another parent\'s subject is not this tenant\'s scope');
  });
  const acl = (await runtime.query(`SELECT has_table_privilege(current_user,'hon.eian_turns','SELECT') t,
    has_function_privilege(current_user,'hon.ai_select_text_route(uuid,uuid,uuid,text,text,integer,bigint)','EXECUTE') r,
    has_function_privilege(current_user,'hon.eian_scope(text)','EXECUTE') s, has_function_privilege(current_user,'hon.begin_eian_turn(text,text,text)','EXECUTE') b`)).rows[0];
  ok(!acl.t && !acl.r && !acl.s && acl.b, 'runtime: no table access, no helper access, entry points only');

  // 10. Budget: parents share the school's whole AI budget (D3, no separate cap); the organization ceiling refuses before any call.
  const ceiling = Number((await one('SELECT hon.ai_org_ceiling($1,clock_timestamp()) c', [ids.organization])).c);
  const calls = fake.calls.length;
  ok((await expect(status(PARENT), 200, 'status under the ceiling')).data.mode === 'AI', 'AI before the budget checks');
  const ledgerRow = (credits, source) => sql("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,spend_class,source_invocation_id,correlation_id) VALUES($1,$2,$3,'OPENROUTER','approved/eian-local','TEXT',1,1,0,$4,'AGENT_INFERENCE',$5,gen_random_uuid())",
    [ids.organization, ids.school, PARENT.principal, credits, source]);
  // Parent turns' own recorded usage at 90% of the ceiling: no parent share or cap, so Eian still answers with AI.
  await ledgerRow(Math.floor(ceiling * 0.9), down.id);
  ok((await expect(status(PARENT), 200, 'no parent cap status')).data.mode === 'AI', 'no separate parent cap: AI at 90% of the budget');
  fake.next.push(() => ({ reply: 'Still here.', inputTokens: 10, outputTokens: 5, providerCostMicrounits: 1 }));
  const uncapped = (await expect(ask(PARENT, 'Still answering?'), 201, 'no parent cap ask')).data;
  ok(uncapped.status === 'COMPLETED' && fake.calls.length === calls + 1, 'no separate parent cap: answered with one call');
  await sql('DELETE FROM hon.ai_usage_ledger WHERE organization_id=$1 AND input_units=1 AND output_units=1', [ids.organization]);
  // The organization ceiling itself (staff use up everything).
  await ledgerRow(ceiling, null);
  const full = (await expect(ask(PARENT, 'Ceiling reached?'), 201, 'ceiling reached ask')).data;
  ok(full.status === 'BLOCKED' && full.reason === 'BUDGET_REACHED' && (await turnRow(full.id)).reason === 'CUSTOMER_BUDGET_EXCEEDED' && fake.calls.length === calls + 1, 'ceiling reached: blocked, no call');

  // 11. Burst guard: 20 new questions per guardian per 10 minutes, counted under a lock; replays never count.
  await sql('DELETE FROM hon.ai_usage_ledger WHERE organization_id=$1 AND input_units=1 AND output_units=1', [ids.organization]);
  const used = await turnsOf(PARENT);
  const results = await Promise.all(Array.from({ length: 22 - used }, (_, i) => ask(PARENT, `Burst ${i}?`)));
  const busy = results.filter((r) => r.status === 429 && r.body.code === 'EIAN_BUSY').length;
  ok(await turnsOf(PARENT) === 20, `exactly 20 turns in the window under parallel asks (got ${await turnsOf(PARENT)})`);
  ok(busy === 22 - 20, 'the rest are EIAN_BUSY');
  ok((await expect(ask(PARENT, 'When is the next class?', key), 200, 'replay while busy')).meta.replayed === true, 'a replay is never counted');

  // 12. The canonical 011 section (exact definer flags, search paths, body hashes, ACLs, forced RLS, the four S4 triggers).
  const canonical = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
  const block = canonical.split('-- Eian family AI exact verification (0474)')[1]?.split('-- End Eian family AI exact verification.')[0];
  ok(Boolean(block), '011 section present');
  await sql(block.slice(block.indexOf('\n') + 1).replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE));
  ok(true, '011 section passes on the fixture');

  // 13. Review P2: a crowded family's facts (many small items) are trimmed by the API to the size the database measures
  // (jsonb text), so eian_facts_ok accepts the largest facts the API can build, and both sides agree on the byte count.
  {
    const { buildEianFacts, jsonbTextBytes } = await load('eian/eian-facts.js');
    const { crowdedSources } = apiRequire('./test/eian-facts-fixtures.cjs');
    const crowded = buildEianFacts(crowdedSources());
    const measured = await one('SELECT hon.eian_facts_ok($1::jsonb) ok, octet_length($1::jsonb::text) n', [JSON.stringify(crowded)]);
    ok(measured.n === jsonbTextBytes(crowded), `API and database measure the same jsonb text (${measured.n} bytes)`);
    ok(measured.n > Buffer.byteLength(JSON.stringify(crowded)), 'jsonb text is longer than the compact JSON sent');
    ok(measured.ok === true && crowded.classes?.length > 0, 'the largest facts the API builds are accepted');
    const untrimmed = { ...crowded, knowledge: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, text: 'x'.repeat(400) })) };
    ok((await one('SELECT hon.eian_facts_ok($1::jsonb) ok', [JSON.stringify(untrimmed)])).ok === false, 'facts over the cap are still refused');
  }

  console.log(JSON.stringify({ proof: 'eian-family-ai', checks, providerCalls: fake.calls.length, networkCalls: 0 }));
  console.log(`PASS Eian family AI (0474): ${checks} checks.`);
} finally {
  await app?.close();
  await cleanup().catch(() => null);
  await admin.end(); await runtime.end();
}
