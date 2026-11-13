/**
 * School autopay charge proof (B-TUI-2 piece 5a, 0337) over signed HTTP (HON session cookie -> HonIdentityGuard + human
 * UI guards + global ValidationPipe + HonExceptionFilter -> SchoolPayAutopayController -> SchoolPayChargeService ->
 * protected definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture
 * only. The processors are the in-process simulators (no network, no credentials). Test mode only; synthetic data; no
 * message is sent and HON takes no fee.
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
const { SchoolPayChargeService } = await load('school-payments/school-pay-charge.service.js');
const { SchoolPayChargeController } = await load('school-payments/school-pay-charge.controller.js');
const { SCHOOL_PAYMENT_ADAPTERS, SimulatedStripeConnectAdapter, SimulatedSquareAdapter, UnconfiguredSchoolPaymentAdapter } = await load('school-payments/school-payment-adapter.js');
const { SCHOOL_PAYMENT_VAULT, SchoolPaymentVault } = await load('school-payments/school-payment-vault.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-pay-charges', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const stripe = new SimulatedStripeConnectAdapter();
const square = new SimulatedSquareAdapter();
const adapters = new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]);
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolPaymentController, SchoolPayMethodController, SchoolPayAutopayController, SchoolPayChargeController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolPaymentService, SchoolPayMethodService, SchoolPayAutopayService, SchoolPayChargeService,
      { provide: RuntimeDatabaseService, useValue: database }, { provide: SCHOOL_PAYMENT_ADAPTERS, useValue: adapters }, { provide: SCHOOL_PAYMENT_VAULT, useValue: new SchoolPaymentVault(randomBytes(32), 'proof-0337') }],
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
  read: 'school_pay.autopay.read', enroll: 'school_pay.autopay.enroll', state: 'school_pay.autopay.state', cycle: 'school_pay.autopay.cycle',
  charge: 'school_pay.autopay.charge', reconcile: 'school_pay.autopay.reconcile',
  setup: 'school_pay.method.setup', finish: 'school_pay.method.finish',
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
const readCharges = (actor, payer, options = {}) => call(actor, 'GET', `/payers/${payer}/autopay/charges`, options);
const enroll = (actor, payer, methodId, options = {}) => call(actor, 'POST', `/payers/${payer}/autopay`, { body: { methodId, consentTextVersion: 'autopay-v1' }, command: COMMAND.enroll, ...options });
const setState = (actor, plan, expectedVersion, state, options = {}) => call(actor, 'POST', `/autopay/${plan}/state`, { body: { expectedVersion, state }, command: COMMAND.state, ...options });
const prepare = (actor, plan, expectedVersion, cycleDate, options = {}) => call(actor, 'POST', `/autopay/${plan}/cycles`, { body: { expectedVersion, cycleDate }, command: COMMAND.cycle, ...options });
const charge = (actor, cycle, totalMinor, currency = 'USD', options = {}) => call(actor, 'POST', `/autopay/cycles/${cycle}/charge`, { body: { totalMinor, currency }, command: COMMAND.charge, ...options });
const reconcile = (actor, attempt, options = {}) => call(actor, 'POST', `/autopay/charges/${attempt}/reconcile`, { body: {}, command: COMMAND.reconcile, ...options });
const LEAK = /cus_sim|pm_sim|acct_sim|seti_sim|pi_sim|sqpay_sim|SQCUSTSIM|ccof:sim|MLSIM/;
async function success(run, label) {
  const { status, body, headers, text } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  ok(!LEAK.test(text), `${label}: no provider reference reaches the browser`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}
/** A direct owner-connection write that must be refused; each runs in its own transaction, rolled back. */
async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_pay_charge_attempts WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left charge fixtures behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`charge-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`charge-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`charge-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `charge-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Charge Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Charge Staff')", [principal, user]);
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


let OWN, READER, NONE, AUTOPAYER, OWN_B;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Charge Org','Charge Org'),($2,'Charge Other Org','Charge Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Charge ${slug}`, `charge-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['school_pay.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'school_pay.method.manage', 'school_pay.discount.manage'])]);
  AUTOPAYER = await staff('autopayer', [await role(ids.organization, ['school_pay.autopay.manage'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_pay.autopay.manage', 'school_pay.read'])], { school: ids.schoolB });
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
async function saveMethod(actor, billingAccount, connectionId, kind = 'CARD', consent = kind === 'CARD' ? 'card-on-file-v1' : 'ach-mandate-v1') {
  const started = await call(actor, 'POST', `/payers/${billingAccount}/method-setups`, { body: { connectionId, methodKinds: [kind], consentTextVersion: consent }, command: COMMAND.setup });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.data.setupUrl).searchParams.get('state');
  const done = await call(actor, 'POST', `/payers/${billingAccount}/method-setups/${started.body.data.setup.setupId}/finish`, { body: { expectedVersion: 1, setupState: state }, command: COMMAND.finish });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.data.method;
}
/** One payer with a saved method, autopay on it, and today's cycle prepared (two students; the second gets no discount). */
async function prepared(label, connectionId, { kind = 'CARD', amounts = [12000, 8000], school = ids.schoolA, actor = OWN, consent } = {}) {
  const payerId = await payer(label, 'Family', { school });
  const method = await saveMethod(actor, payerId, connectionId, kind, consent);
  for (const [i, amount] of amounts.entries()) await membership(payerId, await person(`${label}${i}`, 'Family', { school }), `PLAN_${i}`, { amount, school });
  const plan = (await success(() => enroll(actor, payerId, method.methodId), `${label}: enroll`)).data.plan;
  const cycle = (await success(async () => prepare(actor, plan.planId, 1, await localDay(0)), `${label}: prepare`)).data.cycle;
  return { payer: payerId, method, plan, cycle };
}
const invoicesOf = (cycleId) => sql(`SELECT i.id,i.status::text status,i.total_minor,(SELECT count(*)::int FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id) records
  FROM hon.invoices i JOIN hon.school_pay_autopay_cycle_lines l ON l.invoice_id=i.id WHERE l.cycle_id=$1 ORDER BY i.id`, [cycleId]).then((r) => r.rows);
const attemptRow = (id) => sql('SELECT * FROM hon.school_pay_charge_attempts WHERE id=$1', [id]).then((r) => r.rows[0]);
const manualPayment = (invoiceId) => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
  SELECT organization_id,school_id,id,total_minor,currency,current_date,'CASH',$2 FROM hon.invoices WHERE id=$1`, [invoiceId, OWN.principal]);

try {
  await cleanup();
  await seed();
  await startApp();
  const stripeConn = await connect(OWN, 'STRIPE_CONNECT');
  const squareConn = await connect(OWN, 'SQUARE');

  // 1. A card charge that succeeds: refusals first, then one attempt, PROVIDER payments, PAID invoices; replay and re-charge.
  const a = await prepared('Avery', stripeConn.connectionId);
  ok(a.cycle.totalMinor === 20000 && a.cycle.lines.length === 2, 'cycle of 200.00 with two invoices');
  const empty = (await success(() => readCharges(OWN, a.payer), 'owner reads charges')).data;
  ok(empty.canManage === true && empty.platformFee === 'NONE' && empty.attempts.length === 0, 'no attempt yet, no fee');
  ok((await success(() => readCharges(READER, a.payer), 'reader reads charges')).data.canManage === false, 'a reader cannot charge');
  await refused(() => readCharges(NONE, a.payer), 403, 'SCHOOL_PAY_READ_FORBIDDEN', 'charges read refused without permission');
  await refused(() => readCharges(OWN, a.payer, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'charges read with a key');
  for (const actor of [READER, NONE]) await refused(() => charge(actor, a.cycle.cycleId, 20000), 403, 'SCHOOL_PAY_AUTOPAY_FORBIDDEN', `charge refused for ${actor.subject.split('-').pop()}`);
  await refused(() => charge(OWN, a.cycle.cycleId, 19999), 422, 'SCHOOL_PAY_CHARGE_AMOUNT_MISMATCH', 'a total that is not the cycle total');
  await refused(() => charge(OWN, a.cycle.cycleId, 20000, 'EUR'), 422, 'SCHOOL_PAY_CHARGE_AMOUNT_MISMATCH', 'another currency');
  for (const body of [{ totalMinor: 0, currency: 'USD' }, { totalMinor: 20000, currency: 'usd' }, { totalMinor: 200.5, currency: 'USD' }, { totalMinor: 20000 }]) {
    await refused(() => call(OWN, 'POST', `/autopay/cycles/${a.cycle.cycleId}/charge`, { body, command: COMMAND.charge }), 400, 'VALIDATION_FAILED', `bad charge body ${JSON.stringify(body)}`);
  }
  await refused(() => call(OWN, 'POST', `/autopay/cycles/${a.cycle.cycleId}/charge`, { body: { totalMinor: 20000, currency: 'USD', applicationFee: 1 }, command: COMMAND.charge }), 400, undefined, 'unknown field (no fee field)');
  await refused(() => charge(OWN, a.cycle.cycleId, 20000, 'USD', { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'charge without a key');
  await refused(() => charge(OWN, a.cycle.cycleId, 20000, 'USD', { command: COMMAND.cycle }), 403, 'HUMAN_UI_REQUIRED', 'charge under another command header');
  await refused(() => charge(OWN, randomUUID(), 20000), 404, 'SCHOOL_PAY_CYCLE_NOT_FOUND', 'unknown cycle');
  await refused(() => charge(OWN_B, a.cycle.cycleId, 20000, 'USD', { school: ids.schoolB }), 404, 'SCHOOL_PAY_CYCLE_NOT_FOUND', 'a school-A cycle at the school-B route');
  await refused(() => charge(OWN_B, a.cycle.cycleId, 20000, 'USD', { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  ok(stripe.chargeCalls === 0, 'no refusal reached the processor');
  const key = randomUUID();
  const paid = (await success(() => charge(AUTOPAYER, a.cycle.cycleId, 20000, 'USD', { key }), 'autopay manager charges the cycle')).data.attempt;
  ok(paid.state === 'SUCCEEDED' && paid.version === 2 && paid.amountMinor === 20000 && paid.currency === 'USD' && paid.failureClass === null && paid.finishedAt
    && paid.methodId === a.method.methodId && paid.providerCode === 'STRIPE_CONNECT' && paid.platformFee === 'NONE', 'attempt SUCCEEDED for 200.00, no fee');
  ok(stripe.chargeCalls === 1, 'the processor was called once');
  const held = stripe.charges.get(`hon-school-pay-charge-${paid.attemptId}`);
  ok(held && held.amountMinor === 20000 && held.currency === 'USD' && held.methodRef && held.customerRef, 'the processor holds one charge with the attempt key');
  const aInv = await invoicesOf(a.cycle.cycleId);
  ok(aInv.length === 2 && aInv.every((i) => i.status === 'PAID' && i.records === 1), 'both cycle invoices PAID with one record each');
  const recs = (await sql(`SELECT r.* FROM hon.invoice_payment_records r JOIN hon.school_pay_autopay_cycle_lines l ON l.invoice_id=r.invoice_id WHERE l.cycle_id=$1`, [a.cycle.cycleId])).rows;
  ok(recs.every((r) => r.method === 'PROVIDER' && r.reference === held.chargeRef && r.actor_principal_id === AUTOPAYER.principal && r.voided_at === null)
    && recs.reduce((s, r) => s + r.amount_minor, 0) === 20000, 'PROVIDER records carry the processor charge id and sum to the charge');
  const row = await attemptRow(paid.attemptId);
  ok(row.provider_charge_ref === held.chargeRef && row.connection_id === stripeConn.connectionId, 'the attempt keeps the charge id (API side only)');
  const events = (await sql('SELECT kind,attempt_version FROM hon.school_pay_charge_events WHERE attempt_id=$1 ORDER BY attempt_version', [paid.attemptId])).rows;
  ok(events.map((e) => `${e.kind}:${e.attempt_version}`).join() === 'CHARGE_STARTED:1,CHARGE_SUCCEEDED:2', 'history: started, succeeded');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code IN ('school_pay.charge.started','school_pay.charge.succeeded')", [paid.attemptId])).rows[0].n === 2, 'two attempt audit rows');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='school_pay.charge.invoice_paid' AND entity_id = ANY($1::uuid[])", [aInv.map((i) => i.id)])).rows[0].n === 2, 'one paid audit row per invoice');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type LIKE 'school_pay.charge.%'", [paid.attemptId])).rows[0].n === 2, 'two inert outbox events');
  const replay = await success(() => charge(AUTOPAYER, a.cycle.cycleId, 20000, 'USD', { key }), 'charge replay');
  ok(replay.meta.replayed === true && replay.data.attempt.attemptId === paid.attemptId && replay.data.attempt.state === 'SUCCEEDED' && stripe.chargeCalls === 1, 'a replay returns the settled attempt without calling the processor');
  await refused(() => charge(AUTOPAYER, a.cycle.cycleId, 19000, 'USD', { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'charge key reuse');
  await refused(() => charge(OWN, a.cycle.cycleId, 20000), 409, 'SCHOOL_PAY_CHARGE_EXISTS', 'a paid cycle is never charged again');
  await refused(() => reconcile(OWN, paid.attemptId), 409, 'SCHOOL_PAY_CHARGE_STATE', 'a settled attempt cannot be reconciled');
  await rejectsSql(() => sql("UPDATE hon.invoice_payment_records SET voided_at=clock_timestamp(),voided_by_principal_id=$2,void_reason='x' WHERE id=$1", [recs[0].id, OWN.principal]), /SCHOOL_PAY_PROVIDER_PAYMENT_LOCKED/, 'a PROVIDER record is never voided by hand');
  const list = (await success(() => readCharges(READER, a.payer), 'charges listed')).data.attempts;
  ok(list.length === 1 && list[0].attemptId === paid.attemptId && list[0].state === 'SUCCEEDED', 'the payer read lists the attempt');
  ok(stripe.charges.size === 1, 'still one charge at the processor');

  // 2. A bank debit: PROCESSING; the invoices are held for the charge; reconcile until the processor settles it.
  const b = await prepared('Blake', stripeConn.connectionId, { kind: 'US_BANK_ACCOUNT', amounts: [9000] });
  const proc = (await success(() => charge(OWN, b.cycle.cycleId, 9000), 'bank debit charge')).data.attempt;
  ok(proc.state === 'PROCESSING' && proc.finishedAt === null && proc.version === 2, 'a bank debit is PROCESSING');
  const bInv = await invoicesOf(b.cycle.cycleId);
  ok(bInv.every((i) => i.status === 'ISSUED' && i.records === 0), 'invoices stay ISSUED while it clears');
  await rejectsSql(() => manualPayment(bInv[0].id), /SCHOOL_PAY_CHARGE_IN_PROGRESS/, 'no manual payment while a charge is open');
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='VOID',version=version+1 WHERE id=$1", [bInv[0].id]), /SCHOOL_PAY_CHARGE_IN_PROGRESS/, 'no void while a charge is open');
  await refused(() => charge(OWN, b.cycle.cycleId, 9000), 409, 'SCHOOL_PAY_CHARGE_EXISTS', 'no second attempt while one is open');
  await refused(() => reconcile(READER, proc.attemptId), 403, 'SCHOOL_PAY_AUTOPAY_FORBIDDEN', 'reader cannot reconcile');
  await refused(() => call(OWN, 'POST', `/autopay/charges/${proc.attemptId}/reconcile`, { body: { outcome: 'SUCCEEDED' }, command: COMMAND.reconcile }), 400, undefined, 'reconcile takes no outcome from the browser');
  await refused(() => reconcile(OWN, randomUUID()), 404, 'SCHOOL_PAY_CHARGE_NOT_FOUND', 'unknown attempt');
  const still = (await success(() => reconcile(OWN, proc.attemptId), 'reconcile while clearing')).data.attempt;
  ok(still.state === 'PROCESSING' && still.version === 2, 'still PROCESSING: nothing written');
  stripe.settleCharge(proc.attemptId, 'SUCCEEDED');
  const cleared = (await success(() => reconcile(OWN, proc.attemptId), 'reconcile after it cleared')).data.attempt;
  ok(cleared.state === 'SUCCEEDED' && cleared.version === 3, 'the cleared debit is SUCCEEDED');
  ok((await invoicesOf(b.cycle.cycleId)).every((i) => i.status === 'PAID' && i.records === 1), 'and its invoice is PAID');
  ok(stripe.chargeCalls === 2, 'reconcile looked the charge up; it never charged again');

  // 3. A decline: FAILED with its class, invoices untouched, and the cycle can be charged again.
  const c = await prepared('Casey', stripeConn.connectionId, { amounts: [5000] });
  const firstKey = randomUUID();
  // The attempt id is only known after it is written, so the decline is set for whatever attempt comes next.
  const nextOutcome = (outcome) => { const original = stripe.chargeOffSession.bind(stripe); stripe.chargeOffSession = async (input) => { stripe.chargeOutcomes.set(input.attemptId, outcome); stripe.chargeOffSession = original; return original(input); }; };
  nextOutcome({ outcome: 'FAILED', failureClass: 'INSUFFICIENT_FUNDS' });
  const declined = (await success(() => charge(OWN, c.cycle.cycleId, 5000, 'USD', { key: firstKey }), 'declined charge')).data.attempt;
  ok(declined.state === 'FAILED' && declined.failureClass === 'INSUFFICIENT_FUNDS' && declined.finishedAt, 'FAILED INSUFFICIENT_FUNDS');
  ok((await invoicesOf(c.cycle.cycleId)).every((i) => i.status === 'ISSUED' && i.records === 0), 'a decline records no payment');
  await refused(() => reconcile(OWN, declined.attemptId), 409, 'SCHOOL_PAY_CHARGE_STATE', 'a failed attempt is final');
  const retried = (await success(() => charge(OWN, c.cycle.cycleId, 5000), 'charge again after a decline')).data.attempt;
  ok(retried.state === 'SUCCEEDED' && retried.attemptId !== declined.attemptId, 'a new attempt succeeds');
  ok((await invoicesOf(c.cycle.cycleId)).every((i) => i.status === 'PAID' && i.records === 1), 'invoice PAID once');
  const cList = (await success(() => readCharges(OWN, c.payer), 'two attempts listed')).data.attempts;
  ok(cList.length === 2 && cList.filter((x) => x.state !== 'FAILED').length === 1, 'one failed and one succeeded attempt');

  // 4. The answer is lost after the processor charged: UNKNOWN, held open, then settled from the processor's record.
  const d = await prepared('Drew', stripeConn.connectionId, { amounts: [7000] });
  nextOutcome({ lostAnswer: true });
  const lost = (await success(() => charge(OWN, d.cycle.cycleId, 7000), 'charge with a lost answer')).data.attempt;
  ok(lost.state === 'UNKNOWN' && lost.finishedAt === null, 'UNKNOWN, never assumed paid or failed');
  ok((await invoicesOf(d.cycle.cycleId)).every((i) => i.status === 'ISSUED' && i.records === 0), 'nothing recorded for an unknown outcome');
  await rejectsSql(async () => manualPayment((await invoicesOf(d.cycle.cycleId))[0].id), /SCHOOL_PAY_CHARGE_IN_PROGRESS/, 'no manual payment while the outcome is unknown');
  await refused(() => charge(OWN, d.cycle.cycleId, 7000), 409, 'SCHOOL_PAY_CHARGE_EXISTS', 'no retry until it is reconciled');
  const callsBefore = stripe.chargeCalls;
  const found = (await success(() => reconcile(OWN, lost.attemptId), 'reconcile the lost answer')).data.attempt;
  ok(found.state === 'SUCCEEDED' && stripe.chargeCalls === callsBefore, 'reconcile found the charge and did not resend');
  ok((await invoicesOf(d.cycle.cycleId)).every((i) => i.status === 'PAID' && i.records === 1), 'paid exactly once');

  // 5. The request never reached the processor: UNKNOWN, and reconcile resends with the same key inside the window.
  const e = await prepared('Emery', stripeConn.connectionId, { amounts: [6000] });
  nextOutcome({ neverArrived: true });
  const unsent = (await success(() => charge(OWN, e.cycle.cycleId, 6000), 'charge that never arrived')).data.attempt;
  ok(unsent.state === 'UNKNOWN', 'UNKNOWN when the request may not have arrived');
  const resent = (await success(() => reconcile(OWN, unsent.attemptId), 'reconcile resends')).data.attempt;
  ok(resent.state === 'SUCCEEDED' && stripe.charges.has(`hon-school-pay-charge-${unsent.attemptId}`), 'the resend with the same key charged once');

  // 6. A request that stopped after writing the attempt: a fresh PENDING attempt is charged by reconcile; one older than
  //    the provider key window and unknown to the processor is FAILED NOT_SENT.
  const f = await prepared('Finley', stripeConn.connectionId, { amounts: [4000] });
  const g = await prepared('Gray', stripeConn.connectionId, { amounts: [3000] });
  const stray = async (p, ageHours) => (await sql(`INSERT INTO hon.school_pay_charge_attempts(organization_id,school_id,billing_account_id,cycle_id,plan_id,method_id,connection_id,provider_code,
      amount_minor,currency,created_by_principal_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'STRIPE_CONNECT',$8,'USD',$9,clock_timestamp()-make_interval(hours=>$10),clock_timestamp()-make_interval(hours=>$10))
      RETURNING id`, [ids.organization, ids.schoolA, p.payer, p.cycle.cycleId, p.plan.planId, p.method.methodId, stripeConn.connectionId, p.cycle.totalMinor, AUTOPAYER.principal, ageHours])).rows[0].id;
  const freshStray = await stray(f, 1), oldStray = await stray(g, 30);
  const recovered = (await success(() => reconcile(OWN, freshStray), 'reconcile a stopped request')).data.attempt;
  ok(recovered.state === 'SUCCEEDED' && recovered.version === 2, 'a stopped request inside the window is charged once');
  const expired = (await success(() => reconcile(OWN, oldStray), 'reconcile an old stopped request')).data.attempt;
  ok(expired.state === 'FAILED' && expired.failureClass === 'NOT_SENT' && !stripe.charges.has(`hon-school-pay-charge-${oldStray}`), 'an old attempt the processor never saw is FAILED NOT_SENT, nothing charged');
  ok((await invoicesOf(g.cycle.cycleId)).every((i) => i.status === 'ISSUED'), 'its invoices can be charged again');
  ok((await success(() => charge(OWN, g.cycle.cycleId, 3000), 'charge after NOT_SENT')).data.attempt.state === 'SUCCEEDED', 'and are');

  // 7. Square (simulator) charges a card; a provider with no test credentials is FAILED NOT_SENT before anything is sent.
  const h = await prepared('Harper', squareConn.connectionId, { amounts: [11000] });
  adapters.set('SQUARE', new UnconfiguredSchoolPaymentAdapter('SQUARE'));
  const notSent = (await success(() => charge(OWN, h.cycle.cycleId, 11000), 'Square without credentials')).data.attempt;
  ok(notSent.state === 'FAILED' && notSent.failureClass === 'NOT_SENT' && square.chargeCalls === 0, 'FAILED NOT_SENT, nothing sent');
  adapters.set('SQUARE', square);
  const sq = (await success(() => charge(OWN, h.cycle.cycleId, 11000), 'Square sandbox charge')).data.attempt;
  ok(sq.state === 'SUCCEEDED' && sq.providerCode === 'SQUARE' && square.chargeCalls === 1, 'Square simulator charge SUCCEEDED');

  // 8. Plan and invoice preconditions at charge time.
  const i = await prepared('Indy', stripeConn.connectionId, { amounts: [2500] });
  await success(() => setState(OWN, i.plan.planId, 1, 'PAUSED'), 'pause Indy');
  await refused(() => charge(OWN, i.cycle.cycleId, 2500), 409, 'SCHOOL_PAY_AUTOPAY_STATE', 'a paused plan is not charged');
  await success(() => setState(OWN, i.plan.planId, 2, 'ACTIVE'), 'resume Indy');
  await manualPayment((await invoicesOf(i.cycle.cycleId))[0].id);
  await refused(() => charge(OWN, i.cycle.cycleId, 2500), 409, 'SCHOOL_PAY_CHARGE_INVOICES_CHANGED', 'an invoice with a recorded payment is not charged');
  // Review P3: a method saved under consent text HON does not know (or the other kind's mandate) is never charged.
  for (const [label, kind, consent] of [['Jules', 'CARD', 'card-v0'], ['Kai', 'US_BANK_ACCOUNT', 'card-on-file-v1']]) {
    const x = await prepared(label, stripeConn.connectionId, { kind, amounts: [1500], consent });
    await refused(() => charge(OWN, x.cycle.cycleId, 1500), 422, 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE', `${label}: unknown consent text (${kind} ${consent}) is not charged`);
    ok((await sql('SELECT count(*)::int n FROM hon.school_pay_charge_attempts WHERE cycle_id=$1', [x.cycle.cycleId])).rows[0].n === 0, `${label}: no attempt was opened`);
  }

  // 9. Data guards, whoever writes.
  await rejectsSql(() => sql("UPDATE hon.school_pay_charge_attempts SET state='PENDING',version=version+1 WHERE id=$1", [lost.attemptId]), /IMMUTABLE/, 'a settled attempt never changes');
  await rejectsSql(() => sql("UPDATE hon.school_pay_charge_attempts SET amount_minor=1,version=version+1 WHERE id=$1", [proc.attemptId]), /IMMUTABLE/, 'amount rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_charge_attempts WHERE id=$1', [paid.attemptId]), /IMMUTABLE/, 'attempt deleted');
  await rejectsSql(() => sql("INSERT INTO hon.school_pay_charge_attempts(organization_id,school_id,billing_account_id,cycle_id,plan_id,method_id,connection_id,provider_code,amount_minor,currency,created_by_principal_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'STRIPE_CONNECT',1,'USD',$8,'SUCCEEDED')",
    [ids.organization, ids.schoolA, i.payer, i.cycle.cycleId, i.plan.planId, i.method.methodId, stripeConn.connectionId, OWN.principal]), /IMMUTABLE/, 'an attempt is born PENDING');
  await rejectsSql(() => stray(a, 0), /duplicate key|unique/, 'a second live attempt for a paid cycle');
  await rejectsSql(() => sql('UPDATE hon.school_pay_charge_events SET kind=$2 WHERE attempt_id=$1', [paid.attemptId, 'CHARGE_FAILED']), /IMMUTABLE/, 'history rewritten');
  await rejectsSql(async () => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
    SELECT organization_id,school_id,id,1,currency,current_date,'PROVIDER',$2 FROM hon.invoices WHERE id=$1`, [(await invoicesOf(i.cycle.cycleId))[0].id, OWN.principal]), /provider_reference_check/, 'a PROVIDER record needs the processor reference');
  await rejectsSql(async () => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
    SELECT organization_id,school_id,id,1,currency,current_date,'WIRE',$2 FROM hon.invoices WHERE id=$1`, [(await invoicesOf(i.cycle.cycleId))[0].id, OWN.principal]), /method_check/, 'an unknown method');
  await rejectsSql(() => sql('TRUNCATE hon.school_pay_charge_events CASCADE'), /./, 'history truncated');

  // 10. Runtime boundary: no table privilege; four entry points; private helpers refused; the 011 section passes.
  for (const table of ['school_pay_charge_attempts', 'school_pay_charge_events']) {
    const t = (await sql(`SELECT c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  const entry = ['read_school_pay_autopay_charges(text,uuid)', 'read_school_pay_charge_attempt(text,uuid)', 'begin_school_pay_charge(text,uuid,jsonb,text,uuid,uuid)', 'finish_school_pay_charge(text,uuid,jsonb,text,uuid,uuid)'];
  const privateFns = ['guard_school_pay_charge_attempt()', 'school_pay_invoice_charge_open(uuid)', 'guard_school_pay_charge_payment_record()', 'guard_school_pay_charge_invoice()',
    'school_pay_charge_json(hon.school_pay_charge_attempts)', 'school_pay_charge_record(uuid,hon.school_pay_charge_attempts,text,jsonb,text,uuid,uuid)', 'school_pay_lock_charge(uuid,integer)',
    'school_pay_charge_outcome_ok(jsonb)', 'school_pay_charge_settle(hon.school_pay_charge_attempts,jsonb,uuid,text,uuid,uuid)'];
  for (const fn of entry) ok((await sql('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].x === true, `runtime executes ${fn}`);
  for (const fn of privateFns) ok((await sql('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].x === false, `runtime cannot execute ${fn}`);
  await assert.rejects(runtime.query(`SELECT hon.read_school_pay_charge_attempt('x','${paid.attemptId}')`), /SCHOOL_PAY_AUTOPAY_FORBIDDEN/); checks += 1;
  await assert.rejects(runtime.query(`SELECT hon.finish_school_pay_charge('x','${proc.attemptId}','{}'::jsonb,'k',gen_random_uuid(),gen_random_uuid())`), /VALIDATION_FAILED|FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School autopay charges exact verification (B-TUI-2 0337)', end = '-- End school autopay charges exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 11. No HON fee anywhere, and no SaaS payment attempt.
  ok((await sql('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n === 0, 'no SaaS payment attempt');
  ok([...stripe.charges.values(), ...square.charges.values()].every((x) => !('applicationFee' in x)), 'no charge carries an application fee');

  console.log(`PASS: school autopay charges (0337): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
