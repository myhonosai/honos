/**
 * School payment credential vault proof (B-TUI-2 piece 2, 0320) over signed HTTP (HON session cookie -> HonIdentityGuard
 * + human UI guards -> SchoolPaymentController -> SchoolPaymentService with the AES-256-GCM vault -> in-process Square and
 * Stripe simulators (no network; the simulated Square hands back synthetic OAuth tokens) -> protected definer functions on
 * the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Sandbox only; synthetic
 * data; nothing charges, refunds, stores a card or sends a message.
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
const { SCHOOL_PAYMENT_ADAPTERS, SimulatedStripeConnectAdapter, SimulatedSquareAdapter, SchoolPaymentProviderError } = await load('school-payments/school-payment-adapter.js');
const { SCHOOL_PAYMENT_VAULT, SchoolPaymentVault } = await load('school-payments/school-payment-vault.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-payment-vault', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

/** Square simulator that counts code exchanges and remembers every credential it hands out. */
class ProofSquare extends SimulatedSquareAdapter {
  exchanges = 0; issued = []; failRenewal = false; revokeRenewal = false;
  async completeOnboarding(input) { this.exchanges += 1; const result = await super.completeOnboarding(input); this.issued.push(result.credential); return result; }
  async renewCredential(input) {
    if (this.failRenewal) throw new SchoolPaymentProviderError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (this.revokeRenewal) throw new SchoolPaymentProviderError('FAILED', 'GRANT_REVOKED');
    const credential = await super.renewCredential(input); this.issued.push(credential); return credential;
  }
}
const stripe = new SimulatedStripeConnectAdapter();
const square = new ProofSquare();
const vault = new SchoolPaymentVault(randomBytes(32), 'proof-vault');
const adapters = new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]);
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolPaymentController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolPaymentService, { provide: RuntimeDatabaseService, useValue: database },
      { provide: SCHOOL_PAYMENT_ADAPTERS, useValue: adapters }, { provide: SCHOOL_PAYMENT_VAULT, useValue: vault }],
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`schoolvault-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`schoolvault-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`schoolvault-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `schoolvault-${ids.organization}-${label}`;
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

let OWN, OWN_B, READER, OTHER_ORG;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'School Vault Org','School Vault Org'),($2,'School Vault Other Org','School Vault Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `School Vault ${slug}`, `schoolvault-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_pay.connection.manage'])], { school: ids.schoolB });
  READER = await staff('reader', [await role(ids.organization, ['school_pay.read'])]);
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
}

const connectionRow = async (id) => (await sql('SELECT * FROM hon.school_pay_connections WHERE id=$1', [id])).rows[0];
const stateOf = (url) => new URL(url).searchParams.get('state');
const credentialRow = async (id) => (await sql('SELECT * FROM hon.school_pay_credentials WHERE connection_id=$1', [id])).rows[0];
const binding = (connectionId, accountRef) => ({ connectionId, providerCode: 'SQUARE', accountRef });
/** Every place a token could leak to: idempotency, audit, outbox, history, connections, credentials (outside the sealed text). */
async function leaks(secret) {
  const pattern = `%${secret}%`;
  return Number((await sql(`SELECT (SELECT count(*) FROM hon.idempotency_records WHERE organization_id=ANY($1::uuid[]) AND (request_fingerprint LIKE $2 OR response_body::text LIKE $2))
    + (SELECT count(*) FROM hon.audit_events WHERE organization_id=ANY($1::uuid[]) AND (coalesce(prior_state::text,'') LIKE $2 OR coalesce(next_state::text,'') LIKE $2))
    + (SELECT count(*) FROM hon.outbox_events WHERE organization_id=ANY($1::uuid[]) AND payload::text LIKE $2)
    + (SELECT count(*) FROM hon.school_pay_connection_events WHERE organization_id=ANY($1::uuid[]) AND snapshot::text LIKE $2)
    + (SELECT count(*) FROM hon.school_pay_connections x WHERE organization_id=ANY($1::uuid[]) AND row_to_json(x)::text LIKE $2)
    + (SELECT count(*) FROM hon.school_pay_credentials k WHERE organization_id=ANY($1::uuid[]) AND row_to_json(k)::text LIKE $2) n`,
    [[ids.organization, ids.otherOrganization], pattern])).rows[0].n);
}
/** A direct runtime call under the actor's human settings (what the API does), for paths HTTP cannot reach. */
async function asRuntime(actor, statement, values, request = randomUUID()) {
  return database.withTenantTransaction({ organizationId: actor.org, schoolId: actor.school, requestId: request, principalId: actor.principal, principalType: 'HUMAN_USER' },
    async (client) => {
      await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [actor.subject]);
      return (await client.query(statement, values)).rows[0]?.data;
    });
}
async function squareConnected(actor) {
  const c = (await success(() => start(actor, 'SQUARE'), 'start Square')).data.connection;
  const linked = await success(() => link(actor, c.connectionId, 1), 'Square link');
  const url = new URL(linked.data.onboardingUrl);
  return { c, state: url.searchParams.get('state'), code: url.searchParams.get('code') };
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Registry, tables and ACL.
  ok(JSON.stringify((await sql('SELECT provider_code, credential_kind FROM hon.school_pay_provider_credentials ORDER BY 1')).rows) === JSON.stringify([{ provider_code: 'SQUARE', credential_kind: 'OAUTH_TOKENS' }]),
    'only Square keeps per-school credentials; Stripe keeps none');
  for (const table of ['school_pay_provider_credentials', 'school_pay_credentials']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  for (const fn of ['check_school_payment_onboarding_state(text,uuid,jsonb)', 'record_school_payment_status_with_credential(text,uuid,jsonb,text,uuid,uuid)',
    'read_school_payment_credential(text,uuid)', 'read_school_payment_account_use(text,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['guard_school_pay_credential()', 'destroy_school_pay_credential_on_end()', 'check_school_pay_connection_credential()', 'school_pay_credential_input_ok(jsonb)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  await assert.rejects(runtime.query(`SELECT hon.read_school_payment_credential('x','${randomUUID()}')`), /SCHOOL_PAY_MANAGE_FORBIDDEN/); checks += 1;

  // 1. A wrong or stale return never spends Square's one-time code.
  const q = await squareConnected(OWN);
  await refused(() => finish(OWN, q.c.connectionId, { expectedVersion: 2, state: 'x'.repeat(43), authorizationCode: q.code }), 403, 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH', 'wrong state');
  await refused(() => finish(OWN, q.c.connectionId, { expectedVersion: 1, state: q.state, authorizationCode: q.code }), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => finish(READER, q.c.connectionId, { expectedVersion: 2, state: q.state, authorizationCode: q.code }), 403, undefined, 'reader');
  ok(square.exchanges === 0, 'no code exchange happened before the state was confirmed');
  ok(!(await credentialRow(q.c.connectionId)), 'nothing stored for a refused return');

  // 2. Finish: the token is sealed and stored in the same commit; it appears nowhere else.
  const finishKey = randomUUID();
  const qf = (await success(() => finish(OWN, q.c.connectionId, { expectedVersion: 2, state: q.state, authorizationCode: q.code }, { key: finishKey }), 'finish Square')).data.connection;
  ok(square.exchanges === 1 && qf.state === 'CONNECTED_ACTIVE', 'one exchange, connected');
  const first = square.issued.at(-1);
  const stored = await credentialRow(q.c.connectionId);
  ok(stored && stored.version === 1 && stored.key_id === 'proof-vault' && stored.destroyed_at === null && stored.provider_code === 'SQUARE'
    && stored.organization_id === ids.organization && stored.school_id === ids.schoolA, 'credential stored for this connection, version 1');
  ok(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(stored.sealed) && !stored.sealed.includes(first.accessToken) && !stored.sealed.includes(first.refreshToken), 'only sealed text is stored');
  ok(stored.access_expires_at.toISOString() === first.accessExpiresAt, 'access expiry kept in clear (not secret)');
  ok(JSON.stringify(vault.open(binding(q.c.connectionId, qf.accountRef), stored.key_id, stored.sealed)) === JSON.stringify(first), 'the API vault opens it to the issued tokens');
  assert.throws(() => vault.open(binding(randomUUID(), qf.accountRef), stored.key_id, stored.sealed)); checks += 1;
  ok(await leaks(first.accessToken) === 0 && await leaks(first.refreshToken) === 0, 'no token in idempotency, audit, outbox, history or rows');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='school_pay.credential.store' AND next_state->>'credentialVersion'='1' AND NOT next_state ? 'sealed'", [q.c.connectionId])).rows[0].n === 1, 'store audited without the sealed text');
  // An exact finish replay is refused before any exchange (the connection is no longer pending) and stores nothing.
  await refused(() => finish(OWN, q.c.connectionId, { expectedVersion: 2, state: q.state, authorizationCode: q.code }, { key: finishKey }), 409, 'SCHOOL_PAY_CONNECTION_STATE', 'finish replay');
  ok(square.exchanges === 1 && (await credentialRow(q.c.connectionId)).version === 1, 'replay: no exchange, no store');

  // 3. Refresh opens the stored token in memory; a fresh token is not renewed.
  const r1 = (await success(() => refresh(OWN, q.c.connectionId, 3), 'refresh')).data.connection;
  ok(r1.state === 'CONNECTED_ACTIVE' && square.seenTokens.at(-1) === first.accessToken, 'status read with the stored access token');
  ok((await credentialRow(q.c.connectionId)).version === 1, 'no rotation for a fresh token');

  // 4. Renewal within 7 days of expiry: rotated in the same commit as the refresh; a replay stores nothing.
  square.now = () => new Date(Date.now() + 25 * 86_400_000);
  const renewKey = randomUUID();
  await success(() => refresh(OWN, q.c.connectionId, 4, { key: renewKey }), 'refresh with renewal');
  const renewed = square.issued.at(-1);
  const rotated = await credentialRow(q.c.connectionId);
  ok(renewed.accessToken !== first.accessToken && square.seenTokens.at(-1) === renewed.accessToken, 'renewed token used for the status read');
  ok(rotated.version === 2 && rotated.rotated_at !== null && rotated.sealed !== stored.sealed
    && JSON.stringify(vault.open(binding(q.c.connectionId, qf.accountRef), rotated.key_id, rotated.sealed)) === JSON.stringify(renewed), 'rotated credential stored, version 2');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='school_pay.credential.rotate'", [q.c.connectionId])).rows[0].n === 1, 'rotation audited');
  ok(await leaks(renewed.accessToken) === 0, 'renewed token stored nowhere in clear');
  const replayed = await success(() => refresh(OWN, q.c.connectionId, 4, { key: renewKey }), 'renewal replay');
  ok(replayed.meta.replayed === true && (await credentialRow(q.c.connectionId)).version === 2, 'an exact replay rotates nothing');
  // A lost renewal answer is UNKNOWN; nothing changes.
  square.now = () => new Date(Date.now() + 50 * 86_400_000);
  square.failRenewal = true;
  await refused(() => refresh(OWN, q.c.connectionId, 5), 503, 'SCHOOL_PAY_PROVIDER_UNKNOWN', 'renewal outcome unknown');
  square.failRenewal = false;
  ok((await credentialRow(q.c.connectionId)).version === 2 && (await connectionRow(q.c.connectionId)).version === 5, 'unknown renewal changed nothing');
  square.now = () => new Date();

  // 5. Direct runtime calls the API never makes are refused.
  const sealedInput = (expectedCredentialVersion) => ({ keyId: 'proof-vault', sealed: rotated.sealed, accessExpiresAt: renewed.accessExpiresAt, expectedCredentialVersion });
  const observation = { accountRef: qf.accountRef, chargesEnabled: true, payoutsEnabled: true, requirementsDue: false, reauthorizationRequired: false,
    capabilities: { bankDebit: false, offSessionRecurring: true, oneTimeCard: true, refunds: true, storedCard: true } };
  const withCredential = 'SELECT hon.record_school_payment_status_with_credential($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data';
  const callWith = (actor, id, body, request = randomUUID()) => asRuntime(actor, withCredential, [actor.subject, id, JSON.stringify(body), randomUUID(), request, randomUUID()], request);
  await assert.rejects(callWith(OWN, q.c.connectionId, { expectedVersion: 5, kind: 'REFRESH', observation, credential: sealedInput(1) }), /SCHOOL_PAY_CREDENTIAL_CONFLICT/); checks += 1;
  await assert.rejects(callWith(OWN, q.c.connectionId, { expectedVersion: 5, kind: 'REFRESH', observation, credential: sealedInput(0) }), /VALIDATION_FAILED/); checks += 1;
  await assert.rejects(callWith(OWN, q.c.connectionId, { expectedVersion: 5, kind: 'REFRESH', observation, credential: { ...sealedInput(2), sealed: 'plain-token' } }), /VALIDATION_FAILED/); checks += 1;
  await assert.rejects(callWith(OWN, q.c.connectionId, { expectedVersion: 5, kind: 'REFRESH', observation, credential: { ...sealedInput(2), extra: 1 } }), /VALIDATION_FAILED/); checks += 1;
  await assert.rejects(callWith(OWN_B, q.c.connectionId, { expectedVersion: 5, kind: 'REFRESH', observation, credential: sealedInput(2) }), /SCHOOL_PAY_CONNECTION_NOT_FOUND/); checks += 1;
  await assert.rejects(asRuntime(READER, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [READER.subject, q.c.connectionId]), /SCHOOL_PAY_MANAGE_FORBIDDEN/); checks += 1;
  await assert.rejects(asRuntime(OWN_B, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [OWN_B.subject, q.c.connectionId]), /SCHOOL_PAY_CONNECTION_NOT_FOUND/); checks += 1;
  await assert.rejects(asRuntime(OTHER_ORG, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [OTHER_ORG.subject, q.c.connectionId]), /SCHOOL_PAY_CONNECTION_NOT_FOUND/); checks += 1;
  const readBack = await asRuntime(OWN, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [OWN.subject, q.c.connectionId]);
  ok(readBack.sealed === rotated.sealed && readBack.credentialVersion === 2 && readBack.accountRef === qf.accountRef && Object.keys(readBack).sort().join() === 'accessExpiresAt,accountRef,connectionId,connectionVersion,credentialVersion,keyId,providerCode,sealed', 'owner reads only the sealed record');
  ok((await credentialRow(q.c.connectionId)).version === 2, 'refused calls stored nothing');

  // 6. A Square finish through the plain 0258 command (no credential) cannot commit.
  const qb = await squareConnected(OWN_B);
  const plainRequest = randomUUID();
  await assert.rejects(asRuntime(OWN_B, 'SELECT hon.record_school_payment_status($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
    [OWN_B.subject, qb.c.connectionId, JSON.stringify({ expectedVersion: 2, kind: 'FINISH', onboardingState: qb.state, observation: { ...observation, accountRef: 'MLSIMPLAIN000001' } }), randomUUID(), plainRequest, randomUUID()], plainRequest),
    /SCHOOL_PAY_CREDENTIAL_REQUIRED/); checks += 1;
  ok((await connectionRow(qb.c.connectionId)).state === 'PENDING_ONBOARDING', 'the plain finish rolled back');
  await sql('BEGIN');
  await sql("UPDATE hon.school_pay_connections SET version=version+1,state='CONNECTED_ACTIVE',provider_account_ref='MLSIMOWNER000001',onboarding_state_hash=NULL WHERE id=$1", [qb.c.connectionId]);
  await assert.rejects(sql('COMMIT'), /SCHOOL_PAY_CREDENTIAL_REQUIRED/); checks += 1;
  // The stored-credential guard holds whoever writes (rolled back).
  await sql('BEGIN');
  await rejectsSql(() => sql('DELETE FROM hon.school_pay_credentials WHERE connection_id=$1', [q.c.connectionId]), /SCHOOL_PAY_CREDENTIAL_IMMUTABLE/, 'credential delete');
  await rejectsSql(() => sql('UPDATE hon.school_pay_credentials SET sealed=sealed WHERE connection_id=$1', [q.c.connectionId]), /SCHOOL_PAY_CREDENTIAL_IMMUTABLE/, 'update without version bump');
  await rejectsSql(() => sql('UPDATE hon.school_pay_credentials SET version=version+1,school_id=$2 WHERE connection_id=$1', [q.c.connectionId, ids.schoolB]), /SCHOOL_PAY_CREDENTIAL_IMMUTABLE|foreign key/, 'scope moved');
  await rejectsSql(() => sql("UPDATE hon.school_pay_credentials SET version=version+1,sealed='EAAA-plaintext' WHERE connection_id=$1", [q.c.connectionId]), /check constraint/, 'plaintext refused by CHECK');
  await rejectsSql(() => sql('TRUNCATE hon.school_pay_credentials'), /./, 'truncate');
  await sql('ROLLBACK');

  // 7. Disconnect destroys the sealed credential in the same commit, then revokes (the account is used nowhere else).
  const gone = await success(() => disconnect(OWN, q.c.connectionId, 5, 'Switching processors'), 'disconnect Square');
  const destroyed = await credentialRow(q.c.connectionId);
  ok(gone.meta.providerRevoked === true && square.revoked.has(qf.accountRef), 'Square access revoked at the provider');
  ok(destroyed.sealed === null && destroyed.destroyed_at !== null && destroyed.version === 3, 'sealed credential destroyed');
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_pay_credentials SET version=version+1,sealed=$2,destroyed_at=NULL WHERE connection_id=$1", [q.c.connectionId, rotated.sealed]), /SCHOOL_PAY_CREDENTIAL_IMMUTABLE/, 'a destroyed credential never comes back');
  await sql('ROLLBACK');
  await assert.rejects(asRuntime(OWN, 'SELECT hon.read_school_payment_credential($1,$2::uuid) AS data', [OWN.subject, q.c.connectionId]), /SCHOOL_PAY_CONNECTION_NOT_FOUND/); checks += 1;
  ok((await sql("SELECT count(*)::int n FROM hon.school_pay_credentials WHERE organization_id=ANY($1::uuid[]) AND destroyed_at IS NULL AND connection_id IN (SELECT id FROM hon.school_pay_connections WHERE ended_at IS NOT NULL)", [[ids.organization, ids.otherOrganization]])).rows[0].n === 0, 'no ended connection keeps a sealed credential');

  // 8. A pending Square connection abandoned before finishing has nothing to destroy or revoke.
  const abandoned = await success(() => disconnect(OWN_B, qb.c.connectionId, 2, 'Not now'), 'abandon pending Square');
  ok(abandoned.data.connection.state === 'ABANDONED' && abandoned.meta.providerRevoked === false && !(await credentialRow(qb.c.connectionId)), 'abandoned: no credential, no revoke');

  // 8b. A grant the seller revoked at Square, found while renewing a near-expiry token: recorded as
  // REAUTHORIZATION_REQUIRED in a normal refresh, with no rotation and no status read on the dead token.
  { const g = await squareConnected(OWN_B);
    const gf = (await success(() => finish(OWN_B, g.c.connectionId, { expectedVersion: 2, state: g.state, authorizationCode: g.code }), 'finish Square (school B)')).data.connection;
    const before = await credentialRow(g.c.connectionId);
    const reads = square.seenTokens.length;
    square.now = () => new Date(Date.now() + 25 * 86_400_000);
    square.revokeRenewal = true;
    const revokedRefresh = (await success(() => refresh(OWN_B, g.c.connectionId, gf.version), 'refresh with a revoked grant')).data.connection;
    square.revokeRenewal = false; square.now = () => new Date();
    const after = await credentialRow(g.c.connectionId);
    ok(revokedRefresh.state === 'REAUTHORIZATION_REQUIRED' && (await connectionRow(g.c.connectionId)).state === 'REAUTHORIZATION_REQUIRED', 'revoked grant recorded as reauthorization required');
    ok(after.version === before.version && after.sealed === before.sealed && after.destroyed_at === null, 'no rotation for a revoked grant');
    ok(square.seenTokens.length === reads, 'no status read with the revoked token');
    ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='school_pay.credential.rotate'", [g.c.connectionId])).rows[0].n === 0, 'no rotation audited');
    const ended = await success(() => disconnect(OWN_B, g.c.connectionId, revokedRefresh.version, 'Reconnecting later'), 'disconnect revoked Square');
    ok((await credentialRow(g.c.connectionId)).sealed === null && ended.data.connection.state !== 'CONNECTED_ACTIVE', 'revoked connection can still be ended and its credential destroyed'); }

  // 9. Stripe keeps no credential and never revokes the school's own account.
  const s = (await success(() => start(OWN, 'STRIPE_CONNECT'), 'start Stripe')).data.connection;
  const sLinked = await success(() => link(OWN, s.connectionId, 1), 'Stripe link');
  const sf = (await success(() => finish(OWN, s.connectionId, { expectedVersion: 2, state: stateOf(sLinked.data.onboardingUrl) }), 'finish Stripe')).data.connection;
  ok(sf.state === 'CONNECTED_ACTIVE' && !(await credentialRow(s.connectionId)), 'Stripe connected without a stored credential');

  // 10. The deployment verifier's 0320 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School payment credential vault exact verification (B-TUI-2 0320)', end = '-- End school payment credential vault exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');
  console.log(`PASS: school payment credential vault (0320): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
