/**
 * School payer saved methods proof (B-TUI-2 piece 3, 0321) over signed HTTP (HON session cookie -> HonIdentityGuard +
 * human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolPayMethodController -> school payment adapters
 * (in-process Stripe Connect and Square simulators, no network) -> protected definer functions on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Test mode only; synthetic data; nothing charges
 * anyone, no card number or secret exists anywhere, and no message is sent.
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
const { SCHOOL_PAYMENT_ADAPTERS, SimulatedStripeConnectAdapter, SimulatedSquareAdapter } = await load('school-payments/school-payment-adapter.js');
// 0320: connecting the simulated Square seals its synthetic tokens in the vault, so the app needs one (a fresh key per run).
const { SCHOOL_PAYMENT_VAULT, SchoolPaymentVault } = await load('school-payments/school-payment-vault.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-pay-methods', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolPaymentController, SchoolPayMethodController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolPaymentService, SchoolPayMethodService, { provide: RuntimeDatabaseService, useValue: database },
      { provide: SCHOOL_PAYMENT_ADAPTERS, useValue: adapters }, { provide: SCHOOL_PAYMENT_VAULT, useValue: new SchoolPaymentVault(randomBytes(32), 'proof-0321') }],
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
  read: 'school_pay.methods.read', expiring: 'school_pay.methods.expiring_read', setup: 'school_pay.method.setup', finish: 'school_pay.method.finish',
  default: 'school_pay.method.default', remove: 'school_pay.method.remove',
  connStart: 'school_pay.connection.start', connLink: 'school_pay.connection.onboarding_link', connFinish: 'school_pay.connection.finish',
  connDisconnect: 'school_pay.connection.disconnect',
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
const readPayer = (actor, payer, options = {}) => call(actor, 'GET', `/payers/${payer}/methods`, options);
const readExpiring = (actor, options = {}) => call(actor, 'GET', '/saved-methods/expiring', options);
const startSetup = (actor, payer, body, options = {}) => call(actor, 'POST', `/payers/${payer}/method-setups`, { body, command: COMMAND.setup, ...options });
const finishSetup = (actor, payer, setup, body, options = {}) => call(actor, 'POST', `/payers/${payer}/method-setups/${setup}/finish`, { body, command: COMMAND.finish, ...options });
const makeDefault = (actor, payer, method, expectedVersion, options = {}) => call(actor, 'POST', `/payers/${payer}/methods/${method}/default`, { body: { expectedVersion }, command: COMMAND.default, ...options });
const removeMethod = (actor, payer, method, expectedVersion, reason, options = {}) => call(actor, 'POST', `/payers/${payer}/methods/${method}/remove`, { body: { expectedVersion, reason }, command: COMMAND.remove, ...options });

async function success(run, label) {
  const { status, body, headers, text } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  ok(!/cus_sim|SQCUSTSIM|pm_sim|ccof:|acct_sim|MLSIM|seti_sim|sqsetup_sim/.test(text), `${label}: no provider account, customer, setup or method reference reaches the browser`);
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

// Disposable-fixture cleanup only (as in the 0258 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_pay_methods WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left saved methods behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`paymethods-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`paymethods-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`paymethods-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `paymethods-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Pay Methods Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Pay Methods Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
async function payer(given, family, { org = ids.organization, school = ids.schoolA } = {}) {
  const person = (await sql('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id', [org, school, given, family])).rows[0].id;
  return (await sql("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id", [org, school, person])).rows[0].id;
}

let OWN, READER, NONE, CONNECTOR, OWN_B, OTHER_ORG, LOSER, P1, P2, P_B, P_OTHER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Pay Methods Org','Pay Methods Org'),($2,'Pay Methods Other Org','Pay Methods Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Pay Methods ${slug}`, `paymethods-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['school_pay.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'billing.invoice.payment.record', 'reporting.view'])]);
  CONNECTOR = await staff('connector', [await role(ids.organization, ['school_pay.connection.manage'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_pay.method.manage'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['school_pay.method.manage'])]);
  P1 = await payer('Avery', 'Family');
  P2 = await payer('Blake', 'Household');
  P_B = await payer('Casey', 'School-B', { school: ids.schoolB });
  P_OTHER = await payer('Drew', 'Other', { org: ids.otherOrganization, school: ids.otherSchool });
}

/** A CONNECTED_ACTIVE connection through the 0258 routes (simulated hosted onboarding). */
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

const stateOf = (url) => new URL(url).searchParams.get('state');
const methodRow = async (id) => (await sql('SELECT * FROM hon.school_pay_methods WHERE id=$1', [id])).rows[0];
const setupRow = async (id) => (await sql('SELECT * FROM hon.school_pay_method_setups WHERE id=$1', [id])).rows[0];
/** The provider setup reference stays server-side; the proof reads it from the database to steer the simulator. */
const refOf = async (setup) => (await setupRow(setup.setupId)).provider_setup_ref;
const CARD = (connectionId) => ({ connectionId, methodKinds: ['CARD'], consentTextVersion: 'card-on-file-v1' });

try {
  await cleanup();
  await seed();
  await startApp();
  const outboxBefore = (await sql('SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1', [ids.organization])).rows[0].n;

  // 0. The permission, OWNER grants, and two active connections (Stripe with bank debit, Square cards only).
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='school_pay.method.manage' AND is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'school_pay.method.manage is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='school_pay.method.manage')`)).rows[0].n === 0, 'every system OWNER role holds it');
  const stripeConn = await connect(OWN, 'STRIPE_CONNECT');
  const squareConn = await connect(OWN, 'SQUARE');

  // 1. Payer read: managers and readers; no provider references in the browser body; other schools and organizations refused.
  const empty = await success(() => readPayer(OWN, P1), 'owner reads payer 1');
  ok(empty.data.canManage === true && empty.data.platformFee === 'NONE' && empty.data.payerName === 'Avery Family' && empty.data.methods.length === 0
    && empty.data.setups.length === 0 && empty.data.connections.map((c) => c.providerCode).join() === 'STRIPE_CONNECT,SQUARE', 'two connections, no methods, no fee');
  ok(empty.data.connections.every((c) => c.storedCard === true && c.hasCustomer === false && !('accountRef' in c) && !('customerRef' in c))
    && empty.data.connections.find((c) => c.providerCode === 'SQUARE').bankDebit === false, 'connections carry no provider references; Square takes no bank account');
  ok((await success(() => readPayer(READER, P1), 'reader reads payer 1')).data.canManage === false, 'a reader cannot manage');
  for (const actor of [NONE, CONNECTOR]) await refused(() => readPayer(actor, P1), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => readPayer(OWN, P_B), 404, 'SCHOOL_PAY_PAYER_NOT_FOUND', 'school-B payer at the school-A route');
  await refused(() => readPayer(OWN, P_OTHER), 404, 'SCHOOL_PAY_PAYER_NOT_FOUND', 'other-organization payer');
  await refused(() => readPayer(OWN_B, P1, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => readPayer(OTHER_ORG, P1, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => readPayer(OWN, P1, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => readPayer(OWN, 'not-a-uuid'), 400, undefined, 'malformed payer id');

  // 2. Start a Stripe card setup: refusals, the hosted link, replay without a link, key reuse; the state stored only as SHA-256.
  for (const actor of [READER, NONE, CONNECTOR]) await refused(() => startSetup(actor, P1, CARD(stripeConn.connectionId)), 403, undefined, `setup refused for ${actor.subject.split('-').pop()}`);
  await refused(() => startSetup(OWN, P1, { ...CARD(stripeConn.connectionId), methodKinds: ['CASH'] }), 400, 'VALIDATION_FAILED', 'unknown method kind');
  await refused(() => startSetup(OWN, P1, { ...CARD(stripeConn.connectionId), methodKinds: ['CARD', 'CARD'] }), 400, 'VALIDATION_FAILED', 'duplicate method kind');
  await refused(() => startSetup(OWN, P1, { ...CARD(stripeConn.connectionId), consentTextVersion: 'Bad Version' }), 400, 'VALIDATION_FAILED', 'malformed consent version');
  await refused(() => startSetup(OWN, P1, { ...CARD(stripeConn.connectionId), cardNumber: '4242424242424242' }), 400, undefined, 'a card number is never accepted');
  await refused(() => startSetup(OWN, P1, { ...CARD(squareConn.connectionId), methodKinds: ['US_BANK_ACCOUNT'] }), 422, 'SCHOOL_PAY_METHODS_UNAVAILABLE', 'Square takes no bank account');
  await refused(() => startSetup(OWN, P1, CARD(randomUUID())), 422, 'SCHOOL_PAY_METHODS_UNAVAILABLE', 'unknown connection');
  await refused(() => startSetup(OWN, P1, CARD(stripeConn.connectionId), { command: COMMAND.finish }), 403, 'HUMAN_UI_REQUIRED', 'setup under another command header');
  await refused(() => startSetup(OWN, P1, CARD(stripeConn.connectionId), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'setup without a key');
  const setupKey = randomUUID();
  const s1 = await success(() => startSetup(OWN, P1, CARD(stripeConn.connectionId), { key: setupKey }), 'start Stripe card setup');
  const setup1 = s1.data.setup, state1 = stateOf(s1.data.setupUrl);
  ok(s1.data.setupUrl.startsWith(`${origin}/staff/billing/saved-payment-methods?payer=${P1}&setup=${setup1.setupId}`) && /^[A-Za-z0-9_-]{43}$/.test(state1),
    'the hosted page returns to the staff page with a one-time state');
  ok(setup1.state === 'PENDING' && setup1.version === 1 && setup1.methodKinds.join() === 'CARD' && setup1.consentTextVersion === 'card-on-file-v1'
    && !('setupRef' in setup1) && /^seti_sim[0-9a-f]{16}$/.test(await refOf(setup1)) && Date.parse(setup1.expiresAt) - Date.parse(setup1.createdAt) === 3_600_000 && s1.meta.replayed === false, 'pending setup, one hour');
  const replay1 = await success(() => startSetup(OWN, P1, CARD(stripeConn.connectionId), { key: setupKey }), 'setup replay');
  ok(replay1.meta.replayed === true && replay1.data.setup.setupId === setup1.setupId && replay1.data.setupUrl === null, 'a replay returns the stored setup without a link');
  await refused(() => startSetup(OWN, P1, { ...CARD(stripeConn.connectionId), methodKinds: ['CARD', 'US_BANK_ACCOUNT'] }, { key: setupKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key for another setup');
  const r1 = await setupRow(setup1.setupId);
  ok(/^[0-9a-f]{64}$/.test(r1.setup_state_hash) && r1.setup_state_hash !== state1, 'only the SHA-256 of the setup state is stored');
  const customer = (await sql('SELECT * FROM hon.school_pay_customers WHERE billing_account_id=$1', [P1])).rows;
  ok(customer.length === 1 && /^cus_sim[0-9a-f]{16}$/.test(customer[0].provider_customer_ref) && customer[0].connection_id === stripeConn.connectionId, 'one Stripe customer for the payer');
  ok((await success(() => readPayer(OWN, P1), 'read with a pending setup')).data.connections.find((c) => c.providerCode === 'STRIPE_CONNECT').hasCustomer === true, 'the payer now has a Stripe customer');

  // 3. Finish: wrong state, stale version, not saved on the provider page yet, then success; the first method is the default.
  await refused(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 1, setupState: 'x'.repeat(43) }), 403, 'SCHOOL_PAY_SETUP_STATE_MISMATCH', 'wrong setup state');
  await refused(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 2, setupState: state1 }), 409, 'VERSION_CONFLICT', 'stale setup version');
  await refused(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 1, setupState: 'short' }), 400, 'VALIDATION_FAILED', 'malformed setup state');
  await refused(() => finishSetup(OWN, P2, setup1.setupId, { expectedVersion: 1, setupState: state1 }), 404, 'SCHOOL_PAY_SETUP_NOT_FOUND', 'the setup of another payer');
  await refused(() => finishSetup(READER, P1, setup1.setupId, { expectedVersion: 1, setupState: state1 }), 403, undefined, 'reader cannot finish');
  stripe.setupOutcomes.set(await refOf(setup1), { incomplete: true });
  await refused(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 1, setupState: state1 }), 409, 'SCHOOL_PAY_SETUP_INCOMPLETE', 'the payer left the provider page without saving');
  stripe.setupOutcomes.delete(await refOf(setup1));
  const finishKey = randomUUID();
  const f1 = await success(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 1, setupState: state1 }, { key: finishKey }), 'finish Stripe card');
  const m1 = f1.data.method;
  ok(m1.kind === 'CARD' && m1.brand === 'VISA' && m1.last4 === '4242' && m1.expMonth === 12 && m1.expYear === 2034 && m1.status === 'ACTIVE'
    && m1.isDefault === true && m1.consentTextVersion === 'card-on-file-v1' && m1.connectionId === stripeConn.connectionId && m1.version === 1, 'Visa 4242 saved as the default');
  const fr = await success(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 1, setupState: state1 }, { key: finishKey }), 'finish replay');
  ok(fr.meta.replayed === true && fr.data.method.methodId === m1.methodId, 'a retried finish replays the stored method');
  await refused(() => finishSetup(OWN, P1, setup1.setupId, { expectedVersion: 2, setupState: state1 }), 409, 'SCHOOL_PAY_SETUP_STATE', 'a finished setup cannot be finished again');
  const done1 = await setupRow(setup1.setupId);
  ok(done1.state === 'COMPLETED' && done1.setup_state_hash === null && done1.method_id === m1.methodId, 'setup completed, state hash cleared');
  ok(/^pm_sim[0-9a-f]{16}$/.test((await methodRow(m1.methodId)).provider_method_ref), 'the Stripe payment method reference is kept server-side');

  // 4. A bank account on Stripe (not the default); superseded setups; an expiring card.
  const s2 = (await success(() => startSetup(OWN, P1, { connectionId: stripeConn.connectionId, methodKinds: ['US_BANK_ACCOUNT'], consentTextVersion: 'ach-mandate-v1' }), 'start bank setup')).data;
  const m2 = (await success(() => finishSetup(OWN, P1, s2.setup.setupId, { expectedVersion: 1, setupState: stateOf(s2.setupUrl) }), 'finish bank')).data.method;
  ok(m2.kind === 'US_BANK_ACCOUNT' && m2.brand === 'BANK' && m2.last4 === '6789' && m2.expMonth === null && m2.expYear === null && m2.isDefault === false, 'bank account saved, not the default');
  const older = (await success(() => startSetup(OWN, P1, CARD(stripeConn.connectionId)), 'start a setup to be replaced')).data;
  const newer = (await success(() => startSetup(OWN, P1, CARD(stripeConn.connectionId)), 'start a newer setup')).data;
  ok((await setupRow(older.setup.setupId)).state === 'SUPERSEDED', 'the newer setup supersedes the older one');
  await refused(() => finishSetup(OWN, P1, older.setup.setupId, { expectedVersion: 1, setupState: stateOf(older.setupUrl) }), 404, 'SCHOOL_PAY_SETUP_NOT_FOUND', 'a superseded setup cannot finish');
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: LA }));
  const thisMonth = { expMonth: now.getMonth() + 1, expYear: now.getFullYear() };
  stripe.setupOutcomes.set(await refOf(newer.setup), { brand: 'MASTERCARD', last4: '4444', ...thisMonth });
  const m3 = (await success(() => finishSetup(OWN, P1, newer.setup.setupId, { expectedVersion: 1, setupState: stateOf(newer.setupUrl) }), 'finish expiring card')).data.method;
  ok(m3.brand === 'MASTERCARD' && m3.expMonth === thisMonth.expMonth && m3.expYear === thisMonth.expYear, 'Mastercard expiring this month');
  const kindMismatch = (await success(() => startSetup(OWN, P1, CARD(stripeConn.connectionId)), 'start a card-only setup')).data;
  stripe.setupOutcomes.set(await refOf(kindMismatch.setup), { kind: 'US_BANK_ACCOUNT' });
  await refused(() => finishSetup(OWN, P1, kindMismatch.setup.setupId, { expectedVersion: 1, setupState: stateOf(kindMismatch.setupUrl) }), 422, 'SCHOOL_PAY_METHODS_UNAVAILABLE', 'a bank account from a card-only setup');
  stripe.setupOutcomes.set(await refOf(kindMismatch.setup), { customerRef: 'cus_simsomeoneelse' });
  await refused(() => finishSetup(OWN, P1, kindMismatch.setup.setupId, { expectedVersion: 1, setupState: stateOf(kindMismatch.setupUrl) }), 422, 'SCHOOL_PAY_CUSTOMER_MISMATCH', 'a method of another provider customer');

  // 5. Square card on file for payer 2 (an expired card), plus an expired setup that cannot finish.
  const q = (await success(() => startSetup(OWN, P2, CARD(squareConn.connectionId)), 'start Square card setup')).data;
  ok(/^sqsetup_sim[0-9a-f]{16}$/.test(await refOf(q.setup)), 'Square setup');
  square.setupOutcomes.set(await refOf(q.setup), { brand: 'AMEX', last4: '0005', expMonth: 1, expYear: 2024 });
  const mq = (await success(() => finishSetup(OWN, P2, q.setup.setupId, { expectedVersion: 1, setupState: stateOf(q.setupUrl) }), 'finish Square card')).data.method;
  ok(mq.brand === 'AMEX' && mq.isDefault === true && mq.connectionId === squareConn.connectionId && (await methodRow(mq.methodId)).provider_method_ref.startsWith('ccof:sim'), 'Square card on file is payer 2 default');
  ok((await sql('SELECT provider_customer_ref FROM hon.school_pay_customers WHERE billing_account_id=$1', [P2])).rows[0].provider_customer_ref.startsWith('SQCUSTSIM'), 'Square customer');
  const late = (await success(() => startSetup(OWN, P2, CARD(stripeConn.connectionId)), 'start a setup that will expire')).data;
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_method_setups DISABLE TRIGGER school_pay_method_setup_guard');
  await sql("UPDATE hon.school_pay_method_setups SET created_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [late.setup.setupId]);
  await sql('ALTER TABLE hon.school_pay_method_setups ENABLE TRIGGER school_pay_method_setup_guard');
  await sql('COMMIT');
  await refused(() => finishSetup(OWN, P2, late.setup.setupId, { expectedVersion: 1, setupState: stateOf(late.setupUrl) }), 404, 'SCHOOL_PAY_SETUP_NOT_FOUND', 'an expired setup cannot finish');

  // 6. Default: switch payer 1 to the bank account; the earlier default is cleared; one default per payer.
  await refused(() => makeDefault(READER, P1, m2.methodId, 1), 403, undefined, 'reader cannot choose the default');
  await refused(() => makeDefault(OWN, P2, m2.methodId, 1), 404, 'SCHOOL_PAY_METHOD_NOT_FOUND', 'a method of another payer');
  await refused(() => makeDefault(OWN, P1, m2.methodId, 5), 409, 'VERSION_CONFLICT', 'stale default version');
  const d = (await success(() => makeDefault(OWN, P1, m2.methodId, 1), 'bank account becomes default')).data.method;
  ok(d.isDefault && d.version === 2, 'bank account is the default');
  const m1after = await methodRow(m1.methodId);
  ok(!m1after.is_default && m1after.version === 2, 'the earlier default is cleared (version bumped)');
  await refused(() => makeDefault(OWN, P1, m2.methodId, 2), 409, 'SCHOOL_PAY_METHOD_ALREADY_DEFAULT', 'already the default');

  // 7. Card expiry list: by the school's own month; expired flagged; far-future and bank accounts left out.
  const exp = (await success(() => readExpiring(OWN), 'expiring list')).data;
  const month = `${thisMonth.expYear}-${String(thisMonth.expMonth).padStart(2, '0')}`;
  ok(exp.asOfMonth === month && exp.methods.map((m) => m.methodId).join() === [mq.methodId, m3.methodId].join(), 'expired Amex first, then this month Mastercard');
  ok(exp.methods[0].expired === true && exp.methods[0].payerName === 'Blake Household' && exp.methods[1].expired === false, 'expired flag and payer name');
  ok((await success(() => readExpiring(READER), 'reader expiring list')).data.methods.length === 2, 'a reader sees the expiry list');
  await refused(() => readExpiring(NONE), 403, undefined, 'expiry list refused without permission');
  ok((await success(() => readExpiring(OWN_B), 'school B expiry list')).data.methods.length === 0, 'school B sees none of school A');

  // 8. Remove: reason required; provider detach reported; removed never changes; the default goes with it.
  await refused(() => removeMethod(OWN, P1, m2.methodId, 2, ''), 400, 'VALIDATION_FAILED', 'empty reason');
  await refused(() => removeMethod(READER, P1, m2.methodId, 2, 'x'), 403, undefined, 'reader cannot remove');
  const removed = await success(() => removeMethod(OWN, P1, m2.methodId, 2, 'Family closed this bank account'), 'remove bank account');
  ok(removed.data.method.status === 'REMOVED' && removed.data.method.isDefault === false && removed.data.method.removeReason === 'Family closed this bank account'
    && removed.meta.providerDetached === true && !('providerMethodRef' in removed.data) && stripe.detached.has((await methodRow(m2.methodId)).provider_method_ref), 'removed, detached at the provider, no reference returned');
  await refused(() => removeMethod(OWN, P1, m2.methodId, 3, 'again'), 409, 'SCHOOL_PAY_METHOD_STATE', 'second removal');
  await refused(() => makeDefault(OWN, P1, m2.methodId, 3), 409, 'SCHOOL_PAY_METHOD_STATE', 'a removed method cannot be the default');
  const p1 = (await success(() => readPayer(OWN, P1), 'payer 1 after removal')).data;
  ok(p1.methods.filter((m) => m.status === 'ACTIVE').length === 2 && p1.methods.at(-1).methodId === m2.methodId && p1.methods.filter((m) => m.isDefault).length === 0, 'active first, removed last, no stale default');
  ok((await success(() => makeDefault(OWN, P1, m1.methodId, 2), 'Visa default again')).data.method.isDefault, 'a new default can be chosen');

  // 9. A disconnected connection can no longer save methods.
  const gone = await call(OWN, 'POST', `/processors/connections/${squareConn.connectionId}/disconnect`, { body: { expectedVersion: squareConn.version, reason: 'Test disconnect' }, command: COMMAND.connDisconnect });
  ok(gone.status === 200 && gone.body.data.connection.state === 'DISCONNECTED', 'Square disconnected');
  ok((await success(() => readPayer(OWN, P2), 'payer 2 after disconnect')).data.connections.every((c) => c.connectionId !== squareConn.connectionId), 'the disconnected connection is not offered');
  await refused(() => startSetup(OWN, P2, CARD(squareConn.connectionId)), 422, 'SCHOOL_PAY_METHODS_UNAVAILABLE', 'no setup on a disconnected connection');

  // 10. Live authority loss: revoked grant, suspended entitlement, suspended school.
  ok((await success(() => readPayer(LOSER, P1), 'loser read before')).data.canManage === true, 'loser manages before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => readPayer(LOSER, P1), 403, undefined, `${label}: read`);
    await refused(() => startSetup(LOSER, P1, CARD(stripeConn.connectionId)), 403, undefined, `${label}: setup`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => readPayer(LOSER, P1), 'loser read after')).data.canManage === true, 'authority restored');

  // 11. No card number, setup state or secret anywhere; history, audit and inert outbox per command.
  const states = [state1, stateOf(s2.setupUrl), stateOf(newer.setupUrl), stateOf(q.setupUrl)];
  for (const secret of [...states, '4242424242424242']) {
    const leaked = (await sql(`SELECT (SELECT count(*) FROM hon.idempotency_records WHERE organization_id=$1 AND (request_fingerprint LIKE $2 OR response_body::text LIKE $2))
        + (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND (prior_state::text LIKE $2 OR next_state::text LIKE $2))
        + (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND payload::text LIKE $2)
        + (SELECT count(*) FROM hon.school_pay_method_events WHERE organization_id=$1 AND snapshot::text LIKE $2) n`, [ids.organization, `%${secret}%`])).rows[0].n;
    ok(Number(leaked) === 0, 'no raw setup state or card number is stored anywhere');
  }
  const m1events = (await sql('SELECT kind FROM hon.school_pay_method_events WHERE entity_id=$1 ORDER BY entity_version, recorded_at', [m1.methodId])).rows.map((x) => x.kind);
  ok(m1events.join() === 'METHOD_SAVED,DEFAULT_CLEARED,DEFAULT_SET', `Visa history ${m1events.join()}`);
  const s1events = (await sql('SELECT kind FROM hon.school_pay_method_events WHERE entity_id=$1 ORDER BY entity_version', [setup1.setupId])).rows.map((x) => x.kind);
  ok(s1events.join() === 'SETUP_STARTED,SETUP_COMPLETED', `setup history ${s1events.join()}`);
  const events = (await sql("SELECT count(*)::int n FROM hon.school_pay_method_events WHERE organization_id=$1", [ids.organization])).rows[0].n;
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type IN ('SCHOOL_PAY_SETUP','SCHOOL_PAY_METHOD')", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type IN ('SCHOOL_PAY_SETUP','SCHOOL_PAY_METHOD')", [ids.organization])).rows[0].n;
  ok(audit === events && outbox === events, 'one audit and one outbox event per history row');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type IN ('SCHOOL_PAY_SETUP','SCHOOL_PAY_METHOD') AND status<>'PENDING'", [ids.organization])).rows[0].n === 0, 'outbox events are inert');
  ok((await sql('SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1', [ids.organization])).rows[0].n - outboxBefore >= outbox, 'outbox accounted');

  // 12. Settings-free guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_pay_methods SET last4='1111', version=version+1 WHERE id=$1", [m1.methodId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'last four rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_pay_methods SET provider_method_ref='pm_simother1234', version=version+1 WHERE id=$1", [m1.methodId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'provider method swapped');
  await rejectsSql(() => sql("UPDATE hon.school_pay_methods SET status='ACTIVE', removed_at=NULL, removed_by_principal_id=NULL, remove_reason=NULL, version=version+1 WHERE id=$1", [m2.methodId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'removed method reactivated');
  await rejectsSql(() => sql('UPDATE hon.school_pay_methods SET is_default=false WHERE id=$1', [m1.methodId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'update without a version bump');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_methods WHERE id=$1', [m1.methodId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'method deleted');
  await rejectsSql(() => sql('UPDATE hon.school_pay_methods SET is_default=true, version=version+1 WHERE id=$1', [m3.methodId]), /duplicate key|unique/, 'two defaults for one payer');
  await rejectsSql(() => sql("UPDATE hon.school_pay_method_setups SET state='PENDING', setup_state_hash=repeat('a',64), method_id=NULL, ended_at=NULL, ended_by_principal_id=NULL, version=version+1 WHERE id=$1", [setup1.setupId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'finished setup reopened');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_method_setups WHERE id=$1', [setup1.setupId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'setup deleted');
  await rejectsSql(() => sql("UPDATE hon.school_pay_customers SET provider_customer_ref='cus_simswapped12' WHERE billing_account_id=$1", [P1]), /IMMUTABLE/, 'customer reference swapped');
  await rejectsSql(() => sql("UPDATE hon.school_pay_method_events SET kind='METHOD_SAVED' WHERE entity_id=$1", [m2.methodId]), /IMMUTABLE/, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_method_events WHERE entity_id=$1', [m2.methodId]), /IMMUTABLE/, 'history deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_pay_methods CASCADE'), /./, 'methods truncated');
  await rejectsSql(() => sql(`INSERT INTO hon.school_pay_methods(organization_id,school_id,connection_id,billing_account_id,customer_id,setup_id,provider_method_ref,kind,brand,last4,exp_month,exp_year,consent_text_version,created_by_principal_id,status,removed_at,removed_by_principal_id,remove_reason)
    SELECT organization_id,school_id,connection_id,billing_account_id,customer_id,$2,'pm_simforged1234','CARD','VISA','4242',1,2030,'v1',created_by_principal_id,'REMOVED',clock_timestamp(),created_by_principal_id,'x' FROM hon.school_pay_methods WHERE id=$1`, [m1.methodId, older.setup.setupId]), /SCHOOL_PAY_METHOD_IMMUTABLE/, 'insert already removed');
  await sql('ROLLBACK');

  // 13. Runtime ACL: EXECUTE on the six entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['read_school_pay_payer_methods(text,uuid)', 'read_school_pay_expiring_methods(text)', 'start_school_pay_method_setup(text,jsonb,text,uuid,uuid)',
    'finish_school_pay_method_setup(text,uuid,jsonb,text,uuid,uuid)', 'set_default_school_pay_method(text,uuid,jsonb,text,uuid,uuid)', 'remove_school_pay_method(text,uuid,jsonb,text,uuid,uuid)'];
  const helpers = ['guard_school_pay_method_setup()', 'guard_school_pay_method()', 'require_school_pay_method_actor(text,text)', 'require_school_pay_method_reader(text)',
    'school_pay_instant(timestamp with time zone)', 'school_pay_method_json(hon.school_pay_methods)', 'school_pay_setup_json(hon.school_pay_method_setups)',
    'school_pay_method_observation_ok(jsonb)', 'school_pay_method_begin(text,text,text)', 'school_pay_method_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid)',
    'school_pay_method_complete(text,text,uuid,jsonb)', 'school_pay_lock_payer(uuid)', 'school_pay_lock_method(uuid,integer)'];
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
  for (const table of ['school_pay_customers', 'school_pay_method_setups', 'school_pay_methods', 'school_pay_method_events']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.require_school_pay_method_actor('x','school_pay.read')"), /permission denied/); checks += 1;
  // Called directly without the human session settings, every entry point refuses.
  await assert.rejects(runtime.query("SELECT hon.read_school_pay_expiring_methods('x')"), /SCHOOL_PAY_READ_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0321 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School payer saved methods exact verification (B-TUI-2 0321)', end = '-- End school payer saved methods exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 14. No money, charge or invoice effect.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school payer saved methods (0321): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
