/**
 * School payment processor connections proof (B-TUI-2 piece 1, 0258) over signed HTTP (HON session cookie ->
 * HonIdentityGuard + human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolPaymentController ->
 * school payment adapters (in-process Stripe Connect and Square simulators, no network) -> protected definer functions on
 * the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Test mode only;
 * synthetic data; nothing charges, refunds, stores a card or token, or sends a message.
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
const { SCHOOL_PAYMENT_ADAPTERS, SimulatedStripeConnectAdapter, SimulatedSquareAdapter } = await load('school-payments/school-payment-adapter.js');
// 0320: the simulated Square hands back synthetic tokens, which the service seals in the vault (proved in the vault proof).
const { SCHOOL_PAYMENT_VAULT, SchoolPaymentVault } = await load('school-payments/school-payment-vault.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-payments', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

/** Stripe simulator whose next onboarding can be pointed at a chosen account (to prove cross-organization refusal). */
class ProofStripe extends SimulatedStripeConnectAdapter {
  nextAccount = null;
  async beginOnboarding(input) {
    const result = await super.beginOnboarding(input);
    if (this.nextAccount && input.accountRef === null) { const account = this.nextAccount; this.nextAccount = null; return { ...result, accountRef: account }; }
    return result;
  }
}
const stripe = new ProofStripe();
const square = new SimulatedSquareAdapter();
const adapters = new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]);
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolPaymentController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolPaymentService, { provide: RuntimeDatabaseService, useValue: database },
      { provide: SCHOOL_PAYMENT_ADAPTERS, useValue: adapters }, { provide: SCHOOL_PAYMENT_VAULT, useValue: new SchoolPaymentVault(randomBytes(32), 'proof-0258') }],
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
  start: 'school_pay.connection.start', link: 'school_pay.connection.onboarding_link', finish: 'school_pay.connection.finish',
  refresh: 'school_pay.connection.refresh', default: 'school_pay.connection.default', disconnect: 'school_pay.connection.disconnect',
};
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/payments/processors${path}`);
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
const read = (actor, options = {}) => call(actor, 'GET', '', options);
const start = (actor, providerCode, options = {}) => call(actor, 'POST', '/connections', { body: { providerCode }, command: COMMAND.start, ...options });
const link = (actor, id, expectedVersion, options = {}) => call(actor, 'POST', `/connections/${id}/onboarding-link`, { body: { expectedVersion }, command: COMMAND.link, ...options });
const finish = (actor, id, body, options = {}) => call(actor, 'POST', `/connections/${id}/finish`, { body, command: COMMAND.finish, ...options });
const refresh = (actor, id, expectedVersion, options = {}) => call(actor, 'POST', `/connections/${id}/refresh`, { body: { expectedVersion }, command: COMMAND.refresh, ...options });
const makeDefault = (actor, id, expectedVersion, options = {}) => call(actor, 'POST', `/connections/${id}/default`, { body: { expectedVersion }, command: COMMAND.default, ...options });
const disconnect = (actor, id, expectedVersion, reason, options = {}) => call(actor, 'POST', `/connections/${id}/disconnect`, { body: { expectedVersion, reason }, command: COMMAND.disconnect, ...options });

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
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0240 proof).
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_pay_connections WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left connections behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`schoolpay-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`schoolpay-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`schoolpay-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `schoolpay-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'School Pay Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'School Pay Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

let OWN, READER, NONE, MIXED, OWN_B, OTHER_ORG, LOSER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'School Pay Org','School Pay Org'),($2,'School Pay Other Org','School Pay Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `School Pay ${slug}`, `schoolpay-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['school_pay.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'billing.invoice.payment.record', 'billing.invoice.issue', 'reporting.view'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['school_pay.connection.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_pay.connection.manage'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['school_pay.connection.manage'])]);
}

const connectionRow = async (id) => (await sql('SELECT * FROM hon.school_pay_connections WHERE id=$1', [id])).rows[0];
const stateOf = (url) => new URL(url).searchParams.get('state');

try {
  await cleanup();
  await seed();
  await startApp();
  const outboxBefore = (await sql('SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1', [ids.organization])).rows[0].n;

  // 0. Permissions, OWNER grants and the provider registry.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code IN ('school_pay.connection.manage','school_pay.read') AND is_sensitive AND is_staff_assignable")).rows[0].n === 2,
    'both school_pay permissions are sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN (VALUES ('school_pay.connection.manage'),('school_pay.read')) x(code) WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=x.code)`)).rows[0].n === 0, 'every system OWNER role holds both');
  const registry = (await sql('SELECT code, test_supported, live_allowed FROM hon.school_pay_providers ORDER BY sort_order')).rows;
  ok(JSON.stringify(registry) === JSON.stringify([{ code: 'STRIPE_CONNECT', test_supported: true, live_allowed: false }, { code: 'SQUARE', test_supported: true, live_allowed: false }]), 'Stripe and Square registered, never live');

  // 1. Read: owner and reader; everyone else refused.
  const empty = await success(() => read(OWN), 'owner read');
  ok(empty.data.canManage === true && empty.data.platformFee === 'NONE' && empty.data.connections.length === 0
    && empty.data.providers.map((p) => p.providerCode).join() === 'STRIPE_CONNECT,SQUARE', 'owner read: two providers, no connections, no platform fee');
  ok((await success(() => read(READER), 'reader read')).data.canManage === false, 'a reader cannot manage');
  for (const actor of [NONE, MIXED, LOSER].slice(0, 2)) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => read(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');

  // 2. Start Stripe: refusals, receipt, replay, key reuse, one open connection per provider.
  for (const actor of [READER, NONE, MIXED]) await refused(() => start(actor, 'STRIPE_CONNECT'), 403, undefined, `start refused for ${actor.subject.split('-').pop()}`);
  await refused(() => start(OWN, 'PAYPAL'), 400, 'VALIDATION_FAILED', 'unknown provider');
  await refused(() => call(OWN, 'POST', '/connections', { body: { providerCode: 'STRIPE_CONNECT', mode: 'LIVE' }, command: COMMAND.start }), 400, undefined, 'a mode cannot be chosen');
  await refused(() => start(OWN, 'STRIPE_CONNECT', { command: COMMAND.finish }), 403, 'HUMAN_UI_REQUIRED', 'start under another command header');
  await refused(() => start(OWN, 'STRIPE_CONNECT', { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'start without a key');
  const startKey = randomUUID();
  const started = await success(() => start(OWN, 'STRIPE_CONNECT', { key: startKey }), 'start Stripe');
  const s = started.data.connection;
  ok(s.state === 'PENDING_ONBOARDING' && s.mode === 'TEST' && s.version === 1 && s.accountRef === null && !s.isDefault && !s.onboardingPending && started.meta.replayed === false, 'Stripe pending, TEST, version 1');
  const replay = await success(() => start(OWN, 'STRIPE_CONNECT', { key: startKey }), 'start replay');
  ok(replay.meta.replayed === true && replay.data.connection.connectionId === s.connectionId, 'exact replay returns the stored receipt');
  await refused(() => start(OWN, 'SQUARE', { key: startKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key for another provider');
  await refused(() => start(OWN, 'STRIPE_CONNECT'), 409, 'SCHOOL_PAY_CONNECTION_EXISTS', 'second open Stripe connection');

  // 3. Onboarding link: the state goes only into the URL; the account ref is set once.
  await refused(() => link(READER, s.connectionId, 1), 403, undefined, 'reader cannot request a link');
  await refused(() => link(OWN, s.connectionId, 7), 409, 'VERSION_CONFLICT', 'stale link version');
  const linkKey = randomUUID();
  const linked = await success(() => link(OWN, s.connectionId, 1, { key: linkKey }), 'Stripe onboarding link');
  const stripeState = stateOf(linked.data.onboardingUrl);
  ok(linked.data.onboardingUrl.startsWith(`${origin}/staff/billing/payment-processors?connection=${s.connectionId}`) && /^[A-Za-z0-9_-]{43}$/.test(stripeState), 'link returns to the staff page with a one-time state');
  ok(linked.data.connection.version === 2 && linked.data.connection.onboardingPending && /^acct_sim[0-9a-f]{16}$/.test(linked.data.connection.accountRef), 'link stores the Stripe account and a pending state');
  const linkReplay = await success(() => link(OWN, s.connectionId, 1, { key: linkKey }), 'link replay');
  ok(linkReplay.meta.replayed === true && linkReplay.data.onboardingUrl === null && linkReplay.data.connection.version === 2, 'a link replay returns no URL');
  const row = await connectionRow(s.connectionId);
  ok(/^[0-9a-f]{64}$/.test(row.onboarding_state_hash) && row.onboarding_state_hash !== stripeState, 'only the SHA-256 of the state is stored');

  // 4. Finish: wrong state, stale version, wrong shape, then success; state cleared and never persisted raw.
  await refused(() => finish(OWN, s.connectionId, { expectedVersion: 2, state: 'x'.repeat(43) }), 403, 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH', 'wrong onboarding state');
  await refused(() => finish(OWN, s.connectionId, { expectedVersion: 1, state: stripeState }), 409, 'VERSION_CONFLICT', 'stale finish version');
  await refused(() => finish(OWN, s.connectionId, { expectedVersion: 2, state: 'short' }), 400, 'VALIDATION_FAILED', 'malformed state');
  await refused(() => finish(OWN, s.connectionId, { expectedVersion: 2, state: stripeState, authorizationCode: 'sim_x' }), 400, 'VALIDATION_FAILED', 'Stripe takes no authorization code');
  await refused(() => refresh(OWN, s.connectionId, 2), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'refresh before finish');
  const finished = await success(() => finish(OWN, s.connectionId, { expectedVersion: 2, state: stripeState }), 'finish Stripe');
  const sf = finished.data.connection;
  ok(sf.state === 'CONNECTED_ACTIVE' && sf.version === 3 && sf.chargesEnabled && sf.payoutsEnabled && !sf.requirementsDue && !sf.onboardingPending
    && Object.values(sf.capabilities).every(Boolean) && sf.statusObservedAt !== null, 'Stripe active with every capability');
  ok((await connectionRow(s.connectionId)).onboarding_state_hash === null, 'the state hash is cleared');
  await refused(() => finish(OWN, s.connectionId, { expectedVersion: 3, state: stripeState }), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'the state cannot be used twice');
  const leaked = (await sql(`SELECT (SELECT count(*) FROM hon.idempotency_records WHERE organization_id=$1 AND (request_fingerprint LIKE $2 OR response_body::text LIKE $2))
      + (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1 AND (prior_state::text LIKE $2 OR next_state::text LIKE $2))
      + (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1 AND payload::text LIKE $2)
      + (SELECT count(*) FROM hon.school_pay_connection_events WHERE organization_id=$1 AND snapshot::text LIKE $2) n`, [ids.organization, `%${stripeState}%`])).rows[0].n;
  ok(Number(leaked) === 0, 'the raw onboarding state is stored nowhere');

  // 5. Square: OAuth code flow, wrong code refused by the provider, bank debit narrowed away.
  const q = (await success(() => start(OWN, 'SQUARE'), 'start Square')).data.connection;
  const qLinked = await success(() => link(OWN, q.connectionId, 1), 'Square onboarding link');
  const qUrl = new URL(qLinked.data.onboardingUrl);
  ok(qLinked.data.connection.accountRef === null && qUrl.searchParams.get('code')?.startsWith('sim_'), 'Square has no account until the code exchange');
  await refused(() => finish(OWN, q.connectionId, { expectedVersion: 2, state: qUrl.searchParams.get('state') }), 400, 'VALIDATION_FAILED', 'Square needs the authorization code');
  await refused(() => finish(OWN, q.connectionId, { expectedVersion: 2, state: qUrl.searchParams.get('state'), authorizationCode: 'sim_wrong' }), 502, 'SCHOOL_PAY_PROVIDER_REJECTED', 'wrong authorization code');
  const qf = (await success(() => finish(OWN, q.connectionId, { expectedVersion: 2, state: qUrl.searchParams.get('state'), authorizationCode: qUrl.searchParams.get('code') }), 'finish Square')).data.connection;
  ok(qf.state === 'CONNECTED_ACTIVE' && /^MLSIM[0-9a-f]{16}$/.test(qf.accountRef) && qf.capabilities.bankDebit === false && qf.capabilities.storedCard && qf.capabilities.offSessionRecurring, 'Square active, cards only');

  // 6. Default: one per school, only ACTIVE; switching clears the earlier default.
  await refused(() => makeDefault(READER, s.connectionId, 3), 403, undefined, 'reader cannot choose the default');
  const d1 = (await success(() => makeDefault(OWN, s.connectionId, 3), 'Stripe default')).data.connection;
  ok(d1.isDefault && d1.version === 4, 'Stripe is the default');
  await refused(() => makeDefault(OWN, s.connectionId, 4), 409, 'SCHOOL_PAY_ALREADY_DEFAULT', 'already the default');
  const d2 = (await success(() => makeDefault(OWN, q.connectionId, 3), 'Square default')).data.connection;
  const sAfter = await connectionRow(s.connectionId);
  ok(d2.isDefault && !sAfter.is_default && sAfter.version === 5, 'switching the default clears Stripe (version bumped)');
  ok((await sql("SELECT count(*)::int n FROM hon.school_pay_connection_events WHERE connection_id=$1 AND kind='DEFAULT_CLEARED'", [s.connectionId])).rows[0].n === 1, 'the cleared default is in the history');

  // 7. Refresh: requirements due -> RESTRICTED (default and capabilities dropped); back to ACTIVE; revoked -> REAUTHORIZATION_REQUIRED.
  square.statuses.set(qf.accountRef, { requirementsDue: true });
  const r1 = (await success(() => refresh(OWN, q.connectionId, 4), 'Square refresh with requirements due')).data.connection;
  ok(r1.state === 'CONNECTED_RESTRICTED' && !r1.isDefault && Object.values(r1.capabilities).every((v) => v === false) && r1.requirementsDue, 'restricted: no default, no capabilities');
  await refused(() => makeDefault(OWN, q.connectionId, 5), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'a restricted connection cannot be the default');
  square.statuses.delete(qf.accountRef);
  ok((await success(() => refresh(OWN, q.connectionId, 5), 'Square refresh healthy')).data.connection.state === 'CONNECTED_ACTIVE', 'active again');
  square.revoked.add(qf.accountRef);
  ok((await success(() => refresh(OWN, q.connectionId, 6), 'Square refresh revoked')).data.connection.state === 'REAUTHORIZATION_REQUIRED', 'revoked access needs reauthorization');
  square.revoked.delete(qf.accountRef);
  ok((await success(() => refresh(OWN, q.connectionId, 7), 'Square refresh restored')).data.connection.state === 'CONNECTED_ACTIVE', 'reauthorized');

  // 8. A provider account links inside one organization only; same-organization schools may share it.
  const other = (await success(() => start(OTHER_ORG, 'STRIPE_CONNECT'), 'other organization start')).data.connection;
  stripe.nextAccount = sf.accountRef;
  await refused(() => link(OTHER_ORG, other.connectionId, 1), 409, 'SCHOOL_PAY_ACCOUNT_LINKED_ELSEWHERE', 'another organization cannot link the same account');
  const b = (await success(() => start(OWN_B, 'STRIPE_CONNECT'), 'school B start')).data.connection;
  stripe.nextAccount = sf.accountRef;
  const bLinked = await success(() => link(OWN_B, b.connectionId, 1), 'school B shares the organization account');
  ok(bLinked.data.connection.accountRef === sf.accountRef, 'school B links the same organization account');
  ok((await success(() => finish(OWN_B, b.connectionId, { expectedVersion: 2, state: stateOf(bLinked.data.onboardingUrl) }), 'school B finish')).data.connection.state === 'CONNECTED_ACTIVE', 'school B active');
  await refused(() => refresh(OWN, b.connectionId, 3), 404, 'SCHOOL_PAY_CONNECTION_NOT_FOUND', 'school A cannot reach school B connection');

  // 9. Live authority loss: revoked grant, suspended entitlement, suspended school.
  ok((await success(() => read(LOSER), 'loser read before')).data.canManage === true, 'loser manages before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => refresh(LOSER, s.connectionId, 5), 403, undefined, `${label}: refresh`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => read(LOSER), 'loser read after')).data.canManage === true, 'authority restored');

  // 10. Disconnect: reason required; provider revoked; ended rows never change; a fresh connection can start.
  await refused(() => disconnect(OWN, s.connectionId, 5, ''), 400, 'VALIDATION_FAILED', 'empty reason');
  const gone = await success(() => disconnect(OWN, s.connectionId, 5, 'Switching processors'), 'disconnect Stripe');
  // 0320: school B still uses the same organization account, so HON does not revoke it (a revoke is per account).
  ok(gone.data.connection.state === 'DISCONNECTED' && gone.data.connection.endReason === 'Switching processors' && gone.meta.providerRevoked === false
    && !stripe.revoked.has(sf.accountRef), 'disconnected; the account stays authorized while school B still uses it');
  const goneB = await success(() => disconnect(OWN_B, b.connectionId, 3, 'School B done'), 'disconnect school B');
  ok(goneB.meta.providerRevoked === true && stripe.revoked.has(sf.accountRef), 'the last connection on the account revokes access at the provider');
  await refused(() => refresh(OWN, s.connectionId, 6), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'refresh after disconnect');
  await refused(() => disconnect(OWN, s.connectionId, 6, 'again'), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'second disconnect');
  const abandoned = await success(() => disconnect(OTHER_ORG, other.connectionId, 1, 'Not now'), 'abandon an unfinished connection');
  ok(abandoned.data.connection.state === 'ABANDONED' && abandoned.meta.providerRevoked === false, 'never-connected connection is abandoned');
  const again = (await success(() => start(OWN, 'STRIPE_CONNECT'), 'start Stripe again')).data.connection;
  ok(again.connectionId !== s.connectionId && again.state === 'PENDING_ONBOARDING', 'a new Stripe connection after disconnect');
  const listed = (await success(() => read(OWN), 'read after everything')).data;
  ok(listed.connections.length === 3 && listed.connections.at(-1).connectionId === s.connectionId && listed.connections.filter((c) => c.isDefault).length === 0
    && listed.connections.find((c) => c.connectionId === q.connectionId).state === 'CONNECTED_ACTIVE', 'open first, ended last, no stale default');

  // 11. History, audit and inert outbox for every command.
  const events = (await sql('SELECT kind FROM hon.school_pay_connection_events WHERE connection_id=$1 ORDER BY connection_version, recorded_at', [s.connectionId])).rows.map((x) => x.kind);
  ok(events.join() === 'STARTED,ONBOARDING_LINK,FINISHED,DEFAULT_SET,DEFAULT_CLEARED,DISCONNECTED', `Stripe history ${events.join()}`);
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_PAY_CONNECTION'", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_PAY_CONNECTION'", [ids.organization])).rows[0].n;
  const commandEvents = (await sql("SELECT count(*)::int n FROM hon.school_pay_connection_events WHERE organization_id=$1 AND kind<>'DEFAULT_CLEARED'", [ids.organization])).rows[0].n;
  ok(audit === commandEvents + 1 && outbox === commandEvents && outbox === (await sql('SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1', [ids.organization])).rows[0].n - outboxBefore,
    'one audit and one outbox event per command (plus one audit for the cleared default)');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_PAY_CONNECTION' AND status<>'PENDING'", [ids.organization])).rows[0].n === 0, 'outbox events are inert (pending, no consumer)');

  // 12. Settings-free guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('UPDATE hon.school_pay_connections SET end_reason=$2, version=version+1 WHERE id=$1', [s.connectionId, 'rewrite']), /SCHOOL_PAY_CONNECTION_IMMUTABLE/, 'ended connection rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_pay_connections SET provider_account_ref='acct_other1234', version=version+1 WHERE id=$1", [q.connectionId]), /SCHOOL_PAY_CONNECTION_IMMUTABLE/, 'account ref swapped');
  await rejectsSql(() => sql('UPDATE hon.school_pay_connections SET is_default=false WHERE id=$1', [q.connectionId]), /SCHOOL_PAY_CONNECTION_IMMUTABLE/, 'update without a version bump');
  await rejectsSql(() => sql("UPDATE hon.school_pay_connections SET mode='LIVE', version=version+1 WHERE id=$1", [q.connectionId]), /SCHOOL_PAY_CONNECTION_IMMUTABLE|check constraint/, 'LIVE mode');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_connections WHERE id=$1', [q.connectionId]), /SCHOOL_PAY_CONNECTION_IMMUTABLE/, 'connection deleted');
  await rejectsSql(() => sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,mode,started_by_principal_id) VALUES($1,$2,'SQUARE','LIVE',$3)`, [ids.organization, ids.schoolB, OWN.principal]), /check constraint/, 'LIVE insert');
  await rejectsSql(() => sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,started_by_principal_id) VALUES($1,$2,'SQUARE','CONNECTED_ACTIVE','MLSIMX1234',$3)`, [ids.organization, ids.schoolB, OWN.principal]), /SCHOOL_PAY_CONNECTION_IMMUTABLE/, 'insert already connected');
  await rejectsSql(() => sql("UPDATE hon.school_pay_connection_events SET kind='STARTED' WHERE connection_id=$1", [s.connectionId]), /IMMUTABLE/, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_connection_events WHERE connection_id=$1', [s.connectionId]), /IMMUTABLE/, 'history deleted');
  await rejectsSql(() => sql("UPDATE hon.school_pay_providers SET live_allowed=true WHERE code='STRIPE_CONNECT'"), /IMMUTABLE|check constraint/, 'provider made live');
  await rejectsSql(() => sql("INSERT INTO hon.school_pay_providers(code,display_name,test_supported,live_allowed,sort_order) VALUES('HON_PAY_X','HON',true,true,99)"), /check constraint/, 'a live provider row');
  await rejectsSql(() => sql('TRUNCATE hon.school_pay_connection_events'), /./, 'history truncated');
  await sql('ROLLBACK');

  // 13. Runtime ACL: EXECUTE on the six entry points only; no table privilege, no helper, nothing for PUBLIC.
  const entry = ['read_school_payment_processors(text)', 'start_school_payment_connection(text,jsonb,text,uuid,uuid)', 'set_school_payment_onboarding_link(text,uuid,jsonb,text,uuid,uuid)',
    'record_school_payment_status(text,uuid,jsonb,text,uuid,uuid)', 'set_default_school_payment_connection(text,uuid,jsonb,text,uuid,uuid)', 'disconnect_school_payment_connection(text,uuid,jsonb,text,uuid,uuid)'];
  const helpers = ['school_pay_capabilities_ok(jsonb)', 'guard_school_pay_connection()', 'require_school_pay_actor(text,text)', 'require_school_pay_reader(text)',
    'school_pay_connection_json(hon.school_pay_connections)', 'school_pay_observation_ok(jsonb)', 'school_pay_command_begin(text,text,text)',
    'school_pay_command_finish(text,text,uuid,hon.school_pay_connections,text,text,jsonb,uuid,uuid)', 'school_pay_args_ok(text,uuid,jsonb,text,uuid,uuid,text[],text[])',
    'school_pay_lock_connection(uuid,integer)', 'school_pay_account_free(hon.school_pay_connections,text)'];
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
  for (const table of ['school_pay_providers', 'school_pay_connections', 'school_pay_connection_events']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.require_school_pay_actor('x','school_pay.read')"), /permission denied/); checks += 1;
  // Called directly without the human session settings, every entry point refuses.
  await assert.rejects(runtime.query("SELECT hon.read_school_payment_processors('x')"), /SCHOOL_PAY_READ_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0258 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School payment connections exact verification (B-TUI-2 0258)', end = '-- End school payment connections exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 14. No money, card, token or invoice effect.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school payment connections (0258): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
