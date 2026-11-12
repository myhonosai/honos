/**
 * School checkout page settings proof (B-TUI-2 piece 9a, 0269) over signed HTTP (HON session cookie -> HonIdentityGuard +
 * human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolCheckoutController -> protected definer functions
 * on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic data;
 * nothing is public, takes a payment or sends a message, and HON adds no fee.
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
const { SchoolCheckoutController } = await load('school-checkout/school-checkout.controller.js');
const { SchoolCheckoutService } = await load('school-checkout/school-checkout.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-checkout', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };


let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolCheckoutController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolCheckoutService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
const SAVE = 'school_checkout.page.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/payments/checkout-pages${query}`);
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
const read = (actor, options = {}) => call(actor, 'GET', options);
const save = (actor, body, options = {}) => call(actor, 'POST', { body, ...options });
const EMPTY = { planIds: [], addOns: [], customFields: [], waiver: null, receiptNote: null, thankYou: null };
const page = (kind, expectedVersion, status, content = EMPTY) => ({ kind, expectedVersion, status, content });

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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_checkout_pages WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left checkout pages behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`checkout-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`checkout-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`checkout-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `checkout-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Checkout Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Checkout Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


let OWN, NONE, MIXED, OWN_B, OTHER_ORG, LOSER;
const plans = {};
async function plan(label, { school = ids.schoolA, org = ids.organization, available = true } = {}) {
  const id = randomUUID();
  await sql('INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,$4,1,$5)', [id, org, school, label.toUpperCase(), OWN.principal]);
  await sql("INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id) VALUES($1,1,$2,$3,$4,$5,'USD',14900,'MONTHLY','OPEN_ENDED',$6)",
    [id, org, school, `Plan ${label}`, available ? 'AVAILABLE' : 'UNAVAILABLE', OWN.principal]);
  return id;
}
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Checkout Org','Checkout Org'),($2,'Checkout Other Org','Checkout Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Checkout ${slug}`, `checkout-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  NONE = await staff('none', [await role(ids.organization, ['school_pay.connection.manage', 'school_pay.read', 'billing.invoice.issue', 'people.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['school_checkout.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['school_checkout.manage'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['school_checkout.manage'])]);
  plans.a = await plan('a'); plans.b = await plan('b'); plans.gone = await plan('gone', { available: false });
  plans.schoolB = await plan('sb', { school: ids.schoolB }); plans.other = await plan('ot', { school: ids.otherSchool, org: ids.otherOrganization });
}

const KOREAN = '도복 (유니폼)';
const full = () => ({
  planIds: [plans.b, plans.a],
  addOns: [{ key: 'uniform', label: { en: 'Uniform', ko: KOREAN, es: 'Uniforme' }, amountMinor: 4500, currency: 'USD', required: true },
    { key: 'registration_fee', label: { en: 'Registration fee' }, amountMinor: 2500, currency: 'USD', required: false }],
  customFields: [{ key: 'shirt_size', label: { en: 'T-shirt size', es: 'Talla' }, kind: 'CHOICE', required: true, options: [{ en: 'Small' }, { en: 'Medium' }, { en: 'Large' }] },
    { key: 'allergies', label: { en: 'Allergies or injuries we should know about' }, kind: 'TEXT', required: false, options: [] },
    { key: 'photo_ok', label: { en: 'Photos may be used on social media' }, kind: 'CHECKBOX', required: false, options: [] }],
  waiver: { text: { en: 'I understand martial arts training carries a risk of injury.\nI agree to the school rules.', ko: '부상 위험을 이해합니다.' } },
  receiptNote: { en: 'Thank you for training with us.' }, thankYou: { en: 'Welcome to the family!', es: '¡Bienvenidos!' },
});

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission and OWNER grant.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='school_checkout.manage' AND is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'school_checkout.manage is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='school_checkout.manage')`)).rows[0].n === 0, 'every system OWNER role holds it');

  // 1. Read: empty pages and this school's plans only; everyone else refused.
  const empty = (await success(() => read(OWN), 'owner read')).data;
  ok(empty.enrollment === null && empty.tuition === null, 'no pages yet');
  ok(empty.plans.map((p) => p.planId).sort().join() === [plans.a, plans.b, plans.gone].sort().join() && empty.plans.find((p) => p.planId === plans.gone).available === false
    && empty.plans.every((p) => p.currency === 'USD' && p.priceMinor === 14900), 'only school-A plans, with their current terms and availability');
  for (const actor of [NONE, MIXED]) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => read(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');
  await refused(() => read(OWN, { query: '?kind=ENROLLMENT' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(OWN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. Save: refusals before anything is written.
  for (const actor of [NONE, MIXED]) await refused(() => save(actor, page('ENROLLMENT', 0, 'DRAFT')), 403, undefined, `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT'), { command: 'school_pay.connection.start' }), 403, 'HUMAN_UI_REQUIRED', 'save under another command header');
  await refused(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT'), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');
  for (const [label, body] of [
    ['unknown kind', page('BOOKING', 0, 'DRAFT')], ['unknown status', page('ENROLLMENT', 0, 'LIVE')], ['negative version', page('ENROLLMENT', -1, 'DRAFT')],
    ['missing content key', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, waiver: undefined })],
    ['html in text', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, thankYou: { en: '<script>x</script>' } })],
    ['no English', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, receiptNote: { ko: '감사합니다' } })],
    ['unknown language', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, receiptNote: { en: 'x', fr: 'y' } })],
    ['zero add-on', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, addOns: [{ ...full().addOns[0], amountMinor: 0 }] })],
    ['duplicate add-on', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, addOns: [full().addOns[0], full().addOns[0]] })],
    ['choice with one option', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, customFields: [{ ...full().customFields[0], options: [{ en: 'Only' }] }] })],
    ['text with options', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, customFields: [{ ...full().customFields[1], options: [{ en: 'x' }] }] })],
    ['duplicate plan', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, planIds: [plans.a, plans.a] })],
    ['eleven add-ons', page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, addOns: Array.from({ length: 11 }, (_, i) => ({ ...full().addOns[0], key: `a${i}` })) })],
    ['published enrollment without plans', page('ENROLLMENT', 0, 'PUBLISHED')]]) {
    await refused(() => save(OWN, body), 400, 'VALIDATION_FAILED', label);
  }
  await refused(() => save(OWN, { ...page('ENROLLMENT', 0, 'DRAFT'), fee: 1 }), 400, undefined, 'an extra top-level field (the global pipe refuses it)');
  for (const [label, id] of [['unavailable plan', plans.gone], ['school-B plan', plans.schoolB], ['other-organization plan', plans.other], ['unknown plan', randomUUID()]]) {
    await refused(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT', { ...EMPTY, planIds: [id] })), 422, 'CHECKOUT_PLAN_UNAVAILABLE', label);
  }
  await refused(() => save(OWN, page('ENROLLMENT', 3, 'DRAFT')), 409, 'VERSION_CONFLICT', 'a first save must expect version 0');
  ok((await sql('SELECT count(*)::int n FROM hon.school_checkout_pages WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'no refusal wrote a page');

  // 3. Create a draft, replay it, reuse its key, then publish it with full content (plan order kept, Korean kept).
  const key1 = randomUUID();
  const draft = await success(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT'), { key: key1 }), 'create draft');
  ok(draft.data.page.version === 1 && draft.data.page.status === 'DRAFT' && draft.data.page.kind === 'ENROLLMENT' && draft.meta.replayed === false, 'draft at version 1');
  const draftReplay = await success(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT'), { key: key1 }), 'draft replay');
  ok(draftReplay.meta.replayed === true && draftReplay.data.page.pageId === draft.data.page.pageId && draftReplay.data.page.version === 1, 'exact replay returns the first receipt');
  await refused(() => save(OWN, page('TUITION', 0, 'DRAFT'), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key for another page');
  await refused(() => save(OWN, page('ENROLLMENT', 0, 'DRAFT')), 409, 'VERSION_CONFLICT', 'a second create for the same kind');
  const published = await success(() => save(OWN, page('ENROLLMENT', 1, 'PUBLISHED', full())), 'publish full content');
  const pub = published.data.page;
  ok(pub.version === 2 && pub.status === 'PUBLISHED' && JSON.stringify(pub.content) === JSON.stringify(full()), 'published content comes back exactly, in order');
  ok(pub.content.addOns[0].label.ko === KOREAN && pub.content.waiver.text.en.includes('\n'), 'Korean and line breaks kept');
  await refused(() => save(OWN, page('ENROLLMENT', 1, 'DRAFT')), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => save(OWN, page('ENROLLMENT', 2, 'PUBLISHED')), 400, 'VALIDATION_FAILED', 'unpublishing all plans while published');
  const tuition = (await success(() => save(OWN, page('TUITION', 0, 'PUBLISHED', { ...EMPTY, receiptNote: { en: 'Paid tuition is not refundable after the month starts.' } })), 'publish tuition page')).data.page;
  ok(tuition.kind === 'TUITION' && tuition.version === 1 && tuition.content.planIds.length === 0, 'a tuition page needs no plans');
  const both = (await success(() => read(OWN), 'read both')).data;
  ok(both.enrollment.version === 2 && both.tuition.version === 1 && both.enrollment.content.planIds.join() === `${plans.b},${plans.a}`, 'read returns both pages');
  ok((await success(() => read(OWN_B), 'school-B read')).data.enrollment === null, 'school B sees none of school A pages');

  // 4. A plan that stops being available blocks the next save that still lists it, never the stored page.
  await sql("INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id) VALUES($1,2,$2,$3,'Plan b','UNAVAILABLE','USD',14900,'MONTHLY','OPEN_ENDED',$4)",
    [plans.b, ids.organization, ids.schoolA, OWN.principal]);
  await sql('UPDATE hon.membership_plans SET current_version=2, updated_at=clock_timestamp() WHERE id=$1', [plans.b]);
  await refused(() => save(OWN, page('ENROLLMENT', 2, 'PUBLISHED', full())), 422, 'CHECKOUT_PLAN_UNAVAILABLE', 'save still listing a retired plan');
  const trimmed = (await success(() => save(OWN, page('ENROLLMENT', 2, 'PUBLISHED', { ...full(), planIds: [plans.a] })), 'save without the retired plan')).data.page;
  ok(trimmed.version === 3 && trimmed.content.planIds.join() === plans.a, 'saved without it');

  // 5. Live authority loss: revoked grant, suspended entitlement, suspended school.
  await success(() => read(LOSER), 'loser read before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => save(LOSER, page('TUITION', 1, 'DRAFT')), 403, undefined, `${label}: save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => save(LOSER, page('TUITION', 1, 'DRAFT')), 'loser save after restore')).data.page.version === 2, 'authority restored');

  // 6. Version history, audit and inert outbox for every save.
  const history = (await sql('SELECT v.version, v.status FROM hon.school_checkout_page_versions v WHERE v.page_id=$1 ORDER BY v.version', [pub.pageId])).rows;
  ok(history.map((h) => `${h.version}${h.status[0]}`).join() === '1D,2P,3P', `enrollment history ${JSON.stringify(history)}`);
  const saves = (await sql('SELECT count(*)::int n FROM hon.school_checkout_page_versions WHERE organization_id=$1', [ids.organization])).rows[0].n;
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_CHECKOUT_PAGE' AND action_code='school_checkout.page.save'", [ids.organization])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_CHECKOUT_PAGE' AND status='PENDING'", [ids.organization])).rows[0].n;
  ok(saves === 5 && audit === saves && outbox === saves, `one version, audit and pending outbox event per save (${saves}/${audit}/${outbox})`);

  // 7. Settings-free guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_pages SET kind='TUITION', version=version+1 WHERE id=$1", [pub.pageId]), /fixed|duplicate key/, 'kind changed');
  await rejectsSql(() => sql('UPDATE hon.school_checkout_pages SET school_id=$2, version=version+1 WHERE id=$1', [pub.pageId, ids.schoolB]), /fixed/, 'school changed');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_pages SET status='DRAFT' WHERE id=$1", [pub.pageId]), /fixed/, 'update without a version bump');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkout_pages WHERE id=$1', [pub.pageId]), /never deleted/, 'delete');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_pages SET content=content||'{\"fee\":1}', version=version+1 WHERE id=$1", [pub.pageId]), /check constraint/, 'content outside the closed shape');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_pages SET content=jsonb_set(content,'{planIds}','[]'), version=version+1 WHERE id=$1", [pub.pageId]), /check constraint/, 'published enrollment with no plan');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_page_versions SET status='DRAFT' WHERE page_id=$1", [pub.pageId]), /./, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkout_page_versions WHERE page_id=$1', [pub.pageId]), /./, 'history deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_checkout_page_versions'), /./, 'history truncated');
  await sql('ROLLBACK');

  // 8. Runtime ACL: two definer entry points only; helpers and tables private.
  for (const fn of ['read_school_checkout_pages(text)', 'save_school_checkout_page(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['checkout_text_ok(jsonb,integer,boolean)', 'checkout_i18n_ok(jsonb,integer,boolean)', 'checkout_content_ok(jsonb)', 'guard_school_checkout_page()',
    'require_school_checkout_actor(text)', 'school_checkout_page_json(hon.school_checkout_pages)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['school_checkout_pages', 'school_checkout_page_versions']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_school_checkout_pages('x')"), /SCHOOL_CHECKOUT_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0269 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School checkout pages exact verification (B-TUI-2 0269)', end = '-- End school checkout pages exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 9. No money, invoice or message effect.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school checkout pages (0269): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
