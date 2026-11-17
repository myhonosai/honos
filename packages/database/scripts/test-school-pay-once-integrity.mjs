/**
 * School one-time payment proof (B-TUI-2 0462): SchoolPayOnceService -> the four fixed API calls on the restricted
 * runtime role -> protected definer functions with forced RLS, plus the internal opener/state/cancel helpers called as a
 * caller's definer would (migration owner), on the guarded disposable CRM-close fixture only. The processors are the
 * in-process simulators (no network, no credentials). Test mode only; synthetic data; nothing is sent; HON takes no fee.
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

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'schoolNone', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const SVC = '00000000-0000-4000-8000-000000000462';

const stripe = new SimulatedStripeConnectAdapter();
const square = new SimulatedSquareAdapter();
const service = new SchoolPayOnceService(new RuntimeDatabaseService(), new Map([['STRIPE_CONNECT', stripe], ['SQUARE', square]]));
const unconfigured = new SchoolPayOnceService(new RuntimeDatabaseService(), new Map([['STRIPE_CONNECT', new UnconfiguredSchoolPaymentAdapter('STRIPE_CONNECT')], ['SQUARE', square]]));
const RETURN = 'https://app.example.test/kiosk/thanks';
const LEAK = /cs_sim|sqlink_sim|pi_sim|sqpay_sim|acct_sim|MLSIM|@example\.test/;

async function refused(run, status, code, label) {
  try { await run(); } catch (error) {
    const body = typeof error.getResponse === 'function' ? error.getResponse() : null;
    assert.equal(error.getStatus?.(), status, `${label}: expected ${status}, got ${error.getStatus?.()} ${JSON.stringify(body)} ${error.message}`);
    if (code) assert.equal(body?.code, code, `${label}: expected ${code}, got ${JSON.stringify(body)}`);
    checks += 1; return;
  }
  assert.fail(`${label}: expected a refusal`);
}
/** A direct write that must be refused; each runs in its own transaction, rolled back. */
async function rejectsSql(client, run, pattern, label) {
  await client.query('BEGIN');
  try { await run(); } catch (error) { await client.query('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await client.query('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0258, 0321 and 0337 proofs).
async function cleanup() {
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.school_pay_once WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left one-time payment fixtures behind');
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`payonce-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`payonce-${ids.organization}-%`]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

let STARTER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PayOnce Org','PayOnce Org'),($2,'PayOnce Other Org','PayOnce Other Org')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.schoolNone, ids.organization, 'n'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `PayOnce ${slug}`, `payonce-${slug}-${school.slice(0, 8)}`]);
  }
  const user = randomUUID(); STARTER = randomUUID();
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PayOnce Staff')", [user, `payonce-${ids.organization}-owner`, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PayOnce Staff')", [STARTER, user]);
  // Fixture-only connections (the onboarding flow is proven by 0258/0320): Stripe at school A, Square at school B, a
  // restricted Stripe connection at the other organization's school. Guards are bypassed for the disposable fixture only.
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_connections DISABLE TRIGGER USER');
  for (const [org, school, provider, ref, state, isDefault] of [[ids.organization, ids.schoolA, 'STRIPE_CONNECT', 'acct_simA1', 'CONNECTED_ACTIVE', true],
    [ids.organization, ids.schoolB, 'SQUARE', 'MLSIMB1', 'CONNECTED_ACTIVE', true], [ids.otherOrganization, ids.otherSchool, 'STRIPE_CONNECT', 'acct_simO1', 'CONNECTED_RESTRICTED', false]]) {
    await sql(`INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,state,provider_account_ref,charges_enabled,payouts_enabled,capabilities,is_default,started_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,true,'{"oneTimeCard":true,"storedCard":true,"bankDebit":false,"offSessionRecurring":true,"refunds":true}'::jsonb,$7,$8)`,
      [org, school, provider, state, ref, state === 'CONNECTED_ACTIVE', isDefault, STARTER]);
  }
  await sql('ALTER TABLE hon.school_pay_connections ENABLE TRIGGER USER');
  await sql('COMMIT');
}
/** A caller's definer opening a payment (the migration owner here; never the runtime). */
const open = (school, source, sourceId, amount, { currency = 'USD', label = { name: 'Trial class' }, payer = {}, minutes = 20, org = ids.organization } = {}) =>
  sql(`SELECT hon.school_pay_once_open($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,clock_timestamp()+make_interval(mins=>$9)) id`,
    [org, school, source, sourceId, amount, currency, JSON.stringify(label), JSON.stringify(payer), minutes]).then((r) => r.rows[0].id);
const stateOf = (id) => sql('SELECT hon.school_pay_once_state($1) s', [id]).then((r) => r.rows[0].s);
const rowOf = (id) => sql('SELECT * FROM hon.school_pay_once WHERE id=$1', [id]).then((r) => r.rows[0]);
const eventsOf = (id) => sql('SELECT kind,payment_version,snapshot,actor_principal_id FROM hon.school_pay_once_events WHERE payment_id=$1 ORDER BY payment_version', [id]).then((r) => r.rows);
const settledOutbox = (id) => sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='school_pay_once.settled'", [id]).then((r) => r.rows[0].n);
/** Disposable fixture only: move a payment's whole life an hour into the past, so its own expiry has passed. */
async function backdate(id) {
  await sql('BEGIN');
  await sql('ALTER TABLE hon.school_pay_once DISABLE TRIGGER school_pay_once_guard');
  await sql("UPDATE hon.school_pay_once SET created_at=created_at-interval '1 hour',expires_at=expires_at-interval '1 hour' WHERE id=$1", [id]);
  await sql('ALTER TABLE hon.school_pay_once ENABLE TRIGGER school_pay_once_guard');
  await sql('COMMIT');
}
const clean = (value, label) => ok(!LEAK.test(JSON.stringify(value)), `${label}: no provider reference or payer email`);

try {
  await cleanup();
  await seed();

  // 1. Which processor a school would use; opening is refused without one, and validated.
  ok((await sql('SELECT hon.school_pay_once_provider($1,$2) p', [ids.organization, ids.schoolA])).rows[0].p === 'STRIPE_CONNECT', 'school A: Stripe');
  ok((await sql('SELECT hon.school_pay_once_provider($1,$2) p', [ids.organization, ids.schoolB])).rows[0].p === 'SQUARE', 'school B: Square');
  ok((await sql('SELECT hon.school_pay_once_provider($1,$2) p', [ids.organization, ids.schoolNone])).rows[0].p === null, 'no connection: none');
  ok((await sql('SELECT hon.school_pay_once_provider($1,$2) p', [ids.otherOrganization, ids.otherSchool])).rows[0].p === null, 'restricted, non-default connection: none');
  ok((await sql('SELECT hon.school_pay_once_provider($1,$2) p', [ids.otherOrganization, ids.schoolA])).rows[0].p === null, 'another organization never sees school A');
  await rejectsSql(admin, () => open(ids.schoolNone, 'WALKIN_VISIT', randomUUID(), 2500), /SCHOOL_PAY_ONCE_NOT_AVAILABLE/, 'no processor: refused');
  for (const [label, run] of [
    ['expiry over 30 minutes', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { minutes: 31 })],
    ['expiry under a minute', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { minutes: 0 })],
    ['zero amount', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 0)],
    ['lower-case currency', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { currency: 'usd' })],
    ['unknown source', () => open(ids.schoolA, 'GIFT_CARD', randomUUID(), 2500)],
    ['label with extra keys', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { label: { name: 'x', price: 1 } })],
    ['empty label', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { label: {} })],
    ['untrimmed label', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { label: { name: ' x' } })],
    ['payer with a name', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { payer: { name: 'Pat' } })],
    ['bad payer email', () => open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2500, { payer: { email: 'not an email' } })],
  ]) await rejectsSql(admin, run, /VALIDATION_FAILED/, label);

  // 2. Open is idempotent per caller record; another amount is refused.
  const visit1 = randomUUID();
  const p1 = await open(ids.schoolA, 'WALKIN_VISIT', visit1, 2500, { payer: { email: 'Pay.Er@Example.test' } });
  ok(await open(ids.schoolA, 'WALKIN_VISIT', visit1, 2500, { payer: { email: 'pay.er@example.test' } }) === p1, 'same open returns the same payment');
  await rejectsSql(admin, () => open(ids.schoolA, 'WALKIN_VISIT', visit1, 2600), /SCHOOL_PAY_ONCE_AMOUNT_MISMATCH/, 'another amount for the same record');
  ok((await rowOf(p1)).payer_email === 'pay.er@example.test', 'payer email kept lower-case, private');
  ok((await eventsOf(p1)).map((e) => e.kind).join() === 'OPENED' && (await eventsOf(p1))[0].actor_principal_id === SVC, 'OPENED by the code-owned recorder');

  // 3. Stripe embedded start: client secret and the school's account for Stripe.js; nothing settled; retry is identical.
  const s1 = await service.start(p1, { surface: 'EMBEDDED', returnUrl: RETURN });
  ok(s1.providerCode === 'STRIPE_CONNECT' && s1.surface === 'EMBEDDED' && /^cs_sim.*_secret_sim$/.test(s1.clientSecret) && s1.url === null && s1.accountRef === 'acct_simA1', 'embedded start');
  const r1 = await rowOf(p1);
  ok(r1.surface === 'EMBEDDED' && r1.return_url === RETURN && r1.provider_session_ref?.startsWith('cs_sim') && r1.state === 'OPEN', 'start and session recorded');
  ok(Math.abs(Date.parse(r1.provider_expires_at) - (Date.parse(r1.updated_at) + 31 * 60_000)) < 120_000, 'provider expiry about 31 minutes after start');
  const calls = stripe.onceBeginCalls;
  const s1again = await service.start(p1, { surface: 'EMBEDDED', returnUrl: RETURN });
  ok(s1again.clientSecret === s1.clientSecret && stripe.onceBeginCalls === calls + 1 && stripe.onceSessions.size === 1, 'a second start gets the same session back');
  await refused(() => service.start(p1, { surface: 'HOSTED', returnUrl: RETURN }), 409, 'SCHOOL_PAY_ONCE_START_MISMATCH', 'another surface after start');
  await refused(() => service.start(p1, { surface: 'EMBEDDED', returnUrl: 'https://app.example.test/other' }), 409, 'SCHOOL_PAY_ONCE_START_MISMATCH', 'another return address after start');
  await refused(() => service.start(p1, { surface: 'EMBEDDED', returnUrl: 'http://evil.example.test/x' }), 400, 'VALIDATION_FAILED', 'plain http return address');
  await refused(() => service.start('not-a-uuid', { surface: 'EMBEDDED', returnUrl: RETURN }), 400, 'VALIDATION_FAILED', 'bad id');
  await refused(() => service.start(randomUUID(), { surface: 'EMBEDDED', returnUrl: RETURN }), 404, 'SCHOOL_PAY_ONCE_NOT_FOUND', 'unknown payment');
  ok(!stripe.onceSessions.values().next().value.applicationFee, 'no application fee on the session');

  // 4. Confirm: still open; then paid at the processor -> SUCCEEDED, final, one settled event; the caller sees PAID.
  ok((await service.confirm(p1)).state === 'OPEN', 'unpaid session: OPEN');
  stripe.settleOnce(p1, 'SUCCEEDED');
  const c1 = await service.confirm(p1);
  ok(c1.state === 'SUCCEEDED' && c1.amountMinor === 2500 && c1.currency === 'USD' && c1.settledAt, 'paid: SUCCEEDED');
  clean(c1, 'confirm result');
  ok((await rowOf(p1)).provider_payment_ref?.startsWith('pi_sim'), 'processor payment id kept privately');
  ok((await service.confirm(p1)).state === 'SUCCEEDED' && (await settledOutbox(p1)) === 1, 'confirm again: no new record');
  const st1 = await stateOf(p1);
  ok(st1.state === 'SUCCEEDED' && st1.providerOpen === false && st1.source === 'WALKIN_VISIT' && st1.sourceId === visit1, 'internal state for the caller');
  await rejectsSql(admin, () => sql('SELECT hon.school_pay_once_cancel($1)', [p1]), /SCHOOL_PAY_ONCE_PAID/, 'a paid payment is never cancelled');
  await rejectsSql(admin, () => open(ids.schoolA, 'WALKIN_VISIT', visit1, 2500), /SCHOOL_PAY_ONCE_EXISTS/, 'a paid record cannot be opened again');
  await refused(() => service.start(p1, { surface: 'EMBEDDED', returnUrl: RETURN }), 409, 'SCHOOL_PAY_ONCE_STATE', 'start after paid');
  for (const e of await eventsOf(p1)) clean(e.snapshot, `history ${e.kind}`);
  ok((await eventsOf(p1)).map((e) => e.kind).join() === 'OPENED,STARTED,SESSION_RECORDED,SUCCEEDED', 'history');

  // 5. Cancel to pay at the desk: the session is closed at the processor first, then CANCELED; a new payment is allowed.
  const visit2 = randomUUID();
  const p2 = await open(ids.schoolA, 'WALKIN_VISIT', visit2, 1500);
  await service.start(p2, { surface: 'HOSTED', returnUrl: RETURN }).then((s) => ok(s.url?.startsWith('https://') && s.clientSecret === null && s.accountRef === null, 'hosted start: a URL only'));
  ok((await stateOf(p2)).providerOpen === true, 'started: the processor may hold a payable session');
  await rejectsSql(admin, () => sql('SELECT hon.school_pay_once_cancel($1)', [p2]), /SCHOOL_PAY_ONCE_PROVIDER_OPEN/, 'internal cancel refuses a started payment');
  const x2 = await service.cancel(p2);
  ok(x2.state === 'CANCELED' && [...stripe.onceSessions.values()].find((s) => s.paymentId === p2).outcome === 'EXPIRED', 'cancel: expired at the processor, CANCELED');
  ok((await stateOf(p2)).state === 'CANCELED' && (await settledOutbox(p2)) === 1, 'caller sees CANCELED');
  stripe.settleOnce(p2, 'SUCCEEDED'); // impossible at a real processor once expired; the record still refuses to change
  ok((await service.confirm(p2)).state === 'CANCELED', 'a settled payment never changes');
  const p2b = await open(ids.schoolA, 'WALKIN_VISIT', visit2, 1500);
  ok(p2b !== p2, 'after a cancel the record can open a new payment');

  // 6. Cancel after the payer already paid: SUCCEEDED, never a second charge.
  const p3 = await open(ids.schoolA, 'CHECKOUT_PAGE', randomUUID(), 9900);
  await service.start(p3, { surface: 'EMBEDDED', returnUrl: RETURN });
  stripe.settleOnce(p3, 'SUCCEEDED');
  ok((await service.cancel(p3)).state === 'SUCCEEDED', 'cancel of an already paid payment records SUCCEEDED');

  // 7. Internal cancel of a payment that never reached the processor.
  const p4 = await open(ids.schoolA, 'POS_SALE', randomUUID(), 700);
  const x4 = (await sql('SELECT hon.school_pay_once_cancel($1) s', [p4])).rows[0].s;
  ok(x4.state === 'CANCELED' && x4.providerOpen === false, 'unstarted: internal cancel');
  ok((await sql('SELECT hon.school_pay_once_cancel($1) s', [p4])).rows[0].s.state === 'CANCELED', 'internal cancel again: returned as is');

  // 8. A lost begin answer: start fails, nothing is guessed; confirm gets the same session back and records it.
  const p5 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 3000);
  stripe.onceFaults.set(p5, { beginLost: true });
  await refused(() => service.start(p5, { surface: 'EMBEDDED', returnUrl: RETURN }), 503, 'SCHOOL_PAY_PROVIDER_UNKNOWN', 'lost begin answer');
  ok((await rowOf(p5)).surface === 'EMBEDDED' && (await rowOf(p5)).provider_session_ref === null, 'started, session not yet known');
  ok((await service.confirm(p5)).state === 'OPEN' && (await rowOf(p5)).provider_session_ref?.startsWith('cs_sim'), 'confirm recovers the same session');
  ok([...stripe.onceSessions.values()].filter((s) => s.paymentId === p5).length === 1, 'one session at the processor');
  ok((await service.cancel(p5)).state === 'CANCELED', 'then cancel closes it');

  // 9. The processor refuses to create a session: cancel ends it without one.
  const p6 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 3000);
  stripe.onceFaults.set(p6, { refuseBegin: true });
  await refused(() => service.start(p6, { surface: 'EMBEDDED', returnUrl: RETURN }), 502, 'SCHOOL_PAY_PROVIDER_REJECTED', 'refused begin');
  ok((await service.cancel(p6)).state === 'CANCELED' && (await rowOf(p6)).provider_session_ref === null, 'cancel without a session');
  stripe.onceFaults.delete(p6);

  // 10. PROCESSING (payment still clearing): cancel is refused; it then settles FAILED with a class.
  const p7 = await open(ids.schoolA, 'CHECKOUT_PAGE', randomUUID(), 4200);
  await service.start(p7, { surface: 'HOSTED', returnUrl: RETURN });
  stripe.settleOnce(p7, 'PROCESSING');
  ok((await service.confirm(p7)).state === 'PROCESSING', 'PROCESSING');
  await refused(() => service.cancel(p7), 409, 'SCHOOL_PAY_ONCE_IN_PROGRESS', 'cancel while processing');
  await rejectsSql(admin, () => sql('SELECT hon.school_pay_once_cancel($1)', [p7]), /SCHOOL_PAY_ONCE_IN_PROGRESS/, 'internal cancel while processing');
  stripe.settleOnce(p7, 'FAILED');
  ok((await service.confirm(p7)).state === 'FAILED' && (await rowOf(p7)).failure_class === 'DECLINED', 'then FAILED DECLINED');
  ok(await open(ids.schoolA, 'CHECKOUT_PAGE', (await rowOf(p7)).source_id, 4200) !== p7, 'after FAILED a new payment is allowed');

  // 11. Expiry: an open session past the payment's expiry is closed at the processor, then EXPIRED; an unstarted one
  // expires without the processor; start refuses; the reconcile sweep settles what is due.
  const p8 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 1000);
  await service.start(p8, { surface: 'EMBEDDED', returnUrl: RETURN });
  const p9 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 1000);
  const p10 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 1000);
  await service.start(p10, { surface: 'EMBEDDED', returnUrl: RETURN });
  stripe.settleOnce(p10, 'SUCCEEDED');
  for (const id of [p8, p9, p10]) await backdate(id);
  await refused(() => service.start(p9, { surface: 'EMBEDDED', returnUrl: RETURN }), 409, 'SCHOOL_PAY_ONCE_EXPIRED', 'start after expiry');
  await rejectsSql(runtime, () => runtime.query('SELECT hon.start_school_pay_once($1,$2::jsonb)', [p9, JSON.stringify({ surface: 'EMBEDDED', returnUrl: RETURN })]),
    /SCHOOL_PAY_ONCE_EXPIRED/, 'database refuses a start after expiry too');
  const due = (await runtime.query('SELECT hon.list_due_school_pay_once(100) d')).rows[0].d;
  ok([p8, p9, p10].every((id) => due.includes(id)), 'due list');
  const swept = await service.reconcileDue(100);
  ok(swept.failed === 0 && swept.settled >= 3, `sweep settled ${JSON.stringify(swept)}`);
  ok((await rowOf(p8)).state === 'EXPIRED' && [...stripe.onceSessions.values()].find((s) => s.paymentId === p8).outcome === 'EXPIRED', 'open session expired at the processor, then EXPIRED');
  ok((await rowOf(p9)).state === 'EXPIRED' && (await rowOf(p9)).provider_session_ref === null, 'unstarted: EXPIRED without the processor');
  ok((await rowOf(p10)).state === 'SUCCEEDED', 'paid before expiry: SUCCEEDED, never expired');

  // 12. Square: hosted only here (payment link); embedded is refused before anything is fixed or sent.
  const q1 = await open(ids.schoolB, 'POS_SALE', randomUUID(), 1800);
  await refused(() => service.start(q1, { surface: 'EMBEDDED', returnUrl: RETURN }), 422, 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED', 'Square embedded');
  ok((await rowOf(q1)).surface === null && square.onceBeginCalls === 0, 'nothing fixed or sent');
  const qs = await service.start(q1, { surface: 'HOSTED', returnUrl: RETURN });
  ok(qs.providerCode === 'SQUARE' && qs.url && (await rowOf(q1)).provider_session_ref.startsWith('sqlink_sim'), 'Square hosted');
  square.settleOnce(q1, 'SUCCEEDED');
  ok((await service.confirm(q1)).state === 'SUCCEEDED', 'Square paid');
  ok(service.supports('STRIPE_CONNECT', 'EMBEDDED') && service.supports('SQUARE', 'HOSTED') && !service.supports('SQUARE', 'EMBEDDED'), 'supports');
  ok(!unconfigured.supports('STRIPE_CONNECT', 'EMBEDDED') && !unconfigured.supports('STRIPE_CONNECT', 'HOSTED'), 'an unconfigured processor supports nothing');
  const u1 = await open(ids.schoolA, 'POS_SALE', randomUUID(), 500);
  await refused(() => unconfigured.start(u1, { surface: 'EMBEDDED', returnUrl: RETURN }), 422, 'SCHOOL_PAY_ONCE_SURFACE_UNSUPPORTED', 'unconfigured: refused before anything is fixed');
  ok((await rowOf(u1)).surface === null, 'unconfigured: nothing fixed');

  // 13. A caller holding the payment (internal state, FOR UPDATE) blocks any record until it commits.
  const p11 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 1200);
  await service.start(p11, { surface: 'EMBEDDED', returnUrl: RETURN });
  stripe.settleOnce(p11, 'SUCCEEDED');
  await sql('BEGIN'); await sql('SELECT hon.school_pay_once_state($1)', [p11]);
  await refused(() => service.confirm(p11), 409, 'SCHOOL_PAY_CONFLICT', 'confirm waits for the caller holding the payment (lock timeout)');
  await sql('ROLLBACK');
  ok((await service.confirm(p11)).state === 'SUCCEEDED', 'after the caller: recorded');

  // 14. The record call trusts nothing it cannot check.
  const p12 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2000);
  await service.start(p12, { surface: 'EMBEDDED', returnUrl: RETURN });
  const ref12 = (await rowOf(p12)).provider_session_ref;
  const rec = (body) => runtime.query('SELECT hon.record_school_pay_once($1,$2::jsonb)', [p12, JSON.stringify(body)]);
  for (const [label, body, pattern] of [
    ['other amount', { outcome: 'SUCCEEDED', amountMinor: 2001, currency: 'USD', sessionRef: ref12, paymentRef: 'pi_x123' }, /SCHOOL_PAY_ONCE_AMOUNT_MISMATCH/],
    ['other currency', { outcome: 'SUCCEEDED', amountMinor: 2000, currency: 'CAD', sessionRef: ref12, paymentRef: 'pi_x123' }, /SCHOOL_PAY_ONCE_AMOUNT_MISMATCH/],
    ['other session', { outcome: 'SUCCEEDED', amountMinor: 2000, currency: 'USD', sessionRef: 'cs_other1', paymentRef: 'pi_x123' }, /SCHOOL_PAY_ONCE_REF_MISMATCH/],
    ['success without a payment id', { outcome: 'SUCCEEDED', amountMinor: 2000, currency: 'USD', sessionRef: ref12 }, /VALIDATION_FAILED/],
    ['failure without a class', { outcome: 'FAILED', amountMinor: 2000, currency: 'USD', sessionRef: ref12 }, /VALIDATION_FAILED/],
    ['unknown key', { outcome: 'OPEN', amountMinor: 2000, currency: 'USD', sessionRef: ref12, note: 'x' }, /VALIDATION_FAILED/],
    ['session-less EXPIRED for a payment with a session', { outcome: 'EXPIRED', amountMinor: 2000, currency: 'USD' }, /SCHOOL_PAY_ONCE_REF_MISMATCH/],
  ]) await rejectsSql(runtime, () => rec(body), pattern, `record: ${label}`);
  const p13 = await open(ids.schoolA, 'WALKIN_VISIT', randomUUID(), 2000);
  await rejectsSql(runtime, () => runtime.query('SELECT hon.record_school_pay_once($1,$2::jsonb)', [p13, JSON.stringify({ outcome: 'OPEN', amountMinor: 2000, currency: 'USD', sessionRef: 'cs_x1234' })]),
    /SCHOOL_PAY_ONCE_REF_MISMATCH/, 'record: a session for an unstarted payment');
  await rejectsSql(runtime, () => runtime.query('SELECT hon.record_school_pay_once($1,$2::jsonb)', [p13, JSON.stringify({ outcome: 'EXPIRED', amountMinor: 2000, currency: 'USD' })]),
    /SCHOOL_PAY_ONCE_STATE/, 'record: EXPIRED before its own expiry');
  await rejectsSql(runtime, () => runtime.query('SELECT hon.record_school_pay_once($1,$2::jsonb)', [p1, JSON.stringify({ outcome: 'EXPIRED', amountMinor: 2500, currency: 'USD', sessionRef: r1.provider_session_ref })]),
    /SCHOOL_PAY_ONCE_STATE/, 'record: a settled payment refuses another answer');

  // 15. Settings-free guards, whoever writes; append-only history.
  for (const [label, text] of [
    ['amount change', 'UPDATE hon.school_pay_once SET amount_minor=1,version=version+1 WHERE id=$1'],
    ['label change', "UPDATE hon.school_pay_once SET label='x',version=version+1 WHERE id=$1"],
    ['expiry change', "UPDATE hon.school_pay_once SET expires_at=expires_at+interval '1 minute',version=version+1 WHERE id=$1"],
    ['session change', "UPDATE hon.school_pay_once SET provider_session_ref='cs_other2',version=version+1 WHERE id=$1"],
    ['settled change', "UPDATE hon.school_pay_once SET state='CANCELED',version=version+1 WHERE id=$1"],
    ['no version bump', "UPDATE hon.school_pay_once SET updated_at=clock_timestamp() WHERE id=$1"],
    ['delete', 'DELETE FROM hon.school_pay_once WHERE id=$1'],
  ]) await rejectsSql(admin, () => sql(text, [label === 'session change' ? p12 : p1]), /SCHOOL_PAY_ONCE_IMMUTABLE/, `guard: ${label}`);
  await rejectsSql(admin, () => sql(`INSERT INTO hon.school_pay_once(organization_id,school_id,source,source_id,connection_id,provider_code,amount_minor,currency,label,state,expires_at)
    SELECT organization_id,school_id,source,gen_random_uuid(),connection_id,provider_code,1,currency,label,'SUCCEEDED',clock_timestamp()+interval '5 minutes' FROM hon.school_pay_once WHERE id=$1`, [p1]),
    /SCHOOL_PAY_ONCE_IMMUTABLE/, 'guard: insert as paid');
  await rejectsSql(admin, () => sql("UPDATE hon.school_pay_once_events SET kind='OPENED' WHERE payment_id=$1", [p1]), /./, 'history is append-only');
  await rejectsSql(admin, () => sql('TRUNCATE hon.school_pay_once_events'), /./, 'history cannot be truncated');

  // 16. Runtime posture: no table privilege; four entry points; the opener, state and cancel stay internal.
  for (const table of ['school_pay_once', 'school_pay_once_events']) {
    const t = (await sql(`SELECT c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  const entry = ['read_school_pay_once(uuid)', 'start_school_pay_once(uuid,jsonb)', 'record_school_pay_once(uuid,jsonb)', 'list_due_school_pay_once(integer)'];
  const internal = ['guard_school_pay_once()', 'school_pay_once_json(hon.school_pay_once)', 'school_pay_once_record(hon.school_pay_once,text,jsonb)',
    'school_pay_once_connection(uuid,uuid)', 'school_pay_once_provider(uuid,uuid)', 'school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)',
    'school_pay_once_state(uuid)', 'school_pay_once_cancel(uuid)'];
  for (const fn of entry) ok((await sql('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].x === true, `runtime executes ${fn}`);
  for (const fn of internal) ok((await sql('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].x === false, `runtime cannot execute ${fn}`);
  await assert.rejects(runtime.query("SELECT hon.school_pay_once_open($1,$2,'WALKIN_VISIT',gen_random_uuid(),1,'USD','{\"name\":\"x\"}','{}',clock_timestamp()+interval '5 minutes')",
    [ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School one-time payment exact verification (B-TUI-2 0462)', end = '-- End school one-time payment exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 17. No HON fee, no SaaS payment attempt, and every audit row is the code-owned recorder's.
  ok((await sql('SELECT count(*)::int n FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n === 0, 'no SaaS payment attempt');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_type='SCHOOL_PAY_ONCE' AND organization_id=$1 AND actor_principal_id<>$2", [ids.organization, SVC])).rows[0].n === 0,
    'every one-time payment audit row is the recorder');
  ok([...stripe.onceSessions.values(), ...square.onceSessions.values()].every((x) => !('applicationFee' in x)), 'no session carries an application fee');

  console.log(`PASS: school one-time payments (0462): ${checks} checks.`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
