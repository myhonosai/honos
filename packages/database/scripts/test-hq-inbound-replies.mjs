// HQ inbox piece B (0698) owners' text replies to HQ, TEST MODE, disposable database only (the 0243 communication delivery
// fixture). It proves: an ordinary text from an owner's confirmed phone to the HQ Messaging Service is kept as a reply in
// the conversation of the newest HQ text that owner was sent (accepted) in the 30 days before it, while they still own the
// school; it is recorded once per provider event and never answered automatically; STOP/START/HELP and codes behave as in
// 0282; texts from unconfirmed phones, from someone with no recent HQ text, sent before the HQ text, or from someone who no
// longer owns the school are not kept; HQ reads only show replies for purposes the reader holds, for one school or all,
// never with a phone number; replies are append-only; the runtime and the worker each run only their own functions.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for HQ inbound reply tests.`);
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
async function refuse(code, work, message) {
  try { await work(); } catch (error) { assert.equal(error?.code, code, `${message}: ${error?.message}`); passed += 1; return; }
  assert.fail(`${message}: expected ${code}`);
}
const K = () => randomUUID();
const ORG = randomUUID(), S = randomUUID(), S2 = randomUUID(), ROLE = randomUUID();
const humans = Object.fromEntries(['hqOwner', 'supportOp', 'billingOp', 'owner1', 'owner2', 'stranger']
  .map((k) => [k, { id: randomUUID(), user: randomUUID(), subject: `hqreply-${k}-${randomUUID()}`, email: `${k}-${randomUUID().slice(0, 8)}@example.test` }]));
const H = (k) => humans[k].subject, P = (k) => humans[k].id;
const SID = 'MG' + '0123456789abcdef'.repeat(2);
const PHONE1 = '+15550110001', PHONE2 = '+15550110002', PHONE3 = '+15550110003';

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0];
const call = async (fn, args, types) => (await one(runtime, `SELECT hon.${fn}(${args.map((_, i) => `$${i + 1}${types?.[i] ?? ''}`).join(',')}) AS d`, args)).d;
const replies = (who, school = null, limit = 100) => call('read_hq_replies', [H(who), school, limit], ['', '::uuid', '::integer']);
let ev = 0;
// Default receipt time sits a minute ahead: the function clamps it to its own clock, so a reply is
// always after a delivery the database just accepted (JS ms vs Postgres µs could otherwise race).
const inbound = async (from, body, { event = `reply-ev-${++ev}`, at = new Date(Date.now() + 60_000) } = {}) =>
  one(worker, 'SELECT * FROM hon.record_hq_inbound_text($1,$2,$3,$4,$5,$6)', ['FAKE', event, from, SID, body, at.toISOString()]);
const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000);

const tables = ['hq_inbound_replies', 'hq_inbound_texts', 'hq_contact_requests', 'hq_contact_phones', 'hq_message_delivery_events', 'hq_message_deliveries',
  'hq_messages', 'hq_communication_requests', 'hq_communication_senders', 'hq_contact_preferences'];
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

// HQ texts wait for 08:00-21:00 school time; pick a school zone where it is daytime now, so the proof never waits.
async function daytimeZone() {
  for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/Berlin', 'Pacific/Auckland', 'America/Sao_Paulo']) {
    const hour = Number((await one(admin, 'SELECT extract(hour FROM now() AT TIME ZONE $1) h', [zone])).h);
    if (hour >= 9 && hour < 20) return zone;
  }
  throw new Error('No daytime zone found.');
}

async function confirmPhone(who, phone) {
  const started = await call('start_my_hq_phone', [H(who), JSON.stringify({ phone, expectedVersion: 0 }), K()], ['', '::jsonb', '::uuid']);
  eq((await inbound(phone, started.code)).outcome, 'CONFIRMED', `${who} confirms their phone by texting the code`);
}
async function sendSms(who, purpose, school, content) {
  const draft = await call('create_hq_message', [H(who), JSON.stringify({ organizationId: ORG, schoolId: school, purpose, channel: 'SMS', content, supportCaseId: null }), K()],
    ['', '::jsonb', '::uuid']);
  await call('queue_hq_message', [H(who), draft.message.messageId, JSON.stringify({ expectedVersion: 1 }), K()], ['', '::uuid', '::jsonb', '::uuid']);
  await admin.query("UPDATE hon.hq_message_deliveries SET next_attempt_at = now() - interval '1 second' WHERE message_id=$1", [draft.message.messageId]);
  const leased = (await worker.query("SELECT * FROM hon.claim_hq_message_deliveries('{SMS}',100,60)")).rows.filter((r) => r.message_id === draft.message.messageId);
  for (const [i, lease] of leased.entries()) {
    await worker.query('SELECT * FROM hon.record_hq_message_send_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [lease.delivery_id, lease.lease_token, 'ACCEPTED', 'FAKE', `fake-reply-${draft.message.messageId.slice(0, 8)}-${i}`, 'SMS', 1, 'GSM7', null, null]);
  }
  return { messageId: draft.message.messageId, leased: leased.length };
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect()]);
try {
  // ---------- 0. posture ----------
  const has = async (client, sig) => (await one(client, "SELECT has_function_privilege(current_user,$1,'EXECUTE') a", ['hon.' + sig])).a;
  eq(await has(runtime, 'read_hq_replies(text,uuid,integer)'), true, 'runtime reads replies');
  eq(await has(worker, 'read_hq_replies(text,uuid,integer)'), false, 'worker cannot read replies');
  eq((await one(admin, "SELECT has_function_privilege('public','hon.read_hq_replies(text,uuid,integer)','EXECUTE') a")).a, false, 'PUBLIC cannot read replies');
  eq(await has(runtime, 'hq_inbound_reply_json(hon.hq_inbound_replies)'), false, 'runtime cannot run the projection');
  const inboundSig = 'record_hq_inbound_text(text,text,text,text,text,timestamp with time zone)';
  eq(await has(worker, inboundSig), true, 'worker still records inbound texts after the function is replaced');
  eq(await has(runtime, inboundSig), false, 'runtime cannot record inbound texts');
  for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    eq((await one(runtime, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.hq_inbound_replies', priv])).a, false, `runtime replies ${priv}`);
    eq((await one(worker, 'SELECT has_table_privilege(current_user,$1,$2) a', ['hon.hq_inbound_replies', priv])).a, false, `worker replies ${priv}`);
  }
  eq(await one(admin, "SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid='hon.hq_inbound_replies'::regclass"), { r: true, f: true }, 'replies forced RLS');
  eq((await one(admin, "SELECT count(*)::int n FROM pg_policies WHERE schemaname='hon' AND tablename='hq_inbound_replies'")).n, 0, 'no policies');
  // The canonical 011 block (run with this fixture's role names) passes, and refuses a runtime grant on the inbound recorder.
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- HQ inbound owner replies exact verification (0698)')[1]?.split('-- End HQ inbound owner replies exact verification.')[0]
    ?.replace(/^[^\n]*\n[^\n]*\n/, '');
  if (!block) throw new Error('Missing canonical 0698 verification.');
  const roles = (await one(runtime, 'SELECT current_user r')).r, workerRole = (await one(worker, 'SELECT current_user r')).r;
  const fixtureBlock = block.replaceAll("'hon_runtime'", `'${roles}'`).replaceAll("'hon_communication_worker'", `'${workerRole}'`);
  await admin.query(fixtureBlock); eq(true, true, 'canonical 011 block passes');
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.${inboundSig} TO ${roles}`);
    await assert.rejects(admin.query(fixtureBlock), /HQ inbound reply function body\/posture drift/); eq(true, true, 'canonical block refuses a runtime grant on the recorder');
  } finally { await admin.query('ROLLBACK'); }
  await cleanup();

  // ---------- fixture ----------
  const zone = await daytimeZone();
  await admin.query('BEGIN');
  for (const h of Object.values(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [h.user, h.subject, h.email, 'Fixture person']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Fixture person',true)", [h.id, h.user]);
  }
  await admin.query("UPDATE hon.users SET display_name='Owner One' WHERE id=$1", [humans.owner1.user]);
  const grant = "INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')";
  await admin.query(grant, [P('hqOwner'), 'HON_HQ_OWNER', '{}']);
  await admin.query(grant, [P('supportOp'), 'HON_HQ_SUPPORT', '{hq.support.manage}']);
  await admin.query(grant, [P('billingOp'), 'HON_HQ_OPERATOR', '{hq.billing.manage}']);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQR Fixture Dojo','HQR Fixture Dojo','ACTIVE',clock_timestamp())", [ORG]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQR Main',$1::text,$3)", [S, ORG, zone]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQR North',$1::text,$3)", [S2, ORG, zone]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [ROLE, ORG]);
  for (const [who, school] of [['owner1', S], ['owner2', S], ['owner2', S2]]) {
    await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
      VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')`, [ORG, school, P(who), ROLE]);
  }
  await admin.query('COMMIT');
  await call('set_hq_communication_sender', [H('hqOwner'), JSON.stringify({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID,
    smsReplyNumber: '+15555550198', a2pState: 'REGISTERED_SERVICE', mmsConverterConfirmed: true }), K()], ['', '::jsonb', '::uuid']);
  await confirmPhone('owner1', PHONE1);
  await confirmPhone('owner2', PHONE2);

  // ---------- 1. nothing sent yet: an ordinary text is not kept ----------
  eq(await inbound(PHONE1, 'Hello HQ?'), { outcome: 'IGNORED', reply: null, replayed: false }, 'no HQ text to this owner yet');
  eq(await inbound(PHONE3, 'Who is this?'), { outcome: 'NO_MATCH', reply: null, replayed: false }, 'an unconfirmed phone is never kept');

  // ---------- 2. a reply joins the conversation ----------
  const support = await sendSms('supportOp', 'SUPPORT', S, 'Your sign-in was reset. Reply here if anything is wrong.');
  eq(support.leased, 2, 'both confirmed owners of HQR Main were texted');
  const replyEvent = `reply-ev-${++ev}`;
  eq(await inbound(PHONE1, '  Thanks, it works now!  ', { event: replyEvent }), { outcome: 'REPLY_RECORDED', reply: null, replayed: false }, 'reply kept, no auto-answer');
  eq(await inbound(PHONE1, 'Thanks, it works now!', { event: replyEvent }), { outcome: 'REPLY_RECORDED', reply: null, replayed: true }, 'same event replays');
  eq((await one(admin, 'SELECT count(*)::int n FROM hon.hq_inbound_replies')).n, 1, 'kept once');
  let view = await replies('supportOp', S);
  eq(view.replies.length, 1, 'support sees the reply for its school');
  const r = view.replies[0];
  eq([r.messageId, r.organizationId, r.schoolId, r.schoolDisplayName, r.purpose, r.channel, r.from.principalId, r.from.displayName, r.body],
    [support.messageId, ORG, S, 'HQR Main', 'SUPPORT', 'SMS', P('owner1'), 'Owner One', 'Thanks, it works now!'], 'reply facts, trimmed body');
  ok(!JSON.stringify(view).includes(PHONE1) && !JSON.stringify(view).includes('example.test'), 'no phone or email in the read');
  eq((await replies('supportOp')).replies.length, 1, 'all-schools read includes it');
  eq((await replies('supportOp', S2)).replies.length, 0, 'another school has none');
  eq((await replies('hqOwner', S)).replies.length, 1, 'HQ owner sees it');
  eq((await replies('billingOp', S)).replies.length, 0, 'billing-only HQ person does not see a SUPPORT reply');
  ok(!JSON.stringify((await admin.query('SELECT * FROM hon.hq_inbound_texts')).rows).includes('Thanks'), 'the inbound log still keeps no body');

  // ---------- 3. the newest HQ text decides the conversation ----------
  const billing = await sendSms('billingOp', 'BILLING', S2, 'Your HQR North invoice is ready.');
  eq(billing.leased, 1, 'owner2 of HQR North texted');
  eq((await inbound(PHONE2, 'Paid, thank you')).outcome, 'REPLY_RECORDED', 'owner2 reply kept');
  eq((await replies('billingOp', S2)).replies.map((x) => [x.messageId, x.purpose, x.body]), [[billing.messageId, 'BILLING', 'Paid, thank you']],
    'joins the newest HQ text to that owner (HQR North, billing)');
  eq((await replies('supportOp', S2)).replies.length, 0, 'support does not see the billing reply');
  eq((await replies('hqOwner')).replies.map((x) => x.body), ['Paid, thank you', 'Thanks, it works now!'], 'newest first');
  eq((await replies('hqOwner', null, 1)).replies.length, 1, 'limit honored');

  // ---------- 4. keywords and timing are unchanged ----------
  eq(await inbound(PHONE1, 'HELP'), { outcome: 'HELP', reply: 'HELP', replayed: false }, 'HELP is still HELP');
  eq((await inbound(PHONE1, 'Sent before your text', { at: hoursAgo(3) })).outcome, 'IGNORED', 'a text sent before the HQ text is not a reply to it');
  eq(await inbound(PHONE1, 'STOP'), { outcome: 'OPTED_OUT', reply: 'STOPPED', replayed: false }, 'STOP is still STOP, not a reply');
  eq(await inbound(PHONE1, 'START'), { outcome: 'OPTED_IN', reply: 'STARTED', replayed: false }, 'START is still START');
  eq(await inbound(PHONE1, '   '), { outcome: 'IGNORED', reply: null, replayed: false }, 'a blank text is not kept');

  // ---------- 5. no longer an owner ----------
  await admin.query('UPDATE hon.principal_role_grants SET effective_until = clock_timestamp() WHERE principal_id=$1 AND school_id=$2', [P('owner1'), S]);
  eq((await inbound(PHONE1, 'Still there?')).outcome, 'IGNORED', 'a former owner\'s text is not kept');
  eq((await one(admin, 'SELECT count(*)::int n FROM hon.hq_inbound_replies')).n, 2, 'still two replies');

  // ---------- 6. reads are guarded ----------
  await refuse('42501', () => call('read_hq_replies', ['nobody-' + randomUUID(), null, 10], ['', '::uuid', '::integer']), 'unknown subject refused');
  await refuse('42501', () => replies('owner2'), 'a school owner is not HQ');
  await refuse('22023', () => replies('hqOwner', null, 0), 'limit at least 1');
  await refuse('22023', () => replies('hqOwner', null, 101), 'limit at most 100');

  // ---------- 7. append-only ----------
  await refuse('42501', () => admin.query("UPDATE hon.hq_inbound_replies SET body='changed'"), 'replies immutable');
  await refuse('42501', () => admin.query('DELETE FROM hon.hq_inbound_replies'), 'replies cannot be deleted');
  await refuse('42501', () => admin.query('TRUNCATE hon.hq_inbound_replies'), 'replies cannot be truncated');

  await cleanup();
  console.log(`PASS: HQ inbound owner replies (0698) integrity (${passed} checks).`);
} finally {
  await Promise.allSettled([admin.end(), runtime.end(), worker.end()]);
}
