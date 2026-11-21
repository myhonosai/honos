/**
 * Family referrals proof (0604) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards -> the parent,
 * staff and public referral controllers -> protected definer functions on the restricted runtime role), on the guarded
 * disposable CRM-close fixture only. Synthetic names and example.test contacts only; nothing is sent and no money moves.
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
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const P = await load('referrals/parent-referrals.controller.js');
const { ParentReferralsService } = await load('referrals/parent-referrals.service.js');
const S = await load('referrals/school-referrals.controller.js');
const { SchoolReferralsService } = await load('referrals/school-referrals.service.js');
const PUB = await load('referrals/public-referral.controller.js');
const { publicReferralTransport } = await load('referrals/public-referral-transport.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-family-referrals', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily', 'pipeline', 'stage', 'form', 'draftForm'].map((key) => [key, randomUUID()]));
const PREFIX = `fref-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [P.ParentReferralsController, S.SchoolReferralsController, PUB.PublicReferralController],
    providers: [HonIdentityGuard, HonIdentityService, ParentReferralsService, SchoolReferralsService, PUB.PublicReferralService,
      P.ParentReferralsReadGuard, P.ParentReferralLinkGuard, S.SchoolReferralsReadGuard, S.SchoolReferralProgramGuard, S.SchoolReferralRewardGuard,
      { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(publicReferralTransport());
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
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0286 and 0329 proofs).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('DELETE FROM hon.public_lead_form_rates WHERE form_id IN (SELECT id FROM hon.public_lead_forms WHERE organization_id = ANY($1::uuid[]))', [[ids.organization, ids.otherOrganization]]);
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label, name = 'Person') {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, subject, `${user}@example.test`, name]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, name]);
  return { subject, principal, org: ids.organization, school: ids.school };
}
async function grant(actor, family, level) {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.school, family, actor.principal, level]);
}
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roleId, { org = ids.organization, school = ids.school } = {}) {
  const actor = await person(label, 'Coach Secret-Staff-Name');
  const id = randomUUID();
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [id, org, school, actor.principal, roleId]);
  return { ...actor, org, school, grant: id };
}


let GUARDIAN, VIEWER, OUTSIDER, OTHER_PARENT, OWNER, READER, OTHER_STAFF;
const staffPath = (actor = OWNER) => `/organizations/${actor.org}/schools/${actor.school}/marketing/referrals`;
const staffRead = (actor = OWNER, options = {}) => call(actor, 'GET', staffPath(actor), options);
const configure = (actor, body, options = {}) => call(actor, 'POST', `${staffPath(actor)}/program`, { body, command: 'crm.referrals.program.save', ...options });
const decide = (actor, referralId, body, options = {}) => call(actor, 'POST', `${staffPath(actor)}/${referralId}/reward`, { body, command: 'crm.referrals.reward', ...options });
const parentRead = (actor, options = {}) => call(actor, 'GET', '/parent/referrals', options);
const parentLink = (actor, options = {}) => call(actor, 'POST', '/parent/referrals/link', { body: {}, command: 'parent.referrals.link', key: null, ...options });
const publicHeaders = { Accept: 'application/json' };
const publicRead = (code) => send(new URL(`${origin}/v1/public/referrals/${code}`), 'GET', publicHeaders);
const friend = (patch = {}) => ({ name: 'Friend Secret-Name', email: `friend-${randomUUID().slice(0, 8)}@example.test`, mobile: '', interest: 'Kids karate', source: '', website: '', acknowledged: true, ...patch });
const publicSubmit = (code, body, key = randomUUID()) => send(new URL(`${origin}/v1/public/referrals/${code}/submissions`), 'POST',
  { ...publicHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': key }, JSON.stringify(body));
const program = (patch = {}) => ({ expectedVersion: 0, status: 'ON', formId: ids.form, referrerReward: 'One free month of classes', friendOffer: 'A free trial week',
  rules: 'Given after your friend joins a membership.', shareMessage: 'Come train with us!', ...patch });
const referralRows = async () => (await sql('SELECT * FROM hon.family_referrals WHERE organization_id=$1 ORDER BY created_at', [ids.organization])).rows;

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Ref Org','Ref Org'),($2,'Ref Other Org','Ref Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Referral Dojo', `fref-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Referral Dojo B', `fref-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')", [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Leads')", [ids.pipeline, ids.organization, ids.school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [ids.stage, ids.organization, ids.school, ids.pipeline]);
  await sql('ALTER TABLE hon.public_lead_forms DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.public_lead_forms(id,organization_id,school_id,status,title,description,optional_fields,pipeline_id,pipeline_stage_id)
    VALUES($1,$3,$4,'PUBLISHED','Try a class','Tell us about you.','["ageBand"]',$5,$6),($2,$3,$4,'DRAFT','Draft form','','[]',$5,$6)`, [ids.form, ids.draftForm, ids.organization, ids.school, ids.pipeline, ids.stage]);
  await sql('ALTER TABLE hon.public_lead_forms ENABLE TRIGGER USER');
  GUARDIAN = await person('guardian', 'Kim Parent'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); OTHER_PARENT = await person('other-parent');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.otherSchool, ids.busyFamily, OTHER_PARENT.principal]);
  OWNER = await staff('owner', await role(ids.organization, ['crm.referral.read', 'crm.referral.manage']));
  READER = await staff('reader', await role(ids.organization, ['crm.referral.read']));
  OTHER_STAFF = await staff('other-staff', await role(ids.organization, ['crm.referral.read', 'crm.referral.manage']), { school: ids.otherSchool });
  // Version rows as 0075/0076 keep them (disposable fixture only).
  await sql('ALTER TABLE hon.public_lead_form_versions DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.public_lead_form_versions(form_id,organization_id,school_id,version,actor_principal_id,request_id,snapshot)
    SELECT f.id,f.organization_id,f.school_id,1,$2,gen_random_uuid(),'{"fixture":true}'::jsonb FROM hon.public_lead_forms f WHERE f.organization_id=$1`, [ids.organization, OWNER.principal]);
  await sql('ALTER TABLE hon.public_lead_form_versions ENABLE TRIGGER USER');
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Nothing set up yet: the family sees an honest "not running", no link; nobody can get a link.
  const before = (await success(() => parentRead(GUARDIAN), 'parent before')).data;
  ok(before.schoolName === 'Referral Dojo' && before.on === false && before.shareUrl === null && before.canShare === false, 'program off: no link, cannot share');
  ok(before.referrerReward === null && before.counts.referred === 0 && before.referrals.length === 0, 'program off: no texts, nothing counted');
  await refused(() => parentLink(GUARDIAN), 422, 'PARENT_REFERRALS_NOT_AVAILABLE', 'no link while off');
  await refused(() => parentRead(OUTSIDER), 403, 'PARENT_REFERRALS_FORBIDDEN', 'no family grant');
  await refused(() => call(GUARDIAN, 'GET', '/parent/referrals?schoolId=x'), 400, 'PARENT_REFERRALS_SELECTORS_NOT_ACCEPTED', 'no selector');
  await refused(() => parentRead(GUARDIAN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'delegated source header');
  await refused(() => parentRead(GUARDIAN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. Staff: read the empty program and the school's forms; only crm.referral.manage changes it.
  const empty = (await success(() => staffRead(OWNER), 'staff read empty')).data;
  ok(empty.program.version === 0 && empty.program.status === 'OFF' && empty.canManage === true, 'empty program, owner can manage');
  ok(empty.forms.length === 1 && empty.forms[0].formId === ids.form && empty.forms[0].status === 'PUBLISHED', 'only published forms to choose from');
  ok((await success(() => staffRead(READER), 'reader read')).data.canManage === false, 'a reader cannot manage');
  await refused(() => configure(READER, program()), 403, 'SCHOOL_REFERRAL_FORBIDDEN', 'reader cannot change the program');
  await refused(() => staffRead(GUARDIAN, { }), 403, 'SCHOOL_REFERRAL_FORBIDDEN', 'a parent is not staff');
  await refused(() => call(OTHER_STAFF, 'GET', staffPath(OWNER)), 403, 'SCHOOL_REFERRAL_FORBIDDEN', 'another school staff cannot read this school');
  await refused(() => configure(OWNER, program({ formId: null })), 400, 'VALIDATION_FAILED', 'ON needs a form');
  await refused(() => configure(OWNER, program({ formId: ids.draftForm })), 422, 'REFERRAL_FORM_UNAVAILABLE', 'a draft form cannot be used');
  await refused(() => configure(OWNER, program({ referrerReward: '' })), 400, 'VALIDATION_FAILED', 'ON needs a reward');
  await refused(() => configure(OWNER, program({ extra: 1 })), 400, 'VALIDATION_FAILED', 'closed body');
  await refused(() => configure(OWNER, program({ friendOffer: 'two\nlines' })), 400, 'VALIDATION_FAILED', 'single-line offer');
  await refused(() => configure(OWNER, program(), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'key required');
  await refused(() => configure(OWNER, program(), { command: 'crm.referrals.reward' }), 403, 'HUMAN_UI_REQUIRED', 'wrong command header');
  const key = randomUUID();
  const saved = (await success(() => configure(OWNER, program(), { key }), 'configure')).data;
  ok(saved.version === 1 && saved.status === 'ON' && saved.formId === ids.form && saved.referrerReward === 'One free month of classes', 'program on at version 1');
  ok((await success(() => configure(OWNER, program(), { key }), 'replay')).meta.replayed === true, 'exact replay');
  await refused(() => configure(OWNER, program({ rules: 'Other' }), { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reuse');
  await refused(() => configure(OWNER, program()), 409, 'VERSION_CONFLICT', 'stale version');
  ok((await sql('SELECT count(*)::int n FROM hon.school_referral_program_versions WHERE school_id=$1', [ids.school])).rows[0].n === 1, 'one version row');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE school_id=$1 AND action_code='crm.referral.program.configure'", [ids.school])).rows[0].n === 1, 'audited once');

  // 3. The family: reward and rules as the school wrote them; a guardian gets one personal link, a viewer cannot.
  const on = (await success(() => parentRead(GUARDIAN), 'parent on')).data;
  ok(on.on && on.canShare && on.shareUrl === null && on.referrerReward === 'One free month of classes' && on.friendOffer === 'A free trial week'
    && on.rules === 'Given after your friend joins a membership.' && on.shareMessage === 'Come train with us!', 'program texts reach the family');
  const viewer = (await success(() => parentRead(VIEWER), 'viewer')).data;
  ok(viewer.on && !viewer.canShare, 'a viewer sees the program but cannot share');
  await refused(() => parentLink(VIEWER), 403, 'PARENT_REFERRALS_FORBIDDEN', 'a viewer cannot get a link');
  await refused(() => parentLink(GUARDIAN, { body: { familyId: ids.otherFamily } }), 400, 'PARENT_REFERRALS_SELECTORS_NOT_ACCEPTED', 'link takes no body');
  await refused(() => parentLink(GUARDIAN, { command: 'parent.referrals.read' }), 403, 'HUMAN_UI_REQUIRED', 'link needs its own command');
  const link = (await success(() => parentLink(GUARDIAN), 'link')).data;
  const match = new RegExp(`^${origin.replace(/[.]/g, '\\.')}/refer/([0-9a-f]{16})$`).exec(link.shareUrl);
  ok(match, 'share link on the HON site');
  const code = match[1];
  ok((await success(() => parentLink(GUARDIAN), 'link again')).data.shareUrl === link.shareUrl, 'the same link every time');
  const viewerAfter = (await success(() => parentRead(VIEWER), 'viewer after link')).data;
  ok(viewerAfter.shareUrl === null && !viewerAfter.canShare, 'a viewer never receives the family link');
  ok((await sql('SELECT count(*)::int n FROM hon.family_referral_codes WHERE family_id=$1', [ids.family])).rows[0].n === 1, 'one code per family');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE school_id=$1 AND action_code='crm.referral.link.issue'", [ids.school])).rows[0].n === 1, 'link issue audited once');

  // 4. The friend's page: school, offer and form only; nothing about the referring family.
  const page = await publicRead(code);
  ok(page.status === 200 && page.body.data.schoolName === 'Referral Dojo' && page.body.data.friendOffer === 'A free trial week' && page.body.data.form.title === 'Try a class', 'public page');
  ok(JSON.stringify(page.body.data.form.optionalFields) === '["ageBand"]', 'form fields from the published form');
  ok(!/Kim|family|Secret|guardian/i.test(JSON.stringify(page.body)), 'no referring family on the public page');
  ok(page.headers['cache-control'] === 'no-store' && page.headers['referrer-policy'] === 'no-referrer', 'public page never cached');
  ok((await publicRead('0'.repeat(16))).status === 404, 'unknown code: not found');
  ok((await publicRead('XYZ')).status === 400, 'malformed code: transport refuses');
  ok((await send(new URL(`${origin}/v1/public/referrals/${code}?x=1`), 'GET', publicHeaders)).status === 400, 'no query string');

  // 5. A friend signs up: a CRM lead through the 0075 intake, recorded as this family's referral (first touch).
  const leadsBefore = (await sql('SELECT count(*)::int n FROM hon.crm_leads WHERE school_id=$1', [ids.school])).rows[0].n;
  const firstKey = randomUUID(), first = friend({ ageBand: 'CHILD' });
  const accepted = await publicSubmit(code, first, firstKey);
  ok(accepted.status === 202 && accepted.body.result === 'accepted', 'friend accepted');
  let rows = await referralRows();
  ok(rows.length === 1 && rows[0].family_id === ids.family && rows[0].code === code && !rows[0].self_referral && !rows[0].existing_contact && rows[0].reward_status === 'PENDING', 'one referral for the family');
  const lead = (await sql('SELECT l.*,p.given_name,p.email::text email FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id WHERE l.id=$1', [rows[0].lead_id])).rows[0];
  ok(lead.school_id === ids.school && lead.pipeline_stage_id === ids.stage && lead.status === 'OPEN' && lead.email === first.email, 'a normal CRM lead in the form\'s stage');
  ok((await sql('SELECT count(*)::int n FROM hon.crm_leads WHERE school_id=$1', [ids.school])).rows[0].n === leadsBefore + 1, 'exactly one new lead');
  ok((await publicSubmit(code, first, firstKey)).status === 202 && (await referralRows()).length === 1, 'exact replay records nothing new');
  ok((await publicSubmit(code, first, randomUUID())).status === 202 && (await referralRows()).length === 1, 'the same friend again is folded into the existing lead by 0075: no second referral');
  ok((await sql('SELECT count(*)::int n FROM hon.crm_leads WHERE school_id=$1', [ids.school])).rows[0].n === leadsBefore + 1, 'still one lead');
  ok((await publicSubmit(code, { ...friend(), name: '' })).status === 400, 'invalid body refused');
  ok((await publicSubmit(code, friend(), 'short')).status === 400, 'idempotency key required');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE school_id=$1 AND action_code='crm.referral.record'", [ids.school])).rows[0].n === 1, 'referral audited');

  // 6. What the family sees: counts and status, never the friend.
  let fam = (await success(() => parentRead(GUARDIAN), 'parent after one')).data;
  ok(fam.counts.referred === 1 && fam.counts.joined === 0 && fam.counts.rewarded === 0 && fam.referrals.length === 1, 'one referred');
  ok(fam.referrals[0].status === 'INTERESTED' && fam.referrals[0].reward === 'PENDING' && Object.keys(fam.referrals[0]).sort().join() === 'referredAt,reward,status', 'status and reward only');
  ok(!JSON.stringify(fam).includes('Secret-Name') && !JSON.stringify(fam).includes(first.email), 'no friend name or contact reaches the family');

  // 7. Flags: a family member's own contact is SELF (not counted for the family); another person's contact is EXISTING_CONTACT.
  await sql('UPDATE hon.users SET email=$2 WHERE external_subject=$1', [GUARDIAN.subject, 'kim.parent@example.test']);
  ok((await publicSubmit(code, friend({ email: 'Kim.Parent@example.test' }))).status === 202, 'self submission accepted as a lead');
  const existingPerson = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Known','Person','known@example.test')", [existingPerson, ids.organization, ids.school]);
  ok((await publicSubmit(code, friend({ email: 'known@example.test' }))).status === 202, 'known contact accepted as a lead');
  rows = await referralRows();
  ok(rows.length === 3 && rows[1].self_referral && !rows[1].existing_contact && !rows[2].self_referral && rows[2].existing_contact, 'SELF and EXISTING_CONTACT flags');
  fam = (await success(() => parentRead(GUARDIAN), 'parent after flags')).data;
  ok(fam.counts.referred === 2 && fam.referrals.length === 2, 'SELF referral not counted or shown for the family');

  // 8. Staff see every referral and record the reward decision; nothing is paid.
  const list = (await success(() => staffRead(OWNER), 'staff list')).data;
  ok(list.referrals.length === 3 && list.counts.referred === 2 && list.counts.awaitingDecision === 0, 'staff list and counts');
  const r1 = list.referrals.find((r) => r.leadId === rows[0].lead_id);
  ok(r1.familyName === 'Kim Family' && r1.friendName === 'Friend Secret-Name' && r1.leadStatus === 'OPEN' && r1.version === 1, 'staff see family, friend and lead');
  ok(list.referrals.some((r) => r.selfReferral) && list.referrals.some((r) => r.existingContact), 'staff see the flags');
  await refused(() => decide(READER, r1.referralId, { expectedVersion: 1, decision: 'GIVEN', note: '' }), 403, 'SCHOOL_REFERRAL_FORBIDDEN', 'reader cannot decide');
  await refused(() => decide(OWNER, r1.referralId, { expectedVersion: 1, decision: 'PAID', note: '' }), 400, 'VALIDATION_FAILED', 'closed decision');
  await refused(() => decide(OWNER, randomUUID(), { expectedVersion: 1, decision: 'GIVEN', note: '' }), 422, 'REFERRAL_NOT_FOUND', 'unknown referral');
  await sql('ALTER TABLE hon.crm_leads DISABLE TRIGGER USER');
  await sql("UPDATE hon.crm_leads SET status='WON', won_at=clock_timestamp() WHERE id=$1", [rows[0].lead_id]);
  await sql('ALTER TABLE hon.crm_leads ENABLE TRIGGER USER');
  await sql('ALTER TABLE hon.crm_leads DISABLE TRIGGER USER');
  await sql("UPDATE hon.crm_leads SET status='WON', won_at=clock_timestamp() WHERE id=$1", [rows[1].lead_id]);
  await sql('ALTER TABLE hon.crm_leads ENABLE TRIGGER USER');
  const awaiting = (await success(() => staffRead(OWNER), 'awaiting')).data;
  ok(awaiting.counts.awaitingDecision === 1 && awaiting.counts.joined === 1, 'a joined friend awaits a reward decision; a joined SELF referral is not counted');
  await refused(() => decide(OWNER, r1.referralId, { expectedVersion: 1, decision: 'PENDING', note: 'waiting' }), 400, 'VALIDATION_FAILED', 'a note needs a decision');
  ok((await success(() => parentRead(GUARDIAN), 'joined')).data.referrals.find((r) => r.status === 'JOINED') && fam.counts.joined === 0, 'family sees JOINED');
  const rewardKey = randomUUID();
  const given = (await success(() => decide(OWNER, r1.referralId, { expectedVersion: 1, decision: 'GIVEN', note: 'Free month on December invoice' }, { key: rewardKey }), 'reward')).data;
  ok(given.rewardStatus === 'GIVEN' && given.version === 2 && given.rewardNote === 'Free month on December invoice' && given.rewardDecidedAt, 'reward recorded');
  ok((await success(() => decide(OWNER, r1.referralId, { expectedVersion: 1, decision: 'GIVEN', note: 'Free month on December invoice' }, { key: rewardKey }), 'reward replay')).meta.replayed, 'reward replay');
  await refused(() => decide(OWNER, r1.referralId, { expectedVersion: 1, decision: 'NOT_ELIGIBLE', note: '' }), 409, 'VERSION_CONFLICT', 'stale reward version');
  fam = (await success(() => parentRead(GUARDIAN), 'rewarded')).data;
  ok(fam.counts.joined === 1 && fam.counts.rewarded === 1 && fam.referrals.some((r) => r.status === 'JOINED' && r.reward === 'GIVEN'), 'family sees joined and rewarded');
  ok(!JSON.stringify(fam).includes('December'), 'the staff note stays with staff');
  const back = (await success(() => decide(OWNER, r1.referralId, { expectedVersion: 2, decision: 'PENDING', note: '' }), 'back to pending')).data;
  ok(back.rewardStatus === 'PENDING' && back.rewardDecidedAt === null && back.rewardNote === '' && back.version === 3, 'decision can be undone');
  for (const t of ['invoices', 'invoice_lines', 'ledger_entries']) {
    const exists = (await sql('SELECT to_regclass($1) IS NOT NULL e', [`hon.${t}`])).rows[0].e;
    if (exists) ok((await sql(`SELECT count(*)::int n FROM hon.${t} WHERE organization_id=$1`, [ids.organization])).rows[0].n === 0, `no ${t} written`);
  }

  await sql('ALTER TABLE hon.families DISABLE TRIGGER USER');
  await sql("UPDATE hon.families SET display_name=$2 WHERE id=$1", [ids.family, 'Kim\tFamily\u200B ' + 'x'.repeat(250)]);
  await sql('ALTER TABLE hon.families ENABLE TRIGGER USER');
  const odd = (await success(() => staffRead(OWNER), 'odd family name')).data.referrals.find((r) => r.referralId === r1.referralId);
  ok(odd.familyName.startsWith('Kim Family x') && odd.familyName.length === 200, 'an unusual stored name is shown as one clean line and the list still works');
  await sql('ALTER TABLE hon.families DISABLE TRIGGER USER');
  await sql("UPDATE hon.families SET display_name='Kim Family' WHERE id=$1", [ids.family]);
  await sql('ALTER TABLE hon.families ENABLE TRIGGER USER');

  // 9. Another school never mixes in.
  const otherList = (await success(() => staffRead(OTHER_STAFF), 'other school staff')).data;
  ok(otherList.referrals.length === 0 && otherList.program.status === 'OFF', 'the other school sees nothing of this school');
  ok((await success(() => parentRead(OTHER_PARENT), 'other school family')).data.on === false, 'the other school program is its own');

  // 10. The link stops at once: program OFF, form disabled, family suspended or without a live grant. History stays.
  const off = (await success(() => configure(OWNER, program({ expectedVersion: 1, status: 'OFF' })), 'off')).data;
  ok(off.status === 'OFF' && off.version === 2, 'program off');
  ok((await publicRead(code)).status === 404 && (await publicSubmit(code, friend())).status === 400, 'link stops when off');
  fam = (await success(() => parentRead(GUARDIAN), 'parent off')).data;
  ok(fam.on === false && fam.shareUrl === null && fam.counts.referred === 2 && fam.referrals.length === 2, 'history stays when off');
  await refused(() => parentLink(GUARDIAN), 422, 'PARENT_REFERRALS_NOT_AVAILABLE', 'no link when off');
  ok((await success(() => configure(OWNER, program({ expectedVersion: 2 })), 'on again')).data.version === 3, 'program on again');
  ok((await publicRead(code)).status === 200, 'link works again');
  const formStatus = async (status) => { await sql('ALTER TABLE hon.public_lead_forms DISABLE TRIGGER USER'); await sql('UPDATE hon.public_lead_forms SET status=$2 WHERE id=$1', [ids.form, status]); await sql('ALTER TABLE hon.public_lead_forms ENABLE TRIGGER USER'); };
  await formStatus('DISABLED');
  ok((await publicRead(code)).status === 404 && (await success(() => parentRead(GUARDIAN), 'form disabled')).data.on === false, 'a disabled form stops the link');
  await formStatus('PUBLISHED');
  await sql("UPDATE hon.families SET status='SUSPENDED' WHERE id=$1", [ids.family]);
  ok((await publicRead(code)).status === 404 && (await publicSubmit(code, friend())).status === 400, 'a suspended family link stops');
  await sql("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.family]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  ok((await publicRead(code)).status === 404, 'a lapsed entitlement stops the link (0075 published read)');
  await refused(() => parentRead(GUARDIAN), 403, 'PARENT_REFERRALS_FORBIDDEN', 'lapsed entitlement: family read refused');
  await refused(() => staffRead(OWNER), 403, 'SCHOOL_REFERRAL_FORBIDDEN', 'lapsed entitlement: staff read refused');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await publicRead(code)).status === 200, 'works again once access is live');

  // 11. Per-code limit (30 an hour), checked straight on the runtime role.
  await sql('DELETE FROM hon.public_lead_form_rates WHERE form_id=$1 AND bucket=$2', [ids.form, `REF:${code}`]);
  let limited = false;
  for (let i = 0; i < 31; i += 1) {
    const r = (await runtime.query('SELECT hon.submit_family_referral($1,$2::jsonb,$3) r', [code, '{"bad":true}', randomUUID()])).rows[0].r;
    if (i < 30) assert.equal(r, 'INVALID'); else limited = r === 'RATE_LIMITED';
  }
  ok(limited, 'the 31st attempt in an hour is rate limited');

  // 12. Records never change who referred whom and never disappear; runtime has no table access.
  await assert.rejects(sql('UPDATE hon.family_referrals SET family_id=$2 WHERE id=$1', [rows[0].id, ids.otherFamily])); checks += 1;
  await assert.rejects(sql('UPDATE hon.family_referrals SET reward_status=$2 WHERE id=$1', [rows[0].id, 'GIVEN'])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.family_referrals WHERE id=$1', [rows[0].id])); checks += 1;
  await assert.rejects(sql('UPDATE hon.family_referral_codes SET family_id=$2 WHERE code=$1', [code, ids.otherFamily])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.school_referral_program_versions WHERE school_id=$1', [ids.school])); checks += 1;
  for (const table of ['school_referral_programs', 'school_referral_program_versions', 'school_referral_requests', 'family_referral_codes', 'family_referrals']) {
    ok(!(await sql(`SELECT has_table_privilege($1,$2,'SELECT') s`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0].s, `${table}: no runtime table privilege`);
    ok((await sql('SELECT relrowsecurity AND relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', [`hon.${table}`])).rows[0].f, `${table}: forced RLS`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.family_referrals')); checks += 1;
  const granted = (await sql(`SELECT p.oid::regprocedure::text sig FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace
      AND has_function_privilege($1,p.oid,'EXECUTE') AND p.oid::regprocedure::text ~ '(school_referral|family_referral|parent_referral|public_referral)' ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE])).rows.map((r) => r.sig);
  ok(JSON.stringify(granted) === JSON.stringify(['hon.configure_school_referral_program(text,jsonb,text,uuid,uuid)', 'hon.decide_family_referral_reward(text,uuid,jsonb,text,uuid,uuid)',
    'hon.issue_parent_referral_link(text)', 'hon.read_parent_referrals(text)', 'hon.read_public_referral(text)', 'hon.read_school_referrals(text)', 'hon.submit_family_referral(text,jsonb,text)']), `runtime executes the seven entry points only: ${granted.join(', ')}`);
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Family referrals exact verification (0604)', endMark = '-- End family referrals exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: family referrals (0604): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
