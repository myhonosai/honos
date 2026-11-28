// HQ "Buy a number" (0704, docs/architecture/HQ_TEXTING_NUMBER.md) on the marked disposable communication delivery
// database (the 0243 fixture). It proves: forced RLS and no table privilege on hon.hq_number_orders; the runtime runs only
// the three HQ entry points and the worker none; only the HQ owner starts, finishes or reads orders; one BUYING order at a
// time, the same number resumes it, another number is refused; no order while an SMS sender is ACTIVE; exact key replay;
// READY makes the HQ SMS sender (NOT_REGISTERED, MMS Converter on) in the same call; FAILED only without SIDs; a finished
// order never changes and is never deleted; the canonical 011 block. Nothing reaches Twilio.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ number order tests.`);
}
if (Object.keys(process.env).some((key) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS)(?:_|$)/i.test(key))) {
  throw new Error('Provider credentials are forbidden.');
}
const local = (url) => {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '5432') throw new Error('Disposable localhost:5432 target required.');
  return { connectionString: url, ssl: false };
};
const admin = new Client(local(process.env.DATABASE_URL));
const runtime = new Client(local(process.env.HON_RUNTIME_DATABASE_URL));
const worker = new Client(local(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL));

let passed = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed += 1; };
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
async function refuse(code, work, message, text) {
  try { await work(); } catch (error) {
    assert.equal(error?.code, code, `${message}: ${error?.message}`);
    if (text) assert.equal(error.message, text, message);
    passed += 1; return;
  }
  assert.fail(`${message}: expected ${code}`);
}
const K = () => randomUUID();
const hex = () => createHash('md5').update(K()).digest('hex');
const PN = () => 'PN' + hex(), MG = () => 'MG' + hex();
const humans = Object.fromEntries(['hqOwner', 'supportOp', 'stranger']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqnum-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const A = '+15125550111', B = '+15125550122', C = '+15125550133';

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const input = (phoneE164, patch = {}) => ({ phoneE164, locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000, ...patch });
const start = (who, body, key = K()) => call('start_hq_number_order', [H(who), JSON.stringify(body), key], ['', '::jsonb', '::uuid']);
const finish = (who, order, body) => call('finish_hq_number_order', [H(who), order, JSON.stringify(body)], ['', '::uuid', '::jsonb']);
const read = (who) => call('read_hq_number_orders', [H(who)]);
const ready = (numberSid = PN(), serviceSid = MG()) => ({ outcome: 'READY', numberSid, serviceSid, failureCode: null });
const failed = (failureCode = 'NUMBER_UNAVAILABLE') => ({ outcome: 'FAILED', numberSid: null, serviceSid: null, failureCode });

const tables = ['hq_number_orders', 'hq_communication_requests', 'hq_communication_senders'];
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    const ps = Object.values(humans).map((h) => h.id), us = Object.values(humans).map((h) => h.user);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])', [ps]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])', [us]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  // ---------- 0. posture ----------
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  for (const sig of ['start_hq_number_order(text,jsonb,uuid)', 'finish_hq_number_order(text,uuid,jsonb)', 'read_hq_number_orders(text)']) {
    eq(await has(runtime, sig), true, `runtime runs ${sig}`);
    eq(await has(worker, sig), false, `worker cannot run ${sig}`);
    eq((await one(admin, "SELECT has_function_privilege('public',$1,'EXECUTE') a", ['hon.' + sig])).a, false, `PUBLIC cannot run ${sig}`);
  }
  eq(await has(runtime, 'hq_number_order_json(hon.hq_number_orders)'), false, 'runtime cannot run the projection');
  for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.hq_number_orders', priv])).a, false, `runtime orders ${priv}`);
    eq((await one(worker, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.hq_number_orders', priv])).a, false, `worker orders ${priv}`);
  }
  eq(await one(admin, "SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid='hon.hq_number_orders'::regclass"), { r: true, f: true }, 'forced RLS');
  eq((await one(admin, "SELECT count(*)::int n FROM pg_policies WHERE schemaname='hon' AND tablename='hq_number_orders'")).n, 0, 'no policies');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- HQ number orders exact verification (0704)')[1]?.split('-- End HQ number orders exact verification.')[0]
    ?.replace(/^[^\n]*\n[^\n]*\n/, '');
  if (!block) throw new Error('Missing canonical 0704 verification.');
  const roles = (await one(runtime, 'SELECT current_user r')).r, workerRole = (await one(worker, 'SELECT current_user r')).r;
  const fixtureBlock = block.replaceAll("'hon_runtime'", `'${roles}'`).replaceAll("'hon_communication_worker'", `'${workerRole}'`);
  await admin.query(fixtureBlock); ok(true, 'canonical 011 block passes');
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.hq_number_order_json(hon.hq_number_orders) TO ${roles}`);
    await assert.rejects(admin.query(fixtureBlock), /HQ number order function drift/); ok(true, 'canonical block refuses a runtime grant on the projection');
  } finally { await admin.query('ROLLBACK'); }
  await cleanup();

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  const grant = "INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')";
  await admin.query(grant, [P('hqOwner'), 'HON_HQ_OWNER', '{}']);
  await admin.query(grant, [P('supportOp'), 'HON_HQ_SUPPORT', '{hq.support.manage}']);
  await admin.query('COMMIT');

  // ---------- 1. who ----------
  for (const who of ['supportOp', 'stranger']) {
    await refuse('42501', () => read(who), `${who} cannot read orders`);
    await refuse('42501', () => start(who, input(A)), `${who} cannot start an order`);
  }
  await refuse('42501', () => call('read_hq_number_orders', ['']), 'blank subject refused');
  eq((await read('hqOwner')).orders, [], 'no orders yet');
  eq((await read('hqOwner')).hasActiveSmsSender, false, 'no SMS sender yet');

  // ---------- 2. input ----------
  for (const bad of [input('5125550111'), input('+11125550111'), input(A, { monthlyPriceMicrounits: -1 }), input(A, { monthlyPriceMicrounits: 1.5 }),
    input(A, { monthlyPriceMicrounits: '1150000' }), input(A, { monthlyPriceMicrounits: 100000001 }), input(A, { region: 'tx' }), input(A, { locality: ' Austin' }),
    input(A, { locality: 'A<b>' }), { ...input(A), extra: 1 }, { phoneE164: A }]) {
    await refuse('22023', () => start('hqOwner', bad), `bad input ${JSON.stringify(bad)}`);
  }
  await refuse('22023', () => call('start_hq_number_order', [H('hqOwner'), JSON.stringify(input(A)), null], ['', '::jsonb', '::uuid']), 'key required');

  // ---------- 3. one BUYING order; same number resumes; key replay ----------
  const key = K();
  const first = await start('hqOwner', input(A), key);
  eq([first.replayed, first.order.status, first.order.phoneE164, first.order.monthlyPriceMicrounits, first.order.numberSid], [false, 'BUYING', A, 1150000, null], 'order BUYING');
  eq(first.order.requestedBy.principalId, P('hqOwner'), 'requested by the owner');
  eq((await start('hqOwner', input(A), key)).order.orderId, first.order.orderId, 'same key replays');
  await refuse('23505', () => start('hqOwner', input(A, { monthlyPriceMicrounits: 1 }), key), 'same key, different body refused');
  const resumed = await start('hqOwner', input(A, { monthlyPriceMicrounits: 1200000 }));
  eq([resumed.replayed, resumed.order.orderId, resumed.order.monthlyPriceMicrounits], [true, first.order.orderId, 1150000], 'same number resumes the open order at its first price');
  await refuse('23514', () => start('hqOwner', input(B)), 'another number waits for the open order', 'HQ_NUMBER_ORDER_OPEN');
  eq((await one(admin, "SELECT count(*)::int n FROM hon.hq_number_orders WHERE status='BUYING'")).n, 1, 'only one BUYING row');

  // ---------- 4. finish input ----------
  for (const bad of [{ ...ready(), numberSid: 'PN1' }, { ...ready(), serviceSid: 'PN' + hex() }, { ...ready(), failureCode: 'X_Y_Z' },
    { ...failed(), numberSid: PN() }, { ...failed(), failureCode: 'lower' }, { ...ready(), outcome: 'BOUGHT' }, { outcome: 'READY' }]) {
    await refuse('22023', () => finish('hqOwner', first.order.orderId, bad), `bad finish ${JSON.stringify(bad)}`);
  }
  await refuse('42501', () => finish('supportOp', first.order.orderId, ready()), 'support cannot finish');
  await refuse('P0002', () => finish('hqOwner', K(), ready()), 'unknown order');

  // ---------- 5. READY makes the HQ SMS sender ----------
  const numberSid = PN(), serviceSid = MG();
  const done = await finish('hqOwner', first.order.orderId, ready(numberSid, serviceSid));
  eq([done.order.status, done.order.numberSid, done.order.serviceSid, done.replayed], ['READY', numberSid, serviceSid, false], 'order READY');
  eq([done.sender.channel, done.sender.status, done.sender.smsServiceSid, done.sender.smsReplyNumber, done.sender.a2pState, done.sender.mmsConverterConfirmed],
    ['SMS', 'ACTIVE', serviceSid, A, 'NOT_REGISTERED', true], 'HQ SMS sender made');
  eq(done.order.senderId, done.sender.senderId, 'order points at the sender');
  eq((await finish('hqOwner', first.order.orderId, ready(numberSid, serviceSid))).replayed, true, 'same finish replays');
  await refuse('23514', () => finish('hqOwner', first.order.orderId, ready()), 'a finished order never changes', 'HQ_NUMBER_ORDER_FINISHED');
  await refuse('23514', () => finish('hqOwner', first.order.orderId, failed()), 'a READY order never fails', 'HQ_NUMBER_ORDER_FINISHED');
  eq((await read('hqOwner')).hasActiveSmsSender, true, 'sender now active');
  await refuse('23514', () => start('hqOwner', input(B)), 'no order while an SMS sender is active', 'HQ_SENDER_EXISTS');

  // ---------- 6. FAILED frees the slot; READY refused if a sender appeared meanwhile ----------
  await call('retire_hq_communication_sender', [H('hqOwner'), done.sender.senderId, K()], ['', '::uuid', '::uuid']);
  const second = await start('hqOwner', input(B));
  const lost = await finish('hqOwner', second.order.orderId, failed('NUMBER_UNAVAILABLE'));
  eq([lost.order.status, lost.order.failureCode, lost.sender], ['FAILED', 'NUMBER_UNAVAILABLE', null], 'order FAILED');
  const third = await start('hqOwner', input(C));
  eq(third.order.status, 'BUYING', 'a FAILED order frees the slot');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: MG(),
    smsReplyNumber: '+15125550199', a2pState: 'PENDING', mmsConverterConfirmed: true }), K()], ['', '::jsonb', '::uuid']);
  await refuse('23514', () => finish('hqOwner', third.order.orderId, ready()), 'READY refused when a sender was set by hand meanwhile', 'HQ_SENDER_EXISTS');
  eq((await one(admin, 'SELECT status FROM hon.hq_number_orders WHERE id=$1', [third.order.orderId])).status, 'BUYING', 'still BUYING');

  // ---------- 7. read ----------
  const view = await read('hqOwner');
  eq(view.orders.map((o) => o.phoneE164), [C, B, A], 'newest first');
  ok(!JSON.stringify(view).includes('idempotency') && !JSON.stringify(view).includes('fingerprint'), 'no key or fingerprint in reads');

  // ---------- 8. evidence ----------
  await refuse('55000', () => admin.query('DELETE FROM hon.hq_number_orders WHERE id=$1', [first.order.orderId]), 'never deleted');
  await refuse('55000', () => admin.query('UPDATE hon.hq_number_orders SET monthly_price_microunits=1, version=version+1 WHERE id=$1', [first.order.orderId]), 'finished never changes');
  await refuse('55000', () => admin.query("UPDATE hon.hq_number_orders SET phone_e164='+15125550144', status='FAILED', failure_code='X_Y_Z', finished_by=$2, finished_at=now(), version=version+1 WHERE id=$1",
    [third.order.orderId, P('hqOwner')]), 'the asked number never changes');
  await refuse('55000', () => admin.query('TRUNCATE hon.hq_number_orders CASCADE'), 'never truncated');
  await refuse('23514', () => admin.query("UPDATE hon.hq_number_orders SET status='READY', version=version+1 WHERE id=$1", [third.order.orderId]), 'READY needs SIDs and sender');

  console.log(`PASS: HQ number orders (0704) (${passed} checks).`);
} finally {
  await cleanup().catch(() => {});
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
}
