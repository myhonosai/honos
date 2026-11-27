/**
 * School blast audience filters and hand-picked contacts proof (BL4, 0695) over signed HTTP (HON session cookie ->
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

const session = { mode: 'OIDC', audience: 'hon-school-blast-filters', secret: randomBytes(32).toString('hex') };
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
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%bl4-${ids.organization}-%`) {
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
  const user = randomUUID(), principal = randomUUID(), subject = `bl4-${ids.organization}-${label}`;
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
const draft = (audienceValue, patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'Belt test reminder', channel: 'EMAIL', subject: 'Hi {{first_name}}',
  body: 'Hello {{first_name}}, see you at {{school_name}}.', audience: audienceValue, ...patch });
const resolveIds = async (aud, school = ids.schoolA, org = ids.organization) =>
  (await sql('SELECT person_id::text p FROM hon.school_blast_resolve($1,$2,$3,$4::jsonb) ORDER BY 1', [org, school, 'EMAIL', JSON.stringify(aud)])).rows.map((r) => r.p);
const auditOk = async (aud) => (await sql('SELECT hon.school_blast_audience_ok($1::jsonb) ok', [JSON.stringify(aud)])).rows[0].ok;
const schoolDay = async (days) => (await sql("SELECT (((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date) + $1::int)::text d", [days])).rows[0].d;

let OWN, SENDER, READER, OWN_B, P = {}, F = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'BL4 Org','BL4 Org'),($2,'BL4 Other Org','BL4 Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `bl4-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  SENDER = await staff('sender', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['marketing.blast.read'])]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])], { school: ids.schoolB });
  const org = ids.organization, school = ids.schoolA;
  const mail = (n) => ({ email: `${n}@example.test`, consent: ['EMAIL'] });
  P.avery = await person('Avery', 'Able', mail('avery')); P.blake = await person('Blake', 'Brown', mail('blake'));
  P.casey = await person('Casey', 'Cole', mail('casey')); P.drew = await person('Drew', 'Dunn', mail('drew'));
  P.archived = await person('Arlo', 'Gone', mail('arlo')); P.demo = await person('Demo', 'Kid', mail('demo'));
  P.otherB = await person('Bea', 'B', { ...mail('bea'), school: ids.schoolB });
  P.otherOrg = await person('Zed', 'Q', { ...mail('zed'), school: ids.otherSchool, org: ids.otherOrganization });

  const account = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, P.avery]);
  const membership = async (participant, state, endsInDays) => {
    const id = randomUUID();
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'KIDS-MONTHLY',$6,clock_timestamp()-interval '60 days',clock_timestamp()+make_interval(days=>$7::int))`, [id, org, school, account, participant, state, endsInDays]);
    return id;
  };
  const averyMembership = await membership(P.avery, 'ACTIVE', 20);
  await membership(P.blake, 'FROZEN', 14);
  await membership(P.drew, 'ACTIVE', 100);
  await membership(P.archived, 'ACTIVE', 20);
  F.program = randomUUID(); F.plan = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Little Tigers')", [F.program, org, school]);
  await raw('membership_plans', "INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,'KIDS-MONTHLY',1,$4)", [F.plan, org, school, OWN.principal]);
  await raw('membership_plan_versions', `INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id)
    VALUES($1,1,$2,$3,'Kids monthly',$4,'AVAILABLE','USD',12900,'MONTHLY','OPEN_ENDED',$5)`, [F.plan, org, school, F.program, OWN.principal]);
  await raw('membership_plan_selections', 'INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id) VALUES($1,$2,$3,$4,1,$5)',
    [averyMembership, org, school, F.plan, OWN.principal]);

  const curriculum = randomUUID();
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Karate','LINEAR')", [curriculum, org, school]);
  const rank = async (name, order) => { const id = randomUUID(); await raw('curriculum_ranks', 'INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,display_color,progression_order) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, curriculum, name, '#ffffff', order]); return id; };
  F.white = await rank('White', 1); F.yellow = await rank('Yellow', 2);
  // Ages 10 days past a birthday, the same in any zone: Avery 9, Blake 30, Casey 6; Drew has no profile.
  const profile = async (personId, years) => {
    const id = randomUUID();
    await sql("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4,(current_date - ($5::text || ' years 10 days')::interval)::date)", [id, org, school, personId, years]);
    return id;
  };
  const enroll = async (profileId, rankId, status = 'ACTIVE') => raw('student_curriculum_enrollments',
    'INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,status) VALUES($1,$2,$3,$4,$5,$6)', [org, school, profileId, curriculum, rankId, status]);
  await enroll(await profile(P.avery, 9), F.white);
  const blakeProfile = await profile(P.blake, 30);
  await enroll(blakeProfile, F.yellow);
  await profile(P.casey, 6);
  await sql("INSERT INTO hon.school_contact_archives(organization_id,school_id,person_id,kind,archived_by_principal_id) VALUES($1,$2,$3,'ARCHIVED',$4)", [org, school, P.archived, OWN.principal]);
  const set = randomUUID();
  await sql("INSERT INTO hon.school_demo_data_sets(id,organization_id,school_id,status,counts,loaded_by_principal_id) VALUES($1,$2,$3,'LOADED','{}',$4)", [set, org, school, OWN.principal]);
  await sql("INSERT INTO hon.school_demo_data_rows(table_name,row_id,set_id,organization_id,school_id,origin) VALUES('people',$1,$2,$3,$4,'LOADED')", [P.demo, set, org, school]);
}

try {
  await cleanup();
  await seed();
  await startApp();
  const all = (filters, more = {}) => ({ groups: ['ALL_CONTACTS'], tags: [], ...(filters ? { filters } : {}), ...more });
  const sorted = (...list) => [...list].sort();

  // 1. The audience shape (F1) in the database: 0621 audiences stay valid; filters and people are closed and bounded.
  for (const [aud, label] of [[{ groups: ['ACTIVE_STUDENTS'], tags: [] }, '0621 audience'], [all({ rankId: F.white }), 'rank'], [all({ noBelt: true }), 'no belt'],
    [all({ programId: F.program, planId: F.plan, membership: 'ACTIVE' }), 'program, plan, membership'], [all({ endsWithinDays: 30 }), 'ends within'],
    [all({ endsFrom: '2026-01-01', endsTo: '2026-01-01' }), 'same-day range'], [all({ ageMin: 0, ageMax: 120 }), 'age bounds'],
    [{ groups: [], tags: [], people: [P.casey] }, 'people only'], [all(null, { people: Array.from({ length: 200 }, () => randomUUID()) }), '200 people']]) {
    ok(await auditOk(aud), `accepted: ${label}`);
  }
  for (const [aud, label] of [[{ groups: [], tags: [] }, 'no group and no people'], [all({}), 'empty filters'], [all({ belt: 'x' }), 'unknown filter'],
    [all({ rankId: F.white, noBelt: true }), 'rank and no belt'], [all({ noBelt: false }), 'noBelt false'], [all({ rankId: F.white.toUpperCase() }), 'upper-case id'],
    [all({ membership: 'FROZEN' }), 'unknown membership'], [all({ endsWithinDays: 14 }), 'unknown days'], [all({ endsWithinDays: '30' }), 'days as text'],
    [all({ endsWithinDays: 30, endsTo: '2026-01-01' }), 'days and range'], [all({ endsFrom: '2026-02-30' }), 'impossible date'], [all({ endsFrom: '2026-1-01' }), 'loose date'],
    [all({ endsFrom: '2026-03-02', endsTo: '2026-03-01' }), 'backwards range'], [all({ ageMin: 121 }), 'age over 120'], [all({ ageMin: -1 }), 'negative age'],
    [all({ ageMin: 9.5 }), 'fractional age'], [all({ ageMin: 10, ageMax: 9 }), 'backwards ages'], [all({ ageMax: '9' }), 'age as text'],
    [all(null, { people: [] }), 'empty people'], [all(null, { people: [P.casey, P.casey] }), 'repeated person'], [all(null, { people: [P.casey.toUpperCase()] }), 'upper-case person'],
    [all(null, { people: Array.from({ length: 201 }, () => randomUUID()) }), '201 people'], [all(null, { people: 'x' }), 'people not a list'],
    [all(null, { extra: 1 }), 'extra key'], [{ groups: ['ALL_CONTACTS'], people: [P.casey] }, 'no tags']]) {
    ok(!(await auditOk(aud)), `refused: ${label}`);
  }

  // 2. The filters (F2) narrow the groups the way the Contacts list does.
  const from = await schoolDay(10), to = await schoolDay(18);
  for (const [aud, expected, label] of [
    [all(), [P.avery, P.blake, P.casey, P.drew], 'all current contacts (archived and sample data never)'],
    [all({ rankId: F.white }), [P.avery], 'belt'], [all({ noBelt: true }), [P.casey, P.drew], 'no belt'],
    [all({ programId: F.program }), [P.avery], 'program'], [all({ planId: F.plan }), [P.avery], 'plan'],
    [all({ membership: 'HAS' }), [P.avery, P.blake, P.drew], 'has a membership'], [all({ membership: 'NONE' }), [P.casey], 'no membership'],
    [all({ membership: 'ACTIVE' }), [P.avery, P.drew], 'active'], [all({ membership: 'PAUSED' }), [P.blake], 'paused'], [all({ membership: 'CANCELLING' }), [], 'cancelling'],
    [all({ endsWithinDays: 30 }), [P.avery, P.blake], 'ends within 30 days'], [all({ endsWithinDays: 7 }), [], 'ends within 7 days'],
    [all({ endsFrom: from, endsTo: to }), [P.blake], 'ends between two school dates'], [all({ endsFrom: from }), [P.avery, P.blake, P.drew], 'ends from'],
    [all({ ageMin: 8, ageMax: 10 }), [P.avery], 'age 8-10'], [all({ ageMin: 18 }), [P.blake], 'adults by age'], [all({ ageMax: 6 }), [P.casey], 'age up to 6'],
    [all({ membership: 'ACTIVE', ageMax: 10 }), [P.avery], 'filters combine'],
    [{ groups: ['ACTIVE_STUDENTS'], tags: [], filters: { noBelt: true } }, [P.drew], 'filters narrow a group'],
  ]) {
    ok(JSON.stringify(await resolveIds(aud)) === JSON.stringify(sorted(...expected)), `${label}: ${JSON.stringify(await resolveIds(aud))}`);
  }

  // 3. Hand-picked contacts are reached as well; only current contacts of this school.
  ok(JSON.stringify(await resolveIds({ groups: [], tags: [], people: [P.casey] })) === JSON.stringify([P.casey]), 'people only');
  ok(JSON.stringify(await resolveIds(all({ rankId: F.white }, { people: [P.casey, P.avery] }))) === JSON.stringify(sorted(P.avery, P.casey)), 'picked plus filtered, once each');
  ok((await resolveIds({ groups: [], tags: [], people: [P.archived, P.demo, P.otherB, P.otherOrg, randomUUID()] })).length === 0, 'archived, sample, other-school, other-organization and unknown picks reach nobody');
  ok(JSON.stringify(await resolveIds({ groups: [], tags: [], people: [P.otherB] }, ids.schoolB)) === JSON.stringify([P.otherB]), 'school B reaches its own pick');

  // 4. Over HTTP: the contract and the database agree; audience counts and a people-only send.
  const filtered = (await success(() => save(SENDER, draft(all({ membership: 'ACTIVE', ageMax: 10 }, { people: [P.casey] }))), 'save filters and people')).data;
  ok(filtered.audience.filters.membership === 'ACTIVE' && filtered.audience.filters.ageMax === 10 && filtered.audience.people[0] === P.casey, `saved audience ${JSON.stringify(filtered.audience)}`);
  const preview = (await success(() => audience(READER, filtered.blastId), 'audience preview')).data;
  ok(preview.matched === 2 && preview.outcomes.QUEUED === 2, `preview counts ${JSON.stringify(preview)}`);
  ok(!JSON.stringify(preview).includes('@example.test'), 'the preview carries no address');
  for (const [bad, label] of [[all({}), 'empty filters'], [all({ membership: 'FROZEN' }), 'unknown membership'], [all({ ageMin: 10, ageMax: 9 }), 'backwards ages'],
    [all({ endsFrom: '2026-02-30' }), 'impossible date'], [all(null, { people: [] }), 'empty people'], [{ groups: [], tags: [] }, 'nobody chosen'],
    [all(null, { people: ['not-an-id'] }), 'bad id']]) {
    await refused(() => save(SENDER, draft(bad)), 400, undefined, `HTTP refused: ${label}`);
  }
  const picked = (await success(() => save(SENDER, draft({ groups: [], tags: [], people: [P.blake, P.otherB] }, { name: 'Picked only' })), 'people-only draft')).data;
  const pickedPreview = (await success(() => audience(READER, picked.blastId), 'people-only preview')).data;
  ok(pickedPreview.matched === 1 && pickedPreview.outcomes.QUEUED === 1, `a school-B pick is not reached from school A ${JSON.stringify(pickedPreview)}`);
  const sent = (await success(() => send(SENDER, { blastId: picked.blastId, expectedVersion: picked.version, sendAt: null }), 'send people-only')).data;
  ok(sent.status === 'QUEUED' && sent.recipientCount === 1, `sent ${JSON.stringify(sent)}`);
  const queued = (await sql("SELECT r.person_id::text p FROM hon.school_blast_recipients r WHERE r.blast_id=$1 AND r.outcome='QUEUED'", [picked.blastId])).rows.map((r) => r.p);
  ok(JSON.stringify(queued) === JSON.stringify([P.blake]), 'exactly the picked contact got a message');
  ok((await sql('SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1 AND school_id=$2', [ids.organization, ids.schoolB])).rows[0].n === 0, 'school B got nothing');
  await refused(() => audience(OWN_B, filtered.blastId, { school: ids.schoolB }), 404, 'BLAST_NOT_FOUND', 'school B cannot preview a school A audience');

  // 5. Both helpers stay private (F3); the 0621 exact verification still passes.
  for (const f of ['hon.school_blast_audience_ok(jsonb)', 'hon.school_blast_resolve(uuid,uuid,text,jsonb)']) {
    ok(!(await sql('SELECT has_function_privilege($1,$2::regprocedure,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, f])).rows[0].x, `${f} is not runtime-callable`);
    await assert.rejects(runtime.query(`SELECT ${f.startsWith('hon.school_blast_audience_ok') ? "hon.school_blast_audience_ok('{}'::jsonb)" : `hon.school_blast_resolve('${ids.organization}','${ids.schoolA}','EMAIL','{}'::jsonb)`}`), /permission denied/); checks += 1;
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- School blasts exact verification (0621)')[1]?.split('-- End school blasts exact verification.')[0];
    ok(section, '0621 verification section');
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');

  console.log(`PASS: school blast audience filters (0695): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
