/**
 * Walk-in kiosk proof (0414) over signed HTTP for staff (HON session cookie -> HonIdentityGuard + human UI guards ->
 * WalkInKioskController -> protected definer functions on the restricted runtime role with forced RLS) and over the strict
 * tablet transport (no session -> PublicWalkInKioskController -> the two fixed public functions), on the guarded disposable
 * CRM-close fixture only. Synthetic names and example.test contacts only; nothing is sent or charged.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const { WalkInKioskController, PublicWalkInKioskController } = await load('walk-in-kiosk/walk-in-kiosk.controller.js');
const { WalkInKioskService } = await load('walk-in-kiosk/walk-in-kiosk.service.js');
const { walkInKioskTransport } = await load('walk-in-kiosk/walk-in-kiosk-transport.js');
const { SchoolPayOnceService } = await load('school-payments/school-pay-once.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-walk-in-kiosk', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [WalkInKioskController, PublicWalkInKioskController],
    providers: [HonIdentityGuard, HonIdentityService, WalkInKioskService, { provide: RuntimeDatabaseService, useValue: database },
      // No processor here (0533 card payment has its own proof): the tablet offers the desk only.
      { provide: SchoolPayOnceService, useValue: new SchoolPayOnceService(database, new Map()) }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(walkInKioskTransport());
  app.use(json({ limit: '2mb', strict: true }));
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
const COMMAND = { settings: 'walkin_kiosk.settings.save', start: 'walkin_kiosk.device.start', end: 'walkin_kiosk.device.end', paid: 'walkin_kiosk.visit.desk_paid' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/walk-in-kiosk${path}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(target, method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const overview = (actor, options = {}) => call(actor, 'GET', '', options);
const readSettings = (actor, options = {}) => call(actor, 'GET', '/settings', options);
const saveSettings = (actor, body, options = {}) => call(actor, 'POST', '/settings', { body, command: COMMAND.settings, ...options });
const startDevice = (actor, body, options = {}) => call(actor, 'POST', '/devices', { body, command: COMMAND.start, ...options });
const endDevice = (actor, id, body, options = {}) => call(actor, 'POST', `/devices/${id}/end`, { body, command: COMMAND.end, ...options });
const readVisit = (actor, id, options = {}) => call(actor, 'GET', `/visits/${id}`, options);
const deskPaid = (actor, id, body, options = {}) => call(actor, 'POST', `/visits/${id}/desk-paid`, { body, command: COMMAND.paid, ...options });

function tablet(path, { body, raw, key = randomBytes(18).toString('base64url'), headers = {} } = {}) {
  const sent = { Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...(key ? { 'Idempotency-Key': key } : {}), ...headers };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1/walk-in-kiosk/${path}`), 'POST', sent, raw ?? (body === undefined ? undefined : JSON.stringify(body)));
}
const terminal = (token, options = {}) => tablet('terminal', { body: { device: token }, key: null, ...options });
const submit = (token, visit, options = {}) => tablet('visits', { body: { device: token, visit }, ...options });

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code ?? body.result, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body) && !('firstName' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0286 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('SET CONSTRAINTS ALL IMMEDIATE');
    for (const table of ['walkin_kiosk_rates', 'walkin_visit_participants']) {
      const column = table === 'walkin_kiosk_rates' ? 'device_id' : 'visit_id';
      const parent = table === 'walkin_kiosk_rates' ? 'walkin_kiosk_devices' : 'walkin_visits';
      await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
      await sql(`DELETE FROM hon.${table} WHERE ${column} IN (SELECT id FROM hon.${parent} WHERE organization_id = ANY($1::uuid[]))`, [[ids.organization, ids.otherOrganization]]);
      await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    }
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch (error) { failed += 1; if (pass === 9) console.error('cleanup', table, error.message); await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left walk-ins behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`walkin-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`walkin-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`walkin-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `walkin-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Desk Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Desk Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID(); grants.push(grant);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
  }
  return { subject, principal, org, school, grants };
}
let OWNER, DESK, NONE, MIXED, OTHER_SCHOOL, today, pipeline, stage, otherPipeline, otherStage;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Walk-in Org','Walk-in Org'),($2,'Walk-in Other Org','Walk-in Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Walk-in Dojo ${slug}`, `walkin-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  pipeline = randomUUID(); stage = randomUUID(); otherPipeline = randomUUID(); otherStage = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'New leads'),($4,$2,$5,'School B leads')", [pipeline, ids.organization, ids.schoolA, otherPipeline, ids.schoolB]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1),($5,$2,$6,$7,'New',1)",
    [stage, ids.organization, ids.schoolA, pipeline, otherStage, ids.schoolB, otherPipeline]);
  OWNER = await staff('owner', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run'])]);
  DESK = await staff('desk', [await role(ids.organization, ['walkin_kiosk.run'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'kiosk.terminal.manage', 'classpass.manage'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
}
const WAIVER = { en: 'I understand martial arts training has risks.\nI agree to follow the instructors.', ko: '무술 훈련에는 위험이 있음을 이해합니다.' };
const OFFERS = [
  { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass', ko: '1일 이용권', es: 'Pase de un día' }, description: { en: 'Train with us today.' }, priceMinor: 2500 },
  { key: 'free-trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0 },
];
const goodSettings = () => ({ expectedVersion: 0, enabled: true, waiver: WAIVER, emergencyRequired: true, pipelineId: pipeline, pipelineStageId: stage, offers: OFFERS,
  thankYou: { en: 'Welcome to the dojo!', es: '¡Bienvenidos!' } });
const yearsAgo = (years, days = 0) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const SIGNATURE = [[[10, 10], [200, 120], [400, 90]], [[500, 500], [520, 530]]];
let settingsVersion = 1;
const visitInput = (patch = {}) => ({
  settingsVersion, language: 'en',
  contact: { givenName: 'Alex', familyName: 'Rivera', email: 'alex@example.test', mobile: '+15555550101', birthDate: null, isParticipant: false, adultConfirmed: true },
  children: [{ givenName: 'Sam', familyName: 'Rivera', birthDate: yearsAgo(9) }], relationship: 'PARENT', emergency: { name: 'Jo Rivera', phone: '+15555550102' },
  heardFrom: 'FRIEND', marketingOptIn: false, offerKey: 'free-trial', waiver: { accepted: true, signerName: 'Alex Rivera', strokes: SIGNATURE }, website: '', ...patch,
});
const digest = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Authority: run reads the overview, manage reads and saves settings; nobody else, never cross-school.
  const first = await success(() => overview(DESK), 'overview by desk staff');
  ok(first.data.configured === false && first.data.enabled === false && first.data.canManage === false && first.data.visits.length === 0, 'unconfigured kiosk');
  ok((await success(() => overview(OWNER), 'overview by the owner')).data.canManage === true, 'the owner may manage');
  for (const actor of [NONE, MIXED]) await refused(() => overview(actor), 403, undefined, `overview refused for ${actor.subject.split('-').pop()}`);
  await refused(() => overview(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => readSettings(DESK), 403, undefined, 'settings need walkin_kiosk.manage');
  await refused(() => overview(DESK, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  const choices = await success(() => readSettings(OWNER), 'settings read');
  ok(choices.data.settings === null && choices.data.pipelines.length === 1 && choices.data.pipelines[0].stages[0].stageId === stage, 'only this school\'s pipelines');

  // 2. Settings: closed validation, exact replay, waiver versions.
  await refused(() => saveSettings(DESK, goodSettings()), 403, undefined, 'desk staff cannot change settings');
  for (const [label, patch] of [['no English waiver', { waiver: { ko: 'x' } }], ['empty waiver', { waiver: { en: '' } }], ['waiver too long', { waiver: { en: 'x'.repeat(8001) } }],
    ['angle bracket', { waiver: { en: '<script>' } }], ['unknown language', { waiver: { en: 'x', fr: 'y' } }], ['no offers', { offers: [] }],
    ['seven offers', { offers: Array.from({ length: 7 }, (_, i) => ({ ...OFFERS[0], key: `o${i}` })) }], ['duplicate offer key', { offers: [OFFERS[0], OFFERS[0]] }],
    ['bad offer kind', { offers: [{ ...OFFERS[0], kind: 'MEMBERSHIP' }] }], ['negative price', { offers: [{ ...OFFERS[0], priceMinor: -1 }] }],
    ['price too high', { offers: [{ ...OFFERS[0], priceMinor: 1000001 }] }], ['fractional price', { offers: [{ ...OFFERS[0], priceMinor: 12.5 }] }],
    ['bad offer key', { offers: [{ ...OFFERS[0], key: 'Day Pass' }] }], ['extra key', { automation: true }], ['thank-you multiline', { thankYou: { en: 'a\nb' } }]]) {
    await refused(() => saveSettings(OWNER, { ...goodSettings(), ...patch }), 400, undefined, `settings validation: ${label}`);
  }
  await refused(() => saveSettings(OWNER, { ...goodSettings(), pipelineId: otherPipeline, pipelineStageId: otherStage }), 422, 'WALKIN_KIOSK_PIPELINE_INVALID', 'another school\'s pipeline');
  await refused(() => saveSettings(OWNER, { ...goodSettings(), expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'first save must be version 0');
  const settingsKey = randomUUID();
  const saved = await success(() => saveSettings(OWNER, goodSettings(), { key: settingsKey }), 'save settings');
  ok(saved.meta.replayed === false && saved.data.settings.version === 1 && saved.data.settings.waiverVersion === 1, 'settings v1, waiver v1');
  const replay = await success(() => saveSettings(OWNER, goodSettings(), { key: settingsKey }), 'settings replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(saved.data), 'exact replay');
  await refused(() => saveSettings(OWNER, { ...goodSettings(), emergencyRequired: false }, { key: settingsKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  const renamed = await success(() => saveSettings(OWNER, { ...goodSettings(), expectedVersion: 1, thankYou: { en: 'Thanks!' } }), 'save without a waiver change');
  ok(renamed.data.settings.version === 2 && renamed.data.settings.waiverVersion === 1, 'the waiver version moves only when the waiver changes');
  ok((await sql('SELECT count(*)::int n FROM hon.walkin_waiver_texts WHERE school_id=$1', [ids.schoolA])).rows[0].n === 1, 'one waiver text version');
  settingsVersion = 2;
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE school_id=$1 AND action_code='walkin_kiosk.settings.save' AND actor_principal_id=$2", [ids.schoolA, OWNER.principal])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE school_id=$1 AND event_type='walkin_kiosk.settings_saved' AND payload::text NOT LIKE '%martial%'", [ids.schoolA])).rows[0].n === 2,
  'audit and inert outbox with no waiver text');

  // 3. Tablets: started by run staff, token shown once, digest stored, replay without the token.
  await refused(() => startDevice(NONE, { label: 'Front desk', hours: 8 }), 403, undefined, 'outsider cannot start a tablet');
  for (const [label, body] of [['no label', { label: '', hours: 8 }], ['13 hours', { label: 'Front', hours: 13 }], ['0 hours', { label: 'Front', hours: 0 }],
    ['token from the browser', { label: 'Front', hours: 8, tokenDigest: 'a'.repeat(64) }]]) {
    await refused(() => startDevice(DESK, body), 400, undefined, `start validation: ${label}`);
  }
  const startKey = randomUUID();
  const started = await success(() => startDevice(DESK, { label: 'Front desk', hours: 8 }, { key: startKey }), 'start a tablet');
  const TOKEN = started.data.token, DEVICE = started.data.device;
  ok(/^[A-Za-z0-9_-]{43}$/.test(TOKEN) && DEVICE.live && DEVICE.version === 1, 'a 32-byte token is shown once');
  const stored = (await sql('SELECT token_digest, ends_at-started_at span FROM hon.walkin_kiosk_devices WHERE id=$1', [DEVICE.deviceId])).rows[0];
  ok(stored.token_digest === digest(TOKEN) && stored.span.hours === 8, 'only the digest is stored; 8 hours');
  ok((await sql('SELECT count(*)::int n FROM hon.idempotency_records WHERE response_body::text LIKE $1', [`%${TOKEN}%`])).rows[0].n === 0
    && (await sql('SELECT count(*)::int n FROM hon.audit_events WHERE next_state::text LIKE $1 OR next_state::text LIKE $2', [`%${TOKEN}%`, `%${digest(TOKEN)}%`])).rows[0].n === 0, 'the token and digest are in no receipt or audit row');
  const startReplay = await success(() => startDevice(DESK, { label: 'Front desk', hours: 8 }, { key: startKey }), 'start replay');
  ok(startReplay.meta.replayed === true && startReplay.data.token === null && startReplay.data.device.deviceId === DEVICE.deviceId, 'a replay never repeats the token');

  // 4. Tablet read: school, offers, waiver; one answer for every bad token.
  const read = await success(() => terminal(TOKEN), 'tablet read');
  ok(read.data.schoolName === 'Walk-in Dojo a' && read.data.settingsVersion === 2 && read.data.offers.length === 2 && read.data.waiver.ko === WAIVER.ko && read.data.emergencyRequired === true, 'tablet shows the settings');
  ok(!JSON.stringify(read.data).includes(pipeline) && !JSON.stringify(read.data).includes(ids.schoolA), 'no ids on the tablet');
  for (const [label, token] of [['unknown', randomBytes(32).toString('base64url')], ['short', 'abc'], ['digest instead of token', digest(TOKEN)]]) {
    await refused(() => terminal(token), token.length === 43 ? 404 : 400, token.length === 43 ? 'CLOSED' : 'INVALID', `tablet read: ${label}`);
  }

  // 5. A visit: a parent signs for a child on a free trial.
  const visitKey = randomBytes(18).toString('base64url');
  const recorded = await success(() => submit(TOKEN, visitInput(), { key: visitKey }), 'record a visit', 201);
  ok(recorded.result === 'RECORDED' && recorded.firstName === 'Sam' && recorded.paymentState === 'FREE' && recorded.priceMinor === 0 && recorded.thankYou === 'Thanks!', 'free trial recorded');
  const visit = (await sql('SELECT * FROM hon.walkin_visits WHERE device_id=$1', [DEVICE.deviceId])).rows[0];
  const lead = (await sql('SELECT * FROM hon.crm_leads WHERE id=$1', [visit.lead_id])).rows[0];
  ok(lead.school_id === ids.schoolA && lead.pipeline_id === pipeline && lead.pipeline_stage_id === stage && lead.source_code === 'WALK_IN_KIOSK' && lead.status === 'OPEN', 'one open lead in the chosen stage');
  ok(lead.attribution.walkInKiosk.visitId === visit.id && (await sql('SELECT count(*)::int n FROM hon.crm_lead_attributions WHERE lead_id=$1', [lead.id])).rows[0].n === 1, 'lead attribution recorded');
  const people = (await sql('SELECT p.given_name, p.email::text email, p.phone_e164 FROM hon.people p WHERE p.id=$1 OR p.id IN (SELECT person_id FROM hon.walkin_visit_participants WHERE visit_id=$2) ORDER BY p.given_name', [visit.contact_person_id, visit.id])).rows;
  ok(people.length === 2 && people[0].given_name === 'Alex' && people[0].email === 'alex@example.test' && people[1].given_name === 'Sam' && people[1].email === null, 'contact and child people');
  const signature = (await sql('SELECT * FROM hon.walkin_waiver_signatures WHERE visit_id=$1', [visit.id])).rows[0];
  ok(signature.signer_relationship === 'PARENT' && signature.language === 'en' && signature.waiver_version === 1 && signature.signer_person_id === visit.contact_person_id
    && signature.text_hash === createHash('sha256').update(WAIVER.en, 'utf8').digest('hex') && JSON.stringify(signature.strokes) === JSON.stringify(SIGNATURE), 'signed waiver with the exact text hash and strokes');
  // IC1 (0555): email consent is recorded automatically at intake; texts only with the box ticked.
  const untickedConsents = (await sql("SELECT c.channel, c.status, c.source, k.method FROM hon.communication_consents c JOIN hon.communication_consent_captures k ON k.consent_id=c.id WHERE c.person_id=$1 ORDER BY 1", [visit.contact_person_id])).rows;
  ok(JSON.stringify(untickedConsents) === JSON.stringify([{ channel: 'EMAIL', status: 'OPTED_IN', source: 'RECIPIENT', method: 'WALK_IN_KIOSK' }]), `email automatic, no text opt-in without the box ticked: ${JSON.stringify(untickedConsents)}`);
  const again = await success(() => submit(TOKEN, visitInput(), { key: visitKey }), 'visit retry', 201);
  ok(JSON.stringify(again) === JSON.stringify(recorded) && (await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE device_id=$1', [DEVICE.deviceId])).rows[0].n === 1, 'exact retry: same answer, one visit');
  await refused(() => submit(TOKEN, visitInput({ heardFrom: 'SOCIAL' }), { key: visitKey }), 400, 'INVALID', 'same key, another body');

  // 6. An adult with a child on a paid day pass, in Korean, with opt-in.
  const korean = await success(() => submit(TOKEN, visitInput({ language: 'ko', offerKey: 'day-pass', marketingOptIn: true,
    contact: { givenName: 'Min', familyName: 'Kim', email: 'min@example.test', mobile: '+15555550103', birthDate: yearsAgo(35), isParticipant: true, adultConfirmed: true },
    children: [{ givenName: 'Joon', familyName: 'Kim', birthDate: yearsAgo(17, 1) }], relationship: 'LEGAL_GUARDIAN', waiver: { accepted: true, signerName: 'Min Kim', strokes: SIGNATURE } })),
  'adult and child on a day pass', 201);
  ok(korean.firstName === 'Min' && korean.paymentState === 'PAY_AT_DESK' && korean.priceMinor === 2500 && korean.thankYou === null, 'paid offer is due at the desk');
  const kv = (await sql("SELECT v.*, s.signer_relationship, s.language slang, s.text_hash FROM hon.walkin_visits v JOIN hon.walkin_waiver_signatures s ON s.visit_id=v.id WHERE v.offer_key='day-pass'")).rows[0];
  ok(kv.offer_name === '1일 이용권' && kv.signer_relationship === 'SELF_AND_LEGAL_GUARDIAN' && kv.slang === 'ko' && kv.text_hash === createHash('sha256').update(WAIVER.ko, 'utf8').digest('hex'), 'Korean waiver and offer name');
  ok((await sql("SELECT array_agg(channel::text ORDER BY channel::text) c FROM hon.communication_consents WHERE person_id=$1 AND status='OPTED_IN' AND source='RECIPIENT'", [kv.contact_person_id])).rows[0].c.join() === 'EMAIL,SMS', 'opt-in recorded for email and text');
  const spanish = await success(() => submit(TOKEN, visitInput({ language: 'es', contact: { ...visitInput().contact, email: 'es@example.test', mobile: '' } })), 'Spanish visit', 201);
  ok(spanish.thankYou === null || typeof spanish.thankYou === 'string', 'Spanish answer');
  const esSig = (await sql("SELECT s.language FROM hon.walkin_waiver_signatures s JOIN hon.walkin_visits v ON v.id=s.visit_id WHERE v.language='es'")).rows[0];
  ok(esSig.language === 'en', 'a waiver without Spanish text is signed (and recorded) in English');

  // 7. Tablet input rules.
  for (const [label, patch] of [
    ['minor contact', { contact: { ...visitInput().contact, isParticipant: true, birthDate: yearsAgo(17) }, children: [], relationship: null }],
    ['adult child', { children: [{ givenName: 'Big', familyName: 'Rivera', birthDate: yearsAgo(18) }] }],
    ['nobody training', { children: [], relationship: null }],
    ['children without relationship', { relationship: null }], ['relationship without children', { contact: { ...visitInput().contact, isParticipant: true, birthDate: yearsAgo(30) }, children: [] }],
    ['four children', { children: Array.from({ length: 4 }, () => visitInput().children[0]) }], ['future birth date', { children: [{ givenName: 'Sam', familyName: 'R', birthDate: '2999-01-01' }] }],
    ['impossible date', { children: [{ givenName: 'Sam', familyName: 'R', birthDate: '2020-02-30' }] }], ['no contact way', { contact: { ...visitInput().contact, email: '', mobile: '' } }],
    ['bad mobile', { contact: { ...visitInput().contact, mobile: '5555550101' } }], ['adult not confirmed', { contact: { ...visitInput().contact, adultConfirmed: false } }],
    ['emergency required', { emergency: { name: '', phone: '' } }], ['emergency name without phone', { emergency: { name: 'Jo', phone: '' } }],
    ['unknown offer', { offerKey: 'membership' }], ['waiver not accepted', { waiver: { ...visitInput().waiver, accepted: false } }],
    ['no signature', { waiver: { ...visitInput().waiver, strokes: [] } }], ['one-point signature', { waiver: { ...visitInput().waiver, strokes: [[[1, 1]]] } }],
    ['signature off the pad', { waiver: { ...visitInput().waiver, strokes: [[[1, 1], [1001, 5]]] } }], ['fractional point', { waiver: { ...visitInput().waiver, strokes: [[[1, 1], [2.5, 5]]] } }],
    ['honeypot', { website: 'spam' }], ['unknown language', { language: 'fr' }], ['angle bracket name', { contact: { ...visitInput().contact, givenName: '<b>' } }], ['angle bracket child', { children: [{ givenName: 'Sam', familyName: '<i>R', birthDate: yearsAgo(8) }] }],
    ['angle bracket signer', { waiver: { ...visitInput().waiver, signerName: 'Kim <x>' } }], ['angle bracket emergency', { emergency: { name: '<Jo>', phone: '+15555550199' } }],
    ['extra key', { notes: 'x' }], ['bad heard from', { heardFrom: 'TV' }]]) {
    await refused(() => submit(TOKEN, visitInput(patch)), 400, 'INVALID', `visit validation: ${label}`);
  }
  await refused(() => submit(TOKEN, visitInput({ settingsVersion: 1 })), 409, 'STALE', 'old settings version: reload');
  ok((await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE device_id=$1', [DEVICE.deviceId])).rows[0].n === 3
    && (await sql("SELECT count(*)::int n FROM hon.crm_leads WHERE school_id=$1 AND source_code='WALK_IN_KIOSK'", [ids.schoolA])).rows[0].n === 3, 'refused visits left nothing behind');

  // 8. Staff: overview, visit detail with the signed waiver, desk payment.
  const view = await success(() => overview(DESK), 'overview with visits');
  ok(view.data.configured && view.data.enabled && view.data.visits.length === 3 && view.data.devices.length === 1 && view.data.devices[0].live, 'three walk-ins and one live tablet');
  const paidVisit = view.data.visits.find((v) => v.paymentState === 'PAY_AT_DESK');
  ok(paidVisit.participants.length === 2 && paidVisit.participants[0].isContact && paidVisit.participants[1].isMinor && paidVisit.offer.priceMinor === 2500, 'visit summary');
  const detail = await success(() => readVisit(DESK, paidVisit.visitId), 'visit detail');
  ok(detail.data.waiver.text === WAIVER.ko && detail.data.waiver.relationship === 'SELF_AND_LEGAL_GUARDIAN' && detail.data.waiver.strokes.length === 2, 'signed waiver as signed');
  await refused(() => readVisit(OTHER_SCHOOL, paidVisit.visitId, { school: ids.schoolB }), 404, 'WALKIN_VISIT_NOT_FOUND', 'another school cannot open the visit');
  const freeVisit = view.data.visits.find((v) => v.paymentState === 'FREE');
  await refused(() => deskPaid(DESK, freeVisit.visitId, { expectedVersion: 1, method: 'CASH' }), 409, 'WALKIN_VISIT_NOT_DUE', 'a free visit has nothing to pay');
  await refused(() => deskPaid(DESK, paidVisit.visitId, { expectedVersion: 1, method: 'CHECK' }), 400, undefined, 'unknown desk method');
  await refused(() => deskPaid(DESK, paidVisit.visitId, { expectedVersion: 2, method: 'CASH' }), 409, 'VERSION_CONFLICT', 'stale version');
  const paidKey = randomUUID();
  const paid = await success(() => deskPaid(DESK, paidVisit.visitId, { expectedVersion: 1, method: 'CASH' }, { key: paidKey }), 'paid at the desk');
  ok(paid.data.visit.paymentState === 'PAID_AT_DESK' && paid.data.visit.deskMethod === 'CASH' && paid.data.visit.version === 2, 'paid at the desk');
  ok((await success(() => deskPaid(DESK, paidVisit.visitId, { expectedVersion: 1, method: 'CASH' }, { key: paidKey }), 'desk replay')).meta.replayed === true, 'desk payment replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='walkin_kiosk.visit.desk_paid' AND actor_principal_id=$2", [paidVisit.visitId, DESK.principal])).rows[0].n === 1, 'one desk audit row');

  // 9. The tablet stops: ended by staff, kiosk turned off, or the starter losing walkin_kiosk.run.
  const second = (await success(() => startDevice(OWNER, { label: 'Lobby', hours: 1 }), 'second tablet')).data;
  const third = (await success(() => startDevice(DESK, { label: 'Mat side', hours: 2 }), 'third tablet')).data;
  await refused(() => endDevice(DESK, second.device.deviceId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'end with a stale version');
  ok((await success(() => endDevice(DESK, second.device.deviceId, { expectedVersion: 1 }), 'end a tablet')).data.device.live === false, 'tablet ended');
  await refused(() => endDevice(DESK, second.device.deviceId, { expectedVersion: 2 }), 409, 'WALKIN_KIOSK_DEVICE_ENDED', 'end twice');
  await refused(() => terminal(second.token), 404, 'CLOSED', 'an ended tablet reads nothing');
  await refused(() => submit(second.token, visitInput()), 404, 'CLOSED', 'an ended tablet records nothing');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [DESK.grants[0], OWNER.principal]);
  await refused(() => terminal(third.token), 404, 'CLOSED', 'a tablet stops when its starter loses walkin_kiosk.run');
  await refused(() => overview(DESK), 403, undefined, 'revoked staff refused');
  await sql(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    SELECT organization_id,school_id,principal_id,role_id,$2,clock_timestamp()-interval '1 second' FROM hon.principal_role_grants WHERE id=$1`, [DESK.grants[0], OWNER.principal]);
  ok((await success(() => terminal(third.token), 'tablet back')).data.settingsVersion === 2, 'the tablet works again once the grant is back');
  // 9b. Barrier: a revocation or an entitlement end that is still in flight when a visit arrives decides that visit. The visit
  // waits on its row locks for the change, then sees it and keeps nothing (without the locks it would commit on its old snapshot).
  { const barrier = new pg.Client(targets.owner);
    await barrier.connect();
    const visitsOf = async () => (await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE device_id=$1', [third.device.deviceId])).rows[0].n;
    const peopleOf = async () => (await sql('SELECT count(*)::int n FROM hon.people WHERE school_id=$1', [ids.schoolA])).rows[0].n;
    const waitingOnLock = async () => {
      for (let i = 0; i < 200; i += 1) {
        const n = (await sql('SELECT count(*)::int n FROM pg_locks l WHERE NOT l.granted')).rows[0].n;
        if (n > 0) return true;
        await new Promise((done) => setTimeout(done, 25));
      }
      return false;
    };
    const contact = (n) => ({ contact: { ...visitInput().contact, email: `barrier${n}@example.test`, mobile: `+1555555020${n}` } });
    try {
      for (const [label, change, restore] of [
        ['starter loses walkin_kiosk.run', () => barrier.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1 AND revoked_at IS NULL', [DESK.principal, OWNER.principal]),
          () => sql(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
            SELECT DISTINCT ON (role_id) organization_id,school_id,principal_id,role_id,$2,clock_timestamp()-interval '1 second' FROM hon.principal_role_grants WHERE principal_id=$1`, [DESK.principal, OWNER.principal])],
        ['school entitlement ends', () => barrier.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]),
          () => sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization])]]) {
        const visits = await visitsOf(), people = await peopleOf();
        await barrier.query('BEGIN');
        await change();
        const pending = submit(third.token, visitInput(contact(label.length % 10)));
        ok(await waitingOnLock(), `barrier (${label}): the visit waits for the in-flight change`);
        await barrier.query('COMMIT');
        await refused(() => pending, 404, 'CLOSED', `barrier (${label}): the visit sees the change`);
        ok(await visitsOf() === visits && await peopleOf() === people, `barrier (${label}): no visit, person, lead or waiver kept`);
        await restore();
        ok((await success(() => terminal(third.token), `barrier (${label}): tablet back`)).data.settingsVersion === 2, `barrier (${label}): restored`);
      }
    } finally { await barrier.query('ROLLBACK').catch(() => undefined); await barrier.end(); } }
  await sql("UPDATE hon.walkin_kiosk_devices SET ends_at=started_at+interval '1 second' WHERE id=$1", [third.device.deviceId]).catch(() => undefined);
  await success(() => saveSettings(OWNER, { ...goodSettings(), expectedVersion: 2, enabled: false, waiver: { en: 'New waiver text.' } }), 'turn the kiosk off and change the waiver');
  await refused(() => terminal(TOKEN), 404, 'CLOSED', 'kiosk off: tablet closed');
  await refused(() => startDevice(DESK, { label: 'Again', hours: 1 }), 409, 'WALKIN_KIOSK_OFF', 'no new tablet while off');
  ok((await sql('SELECT array_agg(waiver_version ORDER BY waiver_version) v FROM hon.walkin_waiver_texts WHERE school_id=$1', [ids.schoolA])).rows[0].v.join() === '1,2', 'the old waiver text is kept');
  await success(() => saveSettings(OWNER, { ...goodSettings(), expectedVersion: 3, waiver: { en: 'New waiver text.' } }), 'turn the kiosk on again');
  ok((await success(() => terminal(TOKEN), 'tablet after turning on')).data.waiver.en === 'New waiver text.', 'tablet shows the new waiver');
  const detailAfter = await success(() => readVisit(OWNER, paidVisit.visitId), 'old visit after a waiver change');
  ok(detailAfter.data.waiver.text === WAIVER.ko && detailAfter.data.waiver.version === 1, 'a signed waiver keeps the text it was signed on');
  await sql('UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => terminal(TOKEN), 404, 'CLOSED', 'tablet closed when access lapses');
  await refused(() => overview(OWNER), 403, undefined, 'staff refused when access lapses');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);

  // 10. Strict tablet transport.
  await refused(() => tablet('terminal?x=1', { body: { device: TOKEN }, key: null }), 400, 'INVALID', 'query string');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { Cookie: 'a=b' } }), 400, 'INVALID', 'cookie sent');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { Authorization: 'Bearer x' } }), 400, 'INVALID', 'authorization sent');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { 'X-Hon-Source': 'HUMAN_UI' } }), 400, 'INVALID', 'X-HON header');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { Origin: 'https://evil.example' } }), 400, 'INVALID', 'other origin');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { 'Sec-Fetch-Site': 'cross-site' } }), 400, 'INVALID', 'cross-site');
  await refused(() => tablet('terminal', { body: { device: TOKEN }, key: null, headers: { 'Content-Type': 'text/plain' } }), 400, 'INVALID', 'not JSON');
  await refused(() => tablet('terminal', { raw: `{"device":"${TOKEN}","device":"${TOKEN}"}`, key: null }), 400, 'INVALID', 'duplicate key');
  await refused(() => tablet('other', { body: {} }), 400, 'INVALID', 'unknown path');
  await refused(() => tablet('visits', { raw: JSON.stringify({ device: TOKEN, visit: { ...visitInput(), notes: 'x'.repeat(40000) } }) }), 400, 'INVALID', 'body over 32 KiB');
  await refused(() => submit(TOKEN, visitInput(), { key: 'short' }), 400, 'INVALID', 'bad idempotency key');

  // 11. Guards.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.walkin_waiver_signatures SET signer_name='x' WHERE visit_id=$1", [visit.id]), /WALKIN_KIOSK_IMMUTABLE/, 'signature rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.walkin_waiver_signatures WHERE visit_id=$1', [visit.id]), /WALKIN_KIOSK_IMMUTABLE/, 'signature deleted');
  await rejectsSql(() => sql("UPDATE hon.walkin_waiver_texts SET texts='{\"en\":\"x\"}' WHERE school_id=$1", [ids.schoolA]), /WALKIN_KIOSK_IMMUTABLE/, 'waiver text rewritten');
  await rejectsSql(() => sql("UPDATE hon.walkin_visit_participants SET given_name='x' WHERE visit_id=$1", [visit.id]), /WALKIN_KIOSK_IMMUTABLE/, 'participant rewritten');
  await rejectsSql(() => sql('UPDATE hon.walkin_visits SET price_minor=0,version=version+1 WHERE id=$1', [paidVisit.visitId]), /WALKIN_KIOSK_IMMUTABLE/, 'price rewritten');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET payment_state='PAY_AT_DESK',desk_method=NULL,desk_paid_at=NULL,desk_paid_by=NULL,version=version+1 WHERE id=$1", [paidVisit.visitId]), /WALKIN_KIOSK_IMMUTABLE/, 'payment undone');
  await rejectsSql(() => sql('UPDATE hon.walkin_kiosk_devices SET ended_at=NULL,ended_by=NULL,version=version+1 WHERE id=$1', [second.device.deviceId]), /WALKIN_KIOSK_IMMUTABLE/, 'ended tablet revived');
  await rejectsSql(() => sql("UPDATE hon.walkin_kiosk_devices SET ends_at=ends_at+interval '1 hour' WHERE id=$1", [DEVICE.deviceId]), /WALKIN_KIOSK_IMMUTABLE/, 'tablet extended');
  await rejectsSql(() => sql("UPDATE hon.walkin_kiosk_settings SET waiver='{\"en\":\"sneaky\"}',version=version+1 WHERE school_id=$1", [ids.schoolA]), /WALKIN_KIOSK_IMMUTABLE/, 'waiver changed without a new version');
  await rejectsSql(() => sql('DELETE FROM hon.walkin_visits WHERE id=$1', [visit.id]), /WALKIN_KIOSK_IMMUTABLE/, 'visit deleted');
  await rejectsSql(() => sql('TRUNCATE hon.walkin_waiver_signatures CASCADE'), /./, 'signatures truncated');
  await sql('ROLLBACK');

  // 12. Runtime ACL: EXECUTE on the nine entry points only; no table privilege; private helpers.
  const entry = ['save_walkin_kiosk_settings(text,jsonb,text,uuid,uuid)', 'start_walkin_kiosk_device(text,jsonb,text,uuid,uuid)', 'end_walkin_kiosk_device(text,uuid,jsonb,text,uuid,uuid)',
    'set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid)', 'read_walkin_kiosk(text)', 'read_walkin_kiosk_settings(text)', 'read_walkin_visit(text,uuid)',
    'read_walkin_kiosk_terminal(text)', 'submit_walkin_visit(text,jsonb,text)'];
  const helpers = ['walkin_text_ok(jsonb,integer,integer,boolean)', 'guard_walkin_kiosk()', 'walkin_utc(timestamp with time zone)', 'walkin_principal_holds(uuid,uuid,uuid,text)',
    'require_walkin_actor(text,text)', 'walkin_command_begin(text,text,text,text)', 'walkin_command_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'walkin_settings_json(hon.walkin_kiosk_settings)', 'walkin_device_json(hon.walkin_kiosk_devices)', 'walkin_visit_json(hon.walkin_visits)', 'walkin_settings_input(jsonb)',
    'walkin_live_device(text)', 'take_walkin_kiosk_rate(uuid,text,integer)', 'walkin_name_ok(jsonb)', 'walkin_birth_date(jsonb,date)',
    'walkin_visit_input(hon.walkin_kiosk_settings,jsonb,date)'];
  for (const fn of entry) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(row.runtime && row.prosecdef && !row.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  for (const table of ['walkin_kiosk_settings', 'walkin_waiver_texts', 'walkin_kiosk_devices', 'walkin_visits', 'walkin_visit_participants', 'walkin_waiver_signatures', 'walkin_kiosk_rates']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(row.forced && !row.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.walkin_waiver_signatures LIMIT 1'), /permission denied/); checks += 1;
  ok((await sql("SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000414'")).rows[0].n === 0, 'the kiosk intake principal holds no role');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE school_id=$1 AND event_type LIKE 'walkin_kiosk.%' AND (payload::text LIKE '%example.test%' OR payload::text LIKE '%Rivera%')", [ids.schoolA])).rows[0].n === 0, 'no contact data in the outbox');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Walk-in kiosk exact verification (0414)', endMark = '-- End walk-in kiosk exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: walk-in kiosk (0414): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
