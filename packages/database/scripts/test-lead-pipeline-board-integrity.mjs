/**
 * Lead pipeline board proof (0417) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> CrmPipelineBoardController -> protected definer functions on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing sends a message,
 * enrolls, takes a payment or calls AI.
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
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { CrmPipelineBoardController } = await load('crm-pipeline-board/crm-pipeline-board.controller.js');
const { CrmPipelineBoardService } = await load('crm-pipeline-board/crm-pipeline-board.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-lead-board', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [CrmPipelineBoardController],
    providers: [HonIdentityGuard, HonIdentityService, CrmPipelineBoardService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/crm/${path}${query}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: sent }, (response) => {
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
const board = (actor, options = {}) => call(actor, 'GET', 'pipeline-board', options);
const move = (actor, lead, body, options = {}) => call(actor, 'POST', `leads/${lead}/stage`, { body, command: 'crm.lead.stage.move', ...options });
const saveStages = (actor, pipeline, body, options = {}) => call(actor, 'POST', `pipelines/${pipeline}/stages`, { body, command: 'crm.pipeline.stages.save', ...options });
async function success(run, label) {
  const { status, body, headers } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%board-${ids.organization}-%`) {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    // Deferred constraint triggers from the lead attribution snapshot must fire before ALTER TABLE in this transaction.
    await sql('SET CONSTRAINTS ALL IMMEDIATE');
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
    if ((await sql('SELECT count(*)::int n FROM hon.crm_leads WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n) throw new Error('fixture cleanup left a lead behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [subjects]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `board-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Board Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Board Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
async function pipeline(org, school, name, stages) {
  const id = randomUUID();
  await sql('INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,$4)', [id, org, school, name]);
  const out = {};
  for (const [index, [key, label, terminal]] of stages.entries()) {
    out[key] = randomUUID();
    await sql('INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [out[key], org, school, id, label, index + 1, terminal ?? null]);
  }
  return { id, stages: out };
}
async function lead(org, school, pipe, stage, given, { status = 'OPEN', program = null, source = null, created = '1 day' } = {}) {
  const person = randomUUID(), id = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,$5,$6)', [person, org, school, given, 'Synthetic', `${person}@example.test`]);
  await sql(`INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,program_interest_code,source_code,won_at,lost_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status,$8,$9,CASE WHEN $7='WON' THEN now() END,CASE WHEN $7='LOST' THEN now() END,now()-$10::interval)`,
  [id, org, school, person, pipe.id, stage, status, program, source, created]);
  return id;
}

let OWN, FRONT, READER, NONE, MIXED, OTHER_ORG, P, Q, OTHER_P, L;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Board Org','Board Org'),($2,'Board Other Org','Board Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `Board ${slug}`, `board-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  FRONT = await staff('front', [await role(ids.organization, ['crm.lead.read', 'crm.lead.stage.move'])]);
  READER = await staff('reader', [await role(ids.organization, ['crm.lead.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['crm.lead.read', 'crm.lead.stage.move', 'crm.pipeline.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  P = await pipeline(ids.organization, ids.schoolA, 'New students', [['lead', 'Lead'], ['booked', 'Appointment booked'], ['showed', 'Showed'], ['won', 'Enrolled', 'WON'], ['lost', 'Not now', 'LOST']]);
  Q = await pipeline(ids.organization, ids.schoolA, 'Second', [['first', 'First']]);
  OTHER_P = await pipeline(ids.otherOrganization, ids.otherSchool, 'Other', [['x', 'X']]);
  L = {
    a: await lead(ids.organization, ids.schoolA, P, P.stages.lead, 'Ava', { program: 'Tiny Tigers', source: 'facebook', created: '1 hour' }),
    b: await lead(ids.organization, ids.schoolA, P, P.stages.lead, 'Ben', { program: 'Kids', source: 'website', created: '2 hours' }),
    c: await lead(ids.organization, ids.schoolA, P, P.stages.booked, 'Cal', { program: 'Kids', created: '3 hours' }),
    won: await lead(ids.organization, ids.schoolA, P, P.stages.won, 'Wendy', { status: 'WON' }),
    lost: await lead(ids.organization, ids.schoolA, P, P.stages.lost, 'Lou', { status: 'LOST' }),
    q: await lead(ids.organization, ids.schoolA, Q, Q.stages.first, 'Quinn'),
    other: await lead(ids.otherOrganization, ids.otherSchool, OTHER_P, OTHER_P.stages.x, 'Olly'),
  };
  await sql("INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id) VALUES($1,$2,$3,'TRIAL','SCHEDULED',now()+interval '2 days',now()+interval '2 days 1 hour',$4)",
    [ids.organization, ids.schoolA, L.c, OWN.principal]);
  // 0662 text opt-out: Ben opted out of texts; Ava opted out of email only; Cal opted in to texts.
  for (const [leadId, channel, status] of [[L.b, 'SMS', 'OPTED_OUT'], [L.a, 'EMAIL', 'OPTED_OUT'], [L.c, 'SMS', 'OPTED_IN']]) {
    await sql(`INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id)
      SELECT organization_id,school_id,primary_person_id,$2::hon.communication_consent_channel,$3::hon.communication_consent_status,'STAFF',now(),$4 FROM hon.crm_leads WHERE id=$1`,
    [leadId, channel, status, OWN.principal]);
  }
}
const version = async (id) => (await sql('SELECT version,pipeline_stage_id FROM hon.crm_leads WHERE id=$1', [id])).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission and grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='crm.lead.stage.move' AND NOT is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'crm.lead.stage.move is staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='crm.lead.stage.move')`)).rows[0].n === 0, 'every system OWNER role holds it');
  ok((await sql("SELECT count(*)::int n FROM hon.crm_pipeline_stages WHERE terminal_status IS NOT NULL AND hidden_at IS NOT NULL")).rows[0].n === 0, 'no terminal stage is hidden');
  await assert.rejects(sql("UPDATE hon.crm_pipeline_stages SET hidden_at=now() WHERE id=$1", [P.stages.won]), /FIXED_CRM_STAGE_SAVE_REQUIRED|crm_pipeline_stages_terminal_visible/); checks += 1;

  // 1. Board read.
  const open = (await success(() => board(OWN), 'owner board')).data;
  ok(open.pipeline.id === P.id && open.pipelines.length === 2 && open.status === 'OPEN', 'first pipeline by default, both listed');
  ok(open.stages.map((s) => s.name).join('|') === 'Lead|Appointment booked|Showed|Enrolled|Not now', `stage order ${open.stages.map((s) => s.name)}`);
  // Stages inserted after 0417 take the default colour; 0417 only recoloured terminal stages that already existed.
  ok(open.stages.every((s) => s.color === 'BLUE'), 'new stages default to blue');
  ok(open.stages.find((s) => s.id === P.stages.lead).openCount === 2 && open.stages.find((s) => s.id === P.stages.booked).openCount === 1, 'open counts per stage');
  ok(open.totals.open === 3 && open.totals.won === 1 && open.totals.lost === 1, `totals ${JSON.stringify(open.totals)}`);
  ok(open.leads.map((l) => l.givenName).join(',') === 'Ava,Ben,Cal', 'open leads newest first, other pipeline excluded');
  const ava = open.leads[0], cal = open.leads[2];
  ok(ava.programInterestCode === 'Tiny Tigers' && ava.sourceCode === 'facebook' && ava.nextTrialAt === null, 'program and source on the card');
  ok(cal.nextTrialAt !== null && cal.lastTrialAt === null, 'next trial date on the card');
  ok(open.leads.map((l) => l.textOptedOut).join(',') === 'false,true,false', 'text opt-out (0662) only for an SMS OPTED_OUT consent of the same person');
  ok(!JSON.stringify(open).includes('Olly'), 'other organization never shown');
  const closed = (await success(() => board(READER, { query: '?status=CLOSED' }), 'reader closed board')).data;
  ok(closed.leads.map((l) => l.status).sort().join(',') === 'LOST,WON', 'closed shows won and lost');
  const second = (await success(() => board(OWN, { query: `?pipelineId=${Q.id}` }), 'second pipeline')).data;
  ok(second.pipeline.id === Q.id && second.leads.length === 1, 'chosen pipeline');
  await refused(() => board(OWN, { query: `?pipelineId=${OTHER_P.id}` }), 404, 'CRM_PIPELINE_UNAVAILABLE', 'another school\'s pipeline');
  await refused(() => board(OWN, { query: '?status=ARCHIVED' }), 400, 'VALIDATION_FAILED', 'unknown status');
  await refused(() => board(OWN, { query: '?x=1' }), 400, 'VALIDATION_FAILED', 'unknown query');
  await refused(() => board(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => board(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');
  for (const actor of [NONE, MIXED]) await refused(() => board(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => board(OWN, { school: ids.schoolB }), 403, undefined, 'school-A staff at the school-B route');
  await refused(() => board(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other organization at the school-A route');

  // 2. Move a lead.
  const before = await version(L.a);
  await refused(() => move(READER, L.a, { stageId: P.stages.booked, expectedVersion: before.version }), 403, undefined, 'reader cannot move');
  await refused(() => move(MIXED, L.a, { stageId: P.stages.booked, expectedVersion: before.version }), 403, undefined, 'mixed family role cannot move');
  await refused(() => move(FRONT, L.a, { stageId: P.stages.booked, expectedVersion: before.version }, { command: 'crm.pipeline.stages.save' }), 403, 'HUMAN_UI_REQUIRED', 'wrong command header');
  await refused(() => move(FRONT, L.a, { stageId: P.stages.booked, expectedVersion: before.version }, { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  for (const [label, body] of [['missing version', { stageId: P.stages.booked }], ['string version', { stageId: P.stages.booked, expectedVersion: '1' }],
    ['bad stage id', { stageId: 'nope', expectedVersion: 1 }], ['zero version', { stageId: P.stages.booked, expectedVersion: 0 }]]) {
    await refused(() => move(FRONT, L.a, body), 400, undefined, label);
  }
  for (const [label, stage] of [['terminal WON stage', P.stages.won], ['terminal LOST stage', P.stages.lost], ['same stage', P.stages.lead], ['another pipeline\'s stage', Q.stages.first]]) {
    await refused(() => move(FRONT, L.a, { stageId: stage, expectedVersion: before.version }), 400, 'CRM_STAGE_NOT_ALLOWED', label);
  }
  await refused(() => move(FRONT, L.a, { stageId: P.stages.booked, expectedVersion: before.version + 5 }), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => move(FRONT, L.won, { stageId: P.stages.booked, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'a won lead does not move');
  await refused(() => move(FRONT, L.other, { stageId: P.stages.booked, expectedVersion: 1 }), 404, 'CRM_LEAD_UNAVAILABLE', 'other organization lead');
  ok((await version(L.a)).version === before.version, 'no refusal changed the lead');
  const key = randomUUID();
  const moved = await success(() => move(FRONT, L.a, { stageId: P.stages.booked, expectedVersion: before.version }, { key }), 'front desk moves Ava');
  ok(moved.data.fromStageId === P.stages.lead && moved.data.stageId === P.stages.booked && moved.data.version === before.version + 1 && moved.meta.replayed === false, 'move receipt');
  const after = await version(L.a);
  ok(after.pipeline_stage_id === P.stages.booked && after.version === before.version + 1, 'lead moved and versioned');
  const replay = await success(() => move(FRONT, L.a, { stageId: P.stages.booked, expectedVersion: before.version }, { key }), 'exact replay');
  ok(replay.meta.replayed === true && replay.data.movedAt === moved.data.movedAt, 'replay returns the same receipt');
  await refused(() => move(FRONT, L.a, { stageId: P.stages.showed, expectedVersion: before.version }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reuse with another body');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='crm.lead.stage.move' AND source='HUMAN_UI'", [L.a])).rows[0].n === 1, 'one audit event');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='crm.lead.stage_moved'", [L.a])).rows[0].n === 1, 'one outbox event');

  // 3. Guards: nobody changes a stage outside the fixed functions.
  await assert.rejects(sql('UPDATE hon.crm_leads SET pipeline_stage_id=$2,version=version+1 WHERE id=$1', [L.b, P.stages.booked]), /FIXED_CRM_STAGE_MOVE_REQUIRED/); checks += 1;
  await assert.rejects(sql("UPDATE hon.crm_pipeline_stages SET name='Renamed' WHERE id=$1", [P.stages.lead]), /FIXED_CRM_STAGE_SAVE_REQUIRED/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.move_crm_lead_stage('x',gen_random_uuid(),'{}'::jsonb,'k',gen_random_uuid(),gen_random_uuid())"), /VALIDATION_FAILED|CRM_BOARD_FORBIDDEN/); checks += 1;
  for (const helper of ['hon.require_crm_board_actor(text,text)', 'hon.lock_crm_board_actor(text,text)', 'hon.crm_board_stages_json(uuid)']) {
    ok(!(await sql('SELECT has_function_privilege($1,$2::regprocedure,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, helper])).rows[0].x, `${helper} is not runtime-callable`);
  }

  // 4. Save stages.
  const pv = (await success(() => board(OWN), 'reload')).data.pipeline.version;
  const stageItem = (id, name, color = 'BLUE', hidden = false) => ({ id, name, color, hidden });
  const fullList = [stageItem(P.stages.lead, 'Lead'), stageItem(P.stages.booked, 'Appointment booked'), stageItem(P.stages.showed, 'Showed')];
  await refused(() => saveStages(FRONT, P.id, { expectedVersion: pv, stages: fullList, moves: [] }), 403, undefined, 'front desk cannot edit stages');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: fullList.slice(0, 2), moves: [] }), 400, 'CRM_STAGES_MISMATCH', 'a stage left out');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: [...fullList, stageItem(null, 'enrolled')], moves: [] }), 400, 'CRM_STAGE_NAME_TAKEN', 'a name that Won already uses');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: [...fullList, stageItem(null, 'showed')], moves: [] }), 400, 'VALIDATION_FAILED', 'duplicate names');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: fullList.map((s) => ({ ...s, hidden: true })), moves: [] }), 400, 'VALIDATION_FAILED', 'everything hidden');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: [...fullList, stageItem(null, ' padded')], moves: [] }), 400, 'VALIDATION_FAILED', 'padded name');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: [...fullList, stageItem(null, 'x', 'PINK')], moves: [] }), 400, 'VALIDATION_FAILED', 'colour outside the palette');
  const hideBooked = [stageItem(P.stages.lead, 'Lead'), stageItem(P.stages.booked, 'Appointment booked', 'BLUE', true), stageItem(P.stages.showed, 'Showed')];
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: hideBooked, moves: [] }), 400, 'CRM_STAGE_MOVE_REQUIRED', 'hiding a stage with open leads needs a move');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: hideBooked, moves: [{ fromStageId: P.stages.booked, toStageId: P.stages.won }] }), 400, 'CRM_STAGE_MOVE_REQUIRED', 'move into a terminal stage');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: fullList, moves: [{ fromStageId: P.stages.lead, toStageId: P.stages.showed }] }), 400, 'CRM_STAGE_MOVE_REQUIRED', 'a move nobody needs');
  await refused(() => saveStages(OWN, P.id, { expectedVersion: pv + 3, stages: fullList, moves: [] }), 409, 'VERSION_CONFLICT', 'stale pipeline version');
  await refused(() => saveStages(OWN, OTHER_P.id, { expectedVersion: 1, stages: [stageItem(OTHER_P.stages.x, 'X')], moves: [] }), 404, 'CRM_PIPELINE_UNAVAILABLE', 'another organization\'s pipeline');
  const saveKey = randomUUID();
  const newList = [stageItem(P.stages.showed, 'Showed up', 'GREEN'), stageItem(null, 'Touch back later', 'AMBER'), stageItem(P.stages.lead, 'Lead', 'SKY'),
    stageItem(P.stages.booked, 'Appointment booked', 'BLUE', true)];
  const leadsInBooked = (await sql("SELECT array_agg(id ORDER BY id) ids FROM hon.crm_leads WHERE pipeline_stage_id=$1 AND status='OPEN'", [P.stages.booked])).rows[0].ids;
  ok(leadsInBooked.length === 2, 'Ava and Cal are in the booked stage before the save');
  const saved = await success(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: newList, moves: [{ fromStageId: P.stages.booked, toStageId: P.stages.lead }] }, { key: saveKey }), 'owner saves stages');
  ok(saved.data.version === pv + 1 && saved.data.moves[0].count === 2, `save receipt ${JSON.stringify(saved.data.moves)}`);
  ok(saved.data.stages.map((s) => `${s.name}:${s.position}:${s.color}:${s.hidden}`).join('|')
    === 'Showed up:1:GREEN:false|Touch back later:2:AMBER:false|Lead:3:SKY:false|Appointment booked:4:BLUE:true|Enrolled:5:BLUE:false|Not now:6:BLUE:false',
  `new order ${saved.data.stages.map((s) => `${s.name}:${s.position}:${s.color}:${s.hidden}`)}`);
  ok(saved.data.stages.slice(0, 4).map((s) => s.name).join('|') === 'Showed up|Touch back later|Lead|Appointment booked', 'non-terminal stages in the saved order');
  ok(saved.data.stages.slice(4).every((s) => s.terminalStatus !== null), 'Won and Lost stay last');
  for (const id of leadsInBooked) ok((await version(id)).pipeline_stage_id === P.stages.lead, 'leads from the hidden stage moved to Lead');
  const resave = await success(() => saveStages(OWN, P.id, { expectedVersion: pv, stages: newList, moves: [{ fromStageId: P.stages.booked, toStageId: P.stages.lead }] }, { key: saveKey }), 'exact replay of the save');
  ok(resave.meta.replayed === true && resave.data.savedAt === saved.data.savedAt, 'save replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='crm.pipeline.stages.save'", [P.id])).rows[0].n === 1, 'one save audit');
  const afterSave = (await success(() => board(OWN), 'board after save')).data;
  ok(afterSave.stages.find((s) => s.id === P.stages.booked).hidden && afterSave.stages.find((s) => s.id === P.stages.booked).openCount === 0, 'hidden stage is empty');
  await refused(async () => move(FRONT, L.b, { stageId: P.stages.booked, expectedVersion: (await version(L.b)).version }), 400, 'CRM_STAGE_NOT_ALLOWED', 'cannot move into a hidden stage');
  const touch = afterSave.stages.find((s) => s.name === 'Touch back later');
  await success(async () => move(FRONT, L.b, { stageId: touch.id, expectedVersion: (await version(L.b)).version }), 'move into the new stage');

  // 5. Losing the entitlement closes the board.
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]);
  await refused(() => board(OWN), 403, undefined, 'suspended school cannot read the board');
  await refused(async () => move(FRONT, L.b, { stageId: P.stages.lead, expectedVersion: (await version(L.b)).version }), 403, undefined, 'suspended school cannot move');
  await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]);

  // 6. 011 verification section.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- Lead pipeline board exact verification (0417)', end = '-- End lead pipeline board exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: lead pipeline board (0417, 0662 text opt-out): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
