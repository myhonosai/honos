// HQ-COMM PR C (0282) Texts from HON HQ: a person's own phone and consent, TEST MODE, disposable database only (the 0243
// communication delivery fixture). It proves: only the person reads or changes their own number; the code is shown once,
// stored only as a salted hash, lasts 15 minutes, allows 5 wrong tries and 5 codes a day, and is never replayed; texting the
// code from that phone to the HQ Messaging Service confirms the number and opts in; a number is confirmed for one person
// only; STOP / START / HELP from a confirmed number change and report consent, once per provider event; texts to another
// number are NOT_HQ; the 0281 claim then sends an HQ text to the confirmed number only while the person is opted in;
// HQ reads never carry the number; the runtime and the worker each run only their own functions.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ contact phone tests.`);
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
const ORG = randomUUID(), S = randomUUID(), ROLE = randomUUID();
const humans = Object.fromEntries(['hqOwner', 'supportOp', 'owner1', 'owner2', 'other']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqphone-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id, Uu = (k) => humans[k].user;
const SID = 'MG' + 'abcdef0123456789'.repeat(2), OTHER_SID = 'MG' + '0'.repeat(32);
const PHONE1 = '+15550100001', PHONE2 = '+15550100002';

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const mine = (who) => call('read_my_hq_contact', [H(who)]);
const start = (who, phone, version, key = K()) => call('start_my_hq_phone', [H(who), JSON.stringify({ phone, expectedVersion: version }), key], ['', '::jsonb', '::uuid']);
const texting = (who, enabled, version, key = K()) => call('set_my_hq_texting', [H(who), JSON.stringify({ enabled, expectedVersion: version }), key], ['', '::jsonb', '::uuid']);
const remove = (who, version, key = K()) => call('remove_my_hq_phone', [H(who), JSON.stringify({ expectedVersion: version }), key], ['', '::jsonb', '::uuid']);
let ev = 0;
const inbound = async (from, body, { to = SID, event = `ev-${++ev}` } = {}) =>
  one(worker, 'SELECT * FROM hon.record_hq_inbound_text($1,$2,$3,$4,$5,$6)', ['FAKE', event, from, to, body, new Date().toISOString()]);
const pref = async (who) => (await one(admin, "SELECT status, source FROM hon.hq_contact_preferences WHERE user_id=$1 AND channel='SMS'", [Uu(who)])) ?? null;

const tables = ['hq_inbound_texts', 'hq_contact_requests', 'hq_contact_phones', 'hq_message_delivery_events', 'hq_message_deliveries', 'hq_messages',
  'hq_communication_requests', 'hq_communication_senders', 'hq_contact_preferences'];
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  await admin.query('BEGIN');
  try {
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
    for (const t of tables) await admin.query(`DELETE FROM hon.${t}`);
    for (const t of tables) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
    await admin.query('DELETE FROM hon.audit_events WHERE organization_id=$1', [ORG]);
    for (const t of ['principal_role_grants', 'roles', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`, [ORG]);
    await admin.query('DELETE FROM hon.organizations WHERE id=$1', [ORG]);
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
  for (const sig of ['read_my_hq_contact(text)', 'start_my_hq_phone(text,jsonb,uuid)', 'set_my_hq_texting(text,jsonb,uuid)', 'remove_my_hq_phone(text,jsonb,uuid)']) {
    eq(await has(runtime, sig), true, `runtime runs ${sig}`); eq(await has(worker, sig), false, `worker cannot run ${sig}`);
  }
  const inboundSig = 'record_hq_inbound_text(text,text,text,text,text,timestamp with time zone)';
  eq(await has(worker, inboundSig), true, 'worker records inbound texts'); eq(await has(runtime, inboundSig), false, 'runtime cannot record inbound texts');
  for (const sig of ['require_hq_contact_self(text)', 'hq_contact_json(uuid)', 'hq_contact_sms_address(uuid)', 'hq_contact_set_preference(uuid,text,text,timestamp with time zone)'])
    eq(await has(runtime, sig), false, `runtime cannot run helper ${sig}`);
  for (const t of ['hq_contact_phones', 'hq_inbound_texts', 'hq_contact_requests']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `runtime ${t} ${priv}`);
      eq((await one(worker, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.' + t, priv])).a, false, `worker ${t} ${priv}`);
    }
    eq(await one(admin, 'SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]), { r: true, f: true }, `${t} forced RLS`);
  }
  await cleanup();

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '1 hour')", [P('hqOwner')]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_SUPPORT','{hq.support.manage}',clock_timestamp()-interval '1 hour')", [P('supportOp')]);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQP Fixture Dojo','HQP Fixture Dojo','ACTIVE',clock_timestamp())", [ORG]);
  // UTC school, so quiet hours are known: the proof moves the delivery clock instead of waiting.
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQP Main',$1::text,'UTC')", [S, ORG]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [ROLE, ORG]);
  for (const who of ['owner1', 'owner2']) {
    await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
      VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [ORG, S, P(who), ROLE]);
  }
  await admin.query('COMMIT');

  // ---------- 1. no HQ number yet ----------
  let view = await mine('owner1');
  eq(view.contact, { status: 'REMOVED', phone: null, codeExpiresAt: null, codeExpired: false, wrongCodes: 0, codesLeftToday: 5, confirmedAt: null,
    textingOn: false, version: 0, hqNumber: null }, 'nothing set up');
  await refuse('23514', () => start('owner1', PHONE1, 0), 'no HQ number, no code', 'HQ_TEXTING_UNAVAILABLE');
  await refuse('42501', () => call('read_my_hq_contact', ['nobody-' + randomUUID()]), 'unknown subject refused');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID,
    a2pState: 'REGISTERED_SERVICE', mmsConverterConfirmed: true }), K()], ['', '::jsonb', '::uuid']);
  eq((await mine('owner1')).contact.hqNumber, { ready: true, a2pState: 'REGISTERED_SERVICE' }, 'HQ number ready, never its SID');

  // ---------- 2. start: code once, hash only ----------
  await refuse('22023', () => start('owner1', '5550100001', 0), 'not E.164');
  await refuse('22023', () => call('start_my_hq_phone', [H('owner1'), JSON.stringify({ phone: PHONE1 }), K()], ['', '::jsonb', '::uuid']), 'closed keys');
  const key1 = K();
  const s1 = await start('owner1', PHONE1, 0, key1);
  ok(/^[0-9]{6}$/.test(s1.code), 'six-digit code shown');
  eq([s1.contact.status, s1.contact.phone, s1.contact.textingOn, s1.contact.codesLeftToday, s1.replayed], ['PENDING', PHONE1, false, 4, false], 'pending number');
  const row = await one(admin, 'SELECT code_hash, code_salt, code_expires_at - updated_at AS ttl FROM hon.hq_contact_phones WHERE user_id=$1', [Uu('owner1')]);
  ok(row.code_hash.length === 32 && row.code_salt.length === 16, 'salted sha256 hash stored');
  eq(row.ttl.minutes, 15, 'code lasts 15 minutes');
  const stored = JSON.stringify((await admin.query('SELECT * FROM hon.hq_contact_phones')).rows) + JSON.stringify((await admin.query('SELECT response FROM hon.hq_contact_requests')).rows);
  ok(!stored.includes(s1.code), 'the code itself is never stored');
  const again = await start('owner1', PHONE1, 0, key1);
  eq([again.code, again.replayed, again.contact.status], [null, true, 'PENDING'], 'a replay never shows the code again');
  await refuse('40001', () => start('owner1', PHONE1, 0), 'stale version refused');

  // ---------- 3. confirming by texting the code ----------
  eq(await inbound(PHONE1, '000000' === s1.code ? '111111' : '000000'), { outcome: 'CODE_WRONG', reply: 'CODE_WRONG', replayed: false }, 'wrong code counted');
  eq((await mine('owner1')).contact.wrongCodes, 1, 'one wrong try');
  eq(await inbound(PHONE2, s1.code), { outcome: 'NO_MATCH', reply: null, replayed: false }, 'the code from another phone does nothing');
  eq(await inbound(PHONE1, s1.code, { to: OTHER_SID }), { outcome: 'NOT_HQ', reply: null, replayed: false }, 'a text to another number is not HQ');
  const confirmEvent = `ev-${++ev}`;
  eq(await inbound(PHONE1, ` hon ${s1.code} `, { event: confirmEvent }), { outcome: 'CONFIRMED', reply: 'CONFIRMED', replayed: false }, 'texting the code confirms');
  eq(await inbound(PHONE1, s1.code, { event: confirmEvent }), { outcome: 'CONFIRMED', reply: 'CONFIRMED', replayed: true }, 'same event replays');
  view = await mine('owner1');
  eq([view.contact.status, view.contact.phone, view.contact.textingOn, view.contact.codeExpiresAt], ['CONFIRMED', PHONE1, true, null], 'confirmed and opted in');
  eq(await pref('owner1'), { status: 'OPTED_IN', source: 'RECIPIENT' }, 'texting the code is the person\'s own opt-in');
  eq((await one(admin, 'SELECT code_hash, code_salt FROM hon.hq_contact_phones WHERE user_id=$1', [Uu('owner1')])), { code_hash: null, code_salt: null }, 'hash dropped');
  await refuse('23514', () => start('owner1', PHONE1, view.contact.version), 'same number already confirmed', 'HQ_PHONE_ALREADY_CONFIRMED');
  await refuse('23514', () => start('owner2', PHONE1, 0), 'a confirmed number belongs to one person', 'HQ_PHONE_IN_USE');

  // ---------- 4. wrong-try and daily limits ----------
  const s2 = await start('owner2', PHONE2, 0);
  for (let i = 0; i < 5; i++) eq((await inbound(PHONE2, s2.code === '123456' ? '654321' : '123456')).outcome, 'CODE_WRONG', `wrong try ${i + 1}`);
  eq((await inbound(PHONE2, s2.code)).outcome, 'NO_MATCH', 'after 5 wrong tries the code is dead');
  let v2 = (await mine('owner2')).contact.version;
  for (let i = 2; i <= 5; i++) v2 = (await start('owner2', PHONE2, v2)).contact.version;
  await refuse('23514', () => start('owner2', PHONE2, v2), 'five codes a day', 'HQ_PHONE_CODE_LIMIT');
  await admin.query("UPDATE hon.hq_contact_phones SET codes_issued_on = codes_issued_on - 1, version = version + 1 WHERE user_id=$1", [Uu('owner2')]);
  const s3 = await start('owner2', PHONE2, v2 + 1);
  await admin.query("UPDATE hon.hq_contact_phones SET code_expires_at = clock_timestamp() - interval '1 second', version = version + 1 WHERE user_id=$1", [Uu('owner2')]);
  eq((await mine('owner2')).contact.codeExpired, true, 'expired code shown as expired');
  eq((await inbound(PHONE2, s3.code)).outcome, 'NO_MATCH', 'an expired code does nothing');
  eq((await mine('owner2')).contact.status, 'PENDING', 'still pending');

  // ---------- 5. HQ text goes only to the confirmed, opted-in number ----------
  const draft = await call('create_hq_message', [H('supportOp'), JSON.stringify({ organizationId: ORG, schoolId: S, purpose: 'SUPPORT', channel: 'SMS',
    content: '긴 문자 '.repeat(100).trim(), supportCaseId: null }), K()], ['', '::jsonb', '::uuid']);
  await call('queue_hq_message', [H('supportOp'), draft.message.messageId, JSON.stringify({ expectedVersion: 1 }), K()], ['', '::uuid', '::jsonb', '::uuid']);
  await admin.query("UPDATE hon.hq_message_deliveries SET next_attempt_at = now() - interval '1 second' WHERE message_id=$1", [draft.message.messageId]);
  const hour = Number((await one(admin, "SELECT extract(hour FROM now() AT TIME ZONE 'UTC') h")).h);
  let claimed = (await worker.query("SELECT * FROM hon.claim_hq_message_deliveries('{SMS}',100,60)")).rows.filter((r) => r.organization_id === ORG);
  const byPrincipal = Object.fromEntries((await admin.query('SELECT recipient_principal_id, status, failure_code, hold_reason FROM hon.hq_message_deliveries WHERE message_id=$1',
    [draft.message.messageId])).rows.map((r) => [r.recipient_principal_id, r]));
  eq([byPrincipal[P('owner2')].status, byPrincipal[P('owner2')].failure_code], ['SUPPRESSED', 'CONSENT_MISSING'], 'pending number never texted');
  if (hour >= 8 && hour < 21) {
    eq(claimed.map((r) => [r.recipient_address, r.sender_ref, r.content.length]), [[PHONE1, SID, draft.message.content.length]], 'confirmed owner leased, whole text, HQ Messaging Service');
    await worker.query('SELECT * FROM hon.record_hq_message_send_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [claimed[0].delivery_id, claimed[0].lease_token, 'ACCEPTED', 'FAKE', 'fake-sms-1', 'MMS', null, null, null, null]);
  } else {
    eq([claimed.length, byPrincipal[P('owner1')].hold_reason], [0, 'QUIET_HOURS'], 'outside 08:00-21:00 the confirmed owner waits for daytime');
    passed += 1;
  }
  const hqRead = JSON.stringify(await call('read_hq_message', [H('supportOp'), draft.message.messageId], ['', '::uuid']));
  ok(!hqRead.includes(PHONE1) && !hqRead.includes(PHONE2), 'HQ never sees the number');

  // ---------- 6. STOP / START / HELP ----------
  eq(await inbound(PHONE1, 'stop'), { outcome: 'OPTED_OUT', reply: 'STOPPED', replayed: false }, 'STOP');
  eq(await pref('owner1'), { status: 'OPTED_OUT', source: 'RECIPIENT' }, 'STOP recorded as the recipient\'s opt-out');
  eq((await mine('owner1')).contact.textingOn, false, 'texts off');
  const after = await call('create_hq_message', [H('supportOp'), JSON.stringify({ organizationId: ORG, schoolId: S, purpose: 'SUPPORT', channel: 'SMS',
    content: 'After STOP.', supportCaseId: null }), K()], ['', '::jsonb', '::uuid']);
  await call('queue_hq_message', [H('supportOp'), after.message.messageId, JSON.stringify({ expectedVersion: 1 }), K()], ['', '::uuid', '::jsonb', '::uuid']);
  await admin.query("UPDATE hon.hq_message_deliveries SET next_attempt_at = now() - interval '1 second' WHERE message_id=$1", [after.message.messageId]);
  claimed = (await worker.query("SELECT * FROM hon.claim_hq_message_deliveries('{SMS}',100,60)")).rows.filter((r) => r.organization_id === ORG);
  eq(claimed.length, 0, 'nothing leased after STOP');
  eq((await one(admin, 'SELECT failure_code FROM hon.hq_message_deliveries WHERE message_id=$1 AND recipient_principal_id=$2', [after.message.messageId, P('owner1')])).failure_code,
    'CONSENT_MISSING', 'STOP is honored at send time');
  eq(await inbound(PHONE1, 'HELP'), { outcome: 'HELP', reply: 'HELP', replayed: false }, 'HELP');
  eq(await inbound(PHONE2, 'STOP'), { outcome: 'NO_MATCH', reply: null, replayed: false }, 'STOP from an unconfirmed number changes nothing');
  eq(await inbound(PHONE1, 'what time is class?'), { outcome: 'IGNORED', reply: null, replayed: false }, 'other text ignored');
  eq(await inbound(PHONE1, 'Start'), { outcome: 'OPTED_IN', reply: 'STARTED', replayed: false }, 'START');
  eq(await pref('owner1'), { status: 'OPTED_IN', source: 'RECIPIENT' }, 'START recorded');
  const kinds = (await admin.query("SELECT keyword, outcome FROM hon.hq_inbound_texts ORDER BY recorded_at")).rows;
  ok(kinds.length === ev - 1 || kinds.length === ev, 'one row per provider event');
  ok(!JSON.stringify((await admin.query('SELECT * FROM hon.hq_inbound_texts')).rows).includes('what time'), 'no body stored');

  // ---------- 7. the person's own switch and removal ----------
  view = await mine('owner1');
  const off = await texting('owner1', false, view.contact.version);
  eq([off.contact.textingOn, off.replayed], [false, false], 'switched off on screen');
  eq(await pref('owner1'), { status: 'OPTED_OUT', source: 'USER' }, 'recorded as the person\'s choice');
  await refuse('23514', () => texting('owner1', false, off.contact.version), 'no change refused', 'HQ_TEXTING_NO_CHANGE');
  const on = await texting('owner1', true, off.contact.version);
  eq(on.contact.textingOn, true, 'switched back on');
  const pendingVersion = (await mine('owner2')).contact.version;
  await refuse('23514', () => texting('owner2', true, pendingVersion), 'cannot switch on without a confirmed number', 'HQ_PHONE_NOT_CONFIRMED');
  const gone = await remove('owner1', on.contact.version);
  eq([gone.contact.status, gone.contact.phone, gone.contact.textingOn], ['REMOVED', null, false], 'number removed, texts off');
  eq(await pref('owner1'), { status: 'OPTED_OUT', source: 'USER' }, 'removal turns texts off');
  eq((await inbound(PHONE1, 'START')).outcome, 'NO_MATCH', 'a removed number cannot START');
  eq(await one(admin, "SELECT hon.hq_contact_sms_address($1) a", [Uu('owner1')]), { a: null }, 'no address after removal');
  await refuse('23514', () => remove('owner1', gone.contact.version), 'nothing to remove', 'HQ_PHONE_NONE');
  // Now that owner1 released it, owner2 can confirm the same number.
  const s4 = await start('owner2', PHONE1, (await mine('owner2')).contact.version);
  eq((await inbound(PHONE1, s4.code)).outcome, 'CONFIRMED', 'a released number can be confirmed by someone else');

  // ---------- 8. history is append-only ----------
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_contact_phones WHERE user_id=$1', [Uu('owner1')]), 'phones cannot be deleted');
  await refuse('42501', () => admin.query("UPDATE hon.hq_inbound_texts SET outcome='IGNORED'"), 'inbound texts immutable');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_contact_requests'), 'requests immutable');
  await refuse('42501', () => admin.query('TRUNCATE hon.hq_inbound_texts'), 'no truncate');
  await refuse('42501', () => admin.query("UPDATE hon.hq_contact_phones SET phone_e164='+15550109999' WHERE user_id=$1", [Uu('owner2')]), 'changes need a version bump');

  await cleanup();
  console.log(`PASS: HQ contact phones (0282) integrity (${passed} checks).`);
} finally {
  await Promise.allSettled([admin.end(), runtime.end(), worker.end()]);
}
