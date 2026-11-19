/**
 * Family checkout orders proof (0582, CP3 first slice): ParentCheckoutService -> the three fixed parent calls on the
 * restricted runtime role -> protected definers, SchoolPayOnceService (0529) with the in-process processor simulators,
 * and the staff orders read through SchoolCheckoutService, on the guarded disposable CRM-close fixture only. No network,
 * no credentials, synthetic data, TEST mode only; HON takes no fee and nothing is sent to anyone.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { SchoolPayOnceService } = await load('school-payments/school-pay-once.service.js');
const { SimulatedStripeConnectAdapter, SimulatedSquareAdapter, UnconfiguredSchoolPaymentAdapter } = await load('school-payments/school-payment-adapter.js');
const { ParentCheckoutService } = await load('family-checkout/parent-checkout.service.js');
const { SchoolCheckoutService } = await load('school-checkout/school-checkout.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'foreignFamily'].map((key) => [key, randomUUID()]));
const PREFIX = `fco-${ids.organization.slice(0, 8)}`;
const sql = (text, values = []) => admin.query(text, values);
const one = (text, values = []) => sql(text, values).then((r) => r.rows[0]);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const SVC = '00000000-0000-4000-8000-000000000582';
process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';

const stripe = new SimulatedStripeConnectAdapter();
const square = new SimulatedSquareAdapter();
const db = new RuntimeDatabaseService();
const once = new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]));
const shop = new ParentCheckoutService(db, once);
const noCard = new ParentCheckoutService(db, new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', new UnconfiguredSchoolPaymentAdapter('STRIPE_CONNECT')], ['SQUARE', square]])));
const staffReads = new SchoolCheckoutService(db);
const LEAK = /acct_sim|pi_sim|cs_sim|MLSIM|@example\.test|paymentId|providerCode/;

async function refused(run, status, code, label) {
  try { await run(); } catch (error) {
    const body = typeof error.getResponse === 'function' ? error.getResponse() : null;
    assert.equal(error.getStatus?.(), status, `${label}: expected ${status}, got ${error.getStatus?.()} ${JSON.stringify(body)} ${error.message}`);
    if (code) assert.equal(body?.code, code, `${label}: expected ${code}, got ${JSON.stringify(body)}`);
    checks += 1; return;
  }
  assert.fail(`${label}: expected a refusal`);
}
async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0529 and 0530 proofs).
async function cleanup() {
  const orgs = [ids.organization, ids.otherOrganization];
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function human(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Person')", [user, subject, `${label}-${user.slice(0, 8)}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Person')", [principal, user]);
  return { subject, principal };
}
async function grant(actor, family, school, org, level = 'PRIMARY_GUARDIAN') {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [org, school, family, actor.principal, level]);
}
async function staff(label, permissions) {
  const actor = await human(label), role = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [role, ids.organization, `FCO_${role.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, ids.organization, permission]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",
    [ids.organization, ids.school, actor.principal, role]);
  return actor;
}
async function person(family, school, org, given, role) {
  const id = (await one("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Park') RETURNING id", [org, school, given])).id;
  await sql('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,$5)', [org, school, family, id, role]);
  return id;
}
async function child(family, school, org, given, status = 'ACTIVE') {
  const p = await person(family, school, org, given, 'STUDENT');
  return (await one('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5) RETURNING id', [org, school, p, family, status])).id;
}
async function household(family, school, org, name) {
  await sql('INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,$4)', [family, org, school, name]);
  await person(family, school, org, 'Jin', 'GUARDIAN');
}

const en = (text) => ({ en: text });
const option = (key, priceMinor, extra = {}) => ({ key, label: en(`Option ${key}`), description: null, planId: null, billing: 'ONE_TIME', priceMinor,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0,
  availableThrough: null, mostPopular: false, createsMembership: false, ...extra });
const monthly = (key) => ({ ...option(key, null), billing: 'MONTHLY', recurringMinor: 9900, installments: 0, collectionMethod: 'IN_HOUSE' });
const CONTENT = {
  currency: 'USD', title: en('Summer camp'), description: en('A week of training.'), blocks: [{ position: 'ABOVE', text: en('Bring water.') }],
  multiParticipant: { enabled: true, maxPerOrder: 3 },
  customFields: [
    { key: 'size', label: en('Uniform size'), kind: 'TEXT', required: true, options: [] },
    { key: 'belt', label: en('Belt'), kind: 'CHOICE', required: false, options: [en('White'), en('Yellow')] },
    { key: 'photo', label: en('Photo consent'), kind: 'CHECKBOX', required: true, options: [] },
  ],
  addOns: [{ key: 'uniform', label: en('Uniform'), amountMinor: 2500, currency: 'USD', required: false }, { key: 'patch', label: en('Patch'), amountMinor: 500, currency: 'USD', required: true }],
  options: [option('week', 5000, { additionalParticipantMinor: 3000, capacity: 3, mostPopular: true }), option('day', 2000), monthly('monthly'),
    option('ended', 1000, { availableThrough: '2020-01-01' }), option('member', 1000, { planId: randomUUID(), createsMembership: true })],
  waiver: { text: en('I accept the camp rules.') }, receiptNote: null, thankYou: en('See you at camp!'),
};
const FREE = { ...CONTENT, title: en('Open house'), multiParticipant: { enabled: false, maxPerOrder: 1 }, customFields: [], addOns: [], options: [option('free', 0)], waiver: null, thankYou: null };
async function checkoutPage(slug, content, { status = 'PUBLISHED', school = ids.school, org = ids.organization } = {}) {
  return (await one(`INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'events',$4,$5,$6,$6) RETURNING id`, [org, school, slug, status, JSON.stringify(content), MANAGER.principal])).id;
}
const onceOf = (order) => sql("SELECT * FROM hon.school_pay_once WHERE source='CHECKOUT_PAGE' AND source_id=$1 ORDER BY created_at", [order]).then((r) => r.rows);
const orderRow = (id) => one('SELECT * FROM hon.family_checkout_orders WHERE id=$1', [id]);
async function backdate(paymentId) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_once DISABLE TRIGGER school_pay_once_guard');
  await sql("UPDATE hon.school_pay_once SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours',provider_expires_at=provider_expires_at-interval '2 hours' WHERE id=$1", [paymentId]);
  await sql('ALTER TABLE hon.school_pay_once ENABLE TRIGGER school_pay_once_guard');
  await sql('COMMIT');
}
const clean = (value, label) => ok(!LEAK.test(JSON.stringify({ ...value, url: undefined })), `${label}: no payment id, provider, account or email`);

let PARENT, VIEWER, OTHER, FOREIGN, NOBODY, MANAGER, CLERK, MINA, JOON, LEFT, OTHERKID, FOREIGNKID, CAMP, DRAFT, MONTHLY_ONLY, SINGLE, OPEN_HOUSE, FOREIGN_PAGE;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'FCO Org','FCO Org'),($2,'FCO Other Org','FCO Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.school, ids.organization, 's'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `FCO ${slug}`, `fco-${slug}-${school.slice(0, 8)}`]);
  }
  MANAGER = await staff('manager', ['school_checkout.manage']);
  CLERK = await staff('clerk', ['people.read']);
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_connections DISABLE TRIGGER USER');
  for (const [org, school, ref] of [[ids.organization, ids.school, 'acct_simF1'], [ids.otherOrganization, ids.otherSchool, 'acct_simF2']]) {
    await sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,charges_enabled,payouts_enabled,capabilities,is_default,started_by_principal_id)
      VALUES($1,$2,'STRIPE_CONNECT','CONNECTED_ACTIVE',$3,true,true,'{"oneTimeCard":true,"storedCard":true,"bankDebit":false,"offSessionRecurring":true,"refunds":true}'::jsonb,true,$4)`,
      [org, school, ref, MANAGER.principal]);
  }
  await sql('ALTER TABLE hon.school_pay_connections ENABLE TRIGGER USER');
  await sql('COMMIT');
  await household(ids.family, ids.school, ids.organization, 'Park Family');
  await household(ids.otherFamily, ids.school, ids.organization, 'Lee Family');
  await household(ids.foreignFamily, ids.otherSchool, ids.otherOrganization, 'Kim Family');
  MINA = await child(ids.family, ids.school, ids.organization, 'Mina');
  JOON = await child(ids.family, ids.school, ids.organization, 'Joon');
  LEFT = await child(ids.family, ids.school, ids.organization, 'Gone', 'ARCHIVED');
  OTHERKID = await child(ids.otherFamily, ids.school, ids.organization, 'Otherkid');
  FOREIGNKID = await child(ids.foreignFamily, ids.otherSchool, ids.otherOrganization, 'Foreign');
  PARENT = await human('parent'); VIEWER = await human('viewer'); OTHER = await human('other'); FOREIGN = await human('foreign'); NOBODY = await human('nobody');
  await grant(PARENT, ids.family, ids.school, ids.organization);
  await grant(VIEWER, ids.family, ids.school, ids.organization, 'VIEWER');
  await grant(OTHER, ids.otherFamily, ids.school, ids.organization, 'SECONDARY_GUARDIAN');
  await grant(FOREIGN, ids.foreignFamily, ids.otherSchool, ids.otherOrganization);
  CAMP = await checkoutPage('summer-camp', CONTENT);
  DRAFT = await checkoutPage('draft-camp', CONTENT, { status: 'DRAFT' });
  MONTHLY_ONLY = await checkoutPage('monthly-only', { ...CONTENT, options: [monthly('monthly')] });
  SINGLE = await checkoutPage('private-lesson', { ...CONTENT, multiParticipant: { enabled: false, maxPerOrder: 1 }, waiver: null, customFields: [], addOns: [], options: [option('lesson', 4000)] });
  OPEN_HOUSE = await checkoutPage('open-house', FREE);
  FOREIGN_PAGE = await checkoutPage('foreign-camp', CONTENT, { school: ids.otherSchool, org: ids.otherOrganization });
}

const answers = (size = 'M', extra = {}) => ({ size, photo: true, ...extra });
const body = (extra = {}) => ({ checkoutId: CAMP, expectedVersion: 1, optionKey: 'week', waiverAccepted: true, addOns: ['patch', 'uniform'],
  participants: [{ studentProfileId: MINA, answers: answers('M', { belt: 'Yellow' }) }, { studentProfileId: JOON, answers: answers('S') }], ...extra });

try {
  await cleanup();
  await seed();

  // 1. The list: the school's published pages with a one-time option, only those options, the family's ACTIVE children.
  const list = await shop.list(PARENT.subject);
  ok(list.canBuy && list.canPay && list.testMode === true && list.schoolName === 'FCO s', 'guardian of a Stripe test-mode school: can buy and pay');
  ok(list.pages.map((p) => p.checkoutId).sort().join() === [CAMP, SINGLE, OPEN_HOUSE].sort().join(), 'only published pages with a one-time option (no draft, monthly-only or foreign page)');
  const camp = list.pages.find((p) => p.checkoutId === CAMP);
  ok(camp.options.map((o) => o.key).join() === 'week,day', 'monthly, ended and membership options are not sold here');
  ok(camp.options[0].placesLeft === 3 && camp.options[1].placesLeft === null && camp.options[0].additionalParticipantMinor === 3000 && camp.options[0].mostPopular, 'places left and prices');
  ok(camp.title === 'Summer camp' && camp.waiver === 'I accept the camp rules.' && camp.questions.length === 3 && camp.questions[1].options.join() === 'White,Yellow'
    && camp.addOns.length === 2 && camp.blocks[0].text === 'Bring water.' && camp.maxParticipants === 3 && camp.group === 'events', 'page content in English');
  ok(list.children.map((c) => c.displayName).join() === 'Joon Park,Mina Park', 'only the family\'s ACTIVE children');
  ok(list.orders.length === 0, 'no orders yet');
  clean(list, 'list');
  const viewerList = await shop.list(VIEWER.subject);
  ok(viewerList.canBuy === false && viewerList.pages.length === 3, 'a VIEWER sees the pages but cannot buy');
  ok((await noCard.list(PARENT.subject)).canPay === false, 'processor not configured here: no card payment offered');
  ok((await shop.list(FOREIGN.subject)).pages.every((p) => p.checkoutId === FOREIGN_PAGE), 'another organization sees only its own pages');
  await refused(() => shop.list(NOBODY.subject), 403, 'FAMILY_CHECKOUT_FORBIDDEN', 'no family grant');

  // 2. Refusals before anything is written (F1).
  const none = async () => (await one('SELECT count(*)::int n FROM hon.family_checkout_orders WHERE organization_id=$1', [ids.organization])).n;
  await refused(() => shop.order(VIEWER.subject, body(), randomUUID()), 403, 'FAMILY_CHECKOUT_FORBIDDEN', 'a VIEWER cannot order');
  await refused(() => shop.order(NOBODY.subject, body(), randomUUID()), 403, 'FAMILY_CHECKOUT_FORBIDDEN', 'no grant cannot order');
  await refused(() => shop.order(PARENT.subject, body({ checkoutId: DRAFT }), randomUUID()), 404, 'FAMILY_CHECKOUT_NOT_FOUND', 'a draft page');
  await refused(() => shop.order(PARENT.subject, body({ checkoutId: FOREIGN_PAGE }), randomUUID()), 404, 'FAMILY_CHECKOUT_NOT_FOUND', 'another organization\'s page');
  await refused(() => shop.order(PARENT.subject, body({ checkoutId: randomUUID() }), randomUUID()), 404, 'FAMILY_CHECKOUT_NOT_FOUND', 'an unknown page');
  await refused(() => shop.order(PARENT.subject, body({ expectedVersion: 2 }), randomUUID()), 409, 'FAMILY_CHECKOUT_CHANGED', 'a stale page version');
  for (const key of ['monthly', 'ended', 'member', 'nope']) {
    await refused(() => shop.order(PARENT.subject, body({ optionKey: key }), randomUUID()), 409, 'FAMILY_CHECKOUT_OPTION_UNAVAILABLE', `option ${key}`);
  }
  for (const [label, kid] of [['another family\'s child', OTHERKID], ['another organization\'s child', FOREIGNKID], ['an archived child', LEFT], ['unknown', randomUUID()]]) {
    await refused(() => shop.order(PARENT.subject, body({ participants: [{ studentProfileId: kid, answers: answers() }] }), randomUUID()), 404, 'FAMILY_CHECKOUT_NOT_FOUND', label);
  }
  for (const [label, a] of [['missing required text', { photo: true }], ['photo consent not given', { size: 'M', photo: false }], ['not a listed choice', answers('M', { belt: 'Black' })],
    ['unknown question', answers('M', { shoe: 'x' })], ['blank text', { size: '  ', photo: true }], ['checkbox as text', { size: 'M', photo: 'yes' }]]) {
    await refused(() => shop.order(PARENT.subject, body({ participants: [{ studentProfileId: MINA, answers: a }] }), randomUUID()), 400, 'VALIDATION_FAILED', label);
  }
  await refused(() => shop.order(PARENT.subject, body({ addOns: ['uniform'] }), randomUUID()), 400, 'VALIDATION_FAILED', 'a required add-on left out');
  await refused(() => shop.order(PARENT.subject, body({ addOns: ['patch', 'cape'] }), randomUUID()), 400, 'VALIDATION_FAILED', 'an unknown add-on');
  await refused(() => shop.order(PARENT.subject, body({ waiverAccepted: false }), randomUUID()), 422, 'FAMILY_CHECKOUT_WAIVER_REQUIRED', 'waiver not accepted');
  await refused(() => shop.order(PARENT.subject, { checkoutId: SINGLE, expectedVersion: 1, optionKey: 'lesson', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: MINA, answers: {} }, { studentProfileId: JOON, answers: {} }] }, randomUUID()), 400, 'VALIDATION_FAILED', 'more children than the page allows');
  await refused(() => shop.order(PARENT.subject, body({ participants: [{ studentProfileId: MINA, answers: answers() }, { studentProfileId: MINA, answers: answers() }] }), randomUUID()),
    400, 'VALIDATION_FAILED', 'the same child twice');
  await refused(() => shop.order(PARENT.subject, { ...body(), amountMinor: 1 }, randomUUID()), 400, 'VALIDATION_FAILED', 'the app cannot name an amount');
  await refused(() => shop.order(PARENT.subject, body(), ''), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'a key is required');
  ok(await none() === 0, 'nothing written by any refusal');

  // 3. The order: priced by the page (first child + extra-child fee + add-ons), its payment opened, processor page returned.
  const key = randomUUID();
  const s1 = await shop.order(PARENT.subject, body(), key);
  ok(s1.status === 'OPEN' && s1.payState === 'OPEN' && s1.url.startsWith('https://') && s1.amountMinor === 5000 + 3000 + 2500 + 500 && s1.currency === 'USD', 'order OPEN, page for 11000');
  clean(s1, 'order result');
  const o1 = await orderRow(s1.orderId);
  ok(o1.family_id === ids.family && o1.principal_id === PARENT.principal && o1.title === 'Summer camp - Option week' && o1.add_on_keys.join() === 'patch,uniform'
    && o1.participants.length === 2 && o1.participants[0].answers.belt === 'Yellow' && /^[0-9a-f]{64}$/.test(o1.waiver_sha256), 'order row: family, buyer, answers, waiver hash');
  const [p1] = await onceOf(s1.orderId);
  ok(p1.amount_minor === '11000' && p1.surface === 'HOSTED' && p1.return_url === 'https://app.example.test/parent/payment-return' && p1.payer_email === null
    && p1.label === 'Summer camp - Option week' && Date.parse(p1.expires_at) - Date.parse(p1.created_at) <= 30 * 60_000, 'payment: amount, hosted, fixed return page, 30 minutes, no child name');
  const replay = await shop.order(PARENT.subject, body(), key);
  ok(replay.orderId === s1.orderId && replay.url === s1.url && (await onceOf(s1.orderId)).length === 1 && await none() === 1, 'exact repeat: same order and page');
  await refused(() => shop.order(PARENT.subject, body({ addOns: ['patch'] }), key), 409, 'IDEMPOTENCY_KEY_REUSED', 'another order under the same key');
  ok((await shop.list(PARENT.subject)).pages.find((p) => p.checkoutId === CAMP).options[0].placesLeft === 1, 'two places held while it may be paid');

  // 4. Capacity (F4): two more children do not fit; one does.
  await refused(() => shop.order(PARENT.subject, body(), randomUUID()), 409, 'FAMILY_CHECKOUT_FULL', 'not enough places');
  const s2 = await shop.order(OTHER.subject, body({ participants: [{ studentProfileId: OTHERKID, answers: answers() }], addOns: ['patch'] }), randomUUID());
  ok(s2.amountMinor === 5500 && s2.status === 'OPEN', 'one child: price + required add-on');
  await refused(() => shop.order(OTHER.subject, body({ participants: [{ studentProfileId: OTHERKID, answers: answers() }], addOns: ['patch'] }), randomUUID()), 409, 'FAMILY_CHECKOUT_FULL', 'full');

  // 5. A caller never names a payment (F2): foreign or unknown orders are refused before any payment is read.
  for (const [label, actor, id] of [['another family', OTHER, s1.orderId], ['another organization', FOREIGN, s1.orderId], ['unknown', PARENT, randomUUID()]]) {
    await refused(() => shop.start(actor.subject, id), 404, 'FAMILY_CHECKOUT_NOT_FOUND', `start: ${label}`);
    await refused(() => shop.confirm(actor.subject, id), 404, 'FAMILY_CHECKOUT_NOT_FOUND', `confirm: ${label}`);
    await refused(() => shop.cancel(actor.subject, id), 404, 'FAMILY_CHECKOUT_NOT_FOUND', `cancel: ${label}`);
  }
  await refused(() => shop.confirm(VIEWER.subject, s1.orderId), 403, 'FAMILY_CHECKOUT_FORBIDDEN', 'a VIEWER cannot confirm');
  await refused(() => shop.start(PARENT.subject, 'not-a-uuid'), 400, 'VALIDATION_FAILED', 'bad order id');
  const before = await one('SELECT count(*)::int n FROM hon.school_pay_once_events WHERE organization_id=$1', [ids.organization]);
  ok((await shop.confirm(PARENT.subject, s1.orderId)).payState === 'OPEN', 'not paid yet: OPEN');
  ok((await shop.start(PARENT.subject, s1.orderId)).url === s1.url, 'start again: same page');
  ok(before.n >= 1, 'payment history exists');

  // 6. Paid at the processor (F3): confirm records SUCCEEDED and the database marks the order PAID once.
  stripe.settleOnce(p1.id, 'SUCCEEDED');
  const c1 = await shop.confirm(PARENT.subject, s1.orderId);
  ok(c1.payState === 'SUCCEEDED' && c1.order.status === 'PAID', 'confirm: SUCCEEDED, order PAID');
  clean(c1, 'confirm result');
  ok((await one("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='family_checkout.order_paid' AND actor_principal_id=$2", [s1.orderId, SVC])).n === 1
    && (await one("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='family_checkout.order_paid'", [s1.orderId])).n === 1, 'paid by the code-owned recorder, one event');
  ok((await shop.confirm(PARENT.subject, s1.orderId)).order.status === 'PAID' && (await orderRow(s1.orderId)).version === 2, 'confirm again: nothing new');
  const paidStart = await shop.start(PARENT.subject, s1.orderId);
  ok(paidStart.payState === 'SUCCEEDED' && paidStart.url === null && paidStart.status === 'PAID', 'start a paid order: no page');
  ok(!stripe.onceSessions.get([...stripe.onceSessions.keys()].find((k) => stripe.onceSessions.get(k).paymentId === p1.id)).applicationFee, 'no HON fee on the session');

  // 7. Cancel: closed at the processor first; the order is CANCELED and its place is free again.
  const x2 = await shop.cancel(OTHER.subject, s2.orderId);
  ok(x2.payState === 'CANCELED' && x2.order.status === 'CANCELED', 'cancel: CANCELED');
  ok((await shop.list(PARENT.subject)).pages.find((p) => p.checkoutId === CAMP).options[0].placesLeft === 1, 'the canceled place is free again');
  ok((await shop.start(OTHER.subject, s2.orderId)).url === null, 'a canceled order opens no page');

  // 8. Free option: PAID at once, no payment.
  const free = await shop.order(PARENT.subject, { checkoutId: OPEN_HOUSE, expectedVersion: 1, optionKey: 'free', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: JOON, answers: {} }] }, randomUUID());
  ok(free.status === 'PAID' && free.payState === 'NONE' && free.url === null && free.amountMinor === 0 && (await onceOf(free.orderId)).length === 0, 'free order: PAID, no payment');
  ok((await shop.confirm(PARENT.subject, free.orderId)).payState === 'NONE', 'confirm a free order: NONE');

  // 9. Expired before paying: start checks the processor first, the order is CANCELED, no new page.
  const s3 = await shop.order(PARENT.subject, { checkoutId: SINGLE, expectedVersion: 1, optionKey: 'lesson', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: MINA, answers: {} }] }, randomUUID());
  const [p3] = await onceOf(s3.orderId);
  await backdate(p3.id);
  const listed = (await shop.list(PARENT.subject)).orders.find((o) => o.orderId === s3.orderId);
  ok(listed.status === 'UNPAID', 'an OPEN order whose payment ran out shows UNPAID');
  const r3 = await shop.start(PARENT.subject, s3.orderId);
  ok(r3.payState === 'EXPIRED' && r3.url === null && r3.status === 'CANCELED' && (await onceOf(s3.orderId)).length === 1, 'expired: CANCELED, no new page');

  // 10. PROCESSING holds the place; cancel is refused while clearing.
  const s4 = await shop.order(PARENT.subject, { checkoutId: SINGLE, expectedVersion: 1, optionKey: 'lesson', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: JOON, answers: {} }] }, randomUUID());
  const [p4] = await onceOf(s4.orderId);
  stripe.settleOnce(p4.id, 'PROCESSING');
  ok((await shop.confirm(PARENT.subject, s4.orderId)).payState === 'PROCESSING', 'PROCESSING recorded');
  ok((await shop.start(PARENT.subject, s4.orderId)).url === null, 'start while clearing: no page');
  await refused(() => shop.cancel(PARENT.subject, s4.orderId), 409, 'SCHOOL_PAY_ONCE_IN_PROGRESS', 'no cancel while clearing');
  stripe.settleOnce(p4.id, 'FAILED');
  ok((await shop.confirm(PARENT.subject, s4.orderId)).order.status === 'CANCELED', 'FAILED: order CANCELED');

  // 11. A success for an order that is no longer OPEN (fixture bypass) is kept on the payment and flagged, nothing guessed.
  const s5 = await shop.order(PARENT.subject, { checkoutId: SINGLE, expectedVersion: 1, optionKey: 'lesson', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: MINA, answers: {} }] }, randomUUID());
  const [p5] = await onceOf(s5.orderId);
  await sql('BEGIN');
  await sql('ALTER TABLE hon.family_checkout_orders DISABLE TRIGGER family_checkout_orders_guard');
  await sql("UPDATE hon.family_checkout_orders SET status='CANCELED',settled_at=clock_timestamp(),version=version+1 WHERE id=$1", [s5.orderId]);
  await sql('ALTER TABLE hon.family_checkout_orders ENABLE TRIGGER family_checkout_orders_guard');
  await sql('COMMIT');
  stripe.settleOnce(p5.id, 'SUCCEEDED');
  ok((await shop.confirm(PARENT.subject, s5.orderId)).payState === 'SUCCEEDED' && (await orderRow(s5.orderId)).status === 'CANCELED', 'success recorded, order not changed');
  ok((await one("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='family_checkout.review_needed'", [p5.id])).n === 1
    && (await one("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='family_checkout.review_needed' AND actor_principal_id=$2", [p5.id, SVC])).n === 1, 'flagged for staff review');

  // 12. No hosted page here: nothing is sent to the processor; the order and payment are rolled back with nothing charged.
  const beginCalls = stripe.onceBeginCalls;
  await refused(() => noCard.order(PARENT.subject, { checkoutId: SINGLE, expectedVersion: 1, optionKey: 'lesson', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: MINA, answers: {} }] }, randomUUID()), 422, 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED', 'no hosted page here');
  ok(stripe.onceBeginCalls === beginCalls, 'nothing sent to the processor');

  // 13. Staff (F5): school_checkout.manage reads the school's orders with who, what and answers; others are refused.
  const scope = await db.resolveAuthorizedScope(MANAGER.subject, ids.school, 'school_checkout.manage');
  const context = (subject, s) => ({ ...s, principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', source: 'HUMAN_UI', externalSubject: subject });
  const staffList = await staffReads.orders(context(MANAGER.subject, scope));
  const paidRow = staffList.orders.find((o) => o.orderId === s1.orderId);
  ok(staffList.orders.length === (await none()) && paidRow.status === 'PAID' && paidRow.familyName === 'Park Family' && paidRow.participants.map((p) => p.name).join() === 'Mina Park,Joon Park'
    && paidRow.participants[0].answers.belt === 'Yellow' && paidRow.waiverAccepted && paidRow.addOnKeys.join() === 'patch,uniform' && paidRow.settledAt !== null, 'staff see the orders');
  ok(!LEAK.test(JSON.stringify(staffList)), 'staff read: no payment id, provider, account or email');
  await refused(() => staffReads.orders(context(CLERK.subject, { ...scope, principalId: CLERK.principal })), 403, null, 'without school_checkout.manage');

  // 14. Order guards and direct SQL.
  await rejectsSql(() => sql('UPDATE hon.family_checkout_orders SET amount_minor=1,version=version+1 WHERE id=$1', [s1.orderId]), /never changes/, 'a paid order never changes');
  await rejectsSql(() => sql('DELETE FROM hon.family_checkout_orders WHERE id=$1', [s1.orderId]), /never deleted/, 'orders are never deleted');
  await rejectsSql(() => sql('TRUNCATE hon.family_checkout_orders'), /./, 'no truncate');
  await rejectsSql(() => sql(`INSERT INTO hon.family_checkout_orders(organization_id,school_id,checkout_id,checkout_version,family_id,principal_id,option_key,participants,add_on_keys,title,amount_minor,currency,status,request_key,request_sha256,settled_at)
    VALUES($1,$2,$3,1,$4,$5,'week','[{}]','[]','x',100,'USD','PAID','k',repeat('a',64),clock_timestamp())`, [ids.organization, ids.school, CAMP, ids.family, PARENT.principal]), /OPEN, or PAID when free/, 'a paid order of money cannot be inserted');

  // 15. Rate limit: at most 20 orders per family per day.
  const made = await none();
  const family = (await one('SELECT count(*)::int n FROM hon.family_checkout_orders WHERE family_id=$1', [ids.family])).n;
  for (let i = family; i < 20; i += 1) {
    await shop.order(PARENT.subject, { checkoutId: OPEN_HOUSE, expectedVersion: 1, optionKey: 'free', waiverAccepted: false, addOns: [], participants: [{ studentProfileId: MINA, answers: {} }] }, randomUUID());
  }
  await refused(() => shop.order(PARENT.subject, { checkoutId: OPEN_HOUSE, expectedVersion: 1, optionKey: 'free', waiverAccepted: false, addOns: [],
    participants: [{ studentProfileId: MINA, answers: {} }] }, randomUUID()), 429, 'FAMILY_CHECKOUT_RATE_LIMITED', 'the 21st order of the day');
  ok(made > 0 && (await shop.list(PARENT.subject)).orders.length === 20, 'the family list shows its latest 20 orders');

  // 16. Runtime posture: four entry points; every helper internal; no table privilege; the 011 section.
  const entry = ['read_parent_checkout_pages(text)', 'open_parent_checkout_order(text,jsonb,text)', 'read_parent_checkout_order(text,uuid)', 'read_school_checkout_orders(text)'];
  const internal = ['guard_family_checkout_order()', 'family_checkout_scope(text,boolean)', 'family_checkout_children(uuid,uuid,uuid)', 'family_checkout_today(uuid)',
    'family_checkout_payment_live(uuid)', 'family_checkout_taken(uuid,text)', 'family_checkout_en(jsonb)', 'family_checkout_option_open(jsonb,date)',
    'family_checkout_page_json(hon.school_checkouts,date)', 'family_checkout_order_json(hon.family_checkout_orders)', 'settle_family_checkout_order()',
    'school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)'];
  for (const fn of entry) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === true, `runtime executes ${fn}`);
  for (const fn of internal) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === false, `runtime cannot execute ${fn}`);
  await assert.rejects(runtime.query('SELECT * FROM hon.family_checkout_orders LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.open_parent_checkout_order($1,'{}'::jsonb,'k')", [PARENT.subject]), /VALIDATION_FAILED/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [begin, end] of [['-- Family checkout orders exact verification (0582)', '-- End family checkout orders exact verification.'],
      ['-- School one-time payment exact verification (B-TUI-2 0529)', '-- End school one-time payment exact verification.']]) {
      const section = verify.split(begin)[1]?.split(end)[0];
      ok(section, begin);
      await sql(section.replace(/^[^\n]*\n(?:--[^\n]*\n)?/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  // 17. No SaaS payment attempt, no fee, Square untouched.
  ok((await one('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).n === 0, 'no SaaS payment attempt');
  ok([...stripe.onceSessions.values()].every((x) => !('applicationFee' in x)), 'no session carries an application fee');
  ok(square.onceBeginCalls === 0, 'Square untouched');

  console.log(`PASS: family checkout orders (0582): ${checks} checks.`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
