/**
 * Walk-in kiosk card payment proof (WK3 0533) over the strict tablet transport (no session -> PublicWalkInKioskController ->
 * the three fixed card functions -> SchoolPayOnceService with the in-process processor simulators) and signed staff HTTP
 * (desk paid), on the guarded disposable CRM-close fixture only. TEST mode simulators only: no network, no credentials,
 * nothing is charged or sent; HON takes no fee. Synthetic names and example.test contacts only.
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
const { SimulatedStripeConnectAdapter, SimulatedSquareAdapter } = await load('school-payments/school-payment-adapter.js');

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
const stripe = new SimulatedStripeConnectAdapter();
const payOnce = new SchoolPayOnceService(database, new Map([['STRIPE_CONNECT', stripe], ['SQUARE', new SimulatedSquareAdapter()]]));

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [WalkInKioskController, PublicWalkInKioskController],
    providers: [HonIdentityGuard, HonIdentityService, WalkInKioskService, { provide: RuntimeDatabaseService, useValue: database }, { provide: SchoolPayOnceService, useValue: payOnce }],
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`walkcard-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`walkcard-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`walkcard-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `walkcard-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Desk Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Desk Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID(); grants.push(grant);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
  }
  return { subject, principal, org, school, grants };
}
let OWNER, DESK, OTHER_OWNER, B_OWNER, STARTER, today, pipeline, stage, pipelineB, stageB, pipelineO, stageO;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Card Org','Card Org'),($2,'Card Other Org','Card Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Card Dojo ${slug}`, `walkcard-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  [pipeline, stage, pipelineB, stageB, pipelineO, stageO] = Array.from({ length: 6 }, () => randomUUID());
  for (const [p, st, org, school] of [[pipeline, stage, ids.organization, ids.schoolA], [pipelineB, stageB, ids.organization, ids.schoolB], [pipelineO, stageO, ids.otherOrganization, ids.otherSchool]]) {
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'New leads')", [p, org, school]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [st, org, school, p]);
  }
  OWNER = await staff('owner', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run'])]);
  DESK = await staff('desk', [await role(ids.organization, ['walkin_kiosk.run'])]);
  B_OWNER = await staff('b-owner', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run'])], { school: ids.schoolB });
  OTHER_OWNER = await staff('other-owner', [await role(ids.otherOrganization, ['walkin_kiosk.manage', 'walkin_kiosk.run'])], { org: ids.otherOrganization, school: ids.otherSchool });
  STARTER = OWNER.principal;
  // Fixture-only TEST connections (onboarding is proven by 0258/0320): Stripe at school A and at the other organization's
  // school; none at school B. Guards are bypassed for the disposable fixture only.
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_connections DISABLE TRIGGER USER');
  for (const [org, school, ref, by] of [[ids.organization, ids.schoolA, 'acct_simWA1', OWNER.principal], [ids.otherOrganization, ids.otherSchool, 'acct_simWO1', OTHER_OWNER.principal]]) {
    await sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,charges_enabled,payouts_enabled,capabilities,is_default,started_by_principal_id)
      VALUES($1,$2,'STRIPE_CONNECT','CONNECTED_ACTIVE',$3,true,true,'{"oneTimeCard":true,"storedCard":true,"bankDebit":false,"offSessionRecurring":true,"refunds":true}'::jsonb,true,$4)`,
      [org, school, ref, by]);
  }
  await sql('ALTER TABLE hon.school_pay_connections ENABLE TRIGGER USER');
  await sql('COMMIT');
}
const WAIVER = { en: 'I understand martial arts training has risks.\nI agree to follow the instructors.', ko: '무술 훈련에는 위험이 있음을 이해합니다.' };
const OFFERS = [
  { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass', ko: '1일 이용권', es: 'Pase de un día' }, description: { en: 'Train with us today.' }, priceMinor: 2500 },
  { key: 'free-trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0 },
];
const goodSettings = (p = pipeline, st = stage) => ({ expectedVersion: 0, enabled: true, waiver: WAIVER, emergencyRequired: true, pipelineId: p, pipelineStageId: st, offers: OFFERS,
  thankYou: { en: 'Welcome to the dojo!', es: '¡Bienvenidos!' } });
const yearsAgo = (years, days = 0) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const SIGNATURE = [[[10, 10], [200, 120], [400, 90]], [[500, 500], [520, 530]]];
const settingsVersion = 1;
const visitInput = (patch = {}) => ({
  settingsVersion, language: 'en',
  contact: { givenName: 'Alex', familyName: 'Rivera', email: 'alex@example.test', mobile: '+15555550101', birthDate: null, isParticipant: false, adultConfirmed: true },
  children: [{ givenName: 'Sam', familyName: 'Rivera', birthDate: yearsAgo(9) }], relationship: 'PARENT', emergency: { name: 'Jo Rivera', phone: '+15555550102' },
  heardFrom: 'FRIEND', marketingOptIn: false, offerKey: 'free-trial', waiver: { accepted: true, signerName: 'Alex Rivera', strokes: SIGNATURE }, website: '', ...patch,
});
const digest = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const cardStart = (token, visit, surface, options = {}) => tablet('card-payment/start', { body: { device: token, visit, surface }, key: null, ...options });
const cardStatus = (token, visit, options = {}) => tablet('card-payment/status', { body: { device: token, visit }, key: null, ...options });
const cardCancel = (token, visit, options = {}) => tablet('card-payment/cancel', { body: { device: token, visit }, key: null, ...options });
const visitKey = () => randomBytes(18).toString('base64url');
let contactSeq = 0;
/** One paid (day pass) visit on `token`; returns its key and id. */
async function paidVisit(token, offerKey = 'day-pass') {
  const key = visitKey(); contactSeq += 1;
  const recorded = await success(() => submit(token, visitInput({ offerKey, contact: { givenName: 'Alex', familyName: 'Rivera', email: `alex${contactSeq}@example.test`, mobile: '',
    birthDate: null, isParticipant: false, adultConfirmed: true } }), { key }), `visit ${contactSeq}`, 201);
  ok(recorded.paymentState === (offerKey === 'day-pass' ? 'PAY_AT_DESK' : 'FREE'), `visit ${contactSeq}: ${recorded.paymentState}`);
  const id = (await sql('SELECT id FROM hon.walkin_visits WHERE key_hash=$1', [createHash('sha256').update(`${digest(token)}:key:${key}`, 'utf8').digest('hex')])).rows[0].id;
  return { key, id };
}
const paymentsOf = async (visitId) => (await sql('SELECT * FROM hon.school_pay_once WHERE source=$1 AND source_id=$2 ORDER BY created_at,id', ['WALKIN_VISIT', visitId])).rows;
const visitRow = async (visitId) => (await sql('SELECT * FROM hon.walkin_visits WHERE id=$1', [visitId])).rows[0];
const sessionOf = (paymentId) => [...stripe.onceSessions.values()].find((s) => s.paymentId === paymentId);
async function card(read, expected, label, status = 200) {
  const { status: got, body, headers } = await read();
  assert.equal(got, status, `${label}: expected ${status}, got ${got} ${JSON.stringify(body)}`);
  assert.equal(body.result, expected, `${label}: expected ${expected}, got ${JSON.stringify(body)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  const text = JSON.stringify(body);
  // P3: no payment id, processor payment reference or contact detail ever reaches the tablet.
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text) && !/pi_sim|@example\.test|Rivera/.test(text), `${label}: no payment id, payment reference or contact`);
  if (expected !== 'READY') ok(Object.keys(body).join() === 'result', `${label}: only the result`);
  return body;
}

try {
  await cleanup();
  await seed();
  await startApp();
  ok(process.env.HON_PUBLIC_ORIGIN?.startsWith('http://127.0.0.1:'), 'local origin for return addresses');

  // 1. Kiosk on at school A (Stripe test connection), school B (no connection) and the other organization's school.
  await success(() => saveSettings(OWNER, goodSettings()), 'school A settings');
  await success(() => saveSettings(B_OWNER, goodSettings(pipelineB, stageB)), 'school B settings');
  await success(() => saveSettings(OTHER_OWNER, goodSettings(pipelineO, stageO)), 'other organization settings');
  const TOKEN = (await success(() => startDevice(DESK, { label: 'Front tablet', hours: 2 }), 'tablet A')).data.token;
  const TOKEN2 = (await success(() => startDevice(DESK, { label: 'Side tablet', hours: 2 }), 'second tablet A')).data.token;
  const TOKEN_B = (await success(() => startDevice(B_OWNER, { label: 'B tablet', hours: 2 }), 'tablet B')).data.token;
  const TOKEN_O = (await success(() => startDevice(OTHER_OWNER, { label: 'O tablet', hours: 2 }), 'tablet O')).data.token;
  ok(JSON.stringify((await success(() => terminal(TOKEN), 'terminal A')).data.cardSurfaces) === '["EMBEDDED","HOSTED"]', 'school A offers the tablet form and the phone QR');
  ok(JSON.stringify((await success(() => terminal(TOKEN_B), 'terminal B')).data.cardSurfaces) === '[]', 'school B (no connection) offers the desk only');

  // 2. Tablet form (EMBEDDED): open at the frozen price, same form again, paid on the form, settled into the visit.
  const v1 = await paidVisit(TOKEN);
  await card(() => cardStatus(TOKEN, v1.key), 'NONE', 'nothing started yet');
  const r1 = await card(() => cardStart(TOKEN, v1.key, 'EMBEDDED'), 'READY', 'tablet form');
  ok(r1.surface === 'EMBEDDED' && /_secret_sim$/.test(r1.clientSecret) && r1.url === null && r1.accountRef === 'acct_simWA1', 'client secret and the school account for Stripe.js');
  let pays = await paymentsOf(v1.id);
  ok(pays.length === 1 && Number(pays[0].amount_minor) === 2500 && pays[0].currency === 'USD' && pays[0].label === 'Day pass' && pays[0].payer_email === null
    && pays[0].surface === 'EMBEDDED' && pays[0].return_url === `${process.env.HON_PUBLIC_ORIGIN}/kiosk/walk-in`, 'one payment: frozen price, offer name, no payer detail, tablet return');
  ok(Date.parse(pays[0].expires_at) - Date.now() <= 20 * 60000 && Date.parse(pays[0].expires_at) - Date.now() > 18 * 60000, 'it expires in 20 minutes');
  const again = await card(() => cardStart(TOKEN, v1.key, 'EMBEDDED'), 'READY', 'tablet form again');
  ok(again.clientSecret === r1.clientSecret && (await paymentsOf(v1.id)).length === 1 && stripe.onceSessions.size === 1, 'the same form comes back');
  await card(() => cardStatus(TOKEN, v1.key), 'OPEN', 'not paid yet');
  stripe.settleOnce(pays[0].id, 'SUCCEEDED');
  await card(() => cardStatus(TOKEN, v1.key), 'PAID', 'paid on the form');
  let row = await visitRow(v1.id);
  ok(row.payment_state === 'PAID_CARD' && row.card_payment_id === pays[0].id && row.card_paid_at && row.desk_paid_at === null && row.version === 2, 'visit PAID_CARD with its payment');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='walkin_kiosk.visit.card_paid' AND actor_principal_id='00000000-0000-4000-8000-000000000414' AND source='PUBLIC_API'", [v1.id])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='walkin_kiosk.visit_card_paid' AND payload::text NOT LIKE '%example.test%'", [v1.id])).rows[0].n === 1, 'one audit row and one internal event');
  await card(() => cardStatus(TOKEN, v1.key), 'PAID', 'paid stays paid');
  await card(() => cardStart(TOKEN, v1.key, 'HOSTED'), 'PAID', 'nothing more to start');
  await card(() => cardCancel(TOKEN, v1.key), 'PAID', 'nothing to cancel');
  const listed = (await success(() => overview(DESK), 'overview')).data.visits.find((x) => x.visitId === v1.id);
  ok(listed.paymentState === 'PAID_CARD' && listed.cardPaidAt && listed.deskMethod === null, 'staff see it paid by card');
  await refused(() => deskPaid(DESK, v1.id, { expectedVersion: 2, method: 'CASH' }), 409, 'WALKIN_VISIT_NOT_DUE', 'paid by card: nothing due at the desk');

  // 3. Switching between the phone QR (HOSTED) and the tablet form: the earlier one is closed at the processor first.
  const v2 = await paidVisit(TOKEN);
  const q2 = await card(() => cardStart(TOKEN, v2.key, 'HOSTED'), 'READY', 'phone QR');
  ok(q2.surface === 'HOSTED' && q2.url.startsWith('https://checkout.simulated.invalid/') && q2.clientSecret === null && q2.accountRef === null, 'a processor page link, no account');
  pays = await paymentsOf(v2.id);
  ok(pays[0].return_url === `${process.env.HON_PUBLIC_ORIGIN}/kiosk/walk-in/paid`, 'the phone comes back to a plain thank-you page');
  await card(() => cardStart(TOKEN, v2.key, 'EMBEDDED'), 'READY', 'switch to the tablet form');
  pays = await paymentsOf(v2.id);
  ok(pays.length === 2 && pays[0].state === 'CANCELED' && sessionOf(pays[0].id).outcome === 'EXPIRED' && pays[1].state === 'OPEN' && pays[1].surface === 'EMBEDDED',
    'the QR session was expired at the processor and a new payment opened');
  // The visitor chooses the desk: closed at the processor, the visit is still due at the desk, and card can start again.
  await card(() => cardCancel(TOKEN, v2.key), 'CANCELED', 'pay at the desk instead');
  ok((await paymentsOf(v2.id))[1].state === 'CANCELED' && sessionOf(pays[1].id).outcome === 'EXPIRED' && (await visitRow(v2.id)).payment_state === 'PAY_AT_DESK', 'closed, still due at the desk');
  await card(() => cardStatus(TOKEN, v2.key), 'CANCELED', 'status after cancel');
  await card(() => cardStart(TOKEN, v2.key, 'HOSTED'), 'READY', 'card again after cancel');
  ok((await paymentsOf(v2.id)).length === 3, 'a new payment after a cancelled one');

  // 4. Paid on the phone, then "pay at the desk" pressed on the tablet: the processor says paid, so nobody pays twice.
  const v3 = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v3.key, 'HOSTED'), 'READY', 'QR for v3');
  stripe.settleOnce((await paymentsOf(v3.id))[0].id, 'SUCCEEDED');
  await card(() => cardCancel(TOKEN, v3.key), 'PAID', 'cancel finds it paid');
  ok((await visitRow(v3.id)).payment_state === 'PAID_CARD', 'v3 paid by card');
  // Switching surface after paying on the phone: also paid, no second payment.
  const v3b = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v3b.key, 'HOSTED'), 'READY', 'QR for v3b');
  stripe.settleOnce((await paymentsOf(v3b.id))[0].id, 'SUCCEEDED');
  await card(() => cardStart(TOKEN, v3b.key, 'EMBEDDED'), 'PAID', 'switching after paying');
  ok((await paymentsOf(v3b.id)).length === 1 && (await visitRow(v3b.id)).payment_state === 'PAID_CARD', 'no second payment');

  // 5. Desk paid (K3): an open session is closed at the processor first; a paid one makes the visit PAID_CARD instead; an
  // unstarted one is cancelled in the database; one still clearing is refused.
  const v4 = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v4.key, 'HOSTED'), 'READY', 'QR for v4');
  const d4 = await success(() => deskPaid(DESK, v4.id, { expectedVersion: 1, method: 'CASH' }), 'desk paid with an open QR');
  pays = await paymentsOf(v4.id);
  ok(d4.data.visit.paymentState === 'PAID_AT_DESK' && d4.data.visit.deskMethod === 'CASH' && pays[0].state === 'CANCELED' && sessionOf(pays[0].id).outcome === 'EXPIRED',
    'the QR was closed at the processor before the desk payment');
  stripe.settleOnce(pays[0].id, 'SUCCEEDED'); // impossible at a real processor once expired; the records still refuse it
  await card(() => cardStatus(TOKEN, v4.key), 'NOT_DUE', 'paid at the desk');
  await card(() => cardStart(TOKEN, v4.key, 'HOSTED'), 'NOT_DUE', 'no card after the desk');
  ok((await visitRow(v4.id)).payment_state === 'PAID_AT_DESK' && (await paymentsOf(v4.id)).length === 1, 'still paid at the desk only');

  const v5 = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v5.key, 'HOSTED'), 'READY', 'QR for v5');
  stripe.settleOnce((await paymentsOf(v5.id))[0].id, 'SUCCEEDED');
  const k5 = randomUUID();
  const d5 = await success(() => deskPaid(DESK, v5.id, { expectedVersion: 1, method: 'CASH' }, { key: k5 }), 'desk paid after paying on the phone');
  ok(d5.data.visit.paymentState === 'PAID_CARD' && d5.data.visit.deskMethod === null && d5.data.visit.cardPaidAt, 'the desk sees it was paid by card');
  const d5again = await success(() => deskPaid(DESK, v5.id, { expectedVersion: 1, method: 'CASH' }, { key: k5 }), 'replay');
  ok(d5again.meta.replayed === true && JSON.stringify(d5again.data) === JSON.stringify(d5.data), 'exact replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='walkin_kiosk.visit.card_paid' AND actor_principal_id=$2 AND source='HUMAN_UI'", [v5.id, DESK.principal])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='walkin_kiosk.visit.desk_paid'", [v5.id])).rows[0].n === 0, 'audited as paid by card, not at the desk');

  const v6 = await paidVisit(TOKEN);
  const unstarted = (await runtime.query('SELECT hon.open_walkin_card_payment($1,$2) AS data', [digest(TOKEN), v6.key])).rows[0].data;
  ok(unstarted.result === 'OPEN' && unstarted.providerCode === 'STRIPE_CONNECT', 'opened, never started');
  await success(() => deskPaid(DESK, v6.id, { expectedVersion: 1, method: 'OTHER' }), 'desk paid with an unstarted card payment');
  ok((await paymentsOf(v6.id))[0].state === 'CANCELED' && (await visitRow(v6.id)).payment_state === 'PAID_AT_DESK', 'unstarted payment cancelled in the database');

  const v7 = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v7.key, 'EMBEDDED'), 'READY', 'form for v7');
  stripe.settleOnce((await paymentsOf(v7.id))[0].id, 'PROCESSING');
  await card(() => cardStatus(TOKEN, v7.key), 'PROCESSING', 'still clearing');
  await card(() => cardCancel(TOKEN, v7.key), 'PROCESSING', 'cannot cancel while clearing');
  await refused(() => deskPaid(DESK, v7.id, { expectedVersion: 1, method: 'CASH' }), 409, 'WALKIN_CARD_PAYMENT_IN_PROGRESS', 'desk refused while clearing');
  stripe.settleOnce((await paymentsOf(v7.id))[0].id, 'FAILED');
  await card(() => cardStatus(TOKEN, v7.key), 'FAILED', 'card refused');
  ok((await visitRow(v7.id)).payment_state === 'PAY_AT_DESK', 'still due after a refused card');
  await success(() => deskPaid(DESK, v7.id, { expectedVersion: 1, method: 'CARD_OUTSIDE_HON' }), 'desk paid after a refused card');

  // 6. Expiry: a session past the payment's own expiry is closed at the processor first, then a new one can start.
  const v8 = await paidVisit(TOKEN);
  await card(() => cardStart(TOKEN, v8.key, 'HOSTED'), 'READY', 'QR for v8');
  payOnce.now = () => Date.now() + 25 * 60000;
  await card(() => cardStatus(TOKEN, v8.key), 'EXPIRED', 'expired');
  payOnce.now = Date.now;
  ok(sessionOf((await paymentsOf(v8.id))[0].id).outcome === 'EXPIRED', 'expired at the processor');
  await card(() => cardStart(TOKEN, v8.key, 'HOSTED'), 'READY', 'a new QR after expiry');
  // A processor that does not answer: nothing changes and the tablet says try again.
  const p8 = (await paymentsOf(v8.id))[1].id;
  stripe.onceFaults.set(p8, { findLost: true });
  await card(() => cardStatus(TOKEN, v8.key), 'UNAVAILABLE', 'processor did not answer', 503);
  ok((await paymentsOf(v8.id))[1].state === 'OPEN', 'nothing recorded');
  await card(() => cardStatus(TOKEN, v8.key), 'OPEN', 'answered next time');

  // 7. P3 caller rule: the payment is found only from this tablet's own visit; a foreign one can never be named.
  await card(() => cardStatus(TOKEN2, v8.key), 'NOT_FOUND', 'another tablet of the same school', 404);
  await card(() => cardStart(TOKEN2, v8.key, 'HOSTED'), 'NOT_FOUND', 'another tablet cannot start it', 404);
  await card(() => cardCancel(TOKEN_O, v8.key), 'NOT_FOUND', 'a tablet of another organization cannot cancel it', 404);
  await card(() => cardStatus(TOKEN, visitKey()), 'NOT_FOUND', 'an unknown key', 404);
  await card(() => cardStart(TOKEN, p8, 'HOSTED'), 'NOT_FOUND', 'a payment id given as the key finds nothing', 404);
  await card(() => tablet('card-payment/status', { body: { device: TOKEN, visit: v8.key, paymentId: p8 }, key: null }), 'INVALID', 'a payment id field is refused', 400);
  await card(() => tablet('card-payment/start', { body: { device: TOKEN, visit: v8.key, surface: 'SMS' }, key: null }), 'INVALID', 'unknown surface', 400);
  await card(() => cardStatus(randomBytes(32).toString('base64url'), v8.key), 'CLOSED', 'not a tablet', 404);
  ok((await paymentsOf(v8.id))[1].state === 'OPEN' && stripe.onceSessions.size === [...stripe.onceSessions.values()].length, 'nothing changed by the refused calls');
  await refused(() => deskPaid(OTHER_OWNER, v8.id, { expectedVersion: 1, method: 'CASH' }), 404, 'WALKIN_VISIT_NOT_FOUND', 'another organization cannot reach the visit or its payment');
  await refused(() => deskPaid(B_OWNER, v8.id, { expectedVersion: 1, method: 'CASH' }), 404, 'WALKIN_VISIT_NOT_FOUND', 'another school cannot reach the visit or its payment');
  await refused(() => deskPaid(OTHER_OWNER, v8.id, { expectedVersion: 1, method: 'CASH' }, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'another organization at the school-A route');
  ok((await paymentsOf(v8.id))[1].state === 'OPEN' && sessionOf(p8).outcome === 'OPEN', 'nothing was cancelled for a foreign caller');
  const free = await paidVisit(TOKEN, 'free-trial');
  await card(() => cardStart(TOKEN, free.key, 'EMBEDDED'), 'NOT_DUE', 'a free visit has nothing to pay');
  const vb = await paidVisit(TOKEN_B);
  await card(() => cardStart(TOKEN_B, vb.key, 'HOSTED'), 'NOT_AVAILABLE', 'no card connection at school B', 422);
  ok((await paymentsOf(vb.id)).length === 0, 'nothing opened at school B');
  const front = (await success(() => overview(DESK), 'devices')).data.devices.find((d) => d.label === 'Front tablet');
  await success(() => endDevice(DESK, front.deviceId, { expectedVersion: front.version }), 'end tablet A');
  await card(() => cardStatus(TOKEN, v8.key), 'CLOSED', 'an ended tablet', 404);

  // 8. Strict transport for the card paths.
  await refused(() => tablet('card-payment/status?x=1', { body: { device: TOKEN2, visit: v8.key }, key: null }), 400, 'INVALID', 'query string');
  await refused(() => tablet('card-payment/start', { body: { device: TOKEN2, visit: v8.key, surface: 'HOSTED' }, key: null, headers: { Cookie: 'a=b' } }), 400, 'INVALID', 'cookie sent');
  await refused(() => tablet('card-payment/cancel', { body: { device: TOKEN2, visit: v8.key }, key: null, headers: { Origin: 'https://evil.example' } }), 400, 'INVALID', 'other origin');
  await refused(() => tablet('card-payment/refund', { body: { device: TOKEN2, visit: v8.key }, key: null }), 400, 'INVALID', 'unknown card path');

  // 9. Guards: PAY_AT_DESK moves once, to PAID_AT_DESK or PAID_CARD only, with its payment.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET payment_state='PAY_AT_DESK',card_payment_id=NULL,card_paid_at=NULL,version=version+1 WHERE id=$1", [v1.id]), /WALKIN_KIOSK_IMMUTABLE/, 'card payment undone');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET payment_state='PAID_CARD',card_payment_id=$2,card_paid_at=now(),desk_method=NULL,desk_paid_at=NULL,desk_paid_by=NULL,version=version+1 WHERE id=$1", [v4.id, pays[0].id]), /WALKIN_KIOSK_IMMUTABLE|violates/, 'desk payment turned into a card payment');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET payment_state='PAID_CARD',version=version+1 WHERE id=$1", [v8.id]), /WALKIN_KIOSK_IMMUTABLE|walkin_visits_card_paid_check/, 'PAID_CARD without its payment');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET card_payment_id=$2,version=version+1 WHERE id=$1", [v8.id, p8]), /WALKIN_KIOSK_IMMUTABLE|walkin_visits_card_paid_check/, 'a payment without PAID_CARD');
  const v1pay = (await paymentsOf(v1.id))[0].id;
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET card_payment_id=$2 WHERE id=$1", [v3.id, v1pay]), /WALKIN_KIOSK_IMMUTABLE|unique|duplicate/, 'one payment pays one visit');
  // The check constraint on its own (guard trigger off inside this rolled-back transaction, fixture only).
  await sql('ALTER TABLE hon.walkin_visits DISABLE TRIGGER walkin_visits_guard');
  await rejectsSql(() => sql("UPDATE hon.walkin_visits SET payment_state='PAID_CARD' WHERE id=$1", [v8.id]), /walkin_visits_card_paid_check/, 'constraint: PAID_CARD needs its payment');
  await rejectsSql(() => sql('UPDATE hon.walkin_visits SET card_payment_id=$2,card_paid_at=now() WHERE id=$1', [v8.id, p8]), /walkin_visits_card_paid_check/, 'constraint: a payment needs PAID_CARD');
  await sql('ROLLBACK');

  // 10. Runtime ACL and 011.
  for (const fn of ['read_walkin_card_provider(text)', 'open_walkin_card_payment(text,text)', 'settle_walkin_card_payment(text,text)', 'read_walkin_visit_card_payment(text,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['walkin_card_payment_of(hon.walkin_visits)', 'walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)', 'walkin_tablet_hold(text)',
    'walkin_tablet_visit(hon.walkin_kiosk_devices,text)', 'school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamp with time zone)',
    'school_pay_once_state(uuid)', 'school_pay_once_cancel(uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  await assert.rejects(runtime.query('SELECT card_payment_id FROM hon.walkin_visits LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.read_walkin_visit_card_payment('x',$1::uuid)", [v8.id]), /WALKIN_KIOSK_FORBIDDEN/); checks += 1;
  for (const [startMark, endMark] of [['-- Walk-in kiosk card payment exact verification (0533)', '-- End walk-in kiosk card payment exact verification.'],
    ['-- Walk-in kiosk exact verification (0414)', '-- End walk-in kiosk exact verification.']]) {
    const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
  }
  ok([...stripe.onceSessions.values()].every((x) => !('applicationFee' in x)), 'no session carries an HON fee');

  console.log(`PASS: walk-in kiosk card payment (0533): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
