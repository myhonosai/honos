/**
 * School blast recipients read proof (0716) over signed HTTP (HON session cookie ->
 * HonIdentityGuard + human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolBlastController -> protected
 * definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only.
 * Synthetic contacts only. Messages are only QUEUED for the 0243 worker; no provider is called and nothing is paid.
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
import { membershipFixtureStatement } from './membership-activation-test-support.mjs';

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
const { SchoolBlastController } = await load('school-blasts/school-blast.controller.js');
const { SchoolBlastService } = await load('school-blasts/school-blast.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-blast-recipients', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolBlastController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolBlastService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function call(actor, method, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/marketing/blasts${path}${query}`);
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
const list = (actor, options = {}) => call(actor, 'GET', options);
const read = (actor, id, options = {}) => call(actor, 'GET', { path: `/${id}`, ...options });
const audience = (actor, id, options = {}) => call(actor, 'GET', { path: `/${id}/audience`, ...options });
const save = (actor, body, options = {}) => call(actor, 'POST', { command: 'marketing_blast.save', body, ...options });
const send = (actor, body, options = {}) => call(actor, 'POST', { path: '/send', command: 'marketing_blast.send', body, ...options });
const cancel = (actor, body, options = {}) => call(actor, 'POST', { path: '/cancel', command: 'marketing_blast.cancel', body, ...options });
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
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0478 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%bl16-${ids.organization}-%`) {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  await sql('SET CONSTRAINTS ALL IMMEDIATE'); // crm_leads carries deferred checks; fire them now so its triggers can be switched off
  try {
    for (let pass = 0; pass < 10; pass += 1) {
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_blasts WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a blast behind');
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
  const user = randomUUID(), principal = randomUUID(), subject = `bl16-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Blast Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Coach ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school, label };
}
async function person(given, family, { email = null, phone = null, consent = [], school = ids.schoolA, org = ids.organization, first = null } = {}) {
  const id = first ? first + randomUUID().slice(1) : randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, given, family, email, phone]);
  for (const channel of consent) {
    await sql("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,'OPTED_IN','STAFF',clock_timestamp(),$5)", [org, school, id, channel, OWN.principal]);
  }
  return id;
}
async function raw(table, text, values) {
  await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
  try { return await sql(text, values); } finally { await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`); }
}
const draft = (audienceValue, patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'Open house', channel: 'EMAIL', subject: 'Hi {{first_name}}',
  body: 'Hello {{first_name}}, see you at {{school_name}}.', audience: audienceValue, ...patch });
const recipients = (actor, id, options = {}) => call(actor, 'GET', { path: `/${id}/recipients`, ...options });

let OWN, SENDER, READER, NOBODY, OWN_B, P = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'BL16 Org','BL16 Org'),($2,'BL16 Other Org','BL16 Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `bl16-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  SENDER = await staff('sender', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['marketing.blast.read'])]);
  NOBODY = await staff('nobody', [await role(ids.organization, ['communication.message.read'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])], { school: ids.schoolB });
  P.avery = await person('Avery', 'Able', { email: 'avery@example.test', consent: ['EMAIL'] });
  P.blake = await person('Blake', 'Brown', { email: 'blake@example.test', consent: ['EMAIL'] });
  P.casey = await person('Casey', 'Cole', { email: 'casey@example.test' });
  P.drew = await person('Drew', 'Dunn', { consent: ['EMAIL'] });
}

try {
  await cleanup();
  await seed();
  await startApp();
  const everyone = { groups: [], tags: [], people: [P.avery, P.blake, P.casey, P.drew] };

  // R2: a draft has no rows.
  const saved = (await success(() => save(SENDER, draft(everyone)), 'save draft')).data;
  const empty = (await success(() => recipients(READER, saved.blastId), 'draft recipients')).data;
  ok(empty.status === 'DRAFT' && empty.items.length === 0 && empty.blastId === saved.blastId && empty.channel === 'EMAIL', `draft ${JSON.stringify(empty)}`);

  // R2: a sent blast lists every recipient row, queued people first, with the message and its delivery state.
  const sent = (await success(() => send(SENDER, { blastId: saved.blastId, expectedVersion: saved.version, sendAt: null }), 'send')).data;
  ok(sent.recipientCount === 2, `sent to two ${JSON.stringify(sent)}`);
  const list = (await success(() => recipients(READER, saved.blastId), 'sent recipients')).data;
  ok(list.status === 'QUEUED' && list.items.length === 4, `four rows ${JSON.stringify(list)}`);
  ok(JSON.stringify(list.items.map((r) => r.name)) === JSON.stringify(['Avery Able', 'Blake Brown', 'Casey Cole', 'Drew Dunn']), `queued first, then by name ${JSON.stringify(list.items.map((r) => r.name))}`);
  ok(JSON.stringify(list.items.map((r) => r.outcome)) === JSON.stringify(['QUEUED', 'QUEUED', 'NO_CONSENT', 'NO_ADDRESS']), 'outcomes');
  const messages = (await sql('SELECT r.person_id::text p, r.message_id::text m FROM hon.school_blast_recipients r WHERE r.blast_id=$1 AND r.outcome=\'QUEUED\'', [saved.blastId])).rows;
  for (const row of messages) ok(list.items.find((r) => r.personId === row.p)?.messageId === row.m, `message id of ${row.p}`);
  ok(list.items.filter((r) => r.outcome === 'QUEUED').every((r) => r.delivery === 'WAITING' && r.failureCode === null), 'no delivery attempt yet: WAITING');
  ok(list.items.filter((r) => r.outcome !== 'QUEUED').every((r) => r.messageId === null && r.delivery === null), 'skipped people have no message');
  ok(!JSON.stringify(list).includes('@example.test') && !JSON.stringify(list).includes('Hello'), 'no address and no body');

  // The delivery state follows the 0243 delivery row, with its failure code.
  const avery = list.items.find((r) => r.personId === P.avery);
  await raw('communication_deliveries', `INSERT INTO hon.communication_deliveries(id,organization_id,school_id,message_id,channel,status,failure_code,attempt_count,final_at)
    SELECT gen_random_uuid(),m.organization_id,m.school_id,m.id,'EMAIL','BOUNCED','BOUNCED',1,clock_timestamp() FROM hon.communication_messages m WHERE m.id=$1`, [avery.messageId]);
  const after = (await success(() => recipients(READER, saved.blastId), 'after a bounce')).data;
  const bounced = after.items.find((r) => r.personId === P.avery);
  ok(bounced.delivery === 'BOUNCED' && bounced.failureCode === 'BOUNCED', `bounced ${JSON.stringify(bounced)}`);

  // R1: the read permission, the session school, and the human UI boundary.
  await refused(() => recipients(NOBODY, saved.blastId), 403, undefined, 'no marketing.blast.read');
  await refused(() => recipients(OWN_B, saved.blastId, { school: ids.schoolB }), 404, 'BLAST_NOT_FOUND', 'another school cannot read it');
  await refused(() => recipients(READER, saved.blastId, { school: ids.schoolB }), 403, undefined, 'a route school the reader has no grant for');
  await refused(() => recipients(READER, randomUUID()), 404, 'BLAST_NOT_FOUND', 'unknown blast');
  await refused(() => recipients(READER, 'not-a-uuid'), 400, undefined, 'bad id');
  await refused(() => recipients(READER, saved.blastId, { headers: { 'Idempotency-Key': randomUUID() } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read carries no key');
  await refused(() => recipients(READER, saved.blastId, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, undefined, 'cross-site');
  await sql("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1", [READER.grants[0]]);
  await refused(() => recipients(READER, saved.blastId), 403, undefined, 'revoked grant');

  // R4: one runtime entry point, owner-owned, no other grantee; the 0716 exact verification passes.
  const f = 'hon.read_school_blast_recipients(text,uuid)';
  ok((await sql("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') x", [CRM_CLOSE_RUNTIME_ROLE, f])).rows[0].x, 'runtime may call it');
  for (const r of ['anon', 'authenticated', 'service_role']) {
    const exists = (await sql('SELECT 1 FROM pg_roles WHERE rolname=$1', [r])).rowCount;
    if (exists) ok(!(await sql("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') x", [r, f])).rows[0].x, `${r} may not`);
  }
  await assert.rejects(runtime.query(`SELECT hon.read_school_blast_recipients('x','${saved.blastId}')`), /SCHOOL_BLAST_FORBIDDEN|permission denied|42501/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [start, end] of [['-- School blast recipients read exact verification (0716)', '-- End school blast recipients read exact verification.'],
      ['-- School blasts exact verification (0621)', '-- End school blasts exact verification.']]) {
      const section = verify.split(start)[1]?.split(end)[0];
      ok(section, `${start} section`);
      await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');

  console.log(`PASS: school blast recipients read (0716): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
