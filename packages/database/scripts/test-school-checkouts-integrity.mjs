/**
 * School checkout pages proof (B-TUI-2 checkout CP1, 0402) over signed HTTP (HON session cookie -> HonIdentityGuard +
 * human UI guards + global ValidationPipe + HonExceptionFilter -> SchoolCheckoutController -> protected definer functions
 * on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic data;
 * nothing is public, takes a payment or sends a message, and HON adds no fee.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
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
const SAVE = 'school_checkout.page.save', SETTINGS = 'school_checkout.settings.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/payments/checkout-pages${path}${query}`);
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
const saveSettings = (actor, body, options = {}) => call(actor, 'POST', { body, command: SETTINGS, path: '/settings', ...options });
const EMPTY = { currency: 'USD', title: { en: 'Trial class' }, description: null, blocks: [], multiParticipant: { enabled: false, maxPerOrder: 1 },
  customFields: [], addOns: [], options: [], waiver: null, receiptNote: null, thankYou: null };
const page = (pageId, expectedVersion, slug, status, content = EMPTY, groupKey = 'membership') => ({ pageId, expectedVersion, slug, groupKey, status, content });

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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_checkouts WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
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
const oneTime = (key, priceMinor, extra = {}) => ({ key, label: { en: `Option ${key}` }, description: null, planId: null, billing: 'ONE_TIME', priceMinor,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0, availableThrough: null,
  mostPopular: false, createsMembership: false, ...extra });
const monthly = (key, recurringMinor, extra = {}) => ({ ...oneTime(key, null), billing: 'MONTHLY', priceMinor: null, recurringMinor, installments: 0,
  collectionMethod: 'REVIEW_REQUIRED', ...extra });
const full = () => ({
  currency: 'USD', title: { en: 'Green Belt Program Membership', ko: '그린벨트 프로그램', es: 'Programa Cinturón Verde' },
  description: { en: 'Build focus, confidence and respect.\nClasses for ages 7-12.' },
  blocks: [{ position: 'ABOVE', text: { en: 'Choose the plan that fits your family.' } }, { position: 'BELOW', text: { en: 'Questions? Call the front desk.' } }],
  multiParticipant: { enabled: true, maxPerOrder: 4 },
  customFields: [{ key: 'uniform_size', label: { en: 'Uniform size', es: 'Talla' }, kind: 'CHOICE', required: true, options: [{ en: 'Small' }, { en: 'Medium' }, { en: 'Large' }] },
    { key: 'allergies', label: { en: 'Allergies or injuries we should know about' }, kind: 'TEXT', required: false, options: [] },
    { key: 'photo_ok', label: { en: 'Photos may be used on social media' }, kind: 'CHECKBOX', required: false, options: [] }],
  addOns: [{ key: 'uniform', label: { en: 'Uniform', ko: KOREAN, es: 'Uniforme' }, amountMinor: 4500, currency: 'USD', required: true }],
  options: [
    oneTime('six_months', 121500, { label: { en: '6 Months 1 time' }, planId: plans.a, createsMembership: true, description: { en: 'Paid in full for six months.' } }),
    monthly('one_year_monthly', 22500, { label: { en: '1 year Monthly' }, planId: plans.a, createsMembership: true, installments: 10, collectionMethod: 'AUTO_CHARGE',
      downPayment: { amountMinor: 45000, label: { en: 'First and Last Month' } }, additionalParticipantMinor: 20000, capacity: 30, availableThrough: '2026-12-31', mostPopular: true }),
    oneTime('free_trial', 0, { label: { en: 'Free trial class' } })],
  waiver: { text: { en: 'I understand martial arts training carries a risk of injury.\nI agree to the school rules.', ko: '부상 위험을 이해합니다.' } },
  receiptNote: { en: 'Thank you for training with us.' }, thankYou: { en: 'Welcome to the family!', es: '¡Bienvenidos!' },
});
const count = async (text, values) => (await sql(text, values)).rows[0].n;

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission and OWNER grant (0269, unchanged).
  ok((await count("SELECT count(*)::int n FROM hon.permissions WHERE code='school_checkout.manage' AND is_sensitive AND is_staff_assignable")) === 1, 'school_checkout.manage is sensitive and staff-assignable');

  // 1. Read: default groups at version 0, no pages, this school's plans only; everyone else refused.
  const empty = (await success(() => read(OWN), 'owner read')).data;
  ok(empty.settings.version === 0 && empty.settings.groups.map((g) => g.key).join() === 'trial,membership,event,tournament,test,equipment,camp,sales'
    && empty.settings.pageOrder.length === 0 && empty.pages.length === 0, 'default groups (the current CRM list) and no pages');
  ok(empty.plans.map((p) => p.planId).sort().join() === [plans.a, plans.b, plans.gone].sort().join() && empty.plans.find((p) => p.planId === plans.gone).available === false,
    'only school-A plans, with availability');
  for (const actor of [NONE, MIXED]) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(OWN, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => read(OWN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');
  await refused(() => read(OWN, { query: '?group=trial' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(OWN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. Save refusals before anything is written.
  const draft0 = page(null, 0, 'trial-class', 'DRAFT');
  for (const actor of [NONE, MIXED]) await refused(() => save(actor, draft0), 403, undefined, `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN, draft0, { command: SETTINGS }), 403, 'HUMAN_UI_REQUIRED', 'page save under the settings command header');
  await refused(() => save(OWN, draft0, { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');
  const withOptions = (options, more = {}) => ({ ...EMPTY, options, ...more });
  for (const [label, body] of [
    ['unknown status', page(null, 0, 'trial-class', 'LIVE')], ['create expecting version 3', page(null, 3, 'trial-class', 'DRAFT')],
    ['replace without a version', page(randomUUID(), 0, 'trial-class', 'DRAFT')],
    ['uppercase slug', page(null, 0, 'Trial', 'DRAFT')], ['one-character slug', page(null, 0, 'a', 'DRAFT')], ['double hyphen', page(null, 0, 'ab--c', 'DRAFT')],
    ['trailing hyphen', page(null, 0, 'ab-', 'DRAFT')], ['leading hyphen', page(null, 0, '-ab', 'DRAFT')], ['bad group key', page(null, 0, 'trial-class', 'DRAFT', EMPTY, 'Trial')],
    ['missing content key', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, waiver: undefined })],
    ['html in title', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, title: { en: '<b>x</b>' } })],
    ['no English', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, title: { ko: '체험' } })],
    ['add-on in another currency', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, addOns: [{ ...full().addOns[0], currency: 'KRW' }] })],
    ['one-time with a recurring amount', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 100, { recurringMinor: 100 })]))],
    ['monthly with a price', page(null, 0, 'trial-class', 'DRAFT', withOptions([monthly('x', 100, { priceMinor: 100 })]))],
    ['monthly without a collection method', page(null, 0, 'trial-class', 'DRAFT', withOptions([monthly('x', 100, { collectionMethod: null })]))],
    ['121 installments', page(null, 0, 'trial-class', 'DRAFT', withOptions([monthly('x', 100, { installments: 121 })]))],
    ['zero down payment', page(null, 0, 'trial-class', 'DRAFT', withOptions([monthly('x', 100, { downPayment: { amountMinor: 0, label: { en: 'x' } } })]))],
    ['membership without a plan', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 100, { createsMembership: true })]))],
    ['two most popular', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 1, { mostPopular: true }), oneTime('y', 1, { mostPopular: true })]))],
    ['duplicate option key', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 1), oneTime('x', 2)]))],
    ['impossible date', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 1, { availableThrough: '2026-02-30' })]))],
    ['negative price', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', -1)]))],
    ['fractional price', page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 1.5)]))],
    ['eleven options', page(null, 0, 'trial-class', 'DRAFT', withOptions(Array.from({ length: 11 }, (_, i) => oneTime(`o${i}`, 1))))],
    ['single participant with a maximum of 3', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, multiParticipant: { enabled: false, maxPerOrder: 3 } })],
    ['eleven blocks', page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, blocks: Array.from({ length: 11 }, () => ({ position: 'ABOVE', text: { en: 'x' } })) })],
    ['published without options', page(null, 0, 'trial-class', 'PUBLISHED')]]) {
    await refused(() => save(OWN, body), 400, 'VALIDATION_FAILED', label);
  }
  await refused(() => save(OWN, { ...draft0, fee: 1 }), 400, undefined, 'an extra top-level field (the global pipe refuses it)');
  for (const [label, id] of [['unavailable plan', plans.gone], ['school-B plan', plans.schoolB], ['other-organization plan', plans.other], ['unknown plan', randomUUID()]]) {
    await refused(() => save(OWN, page(null, 0, 'trial-class', 'DRAFT', withOptions([oneTime('x', 1, { planId: id })]))), 422, 'CHECKOUT_PLAN_UNAVAILABLE', label);
  }
  await refused(() => save(OWN, page(null, 0, 'trial-class', 'DRAFT', EMPTY, 'seminar')), 422, 'CHECKOUT_GROUP_UNKNOWN', 'a group that does not exist');
  await refused(() => save(OWN, page(randomUUID(), 1, 'trial-class', 'DRAFT')), 422, 'CHECKOUT_NOT_FOUND', 'replacing an unknown page');
  ok((await count('SELECT count(*)::int n FROM hon.school_checkouts WHERE organization_id=$1', [ids.organization])) === 0, 'no refusal wrote a page');

  // 3. Create a draft, replay it, reuse its key, then publish it with full content; duplicate it; same slug at school B.
  const key1 = randomUUID();
  const draft = (await success(() => save(OWN, draft0, { key: key1 }), 'create draft'));
  const original = draft.data.page;
  ok(original.version === 1 && original.status === 'DRAFT' && original.slug === 'trial-class' && original.groupKey === 'membership' && draft.meta.replayed === false, 'draft at version 1');
  const draftReplay = await success(() => save(OWN, draft0, { key: key1 }), 'draft replay');
  ok(draftReplay.meta.replayed === true && draftReplay.data.page.pageId === original.pageId && draftReplay.data.page.version === 1, 'exact replay returns the first receipt');
  await refused(() => save(OWN, page(null, 0, 'other-page', 'DRAFT'), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the same key for another page');
  await refused(() => save(OWN, draft0), 422, 'CHECKOUT_SLUG_TAKEN', 'a second page with the same address');
  const pub = (await success(() => save(OWN, page(original.pageId, 1, 'trial-class', 'PUBLISHED', full())), 'publish full content')).data.page;
  ok(pub.version === 2 && pub.status === 'PUBLISHED' && JSON.stringify(pub.content) === JSON.stringify(full()), 'published content comes back exactly, options in order');
  ok(pub.content.addOns[0].label.ko === KOREAN && pub.content.waiver.text.en.includes('\n') && pub.content.options[2].priceMinor === 0, 'Korean, line breaks and a free option kept');
  await refused(() => save(OWN, page(original.pageId, 2, 'trial-class-2', 'PUBLISHED', full())), 422, 'CHECKOUT_SLUG_FIXED', 'changing the address');
  await refused(() => save(OWN, page(original.pageId, 1, 'trial-class', 'DRAFT')), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => save(OWN, page(original.pageId, 2, 'trial-class', 'PUBLISHED')), 400, 'VALIDATION_FAILED', 'publishing with no options');
  const copy = (await success(() => save(OWN, page(null, 0, 'trial-class-copy', 'DRAFT', { ...full(), title: { en: 'Holiday Sale - Green Belt' } }, 'sales')), 'duplicate page')).data.page;
  ok(copy.version === 1 && copy.groupKey === 'sales' && copy.pageId !== pub.pageId, 'duplicate is a new page with its own address');
  const atB = (await success(() => save(OWN_B, page(null, 0, 'trial-class', 'DRAFT', { ...EMPTY, options: [oneTime('x', 100, { planId: plans.schoolB })] })), 'school-B page with the same address')).data.page;
  ok(atB.slug === 'trial-class', 'addresses are unique per school only');
  const listed = (await success(() => read(OWN), 'read pages')).data;
  ok(listed.pages.map((p) => p.pageId).join() === `${pub.pageId},${copy.pageId}` && listed.pages[0].version === 2, 'without an order, pages list oldest first');
  ok((await success(() => read(OWN_B), 'school-B read')).data.pages.map((p) => p.pageId).join() === atB.pageId, 'school B sees only its page');

  // 4. Groups and staff order.
  const groups = [{ key: 'sales', label: { en: 'Holiday sales', ko: '세일' } }, { key: 'membership', label: { en: 'Membership' } }, { key: 'seminar', label: { en: 'Seminar' } }];
  const settingsKey = randomUUID();
  const s1 = await success(() => saveSettings(OWN, { expectedVersion: 0, groups, pageOrder: [copy.pageId, pub.pageId] }, { key: settingsKey }), 'save groups and order');
  ok(s1.data.settings.version === 1 && JSON.stringify(s1.data.settings.groups) === JSON.stringify(groups) && s1.meta.replayed === false, 'settings at version 1');
  ok((await success(() => saveSettings(OWN, { expectedVersion: 0, groups, pageOrder: [copy.pageId, pub.pageId] }, { key: settingsKey }), 'settings replay')).meta.replayed === true, 'settings replay');
  ok((await success(() => read(OWN), 'read ordered')).data.pages.map((p) => p.pageId).join() === `${copy.pageId},${pub.pageId}`, 'pages follow the staff order');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups: groups.filter((g) => g.key !== 'sales'), pageOrder: [] }), 422, 'CHECKOUT_GROUP_IN_USE', 'removing a group a page uses');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups, pageOrder: [atB.pageId] }), 422, 'CHECKOUT_NOT_FOUND', 'ordering another school page');
  await refused(() => saveSettings(OWN, { expectedVersion: 0, groups, pageOrder: [] }), 409, 'VERSION_CONFLICT', 'stale settings');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups, pageOrder: [pub.pageId, pub.pageId] }), 400, 'VALIDATION_FAILED', 'a page listed twice');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups: [], pageOrder: [] }), 400, 'VALIDATION_FAILED', 'no groups');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups: [groups[0], groups[0]], pageOrder: [] }), 400, 'VALIDATION_FAILED', 'duplicate group');
  await refused(() => saveSettings(OWN, { expectedVersion: 1, groups, pageOrder: [] }, { command: SAVE }), 403, 'HUMAN_UI_REQUIRED', 'settings under the page command header');
  for (const actor of [NONE, MIXED]) await refused(() => saveSettings(actor, { expectedVersion: 1, groups, pageOrder: [] }), 403, undefined, `settings refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN, page(null, 0, 'camp-2027', 'DRAFT', EMPTY, 'camp')), 422, 'CHECKOUT_GROUP_UNKNOWN', 'a default group the school removed');
  const seminar = (await success(() => save(OWN, page(null, 0, 'seminar-2027', 'DRAFT', EMPTY, 'seminar')), 'page in a new group')).data.page;
  ok((await success(() => read(OWN), 'read with an unordered page')).data.pages.map((p) => p.pageId).join() === `${copy.pageId},${pub.pageId},${seminar.pageId}`, 'pages missing from the order come last');

  // 5. A plan that stops being available blocks the next save that still names it, except archiving; the stored page stays.
  await sql("INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id) VALUES($1,2,$2,$3,'Plan a','UNAVAILABLE','USD',14900,'MONTHLY','OPEN_ENDED',$4)",
    [plans.a, ids.organization, ids.schoolA, OWN.principal]);
  await sql('UPDATE hon.membership_plans SET current_version=2, updated_at=clock_timestamp() WHERE id=$1', [plans.a]);
  await refused(() => save(OWN, page(pub.pageId, 2, 'trial-class', 'PUBLISHED', full())), 422, 'CHECKOUT_PLAN_UNAVAILABLE', 'save still naming a retired plan');
  const archived = (await success(() => save(OWN, page(copy.pageId, 1, 'trial-class-copy', 'ARCHIVED', { ...full(), title: { en: 'Holiday Sale - Green Belt' } }, 'sales')), 'archive a page naming a retired plan')).data.page;
  ok(archived.status === 'ARCHIVED' && archived.version === 2, 'archived');
  const trimmed = (await success(() => save(OWN, page(pub.pageId, 2, 'trial-class', 'PUBLISHED', { ...full(), options: [oneTime('free_trial', 0)] })), 'save without the retired plan')).data.page;
  ok(trimmed.version === 3 && trimmed.content.options.length === 1, 'saved without it');

  // 6. Live authority loss: revoked grant, suspended entitlement, suspended school.
  await success(() => read(LOSER), 'loser read before');
  let n = 0;
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => save(LOSER, page(null, 0, `loser-${n += 1}`, 'DRAFT')), 403, undefined, `${label}: page save`);
    await refused(() => saveSettings(LOSER, { expectedVersion: 1, groups, pageOrder: [] }), 403, undefined, `${label}: settings save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => save(LOSER, page(null, 0, 'loser-page', 'DRAFT')), 'loser save after restore')).data.page.version === 1, 'authority restored');

  // 7. Version history, audit and inert outbox for every save.
  const history = (await sql('SELECT version, status FROM hon.school_checkout_versions WHERE checkout_id=$1 ORDER BY version', [pub.pageId])).rows;
  ok(history.map((h) => `${h.version}${h.status[0]}`).join() === '1D,2P,3P', `page history ${JSON.stringify(history)}`);
  const saves = await count('SELECT count(*)::int n FROM hon.school_checkout_versions WHERE organization_id=$1', [ids.organization]);
  const audit = await count("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_CHECKOUT' AND action_code='school_checkout.save'", [ids.organization]);
  const outbox = await count("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_CHECKOUT' AND status='PENDING'", [ids.organization]);
  ok(saves === 8 && audit === saves && outbox === saves, `one version, audit and pending outbox event per page save (${saves}/${audit}/${outbox})`);
  ok((await count("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_checkout.settings.save'", [ids.organization])) === 1
    && (await count("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_CHECKOUT_SETTINGS' AND status='PENDING'", [ids.organization])) === 1,
  'one audit and outbox event for the settings save');

  // 8. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_checkouts SET slug='moved', version=version+1 WHERE id=$1", [pub.pageId]), /fixed/, 'slug changed');
  await rejectsSql(() => sql('UPDATE hon.school_checkouts SET school_id=$2, version=version+1 WHERE id=$1', [pub.pageId, ids.schoolB]), /fixed/, 'school changed');
  await rejectsSql(() => sql("UPDATE hon.school_checkouts SET status='DRAFT' WHERE id=$1", [pub.pageId]), /fixed/, 'update without a version bump');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkouts WHERE id=$1', [pub.pageId]), /never deleted/, 'delete');
  await rejectsSql(() => sql("UPDATE hon.school_checkouts SET content=content||'{\"fee\":1}', version=version+1 WHERE id=$1", [pub.pageId]), /check constraint/, 'content outside the closed shape');
  await rejectsSql(() => sql("UPDATE hon.school_checkouts SET content=jsonb_set(content,'{options}','[]'), version=version+1 WHERE id=$1", [pub.pageId]), /check constraint/, 'published page with no option');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_settings SET groups='[]' , version=version+1 WHERE school_id=$1", [ids.schoolA]), /check constraint/, 'no groups');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_settings SET page_order='{}' WHERE school_id=$1", [ids.schoolA]), /fixed/, 'settings without a version bump');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkout_settings WHERE school_id=$1', [ids.schoolA]), /never deleted/, 'settings deleted');
  await rejectsSql(() => sql("UPDATE hon.school_checkout_versions SET status='DRAFT' WHERE checkout_id=$1", [pub.pageId]), /./, 'history rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkout_versions WHERE checkout_id=$1', [pub.pageId]), /./, 'history deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_checkout_versions'), /./, 'history truncated');
  await rejectsSql(() => sql('TRUNCATE hon.school_checkouts CASCADE'), /./, 'pages truncated');
  await sql('ROLLBACK');

  // 9. Runtime ACL: three definer entry points; the two 0269 entry points are retired; helpers and tables private.
  for (const fn of ['read_school_checkouts(text)', 'save_school_checkout(text,jsonb,text,uuid,uuid)', 'save_school_checkout_settings(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['read_school_checkout_pages(text)', 'save_school_checkout_page(text,jsonb,text,uuid,uuid)', 'checkout_int_ok(jsonb,bigint,bigint)', 'checkout_fields_ok(jsonb)',
    'checkout_option_ok(jsonb)', 'school_checkout_content_ok(jsonb)', 'school_checkout_groups_ok(jsonb)', 'school_checkout_default_groups()', 'guard_school_checkout()',
    'school_checkout_json(hon.school_checkouts)', 'school_checkout_settings_json(uuid,uuid)', 'school_checkout_begin(text,text,jsonb,text)', 'school_checkout_finish(text,uuid,text,jsonb)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `${fn} is not reachable by the runtime or PUBLIC`);
  }
  await assert.rejects(runtime.query("SELECT hon.save_school_checkout_page('x','{}','k',gen_random_uuid(),gen_random_uuid())"), /permission denied/); checks += 1;
  for (const table of ['school_checkouts', 'school_checkout_versions', 'school_checkout_settings']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_school_checkouts('x')"), /SCHOOL_CHECKOUT_FORBIDDEN/); checks += 1;
  // The deployment verifier's 0269 and 0402 sections (infra/postgres/011) pass against this database with its runtime role.
  const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
  for (const [begin, end] of [['-- School checkout pages exact verification (B-TUI-2 0269)', '-- End school checkout pages exact verification.'],
    ['-- School checkouts exact verification (B-TUI-2 0402)', '-- End school checkouts exact verification.']]) {
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
  }

  // 10. C5 carry-over (run again inside a rolled-back transaction): a 0269 page becomes a DRAFT page with its texts kept.
  {
    const migration = await readFile(resolve(repo, 'packages/database/migrations/0402_school_checkouts.sql'), 'utf8');
    const carry = migration.split('-- C5: copy any 0269 page')[1]?.split('-- End C5 carry-over.')[0]?.replace(/^[^\n]*\n/, '');
    ok(carry && carry.includes('INSERT INTO hon.school_checkouts'), 'carry-over block found');
    const old = { planIds: [plans.b], addOns: [{ key: 'uniform', label: { en: 'Uniform' }, amountMinor: 4500, currency: 'CAD', required: true }],
      customFields: full().customFields, waiver: full().waiver, receiptNote: { en: 'Thanks' }, thankYou: null };
    await sql('BEGIN');
    try {
      await sql("INSERT INTO hon.school_checkout_pages(organization_id,school_id,kind,status,content,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'TUITION','PUBLISHED',$3,$4,$4)",
        [ids.organization, ids.schoolA, JSON.stringify(old), OWN.principal]);
      await sql(carry);
      const moved = (await sql("SELECT c.status, c.group_key, c.content, (SELECT count(*)::int FROM hon.school_checkout_versions v WHERE v.checkout_id=c.id) versions FROM hon.school_checkouts c WHERE c.school_id=$1 AND c.slug='tuition'", [ids.schoolA])).rows;
      ok(moved.length === 1 && moved[0].status === 'DRAFT' && moved[0].group_key === 'membership' && moved[0].versions === 1, 'one DRAFT page with one version');
      const c = moved[0].content;
      ok(c.currency === 'CAD' && c.title.en === 'Tuition payment' && c.options.length === 0 && isDeepStrictEqual(c.addOns, old.addOns)
        && isDeepStrictEqual(c.customFields, old.customFields) && isDeepStrictEqual(c.waiver, old.waiver) && c.receiptNote.en === 'Thanks',
      'texts, add-ons in their currency and questions kept; plans left for staff to add as options');
      await sql(carry);
      ok((await count("SELECT count(*)::int n FROM hon.school_checkouts WHERE school_id=$1 AND slug='tuition'", [ids.schoolA])) === 1, 'running the carry-over again copies nothing twice');
    } finally { await sql('ROLLBACK'); }
  }

  // 11. No money, invoice or message effect.
  ok((await sql('SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n',
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice was created');

  console.log(`PASS: school checkout pages (0402): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
