/**
 * Sign up and pay from a checkout page share link (0627): PublicSchoolCheckoutService (anyone with the link) and
 * SchoolCheckoutService.publicOrders (staff, school_checkout.manage) on the restricted runtime role -> protected definers,
 * SchoolPayOnceService (0529) with the in-process processor simulators, on the guarded disposable CRM-close fixture only.
 * No network, no credentials, synthetic data; nothing is charged or sent.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
const { PublicSchoolCheckoutService } = await load('school-checkout/public-school-checkout.js');
const { SchoolCheckoutService } = await load('school-checkout/school-checkout.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool'].map((key) => [key, randomUUID()]));
const PREFIX = `pco-${ids.organization.slice(0, 8)}`;
const sql = (text, values = []) => admin.query(text, values);
const one = (text, values = []) => sql(text, values).then((r) => r.rows[0]);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const SVC = '00000000-0000-4000-8000-000000000627';
process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';

const stripe = new SimulatedStripeConnectAdapter();
const square = new SimulatedSquareAdapter();
const db = new RuntimeDatabaseService();
const once = new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]));
const site = new PublicSchoolCheckoutService(db, once);
const noCard = new PublicSchoolCheckoutService(db, new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', new UnconfiguredSchoolPaymentAdapter('STRIPE_CONNECT')], ['SQUARE', square]])));
const staffReads = new SchoolCheckoutService(db);
// What a public answer must never carry: payment or processor references, the buyer's contact, internal ids of the payment.
const LEAK = /acct_sim|pi_sim|cs_sim|MLSIM|@example\.test|paymentId|providerCode|\+1555/;
const key = () => randomBytes(24).toString('base64url');

async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}
async function refused(run, status, label) {
  try { await run(); } catch (error) { assert.equal(error.getStatus?.(), status, `${label}: ${error.message}`); checks += 1; return; }
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0598 proof). Rate rows have no organization column: removed by page.
async function cleanup() {
  const orgs = [ids.organization, ids.otherOrganization];
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('DELETE FROM hon.public_checkout_rates WHERE checkout_id IN (SELECT id FROM hon.school_checkouts WHERE organization_id = ANY($1::uuid[]))', [orgs]);
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
async function staff(label, permissions) {
  const actor = await human(label), role = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [role, ids.organization, `PCO_${role.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, ids.organization, permission]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",
    [ids.organization, ids.school, actor.principal, role]);
  return actor;
}

const en = (text) => ({ en: text });
const option = (k, priceMinor, extra = {}) => ({ key: k, label: en(`Option ${k}`), description: null, planId: null, billing: 'ONE_TIME', priceMinor,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0,
  availableThrough: null, mostPopular: false, createsMembership: false, ...extra });
const monthly = (k) => ({ ...option(k, null), billing: 'MONTHLY', recurringMinor: 9900, installments: 0, collectionMethod: 'IN_HOUSE' });
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
    option('member', 1000, { planId: randomUUID(), createsMembership: true })],
  waiver: { text: en('I accept the camp rules.') }, receiptNote: null, thankYou: en('See you at camp!'),
};
const FREE = { ...CONTENT, title: en('Open house'), multiParticipant: { enabled: false, maxPerOrder: 1 }, customFields: [], addOns: [], options: [option('free', 0)], waiver: null, thankYou: null };
let MANAGER, CLERK, CAMP, OPEN_HOUSE, FOREIGN_PAGE;
const link = {};
async function checkoutPage(slug, content, { school = ids.school, org = ids.organization } = {}) {
  const id = (await one(`INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'events','PUBLISHED',$4,$5,$5) RETURNING id`, [org, school, slug, JSON.stringify(content), MANAGER.principal])).id;
  link[id] = (await one('INSERT INTO hon.school_checkout_links(checkout_id,organization_id,school_id,issued_by_principal_id) VALUES($1,$2,$3,$4) RETURNING public_id',
    [id, org, school, MANAGER.principal])).public_id;
  return id;
}
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PCO Org','PCO Org'),($2,'PCO Other Org','PCO Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.school, ids.organization, 's'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `PCO ${slug}`, `pco-${slug}-${school.slice(0, 8)}`]);
  }
  MANAGER = await staff('manager', ['school_checkout.manage']);
  CLERK = await staff('clerk', ['people.read']);
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_connections DISABLE TRIGGER USER');
  for (const [org, school, ref] of [[ids.organization, ids.school, 'acct_simP1'], [ids.otherOrganization, ids.otherSchool, 'acct_simP2']]) {
    await sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,charges_enabled,payouts_enabled,capabilities,is_default,started_by_principal_id)
      VALUES($1,$2,'STRIPE_CONNECT','CONNECTED_ACTIVE',$3,true,true,'{"oneTimeCard":true,"storedCard":true,"bankDebit":false,"offSessionRecurring":true,"refunds":true}'::jsonb,true,$4)`,
      [org, school, ref, MANAGER.principal]);
  }
  await sql('ALTER TABLE hon.school_pay_connections ENABLE TRIGGER USER');
  await sql('COMMIT');
  CAMP = await checkoutPage('summer-camp', CONTENT);
  OPEN_HOUSE = await checkoutPage('open-house', FREE);
  FOREIGN_PAGE = await checkoutPage('foreign-camp', CONTENT, { school: ids.otherSchool, org: ids.otherOrganization });
}

const answers = (size = 'M', extra = {}) => ({ size, photo: true, ...extra });
const order = (extra = {}) => ({ expectedVersion: 1, optionKey: 'week', waiverAccepted: true, addOns: ['patch', 'uniform'], website: '',
  buyer: { name: 'Dana Rivera', email: 'Dana@Example.test', mobile: '+15550100' },
  participants: [{ name: 'Mina Rivera', answers: answers('M', { belt: 'Yellow' }) }, { name: 'Joon Rivera', answers: answers('S') }], ...extra });
const onceOf = (id) => sql("SELECT * FROM hon.school_pay_once WHERE source='CHECKOUT_PAGE' AND source_id=$1 ORDER BY created_at", [id]).then((r) => r.rows);
const orderRow = (id) => one('SELECT * FROM hon.public_checkout_orders WHERE id=$1', [id]);
const count = async () => (await one('SELECT count(*)::int n FROM hon.public_checkout_orders WHERE organization_id=$1', [ids.organization])).n;
const payments = async () => (await one('SELECT count(*)::int n FROM hon.school_pay_once WHERE organization_id=$1', [ids.organization])).n;
const clean = (value, label) => ok(!LEAK.test(JSON.stringify({ ...value, url: undefined })), `${label}: no payment id, provider, account or contact`);
async function backdate(paymentId) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_once DISABLE TRIGGER school_pay_once_guard');
  await sql("UPDATE hon.school_pay_once SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours',provider_expires_at=provider_expires_at-interval '2 hours' WHERE id=$1", [paymentId]);
  await sql('ALTER TABLE hon.school_pay_once ENABLE TRIGGER school_pay_once_guard');
  await sql('COMMIT');
}

try {
  await cleanup();
  await seed();

  // 1. The page read carries the sign-up form: version, questions, add-on keys, waiver, thank-you; and whether a card can be taken.
  const page = await site.page(link[CAMP]);
  ok(page.version === 1 && page.questions.map((q) => q.key).join() === 'size,belt,photo' && page.questions[1].options.map((x) => x.en).join() === 'White,Yellow'
    && page.addOns.map((a) => a.key).join() === 'uniform,patch' && page.waiver.en === 'I accept the camp rules.' && page.hasWaiver && page.thankYou.en === 'See you at camp!', 'form fields');
  ok(page.canPay === true && page.testMode === true, 'a Stripe test-mode school can take a card on a hosted page');
  ok(page.options.find((o) => o.key === 'week').inFamilyApp && !page.options.find((o) => o.key === 'monthly').inFamilyApp
    && !page.options.find((o) => o.key === 'member').inFamilyApp, 'only one-time options without a plan can be signed up for online');
  clean(page, 'page');
  ok((await noCard.page(link[CAMP])).canPay === false, 'processor not configured: no card offered');

  // 2. Refusals before any order or payment is written (P1, P2, P3).
  const before = [await count(), await payments()];
  const refusals = [
    [{ key: 'short', order: order() }, 'INVALID', 'a short key'],
    [{ key: key(), order: order(), extra: 1 }, 'INVALID', 'an unknown body field'],
    [{ key: key(), order: order({ website: 'http://spam' }) }, 'INVALID', 'the hidden website field filled'],
    [{ key: key(), order: order({ buyer: { name: 'Dana', email: 'not-an-email', mobile: '' } }) }, 'INVALID', 'a bad email'],
    [{ key: key(), order: order({ buyer: { name: 'Dana', email: 'dana@example.test', mobile: '555' } }) }, 'INVALID', 'a bad mobile'],
    [{ key: key(), order: order({ buyer: { name: '=HYPERLINK()', email: 'dana@example.test', mobile: '' } }) }, 'INVALID', 'a formula name'],
    [{ key: key(), order: order({ optionKey: 'monthly' }) }, 'OPTION_UNAVAILABLE', 'a monthly option'],
    [{ key: key(), order: order({ optionKey: 'member' }) }, 'OPTION_UNAVAILABLE', 'an option that creates a membership'],
    [{ key: key(), order: order({ optionKey: 'nope' }) }, 'OPTION_UNAVAILABLE', 'an unknown option'],
    [{ key: key(), order: order({ expectedVersion: 2 }) }, 'CHANGED', 'a stale page version'],
    [{ key: key(), order: order({ waiverAccepted: false }) }, 'WAIVER_REQUIRED', 'the waiver not accepted'],
    [{ key: key(), order: order({ addOns: ['uniform'] }) }, 'INVALID', 'a required add-on left out'],
    [{ key: key(), order: order({ addOns: ['patch', 'cape'] }) }, 'INVALID', 'an unknown add-on'],
    [{ key: key(), order: order({ participants: [{ name: 'Mina', answers: { photo: true } }] }) }, 'INVALID', 'a required answer missing'],
    [{ key: key(), order: order({ participants: [{ name: 'Mina', answers: answers('M', { belt: 'Purple' }) }] }) }, 'INVALID', 'a choice not on the page'],
    [{ key: key(), order: order({ participants: [{ name: 'Mina', answers: answers('M', { extra: 'x' }) }] }) }, 'INVALID', 'an answer to no question'],
    [{ key: key(), order: order({ participants: ['A', 'B', 'C', 'D'].map((n) => ({ name: n, answers: answers() })) }) }, 'INVALID', 'more participants than the page allows'],
  ];
  for (const [value, result, label] of refusals) {
    const r = await site.order(link[CAMP], value);
    ok(r.result === result && r.order === null && r.payState === 'NONE' && r.url === null, `${label}: ${result} (got ${r.result})`);
  }
  ok((await site.order('f'.repeat(48), { key: key(), order: order() })).result === 'INVALID', 'an unknown link');
  ok((await noCard.order(link[CAMP], { key: key(), order: order() })).result === 'NOT_AVAILABLE', 'no hosted page here: a priced order is refused');
  ok((await count()) === before[0] && (await payments()) === before[1], 'no order or payment was written for any refusal');

  // 3. An order: priced by the page, its hosted payment opened for exactly that amount, valid 30 minutes, the buyer's email to the processor only.
  const k1 = key();
  const o1 = await site.order(link[CAMP], { key: k1, order: order() });
  ok(o1.result === 'ORDER' && o1.payState === 'OPEN' && /^https:\/\//.test(o1.url) && o1.expiresAt !== null, 'ordered: a hosted page to pay on');
  ok(o1.order.amountMinor === 5000 + 3000 + 2500 + 500 && o1.order.status === 'OPEN' && o1.order.participantCount === 2 && o1.order.title === 'Summer camp - Option week', 'total from the page');
  clean(o1, 'order outcome');
  const row1 = await orderRow(o1.order.orderId);
  ok(row1.email === 'dana@example.test' && row1.mobile === '+15550100' && row1.buyer_name === 'Dana Rivera' && row1.participants[0].name === 'Mina Rivera'
    && row1.participants[0].answers.belt === 'Yellow' && row1.add_on_keys.join() === 'patch,uniform' && row1.waiver_sha256?.length === 64 && row1.key_hash !== k1, 'stored as typed; only the key hash kept');
  const [p1] = await onceOf(o1.order.orderId);
  ok(p1.amount_minor === '11000' && p1.payer_email === 'dana@example.test' && p1.state === 'OPEN' && p1.source === 'CHECKOUT_PAGE'
    && new Date(p1.expires_at) - new Date(p1.created_at) <= 30 * 60 * 1000 + 1000, 'one payment for the total, payer email kept on the payment');
  ok((await one("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='public_checkout.order_open' AND actor_principal_id=$2 AND source='PUBLIC_API'", [o1.order.orderId, SVC])).n === 1,
    'audited by the code-owned intake');
  ok(!JSON.stringify((await one("SELECT next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='public_checkout.order_open'", [o1.order.orderId])).next_state).includes('example.test'), 'no contact in the audit row');

  // 4. Idempotency: an exact repeat returns the same order and page; another order under the same key is refused.
  const again = await site.order(link[CAMP], { key: k1, order: order() });
  ok(again.order.orderId === o1.order.orderId && again.url === o1.url && (await onceOf(o1.order.orderId)).length === 1, 'exact repeat: same order, same page');
  ok((await site.order(link[CAMP], { key: k1, order: order({ optionKey: 'day' }) })).result === 'INVALID', 'another order under the same key: INVALID');
  ok((await site.start(link[CAMP], { key: k1 })).url === o1.url, 'pay again: same page');

  // 4b. A suspended school, organization or entitlement: the open order is still answered (to check or cancel it), but no
  // processor page is handed out and no new order is taken.
  for (const [label, table, column, id] of [['suspended school', 'schools', 'id', ids.school], ['suspended organization', 'organizations', 'id', ids.organization],
    ['suspended entitlement', 'organization_entitlements', 'organization_id', ids.organization]]) {
    await sql(`UPDATE hon.${table} SET status='SUSPENDED' WHERE ${column}=$1`, [id]);
    const held = await site.start(link[CAMP], { key: k1 });
    ok(held.result === 'ORDER' && held.order.orderId === o1.order.orderId && held.payState === 'OPEN' && held.url === null && held.expiresAt === null,
      `${label}: the open order is answered with no page to pay on`);
    ok((await site.status(link[CAMP], { key: k1 })).order.orderId === o1.order.orderId, `${label}: the order can still be checked`);
    ok((await site.order(link[CAMP], { key: key(), order: order() })).result === 'INVALID', `${label}: no new orders`);
    await sql(`UPDATE hon.${table} SET status='ACTIVE' WHERE ${column}=$1`, [id]);
  }
  ok((await site.start(link[CAMP], { key: k1 })).url === o1.url, 'active again: the same page to pay on');

  // 5. Places: the open order holds 2 of 3; a second order for 2 is FULL; the page shows 1 left.
  ok((await site.page(link[CAMP])).options.find((o) => o.key === 'week').placesLeft === 1, 'one place left');
  ok((await site.order(link[CAMP], { key: key(), order: order({ buyer: { name: 'Sam Lee', email: 'sam@example.test', mobile: '' } }) })).result === 'FULL', 'not enough places');

  // 6. Status: not paid yet, then paid at the processor; the database marks the order PAID once.
  ok((await site.status(link[CAMP], { key: k1 })).payState === 'OPEN', 'not paid yet');
  stripe.settleOnce(p1.id, 'SUCCEEDED');
  const s1 = await site.status(link[CAMP], { key: k1 });
  ok(s1.payState === 'SUCCEEDED' && s1.order.status === 'PAID' && s1.url === null, 'paid');
  clean(s1, 'status outcome');
  ok((await one("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='public_checkout.order_paid' AND actor_principal_id=$2", [o1.order.orderId, SVC])).n === 1
    && (await one("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='public_checkout.order_paid'", [o1.order.orderId])).n === 1, 'paid once by the code-owned recorder');
  ok((await one("SELECT count(*)::int n FROM hon.audit_events WHERE (entity_id=$1 OR entity_id=$2) AND action_code LIKE 'family_checkout.%'", [o1.order.orderId, p1.id])).n === 0, 'the family order trigger left it alone');
  ok((await site.status(link[CAMP], { key: k1 })).order.status === 'PAID' && (await orderRow(o1.order.orderId)).version === 2, 'status again: nothing new');
  ok((await site.cancel(link[CAMP], { key: k1 })).order.status === 'PAID', 'cancel after paying: still paid');

  // 7. Cancel before paying: the processor closes the page and the order is CANCELED, freeing its place.
  const k2 = key();
  const o2 = await site.order(link[CAMP], { key: k2, order: order({ participants: [{ name: 'Ari Cho', answers: answers() }], buyer: { name: 'Ari Cho', email: 'ari@example.test', mobile: '' } }) });
  ok(o2.result === 'ORDER' && (await site.page(link[CAMP])).options.find((o) => o.key === 'week').placesLeft === 0, 'the last place is held');
  const c2 = await site.cancel(link[CAMP], { key: k2 });
  ok(c2.payState === 'CANCELED' && c2.order.status === 'CANCELED', 'canceled');
  ok((await site.page(link[CAMP])).options.find((o) => o.key === 'week').placesLeft === 1, 'its place is free again');

  // 8. Expiry: a payment left past its time is expired at the processor on the next status check, and the order ends.
  const k3 = key();
  const o3 = await site.order(link[CAMP], { key: k3, order: order({ optionKey: 'day', addOns: ['patch'], buyer: { name: 'Bo Kim', email: 'bo@example.test', mobile: '' } }) });
  ok(o3.order.amountMinor === 2000 + 2000 + 500, 'no extra-participant fee set: the full price for each');
  const [p3] = await onceOf(o3.order.orderId);
  await backdate(p3.id);
  const s3 = await site.status(link[CAMP], { key: k3 });
  ok(s3.payState === 'EXPIRED' && s3.order.status === 'CANCELED', 'expired: order canceled, nothing charged');

  // 9. A free order is PAID at once, with no payment and no processor call.
  const calls = stripe.onceBeginCalls;
  const free = await site.order(link[OPEN_HOUSE], { key: key(), order: { ...order(), optionKey: 'free', addOns: [], waiverAccepted: false, participants: [{ name: 'Mina Rivera', answers: {} }] } });
  ok(free.result === 'ORDER' && free.order.status === 'PAID' && free.payState === 'NONE' && free.url === null && (await onceOf(free.order.orderId)).length === 0
    && stripe.onceBeginCalls === calls, 'free: PAID, no payment');

  // 10. A key only reaches its own order, through its own link (P3).
  ok((await site.status(link[CAMP], { key: key() })).result === 'NOT_FOUND', 'an unknown key');
  ok((await site.status(link[FOREIGN_PAGE], { key: k1 })).result === 'NOT_FOUND', 'the key on another school\'s link');
  ok((await site.status(link[OPEN_HOUSE], { key: k1 })).result === 'NOT_FOUND', 'the key on another page\'s link');
  ok((await site.status(link[CAMP], { key: k1, orderId: o1.order.orderId })).result === 'INVALID', 'no order or payment id is accepted');
  ok((await site.start(link[CAMP], { key: 'short' })).result === 'INVALID', 'a short key');

  // 11. A page taken down: no new orders, but an earlier order can still be checked through its link.
  await sql("UPDATE hon.school_checkouts SET status='ARCHIVED',version=version+1 WHERE id=$1", [CAMP]);
  ok((await site.page(link[CAMP])) === null, 'the page no longer opens');
  ok((await site.order(link[CAMP], { key: key(), order: order({ expectedVersion: 2 }) })).result === 'INVALID', 'no new orders');
  ok((await site.status(link[CAMP], { key: k1 })).order.status === 'PAID', 'an earlier order is still reachable');
  await sql("UPDATE hon.school_checkouts SET status='PUBLISHED',version=version+1 WHERE id=$1", [CAMP]);

  // 12. At most 5 orders per email per page per hour.
  const freeOrder = (email) => ({ key: key(), order: { ...order(), optionKey: 'free', addOns: [], waiverAccepted: false, buyer: { name: 'Rae Park', email, mobile: '' },
    participants: [{ name: 'Rae Park', answers: {} }] } });
  for (let i = 0; i < 5; i += 1) ok((await site.order(link[OPEN_HOUSE], freeOrder('rae@example.test'))).result === 'ORDER', `order ${i + 1} for one email`);
  ok((await site.order(link[OPEN_HOUSE], freeOrder('RAE@example.test'))).result === 'RATE_LIMITED', 'the 6th for the same email (any case)');
  ok((await site.order(link[OPEN_HOUSE], freeOrder('other@example.test'))).result === 'ORDER', 'another email still can');

  // 12b. Page counters never lock a buyer out of their own order: a known key is always answered and a replay is not counted.
  const mine = freeOrder('lee@example.test');
  ok((await site.order(link[OPEN_HOUSE], mine)).result === 'ORDER', 'a buyer places an order');
  const house = (await one("SELECT checkout_id FROM hon.school_checkout_links WHERE public_id=$1", [link[OPEN_HOUSE]])).checkout_id;
  const exhaust = (bucket, n) => sql(`INSERT INTO hon.public_checkout_rates(checkout_id,bucket,window_start,attempts) VALUES($1,$2,clock_timestamp(),$3)
    ON CONFLICT(checkout_id,bucket) DO UPDATE SET window_start=clock_timestamp(),attempts=$3`, [house, bucket, n]);
  await exhaust('LOOKUP_ATTEMPTS', 1200);
  ok((await site.status(link[OPEN_HOUSE], { key: key() })).result === 'RATE_LIMITED', 'unknown keys run out of lookups');
  ok((await site.status(link[OPEN_HOUSE], { key: mine.key })).result === 'ORDER', 'the buyer\'s own key still finds the order');
  ok((await site.start(link[OPEN_HOUSE], { key: mine.key })).result === 'ORDER', 'and pay still answers');
  ok((await one("SELECT attempts FROM hon.public_checkout_rates WHERE checkout_id=$1 AND bucket='LOOKUP_ATTEMPTS'", [house])).attempts === 1201, 'only the miss was counted');
  await exhaust('ORDER_ATTEMPTS', 300);
  ok((await site.order(link[OPEN_HOUSE], freeOrder('new@example.test'))).result === 'RATE_LIMITED', 'new orders run out of attempts');
  ok((await site.order(link[OPEN_HOUSE], mine)).result === 'ORDER', 'the same key and order still replays');
  ok((await site.order(link[OPEN_HOUSE], { key: key(), order: { ...mine.order, website: 'x' } })).result === 'INVALID', 'a malformed order is refused, not counted');
  ok((await one("SELECT attempts FROM hon.public_checkout_rates WHERE checkout_id=$1 AND bucket='ORDER_ATTEMPTS'", [house])).attempts === 301, 'only the new order was counted');
  await sql('DELETE FROM hon.public_checkout_rates WHERE checkout_id=$1', [house]);

  // 13. Staff (P7): school_checkout.manage reads the link orders with buyer, participants and answers; others are refused.
  const scope = await db.resolveAuthorizedScope(MANAGER.subject, ids.school, 'school_checkout.manage');
  const context = (subject, s) => ({ ...s, principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', source: 'HUMAN_UI', externalSubject: subject });
  const list = await staffReads.publicOrders(context(MANAGER.subject, scope));
  const paid = list.orders.find((o) => o.orderId === o1.order.orderId);
  ok(list.orders.length === (await count()) && paid.status === 'PAID' && paid.buyer.email === 'dana@example.test' && paid.buyer.mobile === '+15550100'
    && paid.participants.map((p) => p.name).join() === 'Mina Rivera,Joon Rivera' && paid.participants[0].answers.belt === 'Yellow' && paid.waiverAccepted && paid.settledAt !== null, 'staff see the link orders');
  ok(list.orders.find((o) => o.orderId === o3.order.orderId).status === 'CANCELED', 'staff see the expired order canceled');
  ok(!/acct_sim|pi_sim|cs_sim|paymentId|providerCode/.test(JSON.stringify(list)), 'staff read: no payment or processor reference');
  await refused(() => staffReads.publicOrders(context(CLERK.subject, { ...scope, principalId: CLERK.principal })), 403, 'without school_checkout.manage');
  const otherScope = { ...scope, organizationId: ids.otherOrganization, schoolId: ids.otherSchool };
  await refused(() => staffReads.publicOrders(context(MANAGER.subject, otherScope)), 403, 'another school');

  // 14. Order guards and direct SQL.
  await rejectsSql(() => sql('UPDATE hon.public_checkout_orders SET amount_minor=1,version=version+1 WHERE id=$1', [o1.order.orderId]), /never changes/, 'a paid order never changes');
  await rejectsSql(() => sql("UPDATE hon.public_checkout_orders SET email='x@example.test' WHERE id=$1", [o2.order.orderId]), /never changes/, 'the buyer never changes');
  await rejectsSql(() => sql('DELETE FROM hon.public_checkout_orders WHERE id=$1', [o1.order.orderId]), /never deleted/, 'orders are never deleted');
  await rejectsSql(() => sql('TRUNCATE hon.public_checkout_orders'), /./, 'no truncate');
  await rejectsSql(() => sql(`INSERT INTO hon.public_checkout_orders(organization_id,school_id,checkout_id,checkout_version,option_key,buyer_name,email,participants,add_on_keys,title,amount_minor,currency,status,key_hash,payload_hash,settled_at)
    VALUES($1,$2,$3,1,'week','X','x@example.test','[{"name":"X","answers":{}}]','[]','T',100,'USD','PAID',repeat('a',64),repeat('b',64),clock_timestamp())`, [ids.organization, ids.school, CAMP]), /OPEN, or PAID when free/, 'a priced order cannot start PAID');
  await rejectsSql(() => sql(`INSERT INTO hon.public_checkout_orders(organization_id,school_id,checkout_id,checkout_version,option_key,buyer_name,email,participants,add_on_keys,title,amount_minor,currency,key_hash,payload_hash)
    VALUES($1,$2,$3,1,'week','X','x@example.test','[{"name":"X","answers":{}}]','[]','T',100,'USD',repeat('a',64),repeat('b',64))`, [ids.organization, ids.school, FOREIGN_PAGE]), /./, 'a page of another school');

  // 15. Runtime posture: three new entry points plus the page read; every helper internal; no table privilege; the 011 sections.
  const entry = ['open_public_checkout_order(text,jsonb,text,boolean)', 'read_public_checkout_order(text,text)', 'read_school_public_checkout_orders(text)', 'read_public_school_checkout(text)'];
  const internal = ['guard_public_checkout_order()', 'take_public_checkout_rate(uuid,text,integer)', 'public_checkout_intake_ok()', 'public_checkout_order_for(uuid,text)',
    'public_checkout_order_json(hon.public_checkout_orders)', 'settle_public_checkout_order()', 'family_checkout_taken(uuid,text)',
    'school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)'];
  for (const fn of entry) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === true, `runtime executes ${fn}`);
  for (const fn of internal) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === false, `runtime cannot execute ${fn}`);
  await assert.rejects(runtime.query('SELECT * FROM hon.public_checkout_orders LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT * FROM hon.public_checkout_rates LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.read_school_public_checkout_orders('nobody')"), /./); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [begin, end] of [['-- Public checkout orders exact verification (0627)', '-- End public checkout orders exact verification.'],
      ['-- Checkout page share links exact verification (0620)', '-- End checkout page share links exact verification.'],
      ['-- Family checkout orders exact verification (0598)', '-- End family checkout orders exact verification.'],
      ['-- School one-time payment exact verification (B-TUI-2 0529)', '-- End school one-time payment exact verification.']]) {
      const section = verify.split(begin)[1]?.split(end)[0];
      ok(section, begin);
      await sql(section.replace(/^[^\n]*\n(?:--[^\n]*\n)*/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  // 16. No SaaS payment attempt, no fee, Square untouched.
  ok((await one('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).n === 0, 'no SaaS payment attempt');
  ok([...stripe.onceSessions.values()].every((x) => !('applicationFee' in x)), 'no session carries an application fee');
  ok(square.onceBeginCalls === 0, 'Square untouched');

  console.log(`PASS: public checkout orders (0627): ${checks} checks.`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
