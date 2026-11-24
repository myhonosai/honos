/**
 * Parent invoice payment proof (0530): ParentInvoicePayService -> the three fixed parent calls on the restricted runtime
 * role -> protected definers, and SchoolPayOnceService (0529) with the in-process processor simulators, on the guarded
 * disposable CRM-close fixture only. No network, no credentials, synthetic data, TEST mode only; HON takes no fee.
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
const { ParentInvoicePayService } = await load('parent-pay/parent-invoice-pay.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'squareSchool', 'otherSchool', 'family', 'otherFamily', 'squareFamily', 'foreignFamily']
  .map((key) => [key, randomUUID()]));
const PREFIX = `ppay-${ids.organization.slice(0, 8)}`;
const sql = (text, values = []) => admin.query(text, values);
const one = (text, values = []) => sql(text, values).then((r) => r.rows[0]);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const SVC = '00000000-0000-4000-8000-000000000530';
process.env.HON_PUBLIC_ORIGIN = 'https://app.example.test';

const stripe = new SimulatedStripeConnectAdapter();
const square = new SimulatedSquareAdapter();
const db = new RuntimeDatabaseService();
const once = new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]));
const pay = new ParentInvoicePayService(db, once);
const noCard = new ParentInvoicePayService(db, new SchoolPayOnceService(db, new Map([['STRIPE_CONNECT', new UnconfiguredSchoolPaymentAdapter('STRIPE_CONNECT')], ['SQUARE', square]])));
const LEAK = /acct_sim|pi_sim|MLSIM|@example\.test|paymentId|providerCode/;

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

// Disposable-fixture cleanup only (as in the 0258, 0321, 0337 and 0529 proofs).
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
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

let STARTER;
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
async function member(family, school, org, given, role, billingContact = false) {
  const id = (await one("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Park') RETURNING id", [org, school, given])).id;
  await sql('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,$5,$6)', [org, school, family, id, role, billingContact]);
  return id;
}
/** One family with a guardian billing contact and a child, and `n` invoices on the child's membership. */
async function household(family, school, org, child) {
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Park Family')", [family, org, school]);
  const guardian = await member(family, school, org, 'Jin', 'GUARDIAN', true);
  const student = await member(family, school, org, child, 'STUDENT');
  const account = (await one("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id", [org, school, guardian])).id;
  await sql('BEGIN');
  await sql('ALTER TABLE hon.memberships DISABLE TRIGGER membership_state_transition_guard');
  const membership = (await one(`INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at)
    VALUES($1,$2,$3,$4,'MONTHLY','ACTIVE',clock_timestamp()-interval '30 days') RETURNING id`, [org, school, account, student])).id;
  await sql('ALTER TABLE hon.memberships ENABLE TRIGGER membership_state_transition_guard');
  await sql('COMMIT');
  return { account, membership };
}
async function invoice(h, school, org, total, status = 'ISSUED') {
  return (await one(`INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,total_minor,due_at)
    VALUES($1,$2,$3,$4,$5,'USD',$6,$6,clock_timestamp()+interval '5 days') RETURNING id`, [org, school, h.account, h.membership, status, total])).id;
}
const manual = (inv, amount, school = ids.school, org = ids.organization) => sql(`INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
  VALUES($1,$2,$3,$4,'USD',current_date,'CASH',$5) RETURNING id`, [org, school, inv, amount, STARTER]);
const invoiceRow = (id) => one('SELECT * FROM hon.invoices WHERE id=$1', [id]);
const onceOf = (inv) => sql("SELECT * FROM hon.school_pay_once WHERE source='FAMILY_INVOICE' AND source_id=$1 ORDER BY created_at", [inv]).then((r) => r.rows);
const sessionOf = (paymentId) => [...stripe.onceSessions.values()].find((s) => s.paymentId === paymentId);
async function backdate(paymentId) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_once DISABLE TRIGGER school_pay_once_guard');
  await sql("UPDATE hon.school_pay_once SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours',provider_expires_at=provider_expires_at-interval '2 hours' WHERE id=$1", [paymentId]);
  await sql('ALTER TABLE hon.school_pay_once ENABLE TRIGGER school_pay_once_guard');
  await sql('COMMIT');
}
const clean = (value, label) => ok(!LEAK.test(JSON.stringify(value)), `${label}: no payment id, provider, account or email`);

let PARENT, VIEWER, OTHER, SQUARE_PARENT, NOBODY, H, HO, HS, HF;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PPay Org','PPay Org'),($2,'PPay Other Org','PPay Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.school, ids.organization, 's'], [ids.squareSchool, ids.organization, 'q'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `PPay ${slug}`, `ppay-${slug}-${school.slice(0, 8)}`]);
  }
  STARTER = (await human('staff')).principal;
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_connections DISABLE TRIGGER USER');
  for (const [org, school, provider, ref] of [[ids.organization, ids.school, 'STRIPE_CONNECT', 'acct_simP1'], [ids.organization, ids.squareSchool, 'SQUARE', 'MLSIMP1'],
    [ids.otherOrganization, ids.otherSchool, 'STRIPE_CONNECT', 'acct_simP2']]) {
    await sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,charges_enabled,payouts_enabled,capabilities,is_default,started_by_principal_id)
      VALUES($1,$2,$3,'CONNECTED_ACTIVE',$4,true,true,'{"oneTimeCard":true,"storedCard":true,"bankDebit":false,"offSessionRecurring":true,"refunds":true}'::jsonb,true,$5)`,
      [org, school, provider, ref, STARTER]);
  }
  await sql('ALTER TABLE hon.school_pay_connections ENABLE TRIGGER USER');
  await sql('COMMIT');
  H = await household(ids.family, ids.school, ids.organization, 'Mina');
  HO = await household(ids.otherFamily, ids.school, ids.organization, 'Otherkid');
  HS = await household(ids.squareFamily, ids.squareSchool, ids.organization, 'Sqkid');
  HF = await household(ids.foreignFamily, ids.otherSchool, ids.otherOrganization, 'Foreign');
  PARENT = await human('parent'); VIEWER = await human('viewer'); OTHER = await human('other'); SQUARE_PARENT = await human('square'); NOBODY = await human('nobody');
  await grant(PARENT, ids.family, ids.school, ids.organization);
  await grant(VIEWER, ids.family, ids.school, ids.organization, 'VIEWER');
  await grant(OTHER, ids.otherFamily, ids.school, ids.organization);
  await grant(SQUARE_PARENT, ids.squareFamily, ids.squareSchool, ids.organization);
}

try {
  await cleanup();
  await seed();
  const inv1 = await invoice(H, ids.school, ids.organization, 12000);
  const draft = await invoice(H, ids.school, ids.organization, 5000, 'DRAFT');
  const otherInv = await invoice(HO, ids.school, ids.organization, 9000);
  const foreignInv = await invoice(HF, ids.otherSchool, ids.otherOrganization, 7000);

  // 1. The list: only the guardian's own family's ISSUED invoices, the open balance, and whether card payment is offered.
  await manual(inv1, 2000);
  const list = await pay.list(PARENT.subject);
  ok(list.canPay === true && list.testMode === true, 'Stripe school: card payment offered, test mode');
  ok(list.invoices.length === 1 && list.invoices[0].invoiceId === inv1, 'only the own family ISSUED invoice (no DRAFT, no other family)');
  const row1 = list.invoices[0];
  ok(row1.totalMinor === 12000 && row1.balanceMinor === 10000 && row1.payState === 'NONE' && row1.payable && row1.childName === 'Mina Park' && row1.currency === 'USD', 'balance after a partial manual payment');
  clean(list, 'list');
  ok(!(await pay.list(OTHER.subject)).invoices.some((x) => x.invoiceId === inv1), 'another family never sees it');
  ok((await noCard.list(PARENT.subject)).canPay === false && (await noCard.list(PARENT.subject)).invoices.every((x) => !x.payable), 'processor not configured here: nothing payable');
  await refused(() => pay.list(VIEWER.subject), 403, 'PARENT_INVOICE_PAY_FORBIDDEN', 'a VIEWER grant cannot pay');
  await refused(() => pay.list(NOBODY.subject), 403, 'PARENT_INVOICE_PAY_FORBIDDEN', 'no family grant');
  ok(draft && (await onceOf(draft)).length === 0, 'nothing opened by a read');

  // 2. Foreign or unknown invoices are refused before any payment is read or opened (the 0529 caller rule).
  for (const [label, id] of [['another family', otherInv], ['another organization', foreignInv], ['unknown', randomUUID()]]) {
    await refused(() => pay.start(PARENT.subject, id), 404, 'PARENT_INVOICE_PAY_NOT_FOUND', `start: ${label}`);
    await refused(() => pay.confirm(PARENT.subject, id), 404, 'PARENT_INVOICE_PAY_NOT_FOUND', `confirm: ${label}`);
    await refused(() => pay.cancel(PARENT.subject, id), 404, 'PARENT_INVOICE_PAY_NOT_FOUND', `cancel: ${label}`);
  }
  ok((await onceOf(otherInv)).length === 0 && (await onceOf(foreignInv)).length === 0, 'no payment opened for a foreign invoice');
  await refused(() => pay.start(PARENT.subject, 'not-a-uuid'), 400, 'VALIDATION_FAILED', 'bad invoice id');
  await refused(() => pay.start(VIEWER.subject, inv1), 403, 'PARENT_INVOICE_PAY_FORBIDDEN', 'VIEWER cannot start');
  await refused(() => pay.start(PARENT.subject, draft), 409, 'PARENT_INVOICE_PAY_NOT_PAYABLE', 'a DRAFT invoice cannot be paid');
  ok((await pay.confirm(PARENT.subject, inv1)).state === 'NONE', 'confirm before any payment: NONE');

  // 3. Start: one hosted page for exactly the open balance; a second press gets the same page back.
  const s1 = await pay.start(PARENT.subject, inv1);
  ok(s1.state === 'OPEN' && s1.url.startsWith('https://') && s1.amountMinor === 10000 && s1.currency === 'USD', 'hosted page for the balance');
  ok(!LEAK.test(JSON.stringify({ ...s1, url: undefined })), 'start result: no payment id, provider, account or email');
  const [p1] = await onceOf(inv1);
  ok(p1.amount_minor === '10000' && p1.surface === 'HOSTED' && p1.return_url === 'https://app.example.test/parent/payment-return' && p1.payer_email === null, 'payment row: balance, hosted, fixed return page, no email');
  ok(/^Tuition invoice due \d{4}-\d{2}-\d{2}$/.test(p1.label), 'label names no child');
  const s1b = await pay.start(PARENT.subject, inv1);
  ok(s1b.url === s1.url && (await onceOf(inv1)).length === 1, 'second press: same page, one payment');
  ok((await pay.list(PARENT.subject)).invoices[0].payState === 'OPEN', 'list shows the open payment');

  // 4. While it may be paid: no manual payment, no status but PAID (P4).
  await rejectsSql(() => manual(inv1, 10000), /PARENT_INVOICE_PAY_IN_PROGRESS/, 'manual payment while the page is open');
  ok((await pay.confirm(PARENT.subject, inv1)).state === 'OPEN', 'not paid yet: OPEN');

  // 5. Paid at the processor: confirm records SUCCEEDED and the database pays the invoice once (P3).
  stripe.settleOnce(p1.id, 'SUCCEEDED');
  const c1 = await pay.confirm(PARENT.subject, inv1);
  ok(c1.state === 'SUCCEEDED', 'confirm: SUCCEEDED');
  clean(c1, 'confirm result');
  const i1 = await invoiceRow(inv1);
  ok(i1.status === 'PAID', 'invoice PAID');
  const recs = (await sql("SELECT * FROM hon.invoice_payment_records WHERE invoice_id=$1 AND method='PROVIDER'", [inv1])).rows;
  ok(recs.length === 1 && recs[0].amount_minor === 10000 && recs[0].reference.startsWith('pi_sim') && recs[0].actor_principal_id === SVC, 'one PROVIDER record of the balance, by the code-owned recorder');
  ok((await one("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='billing.invoice.payment_recorded'", [inv1])).n === 1, 'one payment-recorded event');
  ok((await pay.confirm(PARENT.subject, inv1)).state === 'SUCCEEDED' && (await sql("SELECT 1 FROM hon.invoice_payment_records WHERE invoice_id=$1 AND method='PROVIDER'", [inv1])).rowCount === 1, 'confirm again: nothing new');
  ok(!(await pay.list(PARENT.subject)).invoices.some((x) => x.invoiceId === inv1), 'a paid invoice leaves the list');
  await refused(() => pay.start(PARENT.subject, inv1), 409, 'PARENT_INVOICE_PAY_NOT_PAYABLE', 'no second payment of a paid invoice');
  ok(!sessionOf(p1.id).applicationFee, 'no HON fee on the session');

  // 6. Cancel: the page is closed at the processor first; the hold ends; staff can take a manual payment.
  const inv2 = await invoice(H, ids.school, ids.organization, 4000);
  await pay.start(PARENT.subject, inv2);
  await rejectsSql(() => sql("UPDATE hon.invoices SET status='VOID',version=version+1 WHERE id=$1", [inv2]), /PARENT_INVOICE_PAY_IN_PROGRESS/, 'void while the page is open');
  const x2 = await pay.cancel(PARENT.subject, inv2);
  const [p2] = await onceOf(inv2);
  ok(x2.state === 'CANCELED' && sessionOf(p2.id).outcome === 'EXPIRED', 'cancel: closed at the processor, CANCELED');
  ok((await manual(inv2, 4000)).rowCount === 1 && (await invoiceRow(inv2)).status === 'ISSUED', 'after cancel: a manual payment is allowed');

  // 7. Cancel after the parent already paid: the processor's answer wins (SUCCEEDED, invoice PAID), no double charge.
  const inv3 = await invoice(H, ids.school, ids.organization, 3000);
  await pay.start(PARENT.subject, inv3);
  const [p3] = await onceOf(inv3);
  stripe.settleOnce(p3.id, 'SUCCEEDED');
  ok((await pay.cancel(PARENT.subject, inv3)).state === 'SUCCEEDED' && (await invoiceRow(inv3)).status === 'PAID', 'cancel after paying: SUCCEEDED and PAID');

  // 8. A started payment past both expiries holds nothing; a new start checks the old one at the processor first.
  const inv4 = await invoice(H, ids.school, ids.organization, 2500);
  await pay.start(PARENT.subject, inv4);
  const [p4] = await onceOf(inv4);
  await backdate(p4.id);
  ok((await one('SELECT hon.parent_invoice_pay_open($1) x', [inv4])).x === false, 'expired: no hold');
  const s4 = await pay.start(PARENT.subject, inv4);
  const ps4 = await onceOf(inv4);
  ok(ps4.length === 2 && ps4[0].state === 'EXPIRED' && ps4[1].state === 'OPEN' && s4.state === 'OPEN' && s4.url !== null, 'old page expired at the processor, a new page opened');

  // 9. Still clearing (PROCESSING): start does not open a second page; the invoice stays held.
  const inv5 = await invoice(H, ids.school, ids.organization, 1800);
  await pay.start(PARENT.subject, inv5);
  const [p5] = await onceOf(inv5);
  stripe.settleOnce(p5.id, 'PROCESSING');
  ok((await pay.confirm(PARENT.subject, inv5)).state === 'PROCESSING', 'PROCESSING recorded');
  const s5 = await pay.start(PARENT.subject, inv5);
  ok(s5.state === 'PROCESSING' && s5.url === null && (await onceOf(inv5)).length === 1, 'start while clearing: no new page');
  ok((await pay.list(PARENT.subject)).invoices.find((x) => x.invoiceId === inv5)?.payable === false, 'not payable while clearing');
  await rejectsSql(() => manual(inv5, 1800), /PARENT_INVOICE_PAY_IN_PROGRESS/, 'manual payment while clearing');
  await refused(() => pay.cancel(PARENT.subject, inv5), 409, 'SCHOOL_PAY_ONCE_IN_PROGRESS', 'no cancel while clearing');

  // 10. The invoice changed under the payment (fixture bypass of the hold): the success is kept and flagged, nothing guessed.
  const inv6 = await invoice(H, ids.school, ids.organization, 2200);
  await pay.start(PARENT.subject, inv6);
  const [p6] = await onceOf(inv6);
  await sql('BEGIN');
  await sql('ALTER TABLE hon.invoices DISABLE TRIGGER parent_invoice_pay_invoice_guard');
  await sql("UPDATE hon.invoices SET status='VOID',version=version+1 WHERE id=$1", [inv6]);
  await sql('ALTER TABLE hon.invoices ENABLE TRIGGER parent_invoice_pay_invoice_guard');
  await sql('COMMIT');
  stripe.settleOnce(p6.id, 'SUCCEEDED');
  ok((await pay.confirm(PARENT.subject, inv6)).state === 'SUCCEEDED', 'processor success recorded');
  ok((await invoiceRow(inv6)).status === 'VOID' && (await sql('SELECT 1 FROM hon.invoice_payment_records WHERE invoice_id=$1', [inv6])).rowCount === 0, 'invoice not changed');
  ok((await one("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='parent_invoice_pay.review_needed'", [p6.id])).n === 1
    && (await one("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='parent_invoice_pay.review_needed' AND actor_principal_id=$2", [p6.id, SVC])).n === 1, 'flagged for staff review');

  // 11. A school whose processor cannot show a hosted page here (unconfigured Stripe adapter): nothing is fixed or sent.
  const inv7 = await invoice(H, ids.school, ids.organization, 1500);
  const before = stripe.onceBeginCalls;
  await refused(() => noCard.start(PARENT.subject, inv7), 422, 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED', 'no hosted page here');
  ok(stripe.onceBeginCalls === before && (await onceOf(inv7)).every((p) => p.surface === null), 'nothing sent to the processor');

  // 12. Direct SQL: the opener refuses foreign scope and invented sources; balance is the database's own.
  await rejectsSql(() => sql('SELECT hon.open_parent_invoice_payment($1,$2)', [OTHER.subject, inv7]), /PARENT_INVOICE_PAY_NOT_FOUND/, 'another family cannot open it');
  await rejectsSql(() => sql('SELECT hon.open_parent_invoice_payment($1,$2)', [PARENT.subject, inv1]), /PARENT_INVOICE_PAY_NOT_PAYABLE|SCHOOL_PAY_ONCE_EXISTS/, 'a paid invoice cannot be opened');
  await rejectsSql(() => sql("SELECT hon.school_pay_once_open($1,$2,'GIFT_CARD',gen_random_uuid(),1,'USD','{\"name\":\"x\"}','{}',clock_timestamp()+interval '5 minutes')", [ids.organization, ids.school]),
    /VALIDATION_FAILED/, 'the opener still refuses an unknown source');
  await rejectsSql(() => sql("INSERT INTO hon.school_pay_once(organization_id,school_id,source,source_id,connection_id,provider_code,amount_minor,currency,label,expires_at) SELECT organization_id,school_id,'GIFT_CARD',gen_random_uuid(),connection_id,provider_code,1,'USD','x',clock_timestamp()+interval '5 minutes' FROM hon.school_pay_once LIMIT 1"),
    /school_pay_once_source_check/, 'the table refuses an unknown source');

  // 13. Runtime posture: three entry points; every helper internal; no table privilege.
  const entry = ['read_parent_invoice_payments(text)', 'read_parent_invoice_payment(text,uuid)', 'open_parent_invoice_payment(text,uuid)'];
  const internal = ['parent_invoice_pay_open(uuid)', 'guard_parent_invoice_pay_record()', 'guard_parent_invoice_pay_invoice()', 'guard_parent_invoice_pay_charge()',
    'parent_invoice_pay_scope(text)', 'parent_invoice_pay_invoices(uuid,uuid,uuid)', 'parent_invoice_pay_balance(uuid)', 'parent_invoice_pay_latest(uuid)',
    'settle_parent_invoice_payment()', 'school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)'];
  for (const fn of entry) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === true, `runtime executes ${fn}`);
  for (const fn of internal) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === false, `runtime cannot execute ${fn}`);
  for (const table of ['school_pay_once', 'school_pay_once_events']) {
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- Parent invoice payment exact verification (0530)', end = '-- End parent invoice payment exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 14. No SaaS payment attempt, no fee, and Square's simulator school is untouched.
  ok((await one('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).n === 0, 'no SaaS payment attempt');
  ok([...stripe.onceSessions.values()].every((x) => !('applicationFee' in x)), 'no session carries an application fee');
  ok(square.onceBeginCalls === 0 && SQUARE_PARENT, 'Square untouched');

  console.log(`PASS: parent invoice payment (0530): ${checks} checks.`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
