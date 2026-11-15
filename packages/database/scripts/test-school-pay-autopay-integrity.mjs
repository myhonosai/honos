/**
 * School autopay and sibling discount proof (B-TUI-2 piece 4, 0322) over signed HTTP (HON session cookie ->
 * HonIdentityGuard + human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolPayAutopayController ->
 * protected definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture
 * only. Saved methods come from the 0321 routes over the in-process simulators. Test mode only; synthetic data; nothing
 * charges anyone, no processor is called by these routes, and no message is sent.
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
const { SchoolPaymentController } = await load('school-payments/school-payment.controller.js');
const { SchoolPaymentService } = await load('school-payments/school-payment.service.js');
const { SchoolPayMethodController } = await load('school-payments/school-pay-method.controller.js');
const { SchoolPayMethodService } = await load('school-payments/school-pay-method.service.js');
const { SchoolPayAutopayController } = await load('school-payments/school-pay-autopay.controller.js');
const { SchoolPayAutopayService } = await load('school-payments/school-pay-autopay.service.js');
const { SCHOOL_PAYMENT_ADAPTERS, SimulatedStripeConnectAdapter, SimulatedSquareAdapter } = await load('school-payments/school-payment-adapter.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-pay-autopay', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const stripe = new SimulatedStripeConnectAdapter();
const adapters = new Map([['STRIPE_CONNECT', stripe], ['SQUARE', new SimulatedSquareAdapter()]]);
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolPaymentController, SchoolPayMethodController, SchoolPayAutopayController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolPaymentService, SchoolPayMethodService, SchoolPayAutopayService,
      { provide: RuntimeDatabaseService, useValue: database }, { provide: SCHOOL_PAYMENT_ADAPTERS, useValue: adapters }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = {
  read: 'school_pay.autopay.read', discountRead: 'school_pay.discount.read', discountSet: 'school_pay.discount.set', enroll: 'school_pay.autopay.enroll',
  method: 'school_pay.autopay.method', state: 'school_pay.autopay.state', cancel: 'school_pay.autopay.cancel', cycle: 'school_pay.autopay.cycle',
  setup: 'school_pay.method.setup', finish: 'school_pay.method.finish', remove: 'school_pay.method.remove',
  connStart: 'school_pay.connection.start', connLink: 'school_pay.connection.onboarding_link', connFinish: 'school_pay.connection.finish',
};
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/payments${path}`);
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
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text), text }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
const readAutopay = (actor, payer, options = {}) => call(actor, 'GET', `/payers/${payer}/autopay`, options);
const readRule = (actor, options = {}) => call(actor, 'GET', '/sibling-discount', options);
const setRule = (actor, body, options = {}) => call(actor, 'POST', '/sibling-discount', { body, command: COMMAND.discountSet, ...options });
const enroll = (actor, payer, methodId, options = {}) => call(actor, 'POST', `/payers/${payer}/autopay`, { body: { methodId, consentTextVersion: 'autopay-v1' }, command: COMMAND.enroll, ...options });
const changeMethod = (actor, plan, expectedVersion, methodId, options = {}) => call(actor, 'POST', `/autopay/${plan}/method`, { body: { expectedVersion, methodId }, command: COMMAND.method, ...options });
const setState = (actor, plan, expectedVersion, state, options = {}) => call(actor, 'POST', `/autopay/${plan}/state`, { body: { expectedVersion, state }, command: COMMAND.state, ...options });
const cancel = (actor, plan, expectedVersion, reason, options = {}) => call(actor, 'POST', `/autopay/${plan}/cancel`, { body: { expectedVersion, reason }, command: COMMAND.cancel, ...options });
const prepare = (actor, plan, expectedVersion, cycleDate, options = {}) => call(actor, 'POST', `/autopay/${plan}/cycles`, { body: { expectedVersion, cycleDate }, command: COMMAND.cycle, ...options });

async function success(run, label) {
  const { status, body, headers, text } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  ok(!/cus_sim|pm_sim|acct_sim|seti_sim/.test(text), `${label}: no provider reference reaches the browser`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0258 and 0321 proofs).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.school_pay_autopay_plans WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left autopay plans behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`autopay-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`autopay-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`autopay-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `autopay-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Autopay Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Autopay Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
async function person(given, family, { org = ids.organization, school = ids.schoolA } = {}) {
  return (await sql('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id', [org, school, given, family])).rows[0].id;
}
async function payer(given, family, options = {}) {
  const { org = ids.organization, school = ids.schoolA } = options;
  return (await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id", [org, school, await person(given, family, options)])).rows[0].id;
}
/** A school-local noon instant `days` from the school's today. */
const localNoon = (days) => sql(`SELECT ((((clock_timestamp() AT TIME ZONE $1)::date+$2::int)+time '12:00') AT TIME ZONE $1) t`, [LA, days]).then((r) => r.rows[0].t);
const localDay = (days) => sql('SELECT to_char((clock_timestamp() AT TIME ZONE $1)::date+$2::int,\'YYYY-MM-DD\') d', [LA, days]).then((r) => r.rows[0].d);
/** A fixture membership in a given state (the activation gate is bypassed for the disposable fixture only) with one schedule. */
async function membership(billingAccount, participant, plan, { state = 'ACTIVE', frequency = 'MONTHLY', amount, currency = 'USD', nextDays = 0, status = 'ACTIVE', termEndsDays = null, org = ids.organization, school = ids.schoolA }) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.memberships DISABLE TRIGGER membership_state_transition_guard');
  const ends = termEndsDays === null ? null : await localNoon(termEndsDays);
  const m = (await sql(`INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '60 days',$7) RETURNING id`, [org, school, billingAccount, participant, plan, state, ends])).rows[0].id;
  await sql('ALTER TABLE hon.memberships ENABLE TRIGGER membership_state_transition_guard');
  await sql('COMMIT');
  const next = nextDays === null ? null : await localNoon(nextDays);
  const s = (await sql(`INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [org, school, m, frequency, amount, currency, next, status])).rows[0].id;
  return { membershipId: m, scheduleId: s };
}

let OWN, READER, NONE, AUTOPAYER, DISCOUNTER, OWN_B, LOSER, P1, P2, P_B;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Autopay Org','Autopay Org'),($2,'Autopay Other Org','Autopay Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Autopay ${slug}`, `autopay-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['school_pay.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'school_pay.method.manage', 'school_pay.connection.manage'])]);
  AUTOPAYER = await staff('autopayer', [await role(ids.organization, ['school_pay.autopay.manage'])]);
  DISCOUNTER = await staff('discounter', [await role(ids.organization, ['school_pay.discount.manage'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_pay.autopay.manage', 'school_pay.discount.manage'])], { school: ids.schoolB });
  LOSER = await staff('loser', [await role(ids.organization, ['school_pay.autopay.manage'])]);
  P1 = await payer('Avery', 'Family');
  P2 = await payer('Blake', 'Household');
  P_B = await payer('Casey', 'School-B', { school: ids.schoolB });
}

async function connect(actor, providerCode) {
  const started = await call(actor, 'POST', '/processors/connections', { body: { providerCode }, command: COMMAND.connStart });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const id = started.body.data.connection.connectionId;
  const linked = await call(actor, 'POST', `/processors/connections/${id}/onboarding-link`, { body: { expectedVersion: 1 }, command: COMMAND.connLink });
  const url = new URL(linked.body.data.onboardingUrl);
  const finish = { expectedVersion: 2, state: url.searchParams.get('state'), ...(url.searchParams.get('code') ? { authorizationCode: url.searchParams.get('code') } : {}) };
  const finished = await call(actor, 'POST', `/processors/connections/${id}/finish`, { body: finish, command: COMMAND.connFinish });
  assert.equal(finished.body.data.connection.state, 'CONNECTED_ACTIVE');
  return finished.body.data.connection;
}
async function saveMethod(actor, billingAccount, connectionId, kind = 'CARD') {
  const started = await call(actor, 'POST', `/payers/${billingAccount}/method-setups`, { body: { connectionId, methodKinds: [kind], consentTextVersion: kind === 'CARD' ? 'card-on-file-v1' : 'ach-mandate-v1' }, command: COMMAND.setup });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.data.setupUrl).searchParams.get('state');
  const done = await call(actor, 'POST', `/payers/${billingAccount}/method-setups/${started.body.data.setup.setupId}/finish`, { body: { expectedVersion: 1, setupState: state }, command: COMMAND.finish });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.data.method;
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permissions and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code IN ('school_pay.autopay.manage','school_pay.discount.manage') AND is_sensitive AND is_staff_assignable")).rows[0].n === 2, 'both permissions are sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN (VALUES ('school_pay.autopay.manage'),('school_pay.discount.manage')) x(code) WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=x.code)`)).rows[0].n === 0, 'every system OWNER role holds both');

  // 1. Sibling discount rule: reads, validation, first version, stale and unchanged refusals, replay, other permissions refused.
  const r0 = (await success(() => readRule(OWN), 'owner reads the rule')).data;
  ok(r0.canManage === true && r0.rule === null && r0.history.length === 0, 'no rule yet');
  ok((await success(() => readRule(READER), 'reader reads the rule')).data.canManage === false, 'a reader cannot set it');
  ok((await success(() => readRule(AUTOPAYER), 'autopay manager reads the rule')).data.canManage === false, 'an autopay manager cannot set it');
  await refused(() => readRule(NONE), 403, 'SCHOOL_PAY_READ_FORBIDDEN', 'rule read refused without permission');
  await refused(() => readRule(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'rule read with a key');
  for (const bad of [{ basedOnVersion: 0, kind: 'PERCENT', secondValue: 101, laterValue: 0 }, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 0, laterValue: 0 },
    { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10, laterValue: 20, currency: 'USD' }, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10 },
    { basedOnVersion: 0, kind: 'FIXED', secondValue: 500, laterValue: 700 }, { basedOnVersion: 0, kind: 'FIXED', secondValue: 500, laterValue: 700, currency: 'usd' },
    { basedOnVersion: 0, kind: 'NONE', secondValue: 1, laterValue: 1 }, { basedOnVersion: -1, kind: 'NONE' }, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10.5, laterValue: 20 },
    { basedOnVersion: 0, kind: 'TIERED', secondValue: 1, laterValue: 1 }]) {
    await refused(() => setRule(OWN, bad), 400, 'VALIDATION_FAILED', `rule refused: ${JSON.stringify(bad)}`);
  }
  await refused(() => setRule(OWN, { basedOnVersion: 0, kind: 'NONE' }), 409, 'SCHOOL_PAY_DISCOUNT_UNCHANGED', 'NONE when nothing is set');
  for (const actor of [READER, AUTOPAYER, NONE]) await refused(() => setRule(actor, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10, laterValue: 20 }), 403, 'SCHOOL_PAY_DISCOUNT_FORBIDDEN', `rule set refused for ${actor.subject.split('-').pop()}`);
  await refused(() => setRule(OWN, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10, laterValue: 20 }, { command: COMMAND.enroll }), 403, 'HUMAN_UI_REQUIRED', 'rule set under another command header');
  const ruleKey = randomUUID();
  const v1 = (await success(() => setRule(DISCOUNTER, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10, laterValue: 20 }, { key: ruleKey }), 'discounter sets 10/20 percent')).data.rule;
  ok(v1.version === 1 && v1.kind === 'PERCENT' && v1.secondValue === 10 && v1.laterValue === 20 && v1.currency === null, 'rule version 1');
  const v1r = await success(() => setRule(DISCOUNTER, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 10, laterValue: 20 }, { key: ruleKey }), 'rule replay');
  ok(v1r.meta.replayed === true && v1r.data.rule.version === 1, 'a replay returns the stored rule');
  await refused(() => setRule(DISCOUNTER, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 15, laterValue: 20 }, { key: ruleKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'rule key reuse');
  await refused(() => setRule(OWN, { basedOnVersion: 0, kind: 'PERCENT', secondValue: 15, laterValue: 20 }), 409, 'VERSION_CONFLICT', 'stale based-on version');
  await refused(() => setRule(OWN, { basedOnVersion: 1, kind: 'PERCENT', secondValue: 10, laterValue: 20 }), 409, 'SCHOOL_PAY_DISCOUNT_UNCHANGED', 'same rule again');
  ok((await success(() => readRule(OWN_B), 'school B reads its own rule')).data.rule === null, 'school B has its own (empty) rule');

  // 2. A Stripe connection; payer 1 saves a card and a bank account; payer 2 saves a card.
  const stripeConn = await connect(OWN, 'STRIPE_CONNECT');
  const visa = await saveMethod(OWN, P1, stripeConn.connectionId, 'CARD');
  const bank = await saveMethod(OWN, P1, stripeConn.connectionId, 'US_BANK_ACCOUNT');
  const p2card = await saveMethod(OWN, P2, stripeConn.connectionId, 'CARD');

  // 3. Payer 1's memberships: three students due today (one with two lines), plus lines that must never be billed.
  const ana = await person('Ana', 'Family'), ben = await person('Ben', 'Family'), cy = await person('Cy', 'Family'), dee = await person('Dee', 'Family');
  const anaMonthly = await membership(P1, ana, 'BLACK_BELT_CLUB', { amount: 15000 });
  const anaWeekly = await membership(P1, ana, 'PRIVATE_LESSON', { amount: 4000, frequency: 'WEEKLY' });
  const benMonthly = await membership(P1, ben, 'LITTLE_DRAGONS', { amount: 10000 });
  const cyMonthly = await membership(P1, cy, 'LITTLE_DRAGONS', { amount: 8000, termEndsDays: 10 });
  const later = await membership(P1, dee, 'TEENS', { amount: 9000, nextDays: 20 });
  const frozen = await membership(P1, dee, 'FROZEN_PLAN', { amount: 7000, state: 'FROZEN' });
  const custom = await membership(P1, dee, 'CUSTOM_PLAN', { amount: 6000, frequency: 'CUSTOM' });
  const paused = await membership(P1, dee, 'PAUSED_PLAN', { amount: 5000, status: 'PAUSED' });
  const euro = await membership(P1, dee, 'EURO_PLAN', { amount: 4500, currency: 'EUR' });
  const p2line = await membership(P2, await person('Eli', 'Household'), 'TEENS', { amount: 12000 });
  const today = await localDay(0);

  // 4. Read: no plan, usable methods, the preview with ranked students and the sibling discount; readers and scope checks.
  const a0 = (await success(() => readAutopay(OWN, P1), 'owner reads payer 1 autopay')).data;
  ok(a0.canManage === true && a0.platformFee === 'NONE' && a0.currency === 'USD' && a0.schoolToday === today && a0.payerName === 'Avery Family' && a0.plan === null
    && a0.pastPlans.length === 0 && a0.cycles.length === 0 && a0.discountRule.version === 1, 'payer 1: no plan, rule version 1, no fee');
  ok(a0.methods.length === 2 && a0.methods.every((m) => m.autopayUsable === true) && a0.methods[0].method.methodId === visa.methodId, 'both saved methods usable, default first');
  const pv = a0.preview;
  ok(pv && pv.cycleDate === today && pv.lines.length === 4 && pv.subtotalMinor === 37000 && pv.discountMinor === 2600 && pv.totalMinor === 34400, `preview totals ${JSON.stringify(pv && { s: pv.subtotalMinor, d: pv.discountMinor })}`);
  ok(pv.lines.map((l) => `${l.participantName}:${l.studentRank}:${l.amountMinor}:${l.discountMinor}`).join() === 'Ana Family:1:15000:0,Ana Family:1:4000:0,Ben Family:2:10000:1000,Cy Family:3:8000:1600',
    `students ranked by their largest line; 2nd 10%, 3rd 20%: ${pv.lines.map((l) => `${l.participantName}:${l.studentRank}:${l.discountMinor}`).join()}`);
  ok(![later, frozen, custom, paused, euro].some((x) => pv.lines.some((l) => l.scheduleId === x.scheduleId)), 'not-yet-due, frozen, custom, paused and other-currency lines are left out');
  ok((await success(() => readAutopay(READER, P1), 'reader reads autopay')).data.canManage === false, 'a reader cannot manage autopay');
  await refused(() => readAutopay(NONE, P1), 403, 'SCHOOL_PAY_READ_FORBIDDEN', 'autopay read refused without permission');
  await refused(() => readAutopay(DISCOUNTER, P1), 403, 'SCHOOL_PAY_READ_FORBIDDEN', 'a discount-only manager cannot read a payer');
  await refused(() => readAutopay(OWN, P_B), 404, 'SCHOOL_PAY_PAYER_NOT_FOUND', 'school-B payer at the school-A route');
  await refused(() => readAutopay(OWN_B, P1, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => readAutopay(OWN, 'not-a-uuid'), 400, undefined, 'malformed payer id');
  await refused(() => call(OWN, 'GET', `/payers/${P1}/autopay?date=2030-01-01`), 400, 'VALIDATION_FAILED', 'read with a query');

  // 5. Enroll: refusals, success, replay, one open plan per payer.
  for (const actor of [READER, NONE, DISCOUNTER]) await refused(() => enroll(actor, P1, visa.methodId), 403, 'SCHOOL_PAY_AUTOPAY_FORBIDDEN', `enroll refused for ${actor.subject.split('-').pop()}`);
  await refused(() => enroll(OWN, P1, 'nope'), 400, 'VALIDATION_FAILED', 'malformed method id');
  await refused(() => call(OWN, 'POST', `/payers/${P1}/autopay`, { body: { methodId: visa.methodId, consentTextVersion: 'Bad Version' }, command: COMMAND.enroll }), 400, 'VALIDATION_FAILED', 'malformed consent');
  await refused(() => call(OWN, 'POST', `/payers/${P1}/autopay`, { body: { methodId: visa.methodId, consentTextVersion: 'autopay-v1', amount: 1 }, command: COMMAND.enroll }), 400, undefined, 'unknown field');
  await refused(() => enroll(OWN, P1, p2card.methodId), 422, 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE', 'the saved method of another payer');
  await refused(() => enroll(OWN, P1, randomUUID()), 422, 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE', 'an unknown method');
  await refused(() => enroll(OWN, P_B, visa.methodId), 404, 'SCHOOL_PAY_PAYER_NOT_FOUND', 'a payer of another school');
  await refused(() => enroll(OWN, P1, visa.methodId, { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'enroll without a key');
  const enrollKey = randomUUID();
  const plan = (await success(() => enroll(AUTOPAYER, P1, visa.methodId, { key: enrollKey }), 'autopay manager enrolls payer 1')).data.plan;
  ok(plan.state === 'ACTIVE' && plan.version === 1 && plan.methodId === visa.methodId && plan.consentTextVersion === 'autopay-v1' && plan.billingAccountId === P1, 'plan ACTIVE with the Visa');
  const enrollReplay = await success(() => enroll(AUTOPAYER, P1, visa.methodId, { key: enrollKey }), 'enroll replay');
  ok(enrollReplay.meta.replayed === true && enrollReplay.data.plan.planId === plan.planId, 'a replay returns the stored plan');
  await refused(() => enroll(OWN, P1, bank.methodId), 409, 'SCHOOL_PAY_AUTOPAY_EXISTS', 'a second open plan for the same payer');

  // 6. Change method, pause and resume; a paused plan cannot prepare a cycle.
  await refused(() => changeMethod(OWN, plan.planId, 1, visa.methodId), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'the same method again');
  await refused(() => changeMethod(OWN, plan.planId, 1, p2card.methodId), 422, 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE', 'another payer method');
  await refused(() => changeMethod(OWN, plan.planId, 7, bank.methodId), 409, 'VERSION_CONFLICT', 'stale plan version');
  await refused(() => changeMethod(OWN, randomUUID(), 1, bank.methodId), 404, 'SCHOOL_PAY_AUTOPAY_NOT_FOUND', 'unknown plan');
  const p2v = (await success(() => changeMethod(OWN, plan.planId, 1, bank.methodId), 'switch to the bank account')).data.plan;
  ok(p2v.methodId === bank.methodId && p2v.version === 2, 'plan uses the bank account');
  await refused(() => setState(OWN, plan.planId, 2, 'ACTIVE'), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'resume an active plan');
  await refused(() => setState(OWN, plan.planId, 2, 'CANCELLED'), 400, 'VALIDATION_FAILED', 'cancel through the state route');
  const p3v = (await success(() => setState(OWN, plan.planId, 2, 'PAUSED'), 'pause')).data.plan;
  ok(p3v.state === 'PAUSED' && p3v.version === 3, 'paused');
  await refused(() => prepare(OWN, plan.planId, 3, today), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'no cycle for a paused plan');
  const p4v = (await success(() => setState(OWN, plan.planId, 3, 'ACTIVE'), 'resume')).data.plan;
  ok(p4v.state === 'ACTIVE' && p4v.version === 4, 'resumed');

  // 7. Prepare today's cycle: refusals, then ISSUED invoices with the sibling discount; schedules move to their next period.
  await refused(async () => prepare(OWN, plan.planId, 4, await localDay(8)), 422, 'SCHOOL_PAY_AUTOPAY_TOO_EARLY', 'more than seven days ahead');
  await refused(() => prepare(OWN, plan.planId, 4, '2026-02-30'), 400, 'VALIDATION_FAILED', 'not a calendar date');
  await refused(() => prepare(OWN, plan.planId, 3, today), 409, 'VERSION_CONFLICT', 'stale plan version for a cycle');
  await refused(() => prepare(READER, plan.planId, 4, today), 403, 'SCHOOL_PAY_AUTOPAY_FORBIDDEN', 'reader cannot prepare');
  const before = Object.fromEntries((await sql('SELECT id, next_charge_at FROM hon.membership_payment_schedules WHERE organization_id=$1', [ids.organization])).rows.map((r) => [r.id, r.next_charge_at.toISOString()]));
  const cycleKey = randomUUID();
  const cyc = (await success(() => prepare(AUTOPAYER, plan.planId, 4, today, { key: cycleKey }), 'prepare today')).data.cycle;
  ok(cyc.cycleDate === today && cyc.currency === 'USD' && cyc.subtotalMinor === 37000 && cyc.discountMinor === 2600 && cyc.totalMinor === 34400 && cyc.discountRuleVersion === 1
    && cyc.state === 'READY' && cyc.methodId === bank.methodId && cyc.lines.length === 4, 'one cycle for the combined charge, with the plan method');
  const invoices = (await sql('SELECT i.*, l.student_rank FROM hon.invoices i JOIN hon.school_pay_autopay_cycle_lines l ON l.invoice_id=i.id WHERE l.cycle_id=$1 ORDER BY l.student_rank, i.subtotal_minor DESC', [cyc.cycleId])).rows;
  ok(invoices.length === 4 && invoices.every((i) => i.status === 'ISSUED' && i.currency === 'USD' && i.billing_account_id === P1 && i.total_minor === i.subtotal_minor - i.discount_minor),
    'four ISSUED invoices for payer 1');
  ok((await sql('SELECT count(*)::int n FROM hon.school_pay_autopay_cycle_lines WHERE cycle_id=$1 AND series_anchor_at=period_at', [cyc.cycleId])).rows[0].n === 4,
    'each first billed period anchors its own series');
  ok(invoices.map((i) => `${i.subtotal_minor}-${i.discount_minor}`).join() === '15000-0,4000-0,10000-1000,8000-1600', 'each invoice carries its line and discount');
  const dueLocal = (await sql("SELECT to_char($1::timestamptz AT TIME ZONE $2,'YYYY-MM-DD HH24:MI:SS') d", [invoices[0].due_at, LA])).rows[0].d;
  ok(dueLocal === `${today} 23:59:59`, `invoices are due at the end of the cycle day in the school time zone (${dueLocal})`);
  const after = Object.fromEntries((await sql('SELECT id, next_charge_at FROM hon.membership_payment_schedules WHERE organization_id=$1', [ids.organization])).rows.map((r) => [r.id, r.next_charge_at?.toISOString() ?? null]));
  const localOf = async (iso) => (await sql("SELECT to_char($1::timestamptz AT TIME ZONE $2,'YYYY-MM-DD HH24:MI') d", [iso, LA])).rows[0].d;
  const plusMonth = (await sql("SELECT to_char((($1::date+interval '1 month')::date),'YYYY-MM-DD') d", [today])).rows[0].d;
  ok(await localOf(after[anaMonthly.scheduleId]) === `${plusMonth} 12:00` && await localOf(after[benMonthly.scheduleId]) === `${plusMonth} 12:00`, 'monthly schedules move one month, same local time');
  // Review P2: months count from the schedule's anchor, so a short month clamps only that period (no drift to the 28th).
  { const next = async (at, frequency, anchor) => (await sql(`SELECT to_char(hon.school_pay_next_period($1::timestamptz,$2,$3,NULL,$4::timestamptz) AT TIME ZONE $3,'YYYY-MM-DD HH24:MI') d`,
      [at, frequency, LA, anchor])).rows[0].d;
    const local = (text) => sql('SELECT ($1::timestamp AT TIME ZONE $2)::text t', [text, LA]).then((r) => r.rows[0].t);
    const jan31 = await local('2027-01-31 18:00');
    ok(await next(jan31, 'MONTHLY', jan31) === '2027-02-28 18:00', 'Jan 31 -> Feb 28');
    ok(await next(await local('2027-02-28 18:00'), 'MONTHLY', jan31) === '2027-03-31 18:00', 'Feb 28 -> Mar 31 from the Jan 31 anchor');
    ok(await next(await local('2027-03-31 18:00'), 'MONTHLY', jan31) === '2027-04-30 18:00', 'Mar 31 -> Apr 30');
    ok(await next(await local('2027-04-30 18:00'), 'MONTHLY', jan31) === '2027-05-31 18:00', 'Apr 30 -> May 31');
    const leap = await local('2028-02-29 09:00');
    ok(await next(leap, 'ANNUAL', leap) === '2029-02-28 09:00', 'Feb 29 annual -> Feb 28');
    ok(await next(await local('2031-02-28 09:00'), 'ANNUAL', leap) === '2032-02-29 09:00', 'and back to Feb 29 in the next leap year');
    const dst = await local('2027-02-14 12:00');
    ok(await next(await local('2027-03-14 12:00'), 'MONTHLY', dst) === '2027-04-14 12:00', 'monthly across the DST change keeps local noon');
    ok(await next(await local('2027-03-10 12:00'), 'WEEKLY', null) === '2027-03-17 12:00', 'weekly across the DST change keeps local noon');
    ok(await next(await local('2027-03-15 18:00'), 'MONTHLY', jan31) === '2027-04-15 18:00', 'a schedule moved off its series starts a new one');
    ok(await next(jan31, 'MONTHLY', null) === '2027-02-28 18:00', 'no anchor: the period itself');
    // Review P3: each line stores its series anchor, so a schedule moved to the 31st keeps the 31st after its first step.
    const series = async (prevAt, prevAnchor, at, frequency = 'MONTHLY') => (await sql(`SELECT to_char(hon.school_pay_series_anchor($1::timestamptz,$2::timestamptz,$3::timestamptz,$4,$5) AT TIME ZONE $5,'YYYY-MM-DD HH24:MI') d`,
      [prevAt, prevAnchor, at, frequency, LA])).rows[0].d;
    const jan15 = await local('2027-01-15 18:00'); const feb15 = await local('2027-02-15 18:00'); const mar31 = await local('2027-03-31 18:00');
    ok(await series(null, null, jan15) === '2027-01-15 18:00', 'the first period starts its own series');
    ok(await series(jan15, jan15, feb15) === '2027-01-15 18:00', 'the next on-series period keeps the anchor');
    ok(await series(feb15, jan15, mar31) === '2027-03-31 18:00', 'a schedule moved to Mar 31 starts a new series');
    ok(await next(mar31, 'MONTHLY', mar31) === '2027-04-30 18:00', 'moved series: Mar 31 -> Apr 30');
    const apr30 = await local('2027-04-30 18:00');
    ok(await series(mar31, mar31, apr30) === '2027-03-31 18:00', 'Apr 30 continues the Mar 31 series');
    ok(await next(apr30, 'MONTHLY', mar31) === '2027-05-31 18:00', 'moved series: Apr 30 -> May 31 (no drift to the 30th)');
    ok(await series(jan31, jan31, await local('2027-02-28 18:00')) === '2027-01-31 18:00', 'a clamped Feb 28 stays on the Jan 31 series');
    ok(await series(jan15, jan15, feb15, 'WEEKLY') === '2027-02-15 18:00', 'weekly: a period that is not the next week starts a new series');
  }
  ok(await localOf(after[anaWeekly.scheduleId]) === `${await localDay(7)} 12:00`, 'the weekly schedule moves seven days');
  ok(after[cyMonthly.scheduleId] === null, 'a schedule whose next period passes the term end has no next charge');
  ok([later, frozen, custom, paused, euro, p2line].every((x) => after[x.scheduleId] === before[x.scheduleId]), 'every other schedule is untouched');
  const replay = await success(() => prepare(AUTOPAYER, plan.planId, 4, today, { key: cycleKey }), 'cycle replay');
  ok(replay.meta.replayed === true && replay.data.cycle.cycleId === cyc.cycleId, 'a replay returns the stored cycle');
  await refused(() => prepare(AUTOPAYER, plan.planId, 4, today), 409, 'SCHOOL_PAY_AUTOPAY_NOTHING_DUE', 'nothing is billed twice');
  ok((await sql('SELECT count(*)::int n FROM hon.invoices WHERE organization_id=$1', [ids.organization])).rows[0].n === 4, 'no extra invoice from the replay or the refusal');
  const a1 = (await success(() => readAutopay(OWN, P1), 'read after the cycle')).data;
  ok(a1.cycles.length === 1 && a1.cycles[0].cycleId === cyc.cycleId && a1.preview.cycleDate === await localDay(7) && a1.preview.lines.length === 1
    && a1.preview.lines[0].scheduleId === anaWeekly.scheduleId && a1.preview.lines[0].discountMinor === 0, 'the next preview is the weekly line in seven days');

  // 8. A FIXED rule (version 2) applies only in its currency; the week-ahead cycle bills only the weekly line.
  const v2 = (await success(() => setRule(OWN, { basedOnVersion: 1, kind: 'FIXED', secondValue: 500, laterValue: 700, currency: 'USD' }), 'fixed rule')).data.rule;
  ok(v2.version === 2 && v2.kind === 'FIXED' && v2.currency === 'USD', 'rule version 2');
  const history = (await success(() => readRule(OWN), 'rule history')).data;
  ok(history.rule.version === 2 && history.history.map((r) => r.version).join() === '2,1', 'history newest first');
  const cyc2 = (await success(async () => prepare(OWN, plan.planId, 4, await localDay(7)), 'prepare the week-ahead cycle')).data.cycle;
  ok(cyc2.lines.length === 1 && cyc2.totalMinor === 4000 && cyc2.discountMinor === 0 && cyc2.discountRuleVersion === 2, 'one line, rank 1, no discount');

  // 9. The plan method stops being usable when removed: no cycle; staff switch back to the card.
  ok((await call(OWN, 'POST', `/payers/${P1}/methods/${bank.methodId}/remove`, { body: { expectedVersion: (await sql('SELECT version FROM hon.school_pay_methods WHERE id=$1', [bank.methodId])).rows[0].version, reason: 'Account closed' }, command: COMMAND.remove })).status === 200, 'bank account removed');
  await sql("UPDATE hon.membership_payment_schedules SET next_charge_at=$2 WHERE id=$1", [later.scheduleId, await localNoon(0)]);
  await refused(() => prepare(OWN, plan.planId, 4, today), 422, 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE', 'a removed plan method cannot be charged');
  const a2 = (await success(() => readAutopay(OWN, P1), 'read after removal')).data;
  ok(a2.methods.length === 1 && a2.methods[0].method.methodId === visa.methodId, 'the removed method is no longer offered');
  ok((await success(() => changeMethod(OWN, plan.planId, 4, visa.methodId), 'back to the Visa')).data.plan.version === 5, 'plan version 5');
  const cyc3 = (await success(() => prepare(OWN, plan.planId, 5, today), 'prepare the late line')).data.cycle;
  ok(cyc3.lines.length === 1 && cyc3.lines[0].scheduleId === later.scheduleId && cyc3.lines[0].studentRank === 1 && cyc3.methodId === visa.methodId, 'a single due student is rank 1');

  // 10. Cancel: reason required, final; payer 1 can enroll again; payer 2 enrolls on its own card.
  await refused(() => cancel(OWN, plan.planId, 5, ''), 400, 'VALIDATION_FAILED', 'cancel without a reason');
  const cancelled = (await success(() => cancel(OWN, plan.planId, 5, 'Family pays at the front desk now'), 'cancel')).data.plan;
  ok(cancelled.state === 'CANCELLED' && cancelled.endReason === 'Family pays at the front desk now' && cancelled.endedAt !== null && cancelled.version === 6, 'cancelled with the reason');
  await refused(() => cancel(OWN, plan.planId, 6, 'again'), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'cancel twice');
  await refused(() => changeMethod(OWN, plan.planId, 6, visa.methodId), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'a cancelled plan cannot change');
  await refused(() => setState(OWN, plan.planId, 6, 'PAUSED'), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'a cancelled plan cannot pause');
  await refused(() => prepare(OWN, plan.planId, 6, today), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'a cancelled plan prepares nothing');
  const again = (await success(() => enroll(OWN, P1, visa.methodId), 're-enroll')).data.plan;
  ok(again.planId !== plan.planId && again.state === 'ACTIVE', 'a new plan after cancellation');
  const a3 = (await success(() => readAutopay(OWN, P1), 'read after re-enroll')).data;
  ok(a3.plan.planId === again.planId && a3.pastPlans.length === 1 && a3.pastPlans[0].planId === plan.planId && a3.cycles.length === 3, 'the cancelled plan and earlier cycles are kept');
  const p2plan = (await success(() => enroll(OWN, P2, p2card.methodId), 'payer 2 enrolls')).data.plan;
  const p2cyc = (await success(() => prepare(OWN, p2plan.planId, 1, today), 'payer 2 cycle')).data.cycle;
  ok(p2cyc.lines.length === 1 && p2cyc.totalMinor === 12000 && p2cyc.billingAccountId === P2, 'payer 2 is billed only for its own membership');

  // 11. Live authority loss: revoked grant, suspended entitlement, suspended school.
  ok((await success(() => readAutopay(LOSER, P1), 'loser read before')).data.canManage === true, 'loser manages before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => readAutopay(LOSER, P1), 403, undefined, `${label}: read`);
    await refused(() => setState(LOSER, again.planId, 1, 'PAUSED'), 403, undefined, `${label}: pause`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => readAutopay(LOSER, P1), 'loser read after')).data.canManage === true, 'authority restored');

  // 12. History, audit and inert outbox per command; one audit row per autopay invoice.
  const planEvents = (await sql('SELECT kind FROM hon.school_pay_autopay_events WHERE entity_id=$1 ORDER BY entity_version', [plan.planId])).rows.map((x) => x.kind);
  ok(planEvents.join() === 'PLAN_ENROLLED,PLAN_METHOD_CHANGED,PLAN_PAUSED,PLAN_RESUMED,PLAN_METHOD_CHANGED,PLAN_CANCELLED', `plan history ${planEvents.join()}`);
  const events = (await sql('SELECT count(*)::int n FROM hon.school_pay_autopay_events WHERE organization_id=$1', [ids.organization])).rows[0].n;
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type LIKE 'SCHOOL_PAY_AUTOPAY_%'", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type LIKE 'SCHOOL_PAY_AUTOPAY_%'", [ids.organization])).rows[0].n;
  ok(events === 14 && audit === events && outbox === events, `one audit and one outbox event per history row (${events}/${audit}/${outbox})`);
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type LIKE 'SCHOOL_PAY_AUTOPAY_%' AND status<>'PENDING'", [ids.organization])).rows[0].n === 0, 'outbox events are inert');
  const invoiceCount = (await sql('SELECT count(*)::int n FROM hon.invoices WHERE organization_id=$1', [ids.organization])).rows[0].n;
  ok(invoiceCount === 7 && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_pay.autopay.invoice'", [ids.organization])).rows[0].n === invoiceCount, 'one audit row per autopay invoice');

  // 13. Settings-free guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_pay_autopay_plans SET state='ACTIVE', ended_at=NULL, ended_by_principal_id=NULL, end_reason=NULL, version=version+1 WHERE id=$1", [plan.planId]), /SCHOOL_PAY_AUTOPAY_IMMUTABLE/, 'cancelled plan reopened');
  await rejectsSql(() => sql("UPDATE hon.school_pay_autopay_plans SET consent_text_version='other-v9', version=version+1 WHERE id=$1", [again.planId]), /SCHOOL_PAY_AUTOPAY_IMMUTABLE/, 'consent rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_pay_autopay_plans SET billing_account_id=$2, version=version+1 WHERE id=$1", [again.planId, P2]), /SCHOOL_PAY_AUTOPAY_IMMUTABLE|violates/, 'plan moved to another payer');
  await rejectsSql(() => sql("UPDATE hon.school_pay_autopay_plans SET state='PAUSED' WHERE id=$1", [again.planId]), /SCHOOL_PAY_AUTOPAY_IMMUTABLE/, 'update without a version bump');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_autopay_plans WHERE id=$1', [again.planId]), /SCHOOL_PAY_AUTOPAY_IMMUTABLE/, 'plan deleted');
  await rejectsSql(() => sql("INSERT INTO hon.school_pay_autopay_plans(organization_id,school_id,billing_account_id,method_id,consent_text_version,created_by_principal_id) VALUES($1,$2,$3,$4,'autopay-v1',$5)", [ids.organization, ids.schoolA, P1, visa.methodId, OWN.principal]), /duplicate key|unique/, 'a second open plan');
  await rejectsSql(() => sql('UPDATE hon.school_pay_autopay_cycles SET total_minor=1 WHERE id=$1', [cyc.cycleId]), /IMMUTABLE/, 'cycle rewritten');
  await rejectsSql(() => sql('UPDATE hon.school_pay_autopay_cycle_lines SET discount_minor=0 WHERE cycle_id=$1', [cyc.cycleId]), /IMMUTABLE/, 'line rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_autopay_cycle_lines WHERE cycle_id=$1', [cyc.cycleId]), /IMMUTABLE/, 'line deleted');
  await rejectsSql(() => sql(`INSERT INTO hon.school_pay_autopay_cycle_lines(organization_id,school_id,cycle_id,membership_id,schedule_id,period_at,series_anchor_at,student_rank,amount_minor,discount_minor,invoice_id)
    SELECT organization_id,school_id,cycle_id,membership_id,schedule_id,period_at,series_anchor_at,student_rank,amount_minor,discount_minor,$2 FROM hon.school_pay_autopay_cycle_lines WHERE cycle_id=$1 LIMIT 1`, [cyc.cycleId, invoices[0].id]), /duplicate key|unique/, 'one schedule period billed twice');
  await rejectsSql(() => sql('UPDATE hon.school_pay_discount_rules SET second_value=50 WHERE version=1 AND organization_id=$1', [ids.organization]), /IMMUTABLE/, 'rule rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_discount_rules WHERE organization_id=$1', [ids.organization]), /IMMUTABLE/, 'rule deleted');
  await rejectsSql(() => sql("INSERT INTO hon.school_pay_discount_rules(organization_id,school_id,version,kind,second_value,later_value,created_by_principal_id) VALUES($1,$2,3,'PERCENT',150,0,$3)", [ids.organization, ids.schoolA, OWN.principal]), /check/i, 'a rule above 100 percent');
  await rejectsSql(() => sql("UPDATE hon.school_pay_autopay_events SET kind='PLAN_ENROLLED' WHERE entity_id=$1", [plan.planId]), /IMMUTABLE/, 'history rewritten');
  await rejectsSql(() => sql('TRUNCATE hon.school_pay_autopay_cycles CASCADE'), /./, 'cycles truncated');
  await sql('ROLLBACK');

  // 14. Runtime ACL: EXECUTE on the eight entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['read_school_pay_autopay(text,uuid)', 'read_school_pay_discount_rule(text)', 'set_school_pay_discount_rule(text,jsonb,text,uuid,uuid)',
    'enroll_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid)', 'change_school_pay_autopay_method(text,uuid,jsonb,text,uuid,uuid)', 'set_school_pay_autopay_state(text,uuid,jsonb,text,uuid,uuid)',
    'cancel_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid)', 'prepare_school_pay_autopay_cycle(text,uuid,jsonb,text,uuid,uuid)'];
  const helpers = ['guard_school_pay_autopay_plan()', 'require_school_pay_autopay_actor(text,text)', 'require_school_pay_autopay_reader(text,text[])', 'school_pay_school_zone()',
    'school_pay_discount_rule_json(hon.school_pay_discount_rules)', 'school_pay_autopay_plan_json(hon.school_pay_autopay_plans)', 'school_pay_current_discount_rule()',
    'school_pay_sibling_discount(hon.school_pay_discount_rules,integer,integer,text)', 'school_pay_next_period(timestamp with time zone,text,text,timestamp with time zone,timestamp with time zone)',
    'school_pay_series_anchor(timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)', 'school_pay_autopay_due(uuid,date,text,hon.school_pay_discount_rules)', 'school_pay_autopay_cycle_json(hon.school_pay_autopay_cycles)', 'school_pay_autopay_method_usable(uuid,uuid)',
    'school_pay_autopay_begin(text,text,text,text)', 'school_pay_autopay_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid)',
    'school_pay_autopay_complete(text,text,text,uuid,jsonb)', 'school_pay_lock_autopay_plan(uuid,integer)'];
  for (const fn of entry) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['school_pay_discount_rules', 'school_pay_autopay_plans', 'school_pay_autopay_cycles', 'school_pay_autopay_cycle_lines', 'school_pay_autopay_events']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.require_school_pay_autopay_actor('x','school_pay.read')"), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.read_school_pay_discount_rule('x')"), /SCHOOL_PAY_READ_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0322 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School autopay exact verification (B-TUI-2 0322)', end = '-- End school autopay exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // Review P3: a discount that makes a line free refuses the cycle (an ISSUED invoice is never zero) and writes nothing.
  ok((await success(() => setRule(OWN, { basedOnVersion: 2, kind: 'PERCENT', secondValue: 100, laterValue: 100 }), '100 percent rule')).data.rule.version === 3, 'rule version 3');
  for (const x of [anaMonthly, benMonthly]) await sql('UPDATE hon.membership_payment_schedules SET next_charge_at=$2 WHERE id=$1', [x.scheduleId, await localNoon(2)]);
  const cyclesBefore = (await sql('SELECT count(*)::int n FROM hon.school_pay_autopay_cycles WHERE billing_account_id=$1', [P1])).rows[0].n;
  await refused(async () => prepare(OWN, again.planId, 1, await localDay(2)), 422, 'SCHOOL_PAY_AUTOPAY_ZERO_LINE', 'a free second student refuses the cycle');
  ok((await sql('SELECT count(*)::int n FROM hon.school_pay_autopay_cycles WHERE billing_account_id=$1', [P1])).rows[0].n === cyclesBefore, 'no cycle or invoice was written');

  // 15. No money moved: no payment attempt; the only invoices are the autopay cycle invoices.
  ok((await sql('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n === 0, 'no payment attempt was created');
  ok((await sql('SELECT count(*)::int n FROM hon.invoices i WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM hon.school_pay_autopay_cycle_lines l WHERE l.invoice_id=i.id)', [ids.organization])).rows[0].n === 0, 'every invoice belongs to a cycle line');

  console.log(`PASS: school autopay and sibling discounts (0322): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
