/**
 * Pictures inside email blasts proof (BL3b, 0653) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards
 * -> SchoolBlastController -> protected definer functions on the restricted runtime role), on the guarded disposable
 * CRM-close fixture only. Synthetic contacts and picture rows only: no file is stored, no provider is called, nothing is paid.
 * The worker's picture lookup is called as the fixture owner (the fixture has no worker role); its grant is checked by ACL.
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

const session = { mode: 'OIDC', audience: 'hon-school-blast-pictures', secret: randomBytes(32).toString('hex') };
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
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%bpic-${ids.organization}-%`) {
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
  const user = randomUUID(), principal = randomUUID(), subject = `bpic-${ids.organization}-${label}`;
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
async function membership(personId, state, { school = ids.schoolA, org = ids.organization } = {}) {
  const billing = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [billing, org, school, personId]);
  await sql('BEGIN');
  await membershipFixtureStatement(admin, "INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,'FIXTURE',$5)", [org, school, billing, personId, state]);
  await sql('COMMIT');
}
const tag = (personId, value, actor) => sql("INSERT INTO hon.contact_tags(organization_id,school_id,person_id,tag,tag_key,added_by_principal_id,added_source) VALUES($1,$2,$3,$4,lower($4),$5,'HUMAN_UI')",
  [ids.organization, ids.schoolA, personId, value, actor.principal]);
const messages = async (where = '') => (await sql(`SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1 ${where}`, [ids.organization])).rows[0].n;

const UUIDV = () => randomUUID();
const line = (id) => `{{picture:${id}}}`;
async function picture(title, { school = ids.schoolA, org = ids.organization, state = 'READY' } = {}) {
  const id = UUIDV(), token = randomBytes(32).toString('base64url').slice(0, 43);
  await sql(`INSERT INTO hon.school_media_assets(id,organization_id,school_id,kind,media_type,title,byte_size,sha256,width,height,object_key,link_token,created_by_principal_id)
    VALUES($1,$2,$3,'IMAGE','image/png',$4,10,$5,1200,800,$8,$6,$7)`, [id, org, school, title, 'a'.repeat(64), token, OWN.principal, `media/${id}`]);
  if (state !== 'PENDING') await sql("UPDATE hon.school_media_assets SET state='READY',ready_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
  if (state === 'DELETED') await sql("UPDATE hon.school_media_assets SET state='DELETED',deleted_at=clock_timestamp(),deleted_by_principal_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id, OWN.principal]);
  return { id, token };
}
const draft = (patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'Open house with pictures', channel: 'EMAIL', subject: 'Hi {{first_name}}',
  body: 'Hello {{first_name}},', audience: { groups: ['ACTIVE_STUDENTS'], tags: [] }, ...patch });
const pictures = async (delivery, lease) => (await sql('SELECT hon.communication_email_pictures($1,$2) v', [delivery, lease])).rows[0].v;

let OWN, SENDER, OWN_B, PIC = {}, P = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Pic Org','Pic Org'),($2,'Pic Other Org','Pic Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `bpic-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  SENDER = await staff('sender', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])], { school: ids.schoolB });
  P.ana = await person('Ana', 'Lee', { email: 'ana@example.test', phone: '+15550000001', consent: ['EMAIL', 'SMS'] });
  P.bo = await person('Bo', 'Kim', { email: 'bo@example.test', consent: ['EMAIL'] });
  for (const id of [P.ana, P.bo]) await membership(id, 'ACTIVE');
  P.b = await person('Cy', 'B', { email: 'cy@example.test', consent: ['EMAIL'], school: ids.schoolB });
  await membership(P.b, 'ACTIVE', { school: ids.schoolB });
  PIC.one = await picture('Open house');
  PIC.two = await picture('Belt test');
  PIC.pending = await picture('Unfinished', { state: 'PENDING' });
  PIC.deleted = await picture('Gone', { state: 'DELETED' });
  PIC.schoolB = await picture('Crane', { school: ids.schoolB });
  PIC.otherOrg = await picture('Other', { school: ids.otherSchool, org: ids.otherOrganization });
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. The body rules: whole picture lines in email only, at most 10, lower-case ids; the 0621 rules otherwise.
  const bodyOk = async (body, channel) => (await sql('SELECT hon.school_blast_body_ok(to_jsonb($1::text),$2) v', [body, channel])).rows[0].v;
  ok(await bodyOk(`Hi\n${line(PIC.one.id)}\nBye`, 'EMAIL'), 'a picture line in an email');
  ok(await bodyOk(line(PIC.one.id), 'EMAIL'), 'an email of one picture');
  ok(!(await bodyOk(`Hi ${line(PIC.one.id)}`, 'EMAIL')), 'a picture inside a line is a stray tag');
  ok(!(await bodyOk(line(PIC.one.id), 'SMS')), 'texts hold no pictures');
  ok(!(await bodyOk(line(PIC.one.id.toUpperCase().replace(/^./, 'A')), 'EMAIL')), 'upper-case ids are refused');
  ok(!(await bodyOk(`${line(PIC.one.id)}\r\nx`, 'EMAIL')), 'a \\r stays part of its line');
  ok(await bodyOk(`${Array(10).fill(line(PIC.one.id)).join('\n')}\nx`, 'EMAIL'), 'ten picture lines');
  ok(!(await bodyOk(`${Array(11).fill(line(PIC.one.id)).join('\n')}\nx`, 'EMAIL')), 'eleven picture lines are refused');
  ok(!(await bodyOk(`${'x'.repeat(3500)}\n${line(PIC.one.id)}`, 'EMAIL')), 'still at most 3,500 characters');
  ok(await bodyOk('Hello {{first_name}}', 'EMAIL') && await bodyOk('Hello {{first_name}}', 'SMS'), 'plain bodies as before');
  ok((await sql("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='hon.school_blasts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%school_blast_text_ok(to_jsonb(body)%'")).rows[0].n === 0
    && (await sql("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='hon.school_blasts'::regclass AND conname='school_blasts_body_ok' AND convalidated")).rows[0].n === 1, 'the table check is the 0653 body check');

  // 2. Save checks every picture is a READY picture of this school.
  const body = `Hello {{first_name}},\n${line(PIC.one.id)}\nSee you Saturday.\n${line(PIC.two.id)}\n${line(PIC.one.id)}`;
  const saved = (await success(() => save(SENDER, draft({ body })), 'save with pictures')).data;
  ok(saved.body === body, 'the body keeps its picture lines');
  for (const [p, label] of [[PIC.pending, 'an unfinished upload'], [PIC.deleted, 'a deleted picture'], [PIC.schoolB, 'another school\'s picture'], [PIC.otherOrg, 'another organization\'s picture'], [{ id: UUIDV() }, 'an unknown id']]) {
    await refused(() => save(SENDER, draft({ body: `Hi\n${line(p.id)}` })), 409, 'BLAST_PICTURE_NOT_READY', `save refuses ${label}`);
  }
  await refused(() => save(SENDER, draft({ channel: 'SMS', subject: null, body: `Hi\n${line(PIC.one.id)}` })), 400, 'VALIDATION_FAILED', 'a text with a picture');
  ok(await messages() === 0, 'nothing queued yet');

  // 3. Send checks again: a picture deleted after the save stops the send.
  const later = await picture('Deleted later');
  const d2 = (await success(() => save(SENDER, draft({ name: 'Later', body: `Hi\n${line(later.id)}` })), 'save before delete')).data;
  await sql("UPDATE hon.school_media_assets SET state='DELETED',deleted_at=clock_timestamp(),deleted_by_principal_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [later.id, OWN.principal]);
  await refused(() => send(SENDER, { blastId: d2.blastId, expectedVersion: 1, sendAt: null }), 409, 'BLAST_PICTURE_NOT_READY', 'send refuses a picture deleted since the save');
  ok(await messages() === 0, 'the refused send queued nothing');
  const sent = (await success(() => send(SENDER, { blastId: saved.blastId, expectedVersion: 1, sendAt: null }), 'send with pictures')).data;
  ok(sent.status === 'QUEUED' && sent.recipientCount === 2, `queued to two ${sent.recipientCount}`);
  const queued = (await sql('SELECT id,content FROM hon.communication_messages WHERE origin_id=$1 ORDER BY id', [saved.blastId])).rows;
  ok(queued.length === 2 && queued.every((m) => m.content.includes(line(PIC.one.id)) && /^Hello (Ana|Bo),/.test(m.content)), 'each message keeps the picture lines, merge tags filled');

  // 4. The worker's lookup: only the lease holder of a SENDING email delivery of a campaign blast with pictures.
  const claimed = (await sql("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],100,60) c WHERE c.organization_id=$1", [ids.organization])).rows;
  const mine = claimed.filter((c) => queued.some((m) => m.id === c.message_id));
  ok(mine.length === 2, 'both messages claimed');
  const listed = await pictures(mine[0].delivery_id, mine[0].lease_token);
  ok(Array.isArray(listed) && listed.length === 2, `two distinct pictures ${JSON.stringify(listed)}`);
  const one = listed.find((x) => x.assetId === PIC.one.id);
  ok(one && one.token === PIC.one.token && one.title === 'Open house' && one.width === 1200 && one.height === 800, 'id, token, title and size');
  ok(listed.every((x) => Object.keys(x).sort().join() === 'assetId,height,title,token,width'), 'never a storage key');
  ok(await pictures(mine[0].delivery_id, UUIDV()) === null, 'a wrong lease reads nothing');
  ok(await pictures(mine[0].delivery_id, null) === null, 'no lease reads nothing');
  ok(await pictures(UUIDV(), mine[0].lease_token) === null, 'an unknown delivery reads nothing');
  // A picture deleted after sending is left out of emails not yet delivered.
  await sql("UPDATE hon.school_media_assets SET state='DELETED',deleted_at=clock_timestamp(),deleted_by_principal_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [PIC.two.id, OWN.principal]);
  ok((await pictures(mine[1].delivery_id, mine[1].lease_token)).map((x) => x.assetId).join() === PIC.one.id, 'a deleted picture is left out');
  // Once the delivery has a result, nothing more is read.
  await sql("SELECT * FROM hon.record_communication_send_result($1,$2,'ACCEPTED','FAKE','fake-1','EMAIL',NULL,NULL,NULL,NULL)", [mine[0].delivery_id, mine[0].lease_token]);
  ok(await pictures(mine[0].delivery_id, mine[0].lease_token) === null, 'a finished delivery reads nothing');

  // 5. A blast without pictures, and a non-blast email, read nothing (text only).
  const plain = (await success(() => save(SENDER, draft({ name: 'Plain', body: 'Hello {{first_name}}' })), 'plain draft')).data;
  await success(() => send(SENDER, { blastId: plain.blastId, expectedVersion: 1, sendAt: null }), 'plain send');
  const staffMsg = (await sql("INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,created_by_principal_id,queued_by_principal_id) VALUES($1,$2,$3,'EMAIL',$4,'QUEUED',$5,$5) RETURNING id",
    [ids.organization, ids.schoolA, P.ana, `Note\n${line(PIC.one.id)}`, OWN.principal])).rows[0].id;
  const again = (await sql("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],100,60) c WHERE c.organization_id=$1", [ids.organization])).rows;
  const plainOnes = again.filter((c) => c.message_id !== staffMsg);
  ok(plainOnes.length === 2, `plain blast claimed ${plainOnes.length}`);
  for (const c of plainOnes) ok(await pictures(c.delivery_id, c.lease_token) === null, 'a blast without pictures reads nothing');
  const staffClaim = again.find((c) => c.message_id === staffMsg);
  ok(staffClaim && await pictures(staffClaim.delivery_id, staffClaim.lease_token) === null, 'a staff email with a picture-looking line reads nothing');

  // 6. School B: its own picture works there and only there.
  const bDraft = (await success(() => save(OWN_B, draft({ body: `Hi\n${line(PIC.schoolB.id)}` }), { school: ids.schoolB }), 'school-B picture')).data;
  ok(bDraft.body.includes(PIC.schoolB.id), 'school B saves its own picture');
  await refused(() => save(OWN_B, draft({ body: `Hi\n${line(PIC.one.id)}` }), { school: ids.schoolB }), 409, 'BLAST_PICTURE_NOT_READY', 'school B cannot use school A\'s picture');

  // 7. Grants and the 011 section.
  for (const fn of ['school_blast_picture_ids(text)', 'school_blast_body_ok(jsonb,text)', 'school_blast_pictures_ready(uuid,uuid,text)', 'communication_email_pictures(uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,p.oid,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public,
      p.prosecdef, (SELECT array_agg(a.grantee::regrole::text) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) grantees
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `${fn}: not runtime or PUBLIC`);
    ok((r.grantees ?? []).every((g) => g === 'hon_communication_worker') && (fn.startsWith('communication_') ? r.prosecdef : true), `${fn}: only the worker may run it ${r.grantees}`);
  }
  await assert.rejects(runtime.query('SELECT hon.communication_email_pictures($1,$2)', [UUIDV(), UUIDV()]), /permission denied/); checks += 1;
  for (const fn of ['save_school_blast(text,jsonb,text,uuid,uuid)', 'send_school_blast(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef, `${fn} keeps its runtime grant`);
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [begin, end] of [['-- School blasts exact verification (0621)', '-- End school blasts exact verification.'],
      ['-- Blast pictures exact verification (0653)', '-- End blast pictures exact verification.']]) {
      const section = verify.split(begin)[1]?.split(end)[0];
      ok(section, begin);
      await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  // 8. Evidence carries no picture tokens; nothing paid; the other organization untouched.
  const evidence = (await sql("SELECT next_state::text s FROM hon.audit_events WHERE organization_id=$1 UNION ALL SELECT payload::text FROM hon.outbox_events WHERE organization_id=$1", [ids.organization])).rows;
  ok(!evidence.some((r) => r.s.includes(PIC.one.token) || r.s.includes('picture:')), 'no picture token or line in audit or outbox');
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');
  ok((await sql('SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1', [ids.otherOrganization])).rows[0].n === 0, 'the other organization received nothing');

  console.log(`PASS: blast pictures (0653): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
